/** Read-only receiver-scoped monitor. Schedule only in an existing authorized runner.
 * No identifiers, response text or credentials are included in its output.
 */
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { open, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { z } from 'zod';
import { mcpCaller, type ToolCall } from './post-deploy-probe.js';

const count=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const totalsSchema=z.object({AvailableMessages:count,RunningMessages:count,OldestPendingAge:count,DeadDeliveries:count,AcceptedUnconfirmed:count,UnknownAcceptance:count,ExpiredLeases:count}).strict();
const checkpointSchema=z.object({version:z.literal(1),startedAt:count,phase:z.union([z.literal(0),z.literal(1)]),cursor:z.string().min(1).max(4096).optional(),
  claimsExpected:z.boolean(),unconfirmedAgeMs:count,subscriptionHealth:z.boolean(),totals:totalsSchema}).strict();
export type MonitorCheckpoint=z.infer<typeof checkpointSchema>;
const emptyTotals=()=>({AvailableMessages:0,RunningMessages:0,OldestPendingAge:0,DeadDeliveries:0,AcceptedUnconfirmed:0,UnknownAcceptance:0,ExpiredLeases:0});

/** Each call bounds its work. Partial cycles persist only counters and an opaque cursor,
 * never emit healthy gauges, and resume rather than repeatedly reading the first pages.
 */
export async function processingSnapshot(call:ToolCall,options:{subscriptionHealth?:boolean;maxPages?:number;claimsExpected?:boolean;unconfirmedAgeMs?:number;checkpoint?:MonitorCheckpoint}={},now=Date.now()) {
  const max=options.maxPages??100;
  if(!Number.isSafeInteger(max)||max<1||max>1000)throw new Error('invalid_monitor_budget');
  const claimsExpected=options.claimsExpected===true,unconfirmedAgeMs=options.unconfirmedAgeMs??300000,subscriptionHealth=options.subscriptionHealth===true;
  if(!Number.isSafeInteger(unconfirmedAgeMs)||unconfirmedAgeMs<1000||unconfirmedAgeMs>86400000)throw new Error('invalid_confirmation_grace');
  const state=options.checkpoint?checkpointSchema.parse(structuredClone(options.checkpoint)):
    {version:1 as const,startedAt:now,phase:0 as 0|1,cursor:undefined as string|undefined,claimsExpected,unconfirmedAgeMs,subscriptionHealth,totals:emptyTotals()};
  if(state.claimsExpected!==claimsExpected||state.unconfirmedAgeMs!==unconfirmedAgeMs||state.subscriptionHealth!==subscriptionHealth)throw new Error('monitor_checkpoint_configuration_changed');
  if(now<state.startedAt||now-state.startedAt>900000)throw new Error('monitor_cycle_stale');
  const totals=state.totals;let pages=0;
  while(true) {
    const [tool,field]=([['bridge_list_pending','messages'],['bridge_delivery_status','deliveries']] as const)[state.phase]!;
    const cursors=new Set<string>();if(state.cursor)cursors.add(state.cursor);
    do {
      const result=await call(tool,{limit:100,...(state.cursor?{cursor:state.cursor}:{})});
      if(!Array.isArray(result[field]))throw new Error('invalid_monitor_page');
      for(const item of result[field]) {
        if(field==='messages') {
          const published=Date.parse(item.timestamp);
          if(!Number.isFinite(published))throw new Error('invalid_monitor_timestamp');
          totals.OldestPendingAge=Math.max(totals.OldestPendingAge,state.startedAt-published);
          if(item.processing==='available')totals.AvailableMessages++;else if(item.processing==='running')totals.RunningMessages++;else throw new Error('invalid_monitor_processing_state');
        } else {
          if(!['pending','done','dead'].includes(item.status)||!['confirmed','running','unconfirmed'].includes(item.processing)||!['recorded','unknown'].includes(item.acceptanceEvidence))throw new Error('invalid_monitor_delivery_state');
          if(item.status==='dead'&&item.processing!=='confirmed')totals.DeadDeliveries++;
          if(claimsExpected&&item.processing==='unconfirmed'&&item.acceptanceEvidence==='recorded') {
            if(!Number.isSafeInteger(item.acceptedAt)||item.acceptedAt<0)throw new Error('invalid_monitor_acceptance_timestamp');
            if(state.startedAt-item.acceptedAt>=unconfirmedAgeMs)totals.AcceptedUnconfirmed++;
          }
          if(item.processing!=='confirmed'&&item.acceptanceEvidence==='unknown')totals.UnknownAcceptance++;
          if(item.expiredClaim)totals.ExpiredLeases++;
        }
      }
      if(result.cursor!==undefined && (typeof result.cursor!=='string'||!result.cursor||result.cursor.length>4096||cursors.has(result.cursor)))throw new Error('invalid_monitor_cursor');
      state.cursor=result.cursor;
      if(state.cursor)cursors.add(state.cursor);
      pages++;
      if(!state.cursor)break;
      if(pages>=max)return {complete:false as const,checkpoint:state};
    } while(state.cursor);
    if(state.phase===1)break;
    state.phase=1;
    if(pages>=max)return {complete:false as const,checkpoint:state};
  }
  let unhealthySubscriptions:number|undefined;
  if(subscriptionHealth) {
    const health=await call('bridge_subscription_status',{});
    if(!Array.isArray(health.subscriptions))throw new Error('invalid_subscription_health');
    unhealthySubscriptions=health.authorizationActive!==true?1:health.subscriptions.filter((s:Record<string,unknown>)=>!s.active||s.expired||!s.authorized||!s.generationValid).length;
    if(health.subscriptions.length===0)unhealthySubscriptions=Math.max(1,unhealthySubscriptions);
  }
  const {AcceptedUnconfirmed,...common}=totals;
  return {complete:true as const,coverage:'enabled_inbox_and_current_outbox_only',MonitorHeartbeat:1,...common,
    ...(claimsExpected?{AcceptedUnconfirmed}:{}),
    ...(unhealthySubscriptions===undefined?{}:{UnhealthySubscriptions:unhealthySubscriptions})};
}

async function run(environment:NodeJS.ProcessEnv,request:typeof fetch) {
  const url=environment.BRIDGE_MONITOR_RESOURCE_URL,token=environment.BRIDGE_MONITOR_TOKEN,name=environment.BRIDGE_MONITOR_NAME;
  if(!url||!token||!name||!/^[A-Za-z0-9_-]{1,64}$/.test(name))throw new Error('authorized_monitor_configuration_required');
  if(environment.BRIDGE_MONITOR_SUBSCRIPTIONS!==undefined&&!['true','false'].includes(environment.BRIDGE_MONITOR_SUBSCRIPTIONS))throw new Error('invalid_monitor_configuration');
  if(environment.BRIDGE_MONITOR_CLAIMS_EXPECTED!==undefined&&!['true','false'].includes(environment.BRIDGE_MONITOR_CLAIMS_EXPECTED))throw new Error('invalid_monitor_configuration');
  const options={subscriptionHealth:environment.BRIDGE_MONITOR_SUBSCRIPTIONS==='true',claimsExpected:environment.BRIDGE_MONITOR_CLAIMS_EXPECTED==='true',
    unconfirmedAgeMs:Number(environment.BRIDGE_MONITOR_CONFIRMATION_GRACE_MS??300000),maxPages:Number(environment.BRIDGE_MONITOR_MAX_PAGES??100)};
  const path=environment.BRIDGE_MONITOR_CHECKPOINT;
  // Bind private continuation state to the credential too; never mix principals on reuse.
  const target=createHash('sha256').update(JSON.stringify([url,name,options,token])).digest('hex');
  let checkpoint:MonitorCheckpoint|undefined;
  if(path) {
    try {
      const saved=z.object({target:z.string(),checkpoint:checkpointSchema.nullable()}).strict().parse(JSON.parse(await readFile(path,'utf8')));
      if(saved.target!==target)throw new Error('monitor_checkpoint_target_changed');
      checkpoint=saved.checkpoint??undefined;
    } catch(error) {if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  }
  const now=Date.now();
  const result=await processingSnapshot(mcpCaller(url,token,request),{...options,checkpoint},now);
  if(Date.now()-(checkpoint?.startedAt??now)>900000)throw new Error('monitor_cycle_stale');
  if(!result.complete&&!path)throw new Error('monitor_checkpoint_required_for_large_cycle');
  if(path) {
    const temporary=`${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary,JSON.stringify({target,checkpoint:result.complete?null:result.checkpoint}),{mode:0o600,flag:'wx'});
      await rename(temporary,path);
    } finally {await unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});}
  }
  if(!result.complete){console.log(JSON.stringify({status:'partial',reason:'monitor_cycle_in_progress_no_health_claim'}));return;}
  const {complete:_,...snapshot}=result;
  const Metrics=Object.keys(snapshot).filter(key=>key!=='coverage').map(Name=>({Name,Unit:Name==='OldestPendingAge'?'Milliseconds':'Count'}));
  // A completed multi-run snapshot is timestamped at cycle start, never presented as fresh data.
  console.log(JSON.stringify({_aws:{Timestamp:checkpoint?.startedAt??now,CloudWatchMetrics:[{Namespace:'AgentMessageBridge',Dimensions:[['Monitor']],Metrics}]},Monitor:name,...snapshot}));
}
export async function main(environment=process.env,request:typeof fetch=fetch) {
  const lockPath=environment.BRIDGE_MONITOR_CHECKPOINT?`${environment.BRIDGE_MONITOR_CHECKPOINT}.lock`:undefined;
  if(!lockPath)return run(environment,request);
  // One writer per private checkpoint. A crash leaves a lock for operator inspection,
  // not a second runner silently overwriting progress or mixing cycle counters.
  const lock=await open(lockPath,'wx',0o600);
  try {await run(environment,request);}
  finally {await lock.close();await unlink(lockPath);}
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)main().catch(()=>{console.error(JSON.stringify({status:'failed',reason:'processing_monitor_incomplete_no_health_claim'}));process.exitCode=1;});

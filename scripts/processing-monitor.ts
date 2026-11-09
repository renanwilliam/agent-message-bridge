/** Read-only receiver-scoped monitor. Schedule only in an existing authorized runner.
 * No identifiers, response text or credentials are included in its output.
 */
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { mcpCaller, type ToolCall } from './post-deploy-probe.js';

export async function processingSnapshot(call:ToolCall,options:{subscriptionHealth?:boolean;maxPages?:number}={},now=Date.now()) {
  const max=options.maxPages??100;
  if(!Number.isSafeInteger(max)||max<1||max>1000)throw new Error('invalid_monitor_budget');
  let available=0,running=0,oldestAge=0,dead=0,acceptedUnconfirmed=0,unknownAcceptance=0,expiredLeases=0;
  for(const [tool,field] of [['bridge_list_pending','messages'],['bridge_delivery_status','deliveries']] as const) {
    let cursor:string|undefined;let pages=0;const cursors=new Set<string>();
    do {
      const result=await call(tool,{limit:100,...(cursor?{cursor}:{})});
      if(!Array.isArray(result[field]))throw new Error('invalid_monitor_page');
      for(const item of result[field]) {
        if(field==='messages') {
          const published=Date.parse(item.timestamp);
          if(!Number.isFinite(published))throw new Error('invalid_monitor_timestamp');
          oldestAge=Math.max(oldestAge,now-published);
          if(item.processing==='available')available++;else if(item.processing==='running')running++;else throw new Error('invalid_monitor_processing_state');
        } else {
          if(!['pending','done','dead'].includes(item.status)||!['confirmed','running','unconfirmed'].includes(item.processing)||!['recorded','unknown'].includes(item.acceptanceEvidence))throw new Error('invalid_monitor_delivery_state');
          if(item.status==='dead')dead++;
          if(item.processing!=='confirmed'&&item.acceptanceEvidence==='recorded')acceptedUnconfirmed++;
          if(item.processing!=='confirmed'&&item.acceptanceEvidence==='unknown')unknownAcceptance++;
          if(item.expiredClaim)expiredLeases++;
        }
      }
      if(result.cursor!==undefined && (typeof result.cursor!=='string'||cursors.has(result.cursor)))throw new Error('invalid_monitor_cursor');
      cursor=result.cursor;
      if(cursor)cursors.add(cursor);
      if(++pages>=max && cursor)throw new Error('monitor_page_budget_exhausted');
    } while(cursor);
  }
  let unhealthySubscriptions:number|undefined;
  if(options.subscriptionHealth) {
    const health=await call('bridge_subscription_status',{});
    if(!Array.isArray(health.subscriptions))throw new Error('invalid_subscription_health');
    unhealthySubscriptions=health.authorizationActive!==true?1:health.subscriptions.filter((s:Record<string,unknown>)=>!s.active||s.expired||!s.authorized||!s.generationValid).length;
    if(health.subscriptions.length===0)unhealthySubscriptions=Math.max(1,unhealthySubscriptions);
  }
  return {coverage:'enabled_inbox_and_current_outbox_only',MonitorHeartbeat:1,AvailableMessages:available,RunningMessages:running,OldestPendingAge:Math.max(0,oldestAge),
    DeadDeliveries:dead,AcceptedUnconfirmed:acceptedUnconfirmed,UnknownAcceptance:unknownAcceptance,ExpiredLeases:expiredLeases,
    ...(unhealthySubscriptions===undefined?{}:{UnhealthySubscriptions:unhealthySubscriptions})};
}

export async function main(environment=process.env) {
  const url=environment.BRIDGE_MONITOR_RESOURCE_URL,token=environment.BRIDGE_MONITOR_TOKEN,name=environment.BRIDGE_MONITOR_NAME;
  if(!url||!token||!name||!/^[A-Za-z0-9_-]{1,64}$/.test(name))throw new Error('authorized_monitor_configuration_required');
  if(environment.BRIDGE_MONITOR_SUBSCRIPTIONS!==undefined&&!['true','false'].includes(environment.BRIDGE_MONITOR_SUBSCRIPTIONS))throw new Error('invalid_monitor_configuration');
  const now=Date.now();
  const snapshot=await processingSnapshot(mcpCaller(url,token),{subscriptionHealth:environment.BRIDGE_MONITOR_SUBSCRIPTIONS==='true'},now);
  const Metrics=Object.keys(snapshot).filter(key=>key!=='coverage').map(Name=>({Name,Unit:Name==='OldestPendingAge'?'Milliseconds':'Count'}));
  console.log(JSON.stringify({_aws:{Timestamp:now,CloudWatchMetrics:[{Namespace:'AgentMessageBridge',Dimensions:[['Monitor']],Metrics}]},Monitor:name,...snapshot}));
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)main().catch(()=>{console.error(JSON.stringify({status:'failed',reason:'processing_monitor_incomplete_no_health_claim'}));process.exitCode=1;});

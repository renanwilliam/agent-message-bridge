import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { processingSnapshot, main } from '../scripts/processing-monitor.js';

test('processing monitor follows empty pages and exposes durable dead and accepted-unconfirmed state without identifiers',async()=>{
  const now=Date.UTC(2026,0,1);
  const result=await processingSnapshot(async(name,args)=>{
    if(name==='bridge_list_pending')return args.cursor?{messages:[{timestamp:new Date(now-600000).toISOString(),processing:'available',id:'private-id'},{timestamp:new Date(now-1000).toISOString(),processing:'running'}]}:{messages:[],cursor:'next'};
    if(name==='bridge_delivery_status')return {deliveries:[{status:'dead',processing:'unconfirmed',acceptanceEvidence:'recorded',expiredClaim:true,id:'private-id',acceptedAt:now-600000},{status:'done',processing:'confirmed',acceptanceEvidence:'unknown'}]};
    return {authorizationActive:true,subscriptions:[{active:true,expired:true,authorized:true,generationValid:true}]};
  },{subscriptionHealth:true,claimsExpected:true},now);
  assert.ok(result.complete);if(!result.complete)throw new Error('incomplete');
  assert.equal(result.AvailableMessages,1);assert.equal(result.RunningMessages,1);assert.equal(result.OldestPendingAge,600000);
  assert.equal(result.DeadDeliveries,1);assert.equal(result.AcceptedUnconfirmed,1);assert.equal(result.UnknownAcceptance,0);assert.equal(result.ExpiredLeases,1);assert.equal(result.UnhealthySubscriptions,1);
  assert.equal(JSON.stringify(result).includes('private-id'),false);
});
test('incomplete monitor pagination and protocol failures fail closed instead of reporting a healthy zero',async()=>{
  const result=await processingSnapshot(async()=>({messages:[],cursor:'more'}),{maxPages:1});
  assert.equal(result.complete,false);assert.equal('MonitorHeartbeat' in result,false);assert.equal('AvailableMessages' in result,false);
  await assert.rejects(processingSnapshot(async()=>({messages:[],cursor:'same'})),/invalid_monitor_cursor/);
  await assert.rejects(processingSnapshot(async()=>{throw new Error('failed');}),/failed/);
});
test('completed dead deliveries are history, not actionable dead backlog',async()=>{
  const result=await processingSnapshot(async name=>name==='bridge_list_pending'?{messages:[]}:
    {deliveries:[{status:'dead',processing:'confirmed',acceptanceEvidence:'recorded'},{status:'dead',processing:'unconfirmed',acceptanceEvidence:'unknown'}]});
  assert.ok(result.complete);if(!result.complete)throw new Error('incomplete');
  assert.equal(result.DeadDeliveries,1);
});
test('confirmation alarms are opt-in and exclude fresh acceptances and running or completed work',async()=>{
  const now=Date.UTC(2026,0,1),old=now-300000,fresh=now-1000;
  const deliveries=([['unconfirmed',fresh],['running',old],['confirmed',old],['unconfirmed',old]] as const).map(([processing,acceptedAt])=>({status:'done',processing,acceptanceEvidence:'recorded',acceptedAt}));
  const call=async(name:string)=>name==='bridge_list_pending'?{messages:[]}:{deliveries};
  const disabled=await processingSnapshot(call,{},now);assert.equal('AcceptedUnconfirmed' in disabled,false);
  const enabled=await processingSnapshot(call,{claimsExpected:true},now);
  assert.ok(enabled.complete);if(!enabled.complete)throw new Error('incomplete');
  assert.equal(enabled.AcceptedUnconfirmed,1);
});
test('monitor resumes past 10000 outbox rows with bounded calls and emits only complete snapshots',async()=>{
  const counts={pending:0,deliveries:0};
  const call=async(name:string,args:Record<string,unknown>)=>{
    if(name==='bridge_list_pending'){counts.pending++;return {messages:[]};}
    counts.deliveries++;
    const offset=Number(args.cursor??0),size=Math.min(100,10001-offset);
    return {deliveries:Array.from({length:size},()=>({status:'dead',processing:'confirmed',acceptanceEvidence:'recorded'})),...(offset+size<10001?{cursor:String(offset+size)}:{})};
  };
  const first=await processingSnapshot(call,{maxPages:100},1000);
  assert.equal(first.complete,false);if(first.complete)throw new Error('expected_checkpoint');
  assert.equal(counts.deliveries,99);assert.equal(counts.pending,1);
  const resumed=await processingSnapshot(call,{maxPages:100,checkpoint:JSON.parse(JSON.stringify(first.checkpoint))},2000);
  assert.ok(resumed.complete);if(!resumed.complete)throw new Error('incomplete');
  assert.equal(counts.deliveries,101);assert.equal(counts.pending,1);assert.equal(resumed.DeadDeliveries,0);assert.equal(resumed.MonitorHeartbeat,1);
});
test('stale or differently configured checkpoints fail closed rather than reusing partial health',async()=>{
  const call=async()=>({messages:[],cursor:'next'});
  const first=await processingSnapshot(call,{maxPages:1},1000);
  assert.equal(first.complete,false);if(first.complete)throw new Error('expected_checkpoint');
  await assert.rejects(processingSnapshot(call,{checkpoint:first.checkpoint},902000),/monitor_cycle_stale/);
  await assert.rejects(processingSnapshot(call,{checkpoint:first.checkpoint,claimsExpected:true},2000),/configuration_changed/);
  await assert.rejects(processingSnapshot(call,{checkpoint:first.checkpoint},2000),/invalid_monitor_cursor/);
});
test('monitor CLI persists private progress, resumes after restart and does not publish partial health or cross-identity state',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'bridge-monitor-')),path=join(directory,'checkpoint.json');
  const env={BRIDGE_MONITOR_RESOURCE_URL:'https://bridge.example.test/bridge/mcp',BRIDGE_MONITOR_TOKEN:'synthetic-monitor-token',BRIDGE_MONITOR_NAME:'fixture',BRIDGE_MONITOR_CHECKPOINT:path,BRIDGE_MONITOR_MAX_PAGES:'1'};
  const lines:string[]=[],log=console.log;let requests=0;
  const request:typeof fetch=async(_url,init)=>{
    requests++;const body=JSON.parse(init?.body as string);
    return new Response(JSON.stringify({jsonrpc:'2.0',id:1,result:{structuredContent:body.params.name==='bridge_list_pending'?{messages:[]}:{deliveries:[]}}}));
  };
  try {
    console.log=value=>{lines.push(value);};
    await main(env,request);
    assert.equal(JSON.parse(lines[0]!).status,'partial');assert.equal(lines[0]!.includes('_aws'),false);
    const saved=JSON.parse(await readFile(path,'utf8'));
    assert.equal(saved.checkpoint.phase,1);assert.equal((await stat(path)).mode&0o777,0o600);
    assert.equal(JSON.stringify(saved).includes(env.BRIDGE_MONITOR_TOKEN),false);
    await assert.rejects(main({...env,BRIDGE_MONITOR_TOKEN:'other-synthetic-token'},request),/target_changed/);
    assert.equal(requests,1,'Credential changes cannot resume another identity\'s partial snapshot');
    await main(env,request);
    const emf=JSON.parse(lines[1]!);assert.equal(emf.MonitorHeartbeat,1);assert.equal(emf.DeadDeliveries,0);
    assert.equal(emf._aws.Timestamp,saved.checkpoint.startedAt);assert.equal(emf.AcceptedUnconfirmed,undefined);
    assert.equal(JSON.parse(await readFile(path,'utf8')).checkpoint,null);assert.equal(requests,2);
    await writeFile(`${path}.lock`,'',{mode:0o600});
    await assert.rejects(main(env,request),{code:'EEXIST'});assert.equal(requests,2);
  } finally {console.log=log;await rm(directory,{recursive:true,force:true});}
});

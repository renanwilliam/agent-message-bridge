import test from 'node:test';
import assert from 'node:assert/strict';
import { Bridge } from '../src/bridge.js';
import { MemoryStore } from '../src/memory-store.js';
import { SqliteStore } from '../src/sqlite-store.js';
import { Worker } from '../src/worker.js';
import { recoverDelivery } from '../src/recovery.js';
import { deliveryMetric } from '../src/observability.js';
import { mcpResponseFailed } from '../src/delivery-response.js';
import { mapBounded } from '../src/concurrency.js';
import { createDeliveryHandler } from '../src/delivery-handler.js';
import { processingSnapshot } from '../scripts/processing-monitor.js';
import { HISTORY_RETENTION_MS } from '../src/retention.js';
import { type Delivery, type Principal, tenantKey } from '../src/types.js';
import type { Store, Write } from '../src/store.js';
const alpha:Principal={id:'alpha',tenant:'sample',scopes:['messages:send','messages:read','messages:claim'],peers:['beta']};
const beta:Principal={...alpha,id:'beta',peers:['alpha']};
const config={inboxEnabled:true,messagesPerMinute:100,claimMs:1000,webhookRecipients:['sample:beta']};
const workerConfig={routes:{'sample:beta':{url:'https://receiver.example.test/wake',bearer:'synthetic-placeholder'}},leaseMs:1000,retryMs:100,maxAttempts:2,responseWaitMs:1000};
function fixture(store:Store=new MemoryStore()) {
  let now=Date.UTC(2026,0,1);
  const bridge=new Bridge(store,config,()=>now);
  return {store,bridge,now:()=>now,advance:(ms:number)=>{now+=ms;},send:(id='request',conversationId='conversation')=>bridge.send(alpha,{id,conversationId,recipient:'beta',text:'Synthetic request'})};
}
for(const [name,make] of [['memory',()=>new MemoryStore()],['sqlite',()=>new SqliteStore(':memory:')]] as const) {
  test(`${name}: inbox covers conversations and removes completed pointers without losing pagination`,async()=>{
    const f=fixture(make());
    await Promise.all([f.send('first','one'),f.send('second','two')]);
    const pointers=await f.store.query(tenantKey('sample','inbox','beta'),'message#',100);
    assert.ok(pointers.items.every(row=>row.retentionExpiresAt===(f.now()+HISTORY_RETENTION_MS)/1000));
    const first=await f.bridge.pending(beta,1);assert.equal(first.messages.length,1);assert.ok(first.cursor);
    const msg=first.messages[0]!;assert.equal('text' in msg,false);
    const c=await f.bridge.claim(beta,msg.conversationId,msg.id);assert.equal(c.status,'claimed');
    await f.bridge.complete(beta,{id:'reply',conversationId:msg.conversationId,recipient:'alpha',text:'Synthetic response',replyTo:msg.id,fence:c.fence!});
    const remaining=await f.bridge.pending(beta,1);assert.equal(remaining.messages.length,1);
    const next=await f.bridge.pending(beta,1,first.cursor);assert.equal(next.messages.length,1);
    assert.equal((await f.store.query(tenantKey('sample','inbox','beta'),'message#',100)).items.length,1);
    assert.equal((await f.bridge.pending({...beta,id:'other'})).messages.length,0);
    await assert.rejects(f.bridge.pending({...beta,tenant:'other'},1,next.cursor??first.cursor));
    await assert.rejects(f.bridge.pending({...beta,scopes:['messages:read']}),/forbidden/);
    f.advance(HISTORY_RETENTION_MS);assert.equal((await f.bridge.pending(beta)).messages.length,0);
  });
}
test('inbox insertion is atomic and compatibility gate preserves the old role contract',async()=>{
  class FailingStore extends MemoryStore {
    fail=true;
    override async commit(writes:Write[]) {if(this.fail && writes.some(w=>w.pk.includes('#inbox#')))throw new Error('injected_failure');return super.commit(writes);}
  }
  const store=new FailingStore(),f=fixture(store);
  await assert.rejects(f.send(),/injected_failure/);
  assert.equal((await store.query(tenantKey('sample','history','conversation'),'',100)).items.length,0);
  store.fail=false;await f.send();assert.equal((await f.bridge.pending(beta)).messages.length,1);
  const old=new Bridge(store,{...config,inboxEnabled:false},f.now);
  await old.send(alpha,{id:'old',conversationId:'legacy',recipient:'beta',text:'Synthetic legacy'});
  await assert.rejects(old.pending(beta),/inbox_not_enabled/);
  await assert.rejects(old.deliveries(beta),/inbox_not_enabled/);
  assert.equal((await f.bridge.pending(beta)).messages.length,1,'Legacy publications require reviewed backfill');
});
test('inbox removal is atomic with completion; a failed delete leaves the original claim and work recoverable',async()=>{
  class FailingStore extends MemoryStore {
    rejectDeletes=false;
    override async commit(writes:Write[]) {
      if(this.rejectDeletes&&writes.some(write=>write.pk.includes('#inbox#')&&write.value===undefined))throw new Error('injected_delete_denial');
      return super.commit(writes);
    }
  }
  const store=new FailingStore(),f=fixture(store);await f.send();
  const c=await f.bridge.claim(beta,'conversation','request');
  const reply={id:'reply',conversationId:'conversation',recipient:'alpha',text:'Synthetic response',replyTo:'request',fence:c.fence!};
  store.rejectDeletes=true;await assert.rejects(f.bridge.complete(beta,reply),/injected_delete_denial/);
  assert.equal((await f.bridge.pending(beta)).messages[0]!.processing,'running');
  assert.equal((await f.bridge.history(beta,'conversation')).messages.length,1);
  store.rejectDeletes=false;await f.bridge.complete(beta,reply);
  assert.equal((await f.store.query(tenantKey('sample','inbox','beta'),'message#',100)).items.length,0);
  const terminal=await f.bridge.claim(alpha,'conversation','reply');
  const args={conversationId:'conversation',messageId:'reply',fence:terminal.fence!};
  store.rejectDeletes=true;await assert.rejects(f.bridge.acknowledge(alpha,args),/injected_delete_denial/);
  assert.equal((await f.bridge.pending(alpha)).messages[0]!.processing,'running');
  store.rejectDeletes=false;await f.bridge.acknowledge(alpha,args);
  assert.equal((await f.store.query(tenantKey('sample','inbox','alpha'),'message#',100)).items.length,0);
  assert.equal((await f.bridge.acknowledge(alpha,args)).duplicate,true);
});
test('completed traffic leaves no inbox read amplification while history and TTL evidence remain intact',async()=>{
  class CountingStore extends MemoryStore {
    reads=0;
    override async get<T=Record<string,unknown>>(key:{pk:string;sk:string}) {this.reads++;return super.get<T>(key);}
  }
  const store=new CountingStore(),now=()=>Date.UTC(2026,0,1);
  const bridge=new Bridge(store,{...config,messagesPerMinute:1000,webhookRecipients:[]},now);
  for(let n=0;n<125;n++) {
    await bridge.send(alpha,{id:`request_${n}`,conversationId:'volume',recipient:'beta',text:'Synthetic request'});
    const c=await bridge.claim(beta,'volume',`request_${n}`);
    await bridge.complete(beta,{id:`reply_${n}`,conversationId:'volume',recipient:'alpha',text:'Synthetic response',replyTo:`request_${n}`,fence:c.fence!});
    const terminal=await bridge.claim(alpha,'volume',`reply_${n}`);
    await bridge.acknowledge(alpha,{conversationId:'volume',messageId:`reply_${n}`,fence:terminal.fence!});
  }
  store.reads=0;
  assert.equal((await bridge.pending(beta)).messages.length,0);assert.equal((await bridge.pending(alpha)).messages.length,0);
  assert.equal(store.reads,0,'Completed pointers are deleted, not re-read and filtered');
  const history=await store.query(tenantKey('sample','history','volume'),'message#',100);
  assert.equal(history.items.length,100);assert.ok(history.cursor);
  assert.ok(history.items.every(row=>row.retentionExpiresAt===(now()+HISTORY_RETENTION_MS)/1000));
});
test('2xx without processing stays unconfirmed; expired claims are discoverable without resending accepted events',async()=>{
  const f=fixture();await f.send();let posts=0;
  const worker=new Worker(f.store,workerConfig,async()=>{posts++;return {status:200,body:''};},f.now);
  const key=(await f.store.due(f.now(),10))[0]!;
  await worker.deliver(key);
  let status=(await f.bridge.deliveries(beta)).deliveries[0]!;
  assert.equal(status.processing,'unconfirmed');assert.equal(status.acceptedAt,f.now());
  assert.equal((await f.bridge.pending(beta)).messages[0]!.processing,'available');
  const c=await f.bridge.claim(beta,'conversation','request');
  assert.equal((await f.bridge.pending(beta)).messages[0]!.processing,'running');
  f.advance(1001);assert.equal((await f.bridge.pending(beta)).messages[0]!.processing,'available');
  await assert.rejects(f.bridge.complete(beta,{id:'stale',conversationId:'conversation',recipient:'alpha',text:'Synthetic',replyTo:'request',fence:c.fence!}),/stale_claim/);
  const next=await f.bridge.claim(beta,'conversation','request');
  const response={id:'response',conversationId:'conversation',recipient:'alpha',text:'Synthetic',replyTo:'request',fence:next.fence!};
  await f.bridge.complete(beta,response);assert.equal((await f.bridge.complete(beta,response)).duplicate,true);
  await worker.deliver(key);assert.equal(posts,1);
  status=(await f.bridge.deliveries(beta)).deliveries[0]!;assert.equal(status.processing,'confirmed');
  assert.equal((await f.bridge.pending(beta)).messages.length,0);
});
for(const body of ['{"jsonrpc":"2.0","error":{"code":-32603,"message":"private-error"}}','{"jsonrpc":"2.0","result":{"isError":true}}','[{"jsonrpc":"2.0","result":{}},{"jsonrpc":"2.0","error":{"code":-1}}]']) {
  test(`MCP errors inside HTTP 200 consume bounded retries without storing response text (${body.slice(0,20)})`,async()=>{
    const f=fixture();await f.send();let posts=0;
    const worker=new Worker(f.store,workerConfig,async()=>{posts++;return {status:200,body};},f.now);
    const key=(await f.store.due(f.now(),10))[0]!;
    assert.equal(await worker.deliver(key),'pending');f.advance(101);
    assert.equal(await worker.deliver(key),'dead');assert.equal(posts,2);
    const row=(await f.store.get<Delivery>(key))!;assert.equal(row.value.lastError,'mcp_error');assert.equal(row.value.acceptedAt,undefined);
    assert.ok(!JSON.stringify(row).includes('private-error'));
    assert.equal((await f.bridge.deliveries(beta)).deliveries[0]!.processing,'unconfirmed');
  });
}
test('callback compatibility accepts empty, arbitrary receipt, and successful JSON-RPC bodies as transport receipts only',()=>{
  for(const body of ['', 'accepted','{}','{"result":{}}','{"error":null}','{"ok":true,"error":false}','{"ok":true,"error":""}','{"isError":true}','{"error":{"reason":"domain_field"}}','{"jsonrpc":"2.0","error":false}','{"jsonrpc":"2.0","error":[]}','{"jsonrpc":"2.0","result":{"isError":false}}'])assert.equal(mcpResponseFailed(body),false);
});
for(const error of [false,'']) {
  test(`HTTP 200 webhook receipt with error=${JSON.stringify(error)} records acceptance rather than an MCP retry`,async()=>{
    const f=fixture();await f.send();let posts=0;
    const worker=new Worker(f.store,workerConfig,async()=>{posts++;return {status:200,body:JSON.stringify({ok:true,error})};},f.now);
    const key=(await f.store.due(f.now(),10))[0]!;
    assert.equal(await worker.deliver(key),'pending');f.advance(101);
    assert.equal(await worker.deliver(key),'skipped');assert.equal(posts,1);
    const row=(await f.store.get<Delivery>(key))!;
    assert.equal(row.value.lastError,undefined);assert.equal(row.value.acceptedAt,f.now()-101);
  });
}
test('dead recovery preserves TTL/identity, requires reviewed version and serializes with concurrent claims',async()=>{
  const f=fixture();await f.send();
  const key=(await f.store.due(f.now(),10))[0]!;
  const worker=new Worker(f.store,workerConfig,async()=>({status:401,body:'private'}),f.now);
  assert.equal(await worker.deliver(key),'dead');
  const before=(await f.store.get<Delivery>(key))!;
  const dry=await recoverDelivery(f.store,key,{},f.now());assert.equal(dry.applied,false);
  await assert.rejects(recoverDelivery(f.store,key,{apply:true},f.now()),/reviewed_version/);
  const results=await Promise.allSettled([1,2].map(()=>recoverDelivery(f.store,key,{apply:true,expectedVersion:dry.version},f.now())));
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  const after=(await f.store.get<Delivery>(key))!;
  assert.equal(after.retentionExpiresAt,before.retentionExpiresAt);assert.equal(after.value.id,before.value.id);assert.equal(after.value.recoveryCount,1);assert.equal(after.value.recoveredAttempts,1);
  await worker.deliver(key);
  await assert.rejects(recoverDelivery(f.store,key,{},f.now()),/recovery_budget/);
});
test('recovery refuses expired, uncertain and already processed dead records',async()=>{
  for(const state of ['accepted','network','completed','expired'] as const) {
    const f=fixture();await f.send();const key=(await f.store.due(f.now(),10))[0]!;
    const row=(await f.store.get<Delivery>(key))!;
    await f.store.commit([{...key,expected:row.version,retentionExpiresAt:row.retentionExpiresAt,value:{...row.value,status:'dead',attempts:1,attemptedAt:f.now(),acceptanceUncertain:state==='network',lastError:state==='network'?'network_error':'http_401',...(state==='accepted'?{acceptedAt:f.now()}:{})}}]);
    if(state==='completed') {
      const c=await f.bridge.claim(beta,'conversation','request');
      await f.bridge.complete(beta,{id:'reply',conversationId:'conversation',recipient:'alpha',text:'Synthetic',replyTo:'request',fence:c.fence!});
    }
    if(state==='expired')f.advance(HISTORY_RETENTION_MS);
    await assert.rejects(recoverDelivery(f.store,key,{},f.now()));
  }
});
test('recovery CAS cannot overwrite a claim completed after inspection',async()=>{
  class RacingStore extends MemoryStore { before?:()=>Promise<void>;override async commit(writes:Write[]) {if(this.before){const fn=this.before;this.before=undefined;await fn();}return super.commit(writes);} }
  const store=new RacingStore(),f=fixture(store);await f.send();const key=(await store.due(f.now(),10))[0]!;
  await new Worker(store,workerConfig,async()=>({status:401,body:''}),f.now).deliver(key);
  const dry=await recoverDelivery(store,key,{},f.now());
  store.before=async()=>{await f.bridge.claim(beta,'conversation','request');};
  await assert.rejects(recoverDelivery(store,key,{apply:true,expectedVersion:dry.version},f.now()),/Concurrent update/);
  assert.equal((await store.get<Delivery>(key))!.value.status,'dead');
});
for(const first of ['network','http_503','mcp_error','lost_lease'] as const) {
  for(const status of [401,403,410,413]) {
    test(`recovery preserves ${first} uncertainty after HTTP ${status}`,async()=>{
      const f=fixture();await f.send();const key=(await f.store.due(f.now(),10))[0]!;
      let calls=0,started!:()=>void,finish!:(response:{status:number;body:string})=>void;
      const inFlight=new Promise<void>(resolve=>{started=resolve;});
      const response=new Promise<{status:number;body:string}>(resolve=>{finish=resolve;});
      const worker=new Worker(f.store,workerConfig,async()=>{
        if(++calls>1)return {status,body:''};
        if(first==='lost_lease'){started();return response;}
        if(first==='network')throw new Error('synthetic_timeout');
        return first==='http_503'?{status:503,body:''}:{status:200,body:'{"jsonrpc":"2.0","id":1,"result":{"isError":true}}'};
      },f.now);
      const initial=worker.deliver(key);
      if(first==='lost_lease') {
        await inFlight;f.advance(workerConfig.leaseMs+1);
        assert.equal(await worker.deliver(key),'dead');
        finish({status:200,body:''});assert.equal(await initial,'fenced');
      } else {
        assert.equal(await initial,'pending');f.advance(101);
        assert.equal(await worker.deliver(key),'dead');
      }
      const before=(await f.store.get<Delivery>(key))!;
      assert.equal(before.value.acceptanceUncertain,true);
      for(const options of [{},{apply:true,expectedVersion:before.version}])await assert.rejects(recoverDelivery(f.store,key,options,f.now()),/acceptance_uncertain/);
      assert.equal((await f.store.get(key))!.version,before.version);
    });
  }
}
test('legacy attempted deliveries remain uncertain even when their last error was a safe rejection',async()=>{
  const f=fixture();await f.send();const key=(await f.store.due(f.now(),10))[0]!;
  const row=(await f.store.get<Delivery>(key))!;
  await f.store.commit([{...key,expected:row.version,retentionExpiresAt:row.retentionExpiresAt,value:{...row.value,status:'dead',attempts:2,attemptedAt:f.now(),lastError:'http_401'}}]);
  await assert.rejects(recoverDelivery(f.store,key,{},f.now()),/acceptance_uncertain/);
});
test('a new safe rejection cannot establish evidence for legacy prior or recovered attempts',async()=>{
  for(const previous of [{attempts:1},{attempts:0,recoveredAttempts:1}]) {
    const f=fixture();await f.send();const key=(await f.store.due(f.now(),10))[0]!;
    const row=(await f.store.get<Delivery>(key))!;
    await f.store.commit([{...key,expected:row.version,dueAt:f.now(),retentionExpiresAt:row.retentionExpiresAt,value:{...row.value,...previous}}]);
    await new Worker(f.store,workerConfig,async()=>({status:401,body:''}),f.now).deliver(key);
    assert.equal((await f.store.get<Delivery>(key))!.value.acceptanceUncertain,true);
    await assert.rejects(recoverDelivery(f.store,key,{},f.now()),/acceptance_uncertain/);
  }
});
for(const phase of ['initial','pre_post'] as const) {
  test(`expiry at ${phase} does not signal dead delivery, including SQS redelivery`,async()=>{
    const f=fixture();await f.send();const key=(await f.store.due(f.now(),10))[0]!;
    f.advance(HISTORY_RETENTION_MS-(phase==='pre_post'?1:0));
    const commit=f.store.commit.bind(f.store);
    if(phase==='pre_post')f.store.commit=async writes=>{await commit(writes);if(writes.some(w=>(w.value as Delivery)?.attempts===1))f.advance(1);};
    let posts=0;
    const worker=new Worker(f.store,workerConfig,async()=>{posts++;return {status:200,body:''};},f.now);
    const signals:ReturnType<typeof deliveryMetric>[]=[];
    const handler=createDeliveryHandler(f.store,worker,'sample',value=>{signals.push(value);});
    const event={Records:[{messageId:'synthetic',body:JSON.stringify(key)}]};
    await handler(event);await handler(event);
    assert.equal(signals[0]!.Outcome,'expired');assert.equal(posts,0);
    assert.ok(signals.every(signal=>signal.DeadDelivery===0));
    assert.equal((await f.store.get<Delivery>(key))!.value.lastError,'message_expired');
    assert.equal(deliveryMetric('dead',(await f.store.get<Delivery>(key))!.value).DeadDelivery,0);
  });
}
test('accepted delivery exhausted as dead is recovered through inbox claim, not outbox replay, and late completion remains visible',async()=>{
  const f=fixture();await f.send();let posts=0;
  const worker=new Worker(f.store,workerConfig,async()=>{posts++;return {status:200,body:''};},f.now);
  const key=(await f.store.due(f.now(),10))[0]!;
  await worker.deliver(key);f.advance(1001);await worker.deliver(key);f.advance(1001);
  assert.equal(await worker.deliver(key),'dead');assert.equal(posts,2);
  assert.equal((await f.bridge.pending(beta)).messages[0]!.processing,'available');
  const c=await f.bridge.claim(beta,'conversation','request');
  await f.bridge.complete(beta,{id:'late_reply',conversationId:'conversation',recipient:'alpha',text:'Synthetic',replyTo:'request',fence:c.fence!});
  assert.equal((await f.bridge.pending(beta)).messages.length,0);
  const state=(await f.bridge.deliveries(beta)).deliveries[0]!;assert.equal(state.status,'dead');assert.equal(state.processing,'confirmed');
  const snapshot=await processingSnapshot(async(name,args)=>name==='bridge_list_pending'?f.bridge.pending(beta,args.limit as number,args.cursor as string|undefined):f.bridge.deliveries(beta,args.limit as number,args.cursor as string|undefined),{claimsExpected:true},f.now());
  assert.ok(snapshot.complete);if(!snapshot.complete)throw new Error('incomplete');
  assert.equal(snapshot.DeadDeliveries,0);assert.equal(snapshot.AcceptedUnconfirmed,0);
  assert.equal(await worker.deliver(key),'skipped');assert.equal(posts,2);
});
test('EMF signals dead independently of DLQ and never includes private metadata or untrusted errors',()=>{
  const delivery={kind:'event',attempts:2,lastError:'private-url-secret',message:{timestamp:new Date(0).toISOString(),id:'private-id'},acceptedAt:1} as Delivery;
  const signal=deliveryMetric('dead',delivery,1000);
  assert.equal(signal.DeadDelivery,1);assert.equal(signal.UnconfirmedAcceptance,1);
  assert.equal(signal.MessageAge,1000);assert.ok(!JSON.stringify(signal).includes('private'));
  assert.deepEqual(signal._aws.CloudWatchMetrics[0]!.Dimensions,[['FunctionName'],['FunctionName','Kind','Outcome']]);
});
test('bounded concurrency retains input order and never leaves in-flight failures unobserved',async()=>{
  let active=0,max=0;
  const results=await mapBounded([0,1,2,3,4,5,6],2,async n=>{active++;max=Math.max(active,max);await Promise.resolve();active--;return n*2;});
  assert.equal(max,2);assert.deepEqual(results,[0,2,4,6,8,10,12]);assert.equal(active,0);
  await assert.rejects(mapBounded([1,2],0,async n=>n),/invalid_concurrency/);
});
test('SQS acknowledges a durable dead outcome but emits its independent alarm signal, including retry after a lost log',async()=>{
  const f=fixture();await f.send();const key=(await f.store.due(f.now(),10))[0]!;
  const worker=new Worker(f.store,workerConfig,async()=>({status:401,body:''}),f.now);
  const signals:ReturnType<typeof deliveryMetric>[]=[];
  const handler=createDeliveryHandler(f.store,worker,'sample',value=>{signals.push(value);});
  const event={Records:[{messageId:'sqs_synthetic',body:JSON.stringify(key)}]};
  assert.deepEqual(await handler(event),{batchItemFailures:[]});assert.equal(signals[0]!.DeadDelivery,1);
  assert.deepEqual(await handler(event),{batchItemFailures:[]});assert.equal(signals[1]!.DeadDelivery,1);
  assert.equal((await f.store.get<Delivery>(key))!.value.attempts,1);
  const invalid=await handler({Records:[{messageId:'bad',body:JSON.stringify({pk:'foreign#outbox#beta',sk:key.sk})}]});
  assert.deepEqual(invalid,{batchItemFailures:[{itemIdentifier:'bad'}]});
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { Bridge } from '../src/bridge.js';
import { MemoryStore } from '../src/memory-store.js';
import { Worker } from '../src/worker.js';
import { claimSortKey, HISTORY_RETENTION_MS, retentionTTL } from '../src/retention.js';
import { tenantKey, type Principal, type Delivery, type Message } from '../src/types.js';
import type { Key, Row } from '../src/store.js';
const a:Principal={id:'a',tenant:'sample',peers:['b'],scopes:['messages:send','messages:read','messages:claim']};
const b:Principal={...a,id:'b',peers:['a']};
const input=(id='m')=>({id,conversationId:'c',recipient:'b',text:'private text'});
function fixture(store=new MemoryStore()) {
  let now=Date.UTC(2026,0,1);
  const bridge=new Bridge(store,{maxTurns:20,messagesPerMinute:1000,claimMs:1000,webhookRecipients:['sample:b']},()=>now,true);
  return {store,bridge,now:()=>now,advance:(ms:number)=>{now+=ms;}};
}
const historyPk=tenantKey('sample','history','c');
async function erase(store:MemoryStore,key:Key) {const row=await store.get(key);if(row)await store.commit([{...key,expected:row.version}]);}
const workerConfig={routes:{'sample:b':{url:'https://example.test/wake',bearer:'synthetic'}},leaseMs:1000,retryMs:1000,maxAttempts:8,responseWaitMs:1000};

test('explicit old maxTurns20 permits 1001 messages; per-minute throttling remains',async()=>{
  const f=fixture();
  for(let i=0;i<1001;i++){if(i===1000)f.advance(60000);assert.equal((await f.bridge.send(a,input(`m${i}`))).message.turn,i+1);}
  const limited=new Bridge(new MemoryStore(),{maxTurns:20,messagesPerMinute:1,claimMs:1000,webhookRecipients:[]},f.now);
  await limited.send(a,input());await assert.rejects(limited.send(a,input('next')),/rate_limit/);
});

test('both text copies and all message auxiliaries get fixed original deadlines, meta does not',async()=>{
  const f=fixture();const {message}=await f.bridge.send(a,input());
  f.advance(100);await f.bridge.claim(b,'c','m');
  for(const [kind,subject] of [['history','c'],['dedup','a'],['claims','c'],['outbox','b']]) {
    const rows=(await f.store.query(tenantKey('sample',kind!,subject!),'',100)).items;
    assert.ok(rows.length);for(const row of rows)assert.equal(row.retentionExpiresAt,retentionTTL(message));
  }
  assert.equal((await f.store.get({pk:tenantKey('sample','meta','c'),sk:'meta'}))!.retentionExpiresAt,undefined);
  f.advance(HISTORY_RETENTION_MS-101);
  assert.equal((await f.bridge.getMessage(a,'c','m')).text,'private text');
  f.advance(1);
  assert.deepEqual((await f.bridge.history(a,'c')).messages,[]);
  await assert.rejects(f.bridge.getMessage(a,'c','m'),/message_not_found/);
  await assert.rejects(f.bridge.claim(b,'c','m'),/message_not_found/);
  await assert.rejects(f.bridge.send(a,input()),/message_expired/);
  assert.equal((await f.store.get<Message>({pk:historyPk,sk:'id#m'}))!.value.text,'private text','logical expiry does not claim physical deletion');
});

test('expired empty pages retain a usable scoped cursor leading to recent history',async()=>{
  const f=fixture();await f.bridge.send(a,input('old1'));await f.bridge.send(a,input('old2'));
  f.advance(HISTORY_RETENTION_MS);await f.bridge.send(a,input('new'));
  const first=await f.bridge.history(a,'c',1);assert.deepEqual(first.messages,[]);assert.ok(first.cursor);
  const second=await f.bridge.history(a,'c',1,first.cursor);assert.deepEqual(second.messages,[]);assert.ok(second.cursor);
  const third=await f.bridge.history(a,'c',1,second.cursor);assert.equal(third.messages[0]!.id,'new');assert.equal(third.cursor,undefined);
});

for(const missing of ['dedup','id'] as const)test(`TTL out of order: ${missing} missing is terminal, never busy/503/republication`,async()=>{
  const f=fixture();await f.bridge.send(a,input());f.advance(HISTORY_RETENTION_MS);
  await erase(f.store,missing==='dedup'?{pk:tenantKey('sample','dedup','a'),sk:'m'}:{pk:historyPk,sk:'id#m'});
  await assert.rejects(f.bridge.send(a,input()),/message_expired/);
});

test('ID reuse after TTL cannot inherit old claims, fences or outbox, and preserves sequence/ACL',async()=>{
  const f=fixture();const old=(await f.bridge.send(a,input())).message;const claimed=await f.bridge.claim(b,'c','m');
  f.advance(HISTORY_RETENTION_MS);
  await erase(f.store,{pk:tenantKey('sample','dedup','a'),sk:'m'});await erase(f.store,{pk:historyPk,sk:'id#m'});
  const current=(await f.bridge.send(a,input())).message;assert.equal(current.turn,2);assert.notEqual(current.generation,old.generation);
  const next=await f.bridge.claim(b,'c','m');assert.ok(next.fence!>claimed.fence!);
  await assert.rejects(f.bridge.complete(b,{...input('reply'),recipient:'a',replyTo:'m',fence:claimed.fence!}),/stale_claim/);
  assert.equal((await f.store.query(tenantKey('sample','outbox','b'),'',100)).items.length,2);
  assert.ok(await f.store.get({pk:tenantKey('sample','claims','c'),sk:claimSortKey(old)}));
  await assert.rejects(f.bridge.send({...a,id:'intruder',peers:['b']},input('bad')),/conversation_forbidden/);
});

test('legacy message copies without TTL are logically expired, kept physically and bootstrap old fences',async()=>{
  const f=fixture();const msg:Message={id:'legacy',conversationId:'c',sender:'a',recipient:'b',correlationId:'legacy',text:'legacy secret',timestamp:new Date(f.now()).toISOString(),turn:1};
  await f.store.commit([
    {pk:tenantKey('sample','meta','c'),sk:'meta',expected:null,value:{participants:['a','b'],count:1,correlationId:'legacy'}},
    {pk:historyPk,sk:'message#0000000001#legacy',expected:null,value:msg},{pk:historyPk,sk:'id#legacy',expected:null,value:msg},
    {pk:tenantKey('sample','claims','c'),sk:'claim#legacy',expected:null,value:{owner:'b',fence:77,leaseUntil:0,status:'running'}},
  ]);
  const claim=await f.bridge.claim(b,'c','legacy');assert.equal(claim.fence,78);
  assert.equal((await f.store.get({pk:tenantKey('sample','claims','c'),sk:'claim#legacy'}))!.retentionExpiresAt,retentionTTL(msg));
  f.advance(HISTORY_RETENTION_MS);assert.deepEqual((await f.bridge.history(a,'c')).messages,[]);
  assert.ok(await f.store.get({pk:historyPk,sk:'id#legacy'}));
});

test('claim catches retention crossing during a delayed read and caps busy lease at deadline',async()=>{
  class Delayed extends MemoryStore {after?:()=>void;override async get<T=Record<string,unknown>>(key:Key):Promise<Row<T>|undefined>{const row=await super.get<T>(key);if(key.sk.startsWith('claim#')&&this.after){const fn=this.after;this.after=undefined;fn();}return row;}}
  const store=new Delayed();const f=fixture(store);await f.bridge.send(a,input());f.advance(HISTORY_RETENTION_MS-500);
  const claim=await f.bridge.claim(b,'c','m');assert.equal(claim.leaseUntil,f.now()+500);
  store.after=()=>f.advance(500);await assert.rejects(f.bridge.claim(b,'c','m'),/message_not_found/);
});

test('expired outbox releases due slots and never POSTs, even if claim is pending',async()=>{
  const f=fixture();for(let i=0;i<101;i++)await f.bridge.send(a,input(`old${i}`));f.advance(HISTORY_RETENTION_MS);
  await f.bridge.send(a,input('live'));let posts=0;
  const worker=new Worker(f.store,workerConfig,async()=>{posts++;return {status:200,body:''};},f.now);
  assert.ok((await worker.drain(100)).every(x=>x==='expired'));assert.equal(posts,0);
  const next=await worker.drain(100);assert.ok(next.includes('pending'),JSON.stringify(next));assert.equal(posts,1);
  const outbox=(await f.store.query<Delivery>(tenantKey('sample','outbox','b'),'',100)).items;
  assert.ok(outbox.filter(row=>row.value.status==='dead').every(row=>row.dueAt===undefined));
});

test('worker rechecks deadline immediately before POST after delayed claim read',async()=>{
  class Delayed extends MemoryStore {after?:()=>void;override async get<T=Record<string,unknown>>(key:Key):Promise<Row<T>|undefined>{const row=await super.get<T>(key);if(key.sk.startsWith('claim#')&&this.after){const fn=this.after;this.after=undefined;fn();}return row;}}
  const store=new Delayed();const f=fixture(store);await f.bridge.send(a,input());f.advance(HISTORY_RETENTION_MS-1);
  store.after=()=>f.advance(1);let posts=0;const worker=new Worker(store,workerConfig,async()=>{posts++;return {status:200,body:''};},f.now);
  const row=(await store.query<Delivery>(tenantKey('sample','outbox','b'),'',100)).items[0]!;
  assert.equal(await worker.deliver(row),'expired');assert.equal(posts,0);assert.equal((await store.get(row))!.dueAt,undefined);
});

test('complete and ACK fail closed when the parent expires during delayed reads',async()=>{
  class Delayed extends MemoryStore {after?:()=>void;override async get<T=Record<string,unknown>>(key:Key):Promise<Row<T>|undefined>{const row=await super.get<T>(key);if(key.sk.startsWith('claim#')&&this.after){const fn=this.after;this.after=undefined;fn();}return row;}}
  for(const operation of ['complete','ack'] as const) {
    const store=new Delayed();const f=fixture(store);await f.bridge.send(a,input());
    const first=await f.bridge.claim(b,'c','m');
    await f.bridge.complete(b,{id:'reply',conversationId:'c',recipient:'a',text:'answer',replyTo:'m',fence:first.fence!});
    f.advance(HISTORY_RETENTION_MS-1);const c=await f.bridge.claim(a,'c','reply');
    store.after=()=>f.advance(1);
    if(operation==='ack')await assert.rejects(f.bridge.acknowledge(a,{conversationId:'c',messageId:'reply',fence:c.fence!}),/message_not_found/);
    else await assert.rejects(f.bridge.complete(a,{id:'last',conversationId:'c',recipient:'b',text:'new',replyTo:'reply',fence:c.fence!}),/stale_claim/);
    assert.equal((await store.get({pk:tenantKey('sample','claims','c'),sk:claimSortKey(c.message!)}))!.value.status,'running');
  }
});

test('worker preserves legacy no-TTL and approved grace without renewing either on retry',async()=>{
  for(const grace of [undefined,Date.UTC(2026,1,1)/1000]) {
    const f=fixture();await f.bridge.send(a,input());const queued=(await f.store.query<Delivery>(tenantKey('sample','outbox','b'),'',100)).items[0]!;
    await f.store.commit([{pk:queued.pk,sk:queued.sk,expected:queued.version,retentionExpiresAt:grace,dueAt:queued.dueAt,value:queued.value}]);
    const worker=new Worker(f.store,workerConfig,async()=>({status:503,body:''}),f.now);
    await worker.deliver(queued);assert.equal((await f.store.get(queued))!.retentionExpiresAt,grace);
    f.advance(HISTORY_RETENTION_MS);await worker.deliver(queued);
    const expired=(await f.store.get<Delivery>(queued))!;assert.equal(expired.retentionExpiresAt,grace);assert.equal(expired.dueAt,undefined);assert.equal(expired.value.status,'dead');
  }
});

test('history ordering crosses the old ten-digit key width without resetting turns',async()=>{
  const f=fixture();const {message}=await f.bridge.send(a,input('first'));
  const meta=(await f.store.get({pk:tenantKey('sample','meta','c'),sk:'meta'}))!;
  await f.store.commit([{pk:meta.pk,sk:meta.sk,expected:meta.version,value:{...meta.value,count:9_999_999_998}}]);
  const last=(await f.bridge.send(a,input('last10'))).message;const next=(await f.bridge.send(a,input('first11'))).message;
  assert.equal(last.turn,9_999_999_999);assert.equal(next.turn,10_000_000_000);
  assert.deepEqual((await f.bridge.history(a,'c')).messages.map(m=>m.id),[message.id,last.id,next.id]);
});

test('rate TTL uses minute-window end plus14days without changing the minute quota or legacy expiresAt',async()=>{
  const f=fixture();await f.bridge.send(a,input());
  const row=(await f.store.get<{count:number;expiresAt:number}>({pk:tenantKey('sample','rate','a'),sk:String(Math.floor(f.now()/60000))}))!;
  assert.equal(row.retentionExpiresAt,(Math.floor(f.now()/60000)*60000+60000+HISTORY_RETENTION_MS)/1000);
  assert.equal(row.value.expiresAt,Math.floor(f.now()/1000)+86400);assert.equal(row.value.count,1);
});


test('new claim on legacy parent always has original TTL; complete and ACK preserve it',async()=>{
  const f=fixture();
  const legacy=new Bridge(f.store,{messagesPerMinute:100,claimMs:1000,webhookRecipients:[]},f.now,false);
  const first=(await legacy.send(a,input('legacy_new_claim'))).message;
  assert.equal(first.generation,undefined);
  const c=await f.bridge.claim(b,'c',first.id);
  const key={pk:tenantKey('sample','claims','c'),sk:claimSortKey(first)};
  assert.equal((await f.store.get(key))!.retentionExpiresAt,retentionTTL(first));
  const reply=(await legacy.complete(b,{id:'legacy_reply',conversationId:'c',recipient:'a',text:'reply',replyTo:first.id,fence:c.fence!})).message;
  assert.equal((await f.store.get(key))!.retentionExpiresAt,retentionTTL(first));
  const r=await f.bridge.claim(a,'c',reply.id);
  const replyKey={pk:tenantKey('sample','claims','c'),sk:claimSortKey(reply)};
  const row=(await f.store.get(replyKey))!;
  const grace=retentionTTL(reply)+100;
  await f.store.commit([{pk:row.pk,sk:row.sk,expected:row.version,value:row.value,retentionExpiresAt:grace}]);
  await f.bridge.acknowledge(a,{conversationId:'c',messageId:reply.id,fence:r.fence!});
  assert.equal((await f.store.get(replyKey))!.retentionExpiresAt,grace);
});

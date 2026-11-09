import test from 'node:test';
import assert from 'node:assert/strict';
import { Bridge } from '../src/bridge.js';
import { Bridge as OldBridge } from './fixtures/pre-retention-bridge.js';
import { Worker as OldWorker } from './fixtures/pre-retention-worker.js';
import { MemoryStore } from '../src/memory-store.js';
import { tenantKey, type Principal, type Delivery } from '../src/types.js';
import { claimSortKey } from '../src/retention.js';
const a:Principal={id:'a',tenant:'sample',peers:['b'],scopes:['messages:send','messages:read','messages:claim']};
const b:Principal={...a,id:'b',peers:['a']};
const config={maxTurns:20,messagesPerMinute:1000,claimMs:1000,webhookRecipients:['sample:b']};
const start=Date.UTC(2026,0,1);const now=()=>start;
const input=(id:string)=>({id,conversationId:'c',recipient:'b',text:'synthetic'});
function fixture(){const store=new MemoryStore();return {store,old:new OldBridge(store,config,now),phaseA:new Bridge(store,config,now,false),phaseB:new Bridge(store,config,now,true)};}

for(const writer of ['old','phaseA'] as const)test(`old/A rollout: ${writer} publication has one claim winner and one response under mixed concurrency`,async()=>{
  const f=fixture();const result=await f[writer].send(a,input('m'));assert.equal(result.message.generation,undefined);
  const claims=await Promise.all(Array.from({length:8},(_,i)=>(i%2?f.old:f.phaseA).claim(b,'c','m')));
  const winners=claims.filter(c=>c.status==='claimed');assert.equal(winners.length,1);
  const responses=await Promise.allSettled([f.old,f.phaseA].map((bridge,i)=>bridge.complete(b,{id:`r${i}`,conversationId:'c',recipient:'a',text:'reply',replyTo:'m',fence:winners[0]!.fence!})));
  assert.equal(responses.filter(r=>r.status==='fulfilled').length,1);
  assert.equal((await f.phaseA.history(a,'c')).messages.length,2);
});

for(const writer of ['phaseA','phaseB'] as const)test(`A/B rollout: ${writer} publication has one claim winner and response while both versions serve`,async()=>{
  const f=fixture();const result=await f[writer].send(a,input('m'));assert.equal(!!result.message.generation,writer==='phaseB');
  const claims=await Promise.all(Array.from({length:8},(_,i)=>(i%2?f.phaseA:f.phaseB).claim(b,'c','m')));
  const winners=claims.filter(c=>c.status==='claimed');assert.equal(winners.length,1);
  const responses=await Promise.allSettled([f.phaseA,f.phaseB].map((bridge,i)=>bridge.complete(b,{id:`r${i}`,conversationId:'c',recipient:'a',text:'reply',replyTo:'m',fence:winners[0]!.fence!})));
  assert.equal(responses.filter(r=>r.status==='fulfilled').length,1);
  assert.equal((await f.phaseB.history(a,'c')).messages.length,2);
});

test('old writers may erase new TTL/highwater during phase A, so backfill waits for convergence',async()=>{
  const f=fixture();await f.phaseA.send(a,input('m'));await f.phaseA.claim(b,'c','m');
  const metaKey={pk:tenantKey('sample','meta','c'),sk:'meta'};
  assert.equal((await f.store.get(metaKey))!.value.claimFence,1);
  await f.old.send(a,input('old'));
  assert.equal((await f.store.get(metaKey))!.value.claimFence,undefined);
  const claim=await f.phaseA.claim(b,'c','old');assert.equal(claim.fence,2,'New reader bootstraps while all legacy rows remain intact');
  const queued=(await f.store.query<Delivery>(tenantKey('sample','outbox','b'),'',100)).items.find(r=>r.value.message.id==='m')!;
  assert.ok(queued.retentionExpiresAt);
  const worker=new OldWorker(f.store,{routes:{'sample:b':{url:'https://example.test/wake',bearer:'synthetic'}},leaseMs:1000,retryMs:1000,maxAttempts:8,responseWaitMs:1000},async()=>({status:200,body:''}),now);
  await worker.deliver({pk:queued.pk,sk:queued.sk});
  assert.equal((await f.store.get(queued))!.retentionExpiresAt,undefined,'TTL activation before old invocations drain would be unsafe');
  assert.equal(claimSortKey((await f.phaseA.getMessage(a,'c','m'))),'claim#m');
});

test('phase A retains legacy event IDs for identical publication races with old writers',async()=>{
  const f=fixture();const results=await Promise.all([f.old.send(a,input('m')),f.phaseA.send(a,input('m'))]);
  assert.equal(results.filter(r=>!r.duplicate).length,1);
  const queued=(await f.store.query<Delivery>(tenantKey('sample','outbox','b'),'',100)).items;
  assert.equal(queued.length,1);
  const second=fixture();await second.phaseA.send(a,input('m'));
  assert.equal((await second.store.query<Delivery>(tenantKey('sample','outbox','b'),'',100)).items[0]!.value.id,queued[0]!.value.id);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { Bridge, type BridgeConfig } from '../src/bridge.js';
import { MemoryStore } from '../src/memory-store.js';
import type { Key, Page, Row, Write } from '../src/store.js';
import { BridgeError, tenantKey, type Delivery, type Principal } from '../src/types.js';

const alpha: Principal = { id: 'alpha', tenant: 'team_a', scopes: ['messages:send', 'messages:read', 'messages:claim', 'events:subscribe'], peers: ['beta'] };
const beta: Principal = { ...alpha, id: 'beta', peers: ['alpha'] };
const config: BridgeConfig = { maxTurns: 30, messagesPerMinute: 30, claimMs: 1000, webhookRecipients: ['team_a:beta'] };
function fixture(overrides: Partial<BridgeConfig> = {}, store = new MemoryStore()) {
  let now = Date.UTC(2026, 0, 1);
  return { store, bridge: new Bridge(store, { ...config, ...overrides }, () => now), now: () => now, advance: (ms: number) => { now += ms; } };
}
function input(id = 'message_1', text = 'Synthetic request') { return { id, text, conversationId: 'conversation_a', recipient: 'beta' }; }
function error(code: string) { return (value: unknown) => value instanceof BridgeError && value.code === code; }
const outbox = (store: MemoryStore) => store.query<Delivery>(tenantKey('team_a', 'outbox', 'beta'), '', 100);

class FaultStore extends MemoryStore {
  failNextCommit = false;
  override async commit(writes: Write[]): Promise<void> {
    if (this.failNextCommit) { this.failNextCommit = false; throw new Error('Synthetic storage outage'); }
    return super.commit(writes);
  }
}

async function terminalFixture(store = new MemoryStore(), overrides: Partial<BridgeConfig> = {}) {
  const f=fixture({webhookRecipients:['team_a:alpha','team_a:beta'],...overrides},store);
  await f.bridge.send(alpha,input());
  const requestClaim=await f.bridge.claim(beta,'conversation_a','message_1');
  assert.equal(requestClaim.status,'claimed');
  await f.bridge.complete(beta,{id:'reply_1',conversationId:'conversation_a',recipient:'alpha',text:'Synthetic terminal response',replyTo:'message_1',fence:requestClaim.fence!});
  const replyClaim=await f.bridge.claim(alpha,'conversation_a','reply_1');
  assert.equal(replyClaim.status,'claimed');
  return {...f,ack:{conversationId:'conversation_a',messageId:'reply_1',fence:replyClaim.fence!},claimKey:{pk:tenantKey(alpha.tenant,'claims','conversation_a'),sk:'claim#reply_1'}};
}

test('same id and payload is deduplicated under concurrency; changed payload is a conflict', async () => {
  const { bridge, store } = fixture();
  const results = await Promise.all(Array.from({ length: 10 }, () => bridge.send(alpha, input())));
  assert.equal(results.filter(result => !result.duplicate).length, 1);
  assert.deepEqual(results.map(result => result.message), Array(10).fill(results[0]!.message));
  assert.equal((await bridge.history(alpha, 'conversation_a')).messages.length, 1);
  assert.equal((await outbox(store)).items.length, 1);
  await assert.rejects(bridge.send(alpha, input('message_1', 'Changed payload')), error('idempotency_conflict'));
  await assert.rejects(bridge.send(alpha, { ...input(), conversationId: 'conversation_b' }), error('idempotency_conflict'));
});

test('concurrent distinct messages atomically allocate turns and persist every outbox row', async () => {
  const { bridge, store, now } = fixture();
  const results = await Promise.all(Array.from({ length: 8 }, (_, index) => bridge.send(alpha, input(`message_${index}`))));
  assert.deepEqual(results.map(result => result.message.turn).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8]);
  const history = (await bridge.history(beta, 'conversation_a')).messages;
  assert.deepEqual(history.map(message => message.turn), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(new Set(history.map(message => message.correlationId)).size, 1);
  const rows = (await outbox(store)).items;
  assert.equal(rows.length, 8);
  assert.deepEqual(new Set(rows.map(row => row.value.message.id)), new Set(history.map(message => message.id)));
  assert.ok(rows.every(row => row.dueAt === now() && row.value.status === 'pending'));
  const counter = await store.get<{ count: number }>({ pk: tenantKey(alpha.tenant, 'rate', alpha.id), sk: String(Math.floor(now() / 60000)) });
  assert.equal(counter?.value.count, 8);
});

test('failed initial transaction publishes neither history nor outbox and is safely retryable', async () => {
  const store = new FaultStore(); const { bridge } = fixture({}, store);
  store.failNextCommit = true;
  await assert.rejects(bridge.send(alpha, input()), /Synthetic storage outage/);
  assert.equal((await outbox(store)).items.length, 0);
  await assert.rejects(bridge.history(alpha, 'conversation_a'), error('conversation_not_found'));
  const result = await bridge.send(alpha, input());
  assert.equal(result.duplicate, false);
  assert.equal(result.message.turn, 1);
});

test('rate limits hold under concurrency and retries do not consume another allowance', async () => {
  const { bridge, advance } = fixture({ messagesPerMinute: 3 });
  const attempts = await Promise.allSettled(Array.from({ length: 7 }, (_, index) => bridge.send(alpha, input(`rate_${index}`))));
  const accepted = attempts.filter(result => result.status === 'fulfilled');
  assert.equal(accepted.length, 3);
  assert.ok(attempts.filter(result => result.status === 'rejected').every(result => error('rate_limit')(result.reason)));
  const first = accepted[0]; assert.ok(first?.status === 'fulfilled');
  const replay = await bridge.send(alpha, input(first.value.message.id));
  assert.equal(replay.duplicate, true);
  advance(60000);
  assert.equal((await bridge.send(alpha, input('next_window'))).duplicate, false);
});

test('turn limit persists across rate windows and rejects further conversation messages', async () => {
  const { bridge, advance } = fixture({ maxTurns: 2 });
  await bridge.send(alpha, input('first'));
  await bridge.send(alpha, input('second'));
  advance(60000);
  await assert.rejects(bridge.send(alpha, input('third')), error('turn_limit'));
  assert.equal((await bridge.history(alpha, 'conversation_a')).messages.length, 2);
});

test('identity, peer, scope and tenant boundaries prevent impersonation and history leaks', async () => {
  const { bridge } = fixture();
  await bridge.send(alpha, input());
  const stranger: Principal = { ...alpha, id: 'gamma', peers: ['alpha', 'beta'] };
  await assert.rejects(bridge.history(stranger, 'conversation_a'), error('conversation_not_found'));
  await assert.rejects(bridge.send(stranger, input('intrusion')), error('conversation_forbidden'));
  await assert.rejects(bridge.history({ ...alpha, tenant: 'team_b' }, 'conversation_a'), error('conversation_not_found'));
  await assert.rejects(bridge.send({ ...alpha, peers: [] }, input('no_peer')), error('recipient_forbidden'));
  await assert.rejects(bridge.send({ ...alpha, scopes: ['messages:read'] }, input('no_scope')), error('forbidden'));
  await assert.rejects(bridge.history({ ...alpha, scopes: ['messages:send'] }, 'conversation_a'), error('forbidden'));
  await assert.rejects(bridge.claim(alpha, 'conversation_a', 'message_1'), error('claim_forbidden'));
  const otherTeam = await bridge.send({ ...alpha, tenant: 'team_b' }, input());
  assert.equal(otherTeam.duplicate, false);
  assert.equal(otherTeam.message.turn, 1);
});

test('history pagination is ordered, bounded and rejects a cursor reused for another conversation', async () => {
  const { bridge } = fixture();
  for (let index = 0; index < 5; index++) await bridge.send(alpha, input(`page_${index}`));
  const first = await bridge.history(beta, 'conversation_a', 2);
  assert.deepEqual(first.messages.map(message => message.turn), [1, 2]);
  assert.ok(first.cursor);
  const second = await bridge.history(beta, 'conversation_a', 2, first.cursor);
  assert.deepEqual(second.messages.map(message => message.turn), [3, 4]);
  const third = await bridge.history(beta, 'conversation_a', 2, second.cursor);
  assert.deepEqual(third.messages.map(message => message.turn), [5]);
  assert.equal(third.cursor, undefined);
  await bridge.send(alpha, { ...input('other_conversation'), conversationId: 'conversation_b' });
  await assert.rejects(bridge.history(alpha, 'conversation_b', 2, first.cursor));
  await assert.rejects(bridge.history(alpha, 'conversation_a', 1000));
});

test('only one concurrent claimant wins; an expired lease increments the fence', async () => {
  const { bridge, advance } = fixture();
  await bridge.send(alpha, input());
  const claims = await Promise.all(Array.from({ length: 8 }, () => bridge.claim(beta, 'conversation_a', 'message_1')));
  assert.equal(claims.filter(claim => claim.status === 'claimed').length, 1);
  assert.equal(claims.filter(claim => claim.status === 'busy').length, 7);
  const winner = claims.find(claim => claim.status === 'claimed'); assert.ok(winner?.status === 'claimed');
  advance(1000);
  const replacement = await bridge.claim(beta, 'conversation_a', 'message_1'); assert.equal(replacement.status, 'claimed');
  assert.equal(replacement.fence, winner.fence + 1);
  await assert.rejects(bridge.complete(beta, { id: 'stale_reply', conversationId: 'conversation_a', recipient: 'alpha', text: 'Stale output', replyTo: 'message_1', fence: winner.fence }), error('stale_claim'));
  const result = await bridge.complete(beta, { id: 'fresh_reply', conversationId: 'conversation_a', recipient: 'alpha', text: 'Current output', replyTo: 'message_1', fence: replacement.fence! });
  assert.equal(result.message.replyTo, 'message_1');
  assert.equal(result.message.correlationId, 'message_1');
});

test('completion atomically stores response and closes claim; its replay remains idempotent', async () => {
  const store = new FaultStore(); const { bridge, advance } = fixture({}, store);
  await bridge.send(alpha, input());
  const claim = await bridge.claim(beta, 'conversation_a', 'message_1'); assert.equal(claim.status, 'claimed');
  const response = { id: 'reply_1', conversationId: 'conversation_a', recipient: 'alpha', text: 'Synthetic response', replyTo: 'message_1', fence: claim.fence! };
  store.failNextCommit = true;
  await assert.rejects(bridge.complete(beta, response), /Synthetic storage outage/);
  assert.equal((await bridge.history(alpha, 'conversation_a')).messages.length, 1);
  assert.equal((await bridge.claim(beta, 'conversation_a', 'message_1')).status, 'busy');
  assert.equal((await bridge.complete(beta, response)).duplicate, false);
  assert.deepEqual(await bridge.claim(beta, 'conversation_a', 'message_1'), { status: 'done', responseId: 'reply_1' });
  advance(2000);
  const retry = await bridge.complete(beta, response);
  assert.equal(retry.duplicate, true);
  assert.equal((await bridge.history(alpha, 'conversation_a')).messages.length, 2);
  await assert.rejects(bridge.complete(beta, { ...response, text: 'Different response' }), error('idempotency_conflict'));
  await assert.rejects(bridge.complete(beta, { ...response, id: 'second_response' }), error('stale_claim'));
});

test('responses require completion and valid ownership, fence and live lease', async () => {
  const { bridge, advance } = fixture();
  await bridge.send(alpha, input());
  await assert.rejects(bridge.send(beta, { id: 'reply', conversationId: 'conversation_a', recipient: 'alpha', text: 'Unreserved reply', replyTo: 'message_1' }), error('responses_require_claim_and_complete'));
  const response = { id: 'reply', conversationId: 'conversation_a', recipient: 'alpha', text: 'Response', replyTo: 'message_1', fence: 1 };
  await assert.rejects(bridge.complete(beta, response), error('stale_claim'));
  await assert.rejects(bridge.complete(beta, { ...response, fence: 0 }), error('invalid_fence'));
  await bridge.claim(beta, 'conversation_a', 'message_1');
  advance(1000);
  await assert.rejects(bridge.complete(beta, response), error('stale_claim'));
  assert.equal((await bridge.history(alpha, 'conversation_a')).messages.length, 1);
});

test('expired reservation cannot publish after a delayed subscription read', async () => {
  let delay: (() => void) | undefined;
  class DelayedStore extends MemoryStore {
    private checkpoint(pk: string) { if (pk.includes('#subscriptions#') && delay) { const action = delay; delay = undefined; action(); } }
    override async get<T = Record<string, unknown>>(key: Key): Promise<Row<T> | undefined> { this.checkpoint(key.pk); return super.get<T>(key); }
    override async query<T = Record<string, unknown>>(pk: string, prefix: string, limit: number, cursor?: string): Promise<Page<T>> { this.checkpoint(pk); return super.query<T>(pk, prefix, limit, cursor); }
  }
  const { bridge, advance } = fixture({}, new DelayedStore());
  await bridge.send(alpha, input());
  const claim = await bridge.claim(beta, 'conversation_a', 'message_1'); assert.equal(claim.status, 'claimed');
  delay = () => advance(1000);
  await assert.rejects(bridge.complete(beta, { id: 'delayed_reply', conversationId: 'conversation_a', recipient: 'alpha', text: 'Delayed response', replyTo: 'message_1', fence: claim.fence! }), error('stale_claim'));
  assert.equal((await bridge.history(alpha, 'conversation_a')).messages.length, 1);
});

test('ACK terminal conclui só a reserva e continua idempotente após o lease expirar',async()=>{
  const f=await terminalFixture(new MemoryStore(),{maxTurns:2,messagesPerMinute:1});
  const partitions=[['meta','conversation_a'],['history','conversation_a'],['rate','alpha'],['rate','beta'],['dedup','alpha'],['dedup','beta'],['outbox','alpha'],['outbox','beta']];
  const snapshot=()=>Promise.all(partitions.map(([kind,owner])=>f.store.query(tenantKey(alpha.tenant,kind!,owner!),'',100)));
  const before=await snapshot();
  const recipient={...alpha,scopes:['messages:read','messages:claim'],peers:[]};
  assert.deepEqual(await f.bridge.acknowledge(recipient,f.ack),{status:'done',outcome:'acknowledged',messageId:'reply_1',duplicate:false});
  assert.deepEqual(await snapshot(),before,'ACK não publica mensagem, consome turno/taxa ou altera outboxes');
  const row=await f.store.get(f.claimKey);
  assert.deepEqual(row?.value,{owner:'alpha',fence:f.ack.fence,leaseUntil:0,status:'done',outcome:'acknowledged'});
  assert.deepEqual(await f.bridge.claim(alpha,'conversation_a','reply_1'),{status:'done',outcome:'acknowledged'});
  f.advance(2000);
  assert.deepEqual(await f.bridge.acknowledge(recipient,f.ack),{status:'done',outcome:'acknowledged',messageId:'reply_1',duplicate:true});
  assert.deepEqual(await f.store.get(f.claimKey),row,'Retry não regrava a conclusão nem renova lease');
});

test('ACK terminal exige destinatário, leitura, claim e uma resposta persistida',async()=>{
  const f=await terminalFixture();
  const before=await f.store.get(f.claimKey);
  for(const [principal,args,code] of [
    [{...alpha,scopes:['messages:read']},f.ack,'forbidden'],
    [{...alpha,scopes:['messages:claim']},f.ack,'forbidden'],
    [{...alpha,tenant:'team_b'},f.ack,'conversation_not_found'],
    [{...alpha,id:'stranger'},f.ack,'conversation_not_found'],
    [beta,f.ack,'claim_forbidden'],
    [alpha,{...f.ack,messageId:'missing'},'message_not_found'],
    [alpha,{...f.ack,messageId:'invalid/id'},'invalid_id'],
    [alpha,{...f.ack,conversationId:'invalid/id'},'invalid_id'],
    [beta,{...f.ack,messageId:'message_1'},'acknowledgement_requires_reply'],
  ] as [Principal,typeof f.ack,string][]) await assert.rejects(f.bridge.acknowledge(principal,args),error(code));
  for(const fence of [0,-1,1.5,Number.NaN,Number.MAX_SAFE_INTEGER+1]) {
    await assert.rejects(f.bridge.acknowledge(alpha,{...f.ack,fence}),error('invalid_fence'));
  }
  assert.deepEqual(await f.store.get(f.claimKey),before);
});

test('ACK terminal rejeita ausência de reserva, owner incorreto, expiração e fence substituído',async()=>{
  const f=await terminalFixture();
  let row=await f.store.get(f.claimKey);assert.ok(row);
  await f.store.commit([{...f.claimKey,expected:row.version}]);
  await assert.rejects(f.bridge.acknowledge(alpha,f.ack),error('stale_claim'));
  await f.store.commit([{...f.claimKey,expected:null,value:{...row.value,owner:'beta'}}]);
  await assert.rejects(f.bridge.acknowledge(alpha,f.ack),error('stale_claim'));
  row=await f.store.get(f.claimKey);assert.ok(row);
  await f.store.commit([{...f.claimKey,expected:row.version,value:{...row.value,owner:'alpha'}}]);
  f.advance(1000);
  await assert.rejects(f.bridge.acknowledge(alpha,f.ack),error('stale_claim'));
  const replacement=await f.bridge.claim(alpha,'conversation_a','reply_1');assert.equal(replacement.status,'claimed');
  assert.equal(replacement.fence,f.ack.fence+1);
  await assert.rejects(f.bridge.acknowledge(alpha,f.ack),error('stale_claim'));
  await f.bridge.acknowledge(alpha,{...f.ack,fence:replacement.fence!});
  await assert.rejects(f.bridge.acknowledge(alpha,f.ack),error('stale_claim'));
});

test('ACK terminal verifica expiração após uma leitura atrasada da reserva',async()=>{
  class DelayedClaimStore extends MemoryStore {
    afterClaimRead?:()=>void;
    override async get<T=Record<string,unknown>>(key:Key):Promise<Row<T>|undefined> {
      const row=await super.get<T>(key);
      if(key.sk==='claim#reply_1'&&this.afterClaimRead){const action=this.afterClaimRead;this.afterClaimRead=undefined;action();}
      return row;
    }
  }
  const store=new DelayedClaimStore();const f=await terminalFixture(store);
  const before=await store.get(f.claimKey);
  store.afterClaimRead=()=>f.advance(1000);
  await assert.rejects(f.bridge.acknowledge(alpha,f.ack),error('stale_claim'));
  assert.deepEqual(await store.get(f.claimKey),before);
});

test('ACK terminal recupera falha anterior ao commit e resposta perdida após commit',async()=>{
  class AckFaultStore extends MemoryStore {
    fail?:'before'|'after';
    override async commit(writes:Write[]):Promise<void> {
      const mode=writes.some(write=>(write.value as {outcome?:string})?.outcome==='acknowledged')?this.fail:undefined;
      if(mode)this.fail=undefined;
      if(mode==='before')throw new Error('Synthetic failure before commit');
      await super.commit(writes);
      if(mode==='after')throw new Error('Synthetic lost response');
    }
  }
  const store=new AckFaultStore();const f=await terminalFixture(store);
  const before=await store.get(f.claimKey);
  store.fail='before';
  await assert.rejects(f.bridge.acknowledge(alpha,f.ack),/Synthetic failure before commit/);
  assert.deepEqual(await store.get(f.claimKey),before);
  store.fail='after';
  await assert.rejects(f.bridge.acknowledge(alpha,f.ack),/Synthetic lost response/);
  const done=await store.get(f.claimKey);
  f.advance(2000);
  assert.equal((await f.bridge.acknowledge(alpha,f.ack)).duplicate,true);
  assert.deepEqual(await store.get(f.claimKey),done);
  assert.equal((await f.bridge.history(alpha,'conversation_a')).messages.length,2);
});

test('ACKs concorrentes produzem uma única conclusão e complete não pode reabri-la',async()=>{
  const f=await terminalFixture();
  const results=await Promise.all(Array.from({length:8},()=>f.bridge.acknowledge(alpha,f.ack)));
  assert.equal(results.filter(result=>!result.duplicate).length,1);
  assert.equal(results.filter(result=>result.duplicate).length,7);
  await assert.rejects(f.bridge.complete(alpha,{id:'extra_reply',conversationId:'conversation_a',recipient:'beta',text:'Unexpected reply',replyTo:'reply_1',fence:f.ack.fence}),error('stale_claim'));
  assert.equal((await f.bridge.history(alpha,'conversation_a')).messages.length,2);
});

for(const winner of ['ack','response'] as const) {
  test(`CAS preserva uma única conclusão quando ${winner} vence a corrida ACK/complete`,async()=>{
    class CompletionRaceStore extends MemoryStore {
      beforeCommit?: (writes:Write[])=>Promise<void>;
      override async commit(writes:Write[]):Promise<void> {
        if(this.beforeCommit)await this.beforeCommit(writes);
        return super.commit(writes);
      }
    }
    const store=new CompletionRaceStore();const f=await terminalFixture(store);
    const response={id:'final_reply',conversationId:'conversation_a',recipient:'beta',text:'Final response',replyTo:'reply_1',fence:f.ack.fence};
    const acknowledge=()=>f.bridge.acknowledge(alpha,f.ack);
    const complete=()=>f.bridge.complete(alpha,response);
    store.beforeCommit=async writes=>{
      const target=writes.find(write=>write.sk==='claim#reply_1');
      const value=target?.value as {outcome?:string;responseId?:string}|undefined;
      if(winner==='ack'?value?.responseId==='final_reply':value?.outcome==='acknowledged') {
        store.beforeCommit=undefined;
        await (winner==='ack'?acknowledge():complete());
      }
    };
    await assert.rejects(winner==='ack'?complete():acknowledge(),error(winner==='ack'?'stale_claim':'already_completed_with_response'));
    assert.equal(store.beforeCommit,undefined,'A conclusão concorrente ocorreu dentro da janela CAS');
    if(winner==='ack') {
      assert.deepEqual(await f.bridge.claim(alpha,'conversation_a','reply_1'),{status:'done',outcome:'acknowledged'});
      assert.equal((await f.bridge.history(alpha,'conversation_a')).messages.length,2);
    } else {
      assert.deepEqual(await f.bridge.claim(alpha,'conversation_a','reply_1'),{status:'done',responseId:'final_reply'});
      assert.equal((await complete()).duplicate,true,'Retry legado de complete permanece idempotente');
      assert.equal((await f.bridge.history(alpha,'conversation_a')).messages.length,3);
    }
  });
}

test('message bodies stay in history partitions and human reads never reach claims or secrets',async()=>{
 class ObservedStore extends MemoryStore {
  reads:string[]=[];
  override async get<T=Record<string,unknown>>(key:Key):Promise<Row<T>|undefined>{this.reads.push(key.pk);return super.get<T>(key);}
  override async query<T=Record<string,unknown>>(pk:string,prefix:string,limit:number,cursor?:string):Promise<Page<T>>{this.reads.push(pk);return super.query<T>(pk,prefix,limit,cursor);}
 }
 const store=new ObservedStore();const {bridge,now}=fixture({},store);const text='MESSAGE_BODY_CONFIDENTIAL_FIXTURE';
 await bridge.send(alpha,input('private_body',text));await bridge.claim(beta,'conversation_a','private_body');
 const operational=await Promise.all([
  store.query(tenantKey(alpha.tenant,'meta','conversation_a'),'',100),
  store.query(tenantKey(alpha.tenant,'claims','conversation_a'),'',100),
  store.query(tenantKey(alpha.tenant,'dedup',alpha.id),'',100),outbox(store),store.due(now(),100),
 ]);
 assert.ok(!JSON.stringify(operational).includes(text));
 assert.equal((await store.query(tenantKey(alpha.tenant,'history','conversation_a'),'message#',100)).items.length,1);
 store.reads=[];
 const reader:Principal={id:'human',tenant:alpha.tenant,scopes:['history:read'],peers:[],readParticipants:[alpha.id]};
 assert.equal((await bridge.history(reader,'conversation_a')).messages[0]?.text,text);
 assert.deepEqual(store.reads,[tenantKey(alpha.tenant,'meta','conversation_a'),tenantKey(alpha.tenant,'history','conversation_a')]);
});

test('different senders cannot reuse a conversation message ID and receive a permanent conflict',async()=>{
 const {bridge}=fixture();await bridge.send(alpha,input('shared_id'));
 await assert.rejects(bridge.send(beta,{id:'shared_id',conversationId:'conversation_a',recipient:'alpha',text:'Different sender and body'}),error('message_id_conflict'));
 const retry=await bridge.send(alpha,input('shared_id'));assert.equal(retry.duplicate,true);
 assert.equal((await bridge.history(alpha,'conversation_a')).messages.length,1);
});

for (const changed of [false, true]) {
  test(`publication committed between dedup and history reads ${changed ? 'rejects changed input by fingerprint' : 'returns its idempotent result'}`, async () => {
    class ReadWindowStore extends MemoryStore {
      afterEmptyDedup?: () => Promise<void>;
      override async get<T = Record<string, unknown>>(key: Key): Promise<Row<T> | undefined> {
        const result = await super.get<T>(key);
        if (!result && key.pk === tenantKey(alpha.tenant, 'dedup', alpha.id) && this.afterEmptyDedup) {
          const action = this.afterEmptyDedup;
          this.afterEmptyDedup = undefined;
          await action();
        }
        return result;
      }
    }
    const store = new ReadWindowStore();
    const { bridge, now } = fixture({}, store);
    let committed = 0;
    store.afterEmptyDedup = async () => {
      assert.equal((await bridge.send(alpha, input())).duplicate, false);
      committed++;
    };
    const raced = bridge.send(alpha, input('message_1', changed ? 'Changed during the read window' : 'Synthetic request'));
    if (changed) await assert.rejects(raced, error('idempotency_conflict'));
    else {
      const result = await raced;
      assert.equal(result.duplicate, true);
      assert.equal(result.message.text, 'Synthetic request');
    }
    assert.equal(committed, 1, 'The competing transaction commits inside the controlled read window');
    const history = await bridge.history(alpha, 'conversation_a');
    assert.equal(history.messages.length, 1);
    assert.equal(history.messages[0]!.text, 'Synthetic request');
    assert.equal((await outbox(store)).items.length, 1);
    const rate = await store.get<{ count: number }>({ pk: tenantKey(alpha.tenant, 'rate', alpha.id), sk: String(Math.floor(now() / 60000)) });
    assert.equal(rate?.value.count, 1);
  });
}

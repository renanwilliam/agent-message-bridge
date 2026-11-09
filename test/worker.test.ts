import { EMIT_MESSAGE_GENERATION } from '../src/release-protocol.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryStore } from '../src/memory-store.js';
import { Bridge } from '../src/bridge.js';
import { setEventAuthorization, eventAuthorizationKey } from '../src/event-authorization.js';
import { Events, SIGNING_ROTATION_WINDOW_MS } from '../src/events.js';
import { Worker, type WorkerConfig } from '../src/worker.js';
import { verifyWebhook } from '../src/transport.js';
import { tenantKey, type Delivery, type OutboundPost, type Principal, type Subscription, type SubscriptionSecret } from '../src/types.js';
import type { Key, Row, Write } from '../src/store.js';

const start = 1_700_000_000_000;
const generation='00000000-0000-4000-8000-000000000001';
const secret = `whsec_${Buffer.alloc(32, 17).toString('base64')}`;
const callbackUrl = 'https://callback.example.test/events';
const config: WorkerConfig = {
  routes: { 'team_a:agent_b': { url: 'https://worker.example.test/wake', bearer: 'synthetic-test-token' } },
  leaseMs: 30_000, retryMs: 2_000, maxAttempts: 3, responseWaitMs: 60_000,
};
interface PostCall { url: string; body: string; headers: Record<string, string> }
class ReadTrackingStore extends MemoryStore {
  readonly reads: Key[] = [];
  override async get<T = Record<string, unknown>>(key: Key): Promise<Row<T> | undefined> {
    this.reads.push({ ...key });
    return super.get<T>(key);
  }
}
function wasRead(reads: Key[], key: Key): boolean { return reads.some(read => read.pk === key.pk && read.sk === key.sk); }
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}
async function fixture(kind: Delivery['kind'] = 'webhook', options: Partial<WorkerConfig> = {}) {
  const store = new ReadTrackingStore();
  let clock = start;
  const key: Key = { pk: tenantKey('team_a', 'outbox', 'agent_b'), sk: 'delivery_1' };
  const subscriptionKey: Key = { pk: tenantKey('team_a', 'subscriptions', 'agent_b'), sk: 'subscription_1' };
  const subscriptionSecretKey: Key = { pk: tenantKey('team_a', 'subscription-secrets', 'agent_b'), sk: subscriptionKey.sk };
  const claimKey: Key = { pk: tenantKey('team_a', 'claims', 'conversation_1'), sk: 'claim#message_1' };
  const value: Delivery = {
    id: 'delivery_1', kind, tenant: 'team_a', owner: 'agent_b', attempts: 0, fence: 0,
    leaseUntil: 0, status: 'pending', ...(kind === 'event' ? { subscriptionId: subscriptionKey.sk, subscriptionAuthorizationEpoch:'1', subscriptionGeneration:generation } : {}),
    message: { id: 'message_1', conversationId: 'conversation_1', correlationId: 'correlation_1',
      sender: 'agent_a', recipient: 'agent_b', timestamp: new Date(start).toISOString() },
  };
  const subscription: Subscription = { id: subscriptionKey.sk, tenant: 'team_a', owner: 'agent_b',
    event: 'message.received', params: {},
    expiresAt: start + 86_400_000, active: true, authorizationEpoch:'1', generation };
  await store.commit([{ ...key, expected: null, value, dueAt: clock },
    ...(kind === 'event' ? [
      { ...subscriptionKey, expected: null, value: subscription },
      { ...eventAuthorizationKey('team_a','agent_b'), expected: null, value:{epoch:'1',active:true} },
      { ...subscriptionSecretKey, expected: null, value: { url: callbackUrl, secret } satisfies SubscriptionSecret },
    ] : [])]);
  return {
    store, key, claimKey, subscriptionKey, subscriptionSecretKey,
    now: () => clock,
    advance: (ms: number) => { clock += ms; },
    setTime: (ms: number) => { clock = ms; },
    worker: (post: OutboundPost) => new Worker(store, { ...config, ...options }, post, () => clock),
    row: () => store.get<Delivery>(key),
  };
}

test('competing workers acquire one lease and only one outbound wake occurs', async () => {
  const f = await fixture();
  const calls: PostCall[] = [];
  const post: OutboundPost = async (url, body, headers) => { calls.push({ url, body, headers }); return { status: 200, body: '' }; };
  const results = await Promise.all([f.worker(post).deliver(f.key), f.worker(post).deliver(f.key), f.worker(post).deliver(f.key)]);
  assert.equal(calls.length, 1);
  assert.equal(results.filter(result => result === 'pending').length, 1);
  assert.equal(results.filter(result => result === 'contended' || result === 'skipped').length, 2);
  const row = (await f.row())!;
  assert.equal(row.value.fence, 1);
  assert.equal(row.value.attempts, 1);
  assert.equal(row.dueAt, start + config.responseWaitMs);
});

test('expired lease is recovered; the stale worker cannot overwrite the new owner outcome', async () => {
  const f = await fixture();
  const started = deferred<void>();
  const oldResponse = deferred<{ status: number; body: string }>();
  const calls: PostCall[] = [];
  const oldPost: OutboundPost = async (url, body, headers) => { calls.push({ url, body, headers }); started.resolve(); return oldResponse.promise; };
  const oldDelivery = f.worker(oldPost).deliver(f.key);
  await started.promise;
  const leased = (await f.row())!;
  assert.equal(leased.value.leaseUntil, start + config.leaseMs);
  assert.equal(await f.worker(async () => { throw new Error('Must not send during lease'); }).deliver(f.key), 'skipped');
  f.advance(config.leaseMs + 1);
  const recovered = await f.worker(async (url, body, headers) => { calls.push({ url, body, headers }); return { status: 410, body: '' }; }).deliver(f.key);
  assert.equal(recovered, 'dead');
  oldResponse.resolve({ status: 200, body: '' });
  assert.equal(await oldDelivery, 'fenced');
  const final = (await f.row())!;
  assert.equal(final.value.status, 'dead');
  assert.equal(final.value.lastError, 'http_410');
  assert.equal(final.value.fence, 2);
  assert.equal(calls.length, 2, 'The external request can occur twice after a crash/lease timeout');
  assert.equal(calls[0]!.body, calls[1]!.body);
  assert.equal(calls[0]!.headers['idempotency-key'], calls[1]!.headers['idempotency-key']);
});

test('HTTP 200 acknowledges wake only; completed claim closes delivery without another wake', async () => {
  const f = await fixture();
  const calls: PostCall[] = [];
  const worker = f.worker(async (url, body, headers) => { calls.push({ url, body, headers }); return { status: 200, body: 'accepted' }; });
  assert.equal(await worker.deliver(f.key), 'pending');
  assert.equal((await f.row())!.value.status, 'pending');
  assert.equal(calls[0]!.headers['content-type'], 'application/json', 'Receivers must identify the wake payload as JSON');
  assert.deepEqual(JSON.parse(calls[0]!.body), {
    type: 'message.available', deliveryId: 'delivery_1', messageId: 'message_1',
    conversationId: 'conversation_1', correlationId: 'correlation_1',
  });
  assert.ok(!calls[0]!.body.includes('Synthetic confidential message'));
  assert.equal(calls[0]!.headers.authorization, 'Bearer synthetic-test-token');
  assert.equal(calls[0]!.headers['idempotency-key'], 'delivery_1');
  assert.deepEqual(Object.keys(calls[0]!.headers).sort(), ['authorization','content-type','idempotency-key']);
  await f.store.commit([{ ...f.claimKey, expected: null, value: { status: 'done', leaseUntil: start + 100_000 } }]);
  f.advance(config.responseWaitMs);
  assert.equal(await worker.deliver(f.key), 'done');
  assert.equal(calls.length, 1);
  assert.equal((await f.row())!.dueAt, undefined);
});

for(const timing of ['after_wake','during_post'] as const) {
  test(`ACK terminal real fecha a entrega sem outra mensagem (${timing})`,async()=>{
    const store=new MemoryStore();let now=start;
    const alpha:Principal={id:'agent_a',tenant:'team_a',scopes:['messages:send','messages:read','messages:claim'],peers:['agent_b']};
    const beta:Principal={...alpha,id:'agent_b',peers:['agent_a']};
    const bridge=new Bridge(store,{maxTurns:10,messagesPerMinute:10,claimMs:120_000,webhookRecipients:['team_a:agent_b']},()=>now);
    await bridge.send(beta,{id:'request_1',conversationId:'terminal_conversation',recipient:'agent_a',text:'Synthetic request'});
    const requestClaim=await bridge.claim(alpha,'terminal_conversation','request_1');assert.equal(requestClaim.status,'claimed');
    await bridge.complete(alpha,{id:'reply_1',conversationId:'terminal_conversation',recipient:'agent_b',text:'Synthetic terminal response',replyTo:'request_1',fence:requestClaim.fence!});
    const queued=(await store.query<Delivery>(tenantKey('team_a','outbox','agent_b'),'',100)).items;
    assert.equal(queued.length,1);const key=queued[0]!;
    const started=deferred<void>();const accepted=deferred<{status:number;body:string}>();let calls=0;
    const worker=new Worker(store,config,async()=>{calls++;started.resolve();return timing==='during_post'?accepted.promise:{status:200,body:''};},()=>now);
    const delivery=worker.deliver(key);await started.promise;
    if(timing==='after_wake')assert.equal(await delivery,'pending');
    const terminal=await bridge.claim(beta,'terminal_conversation','reply_1');assert.equal(terminal.status,'claimed');
    const ack={conversationId:'terminal_conversation',messageId:'reply_1',fence:terminal.fence!};
    if(timing==='after_wake') {
      now=start+config.responseWaitMs;
      assert.equal(await worker.deliver(key),'pending','Sair sem ACK mantém a entrega pendente enquanto a reserva vive');
      assert.equal(calls,1);
      assert.equal((await store.get<Delivery>(key))!.dueAt,terminal.leaseUntil!+1);
    }
    await bridge.acknowledge(beta,ack);
    if(timing==='during_post') {accepted.resolve({status:200,body:''});assert.equal(await delivery,'pending');}
    now=(await store.get<Delivery>(key))!.dueAt!;
    assert.equal(await worker.deliver(key),'done');
    const finished=(await store.get<Delivery>(key))!;
    assert.equal(finished.dueAt,undefined);assert.equal(finished.value.attempts,1);assert.equal(finished.value.lastError,undefined);
    assert.equal(calls,1,'A conclusão evita um novo POST na próxima execução elegível');
    assert.deepEqual(await bridge.claim(beta,'terminal_conversation','reply_1'),{status:'done',outcome:'acknowledged'});
    assert.equal((await bridge.history(beta,'terminal_conversation')).messages.length,2);
    assert.equal((await store.query(tenantKey('team_a','outbox','agent_b'),'',100)).items.length,1);
  });
}

test('configured extra authentication header carries the same raw credential only for webhook delivery',async()=>{
  const routes={'team_a:agent_b':{...config.routes['team_a:agent_b']!,additionalAuthHeader:'X-Webhook-Key'}};
  for(const kind of ['webhook','event'] as const){
    const f=await fixture(kind,{routes});const calls:PostCall[]=[];
    await f.worker(async(url,body,headers)=>{calls.push({url,body,headers});return {status:200,body:''};}).deliver(f.key);
    assert.equal(calls.length,1);
    if(kind==='webhook'){
      assert.equal(calls[0]!.headers.authorization,'Bearer synthetic-test-token');
      assert.equal(calls[0]!.headers['x-webhook-key'],'synthetic-test-token');
      assert.equal(calls[0]!.headers['idempotency-key'],'delivery_1');
      assert.ok(!calls[0]!.body.includes('synthetic-test-token'));
    }else{
      assert.equal(calls[0]!.headers.authorization,undefined);
      assert.equal(calls[0]!.headers['x-webhook-key'],undefined);
      assert.equal(verifyWebhook(secret,calls[0]!.body,calls[0]!.headers,start),'delivery_1');
    }
  }
});

test('a direct worker configuration cannot inject or replace a reserved header',async()=>{
  for(const additionalAuthHeader of ['Authorization','X-MCP-Subscription-Id','X-Key\r\nInjected']){
    const f=await fixture('webhook',{routes:{'team_a:agent_b':{...config.routes['team_a:agent_b']!,additionalAuthHeader}}});
    const result=await f.worker(async()=>{assert.fail('Invalid route must not send any request');}).deliver(f.key);
    assert.equal(result,'dead');assert.equal((await f.row())!.value.lastError,'route_invalid');
  }
});

test('a running claim defers wake until its lease expires without consuming an attempt', async () => {
  const f = await fixture();
  const leaseUntil = start + 120_000;
  await f.store.commit([{ ...f.claimKey, expected: null, value: { status: 'running', leaseUntil } }]);
  let calls = 0;
  const worker = f.worker(async () => { calls++; return { status: 200, body: '' }; });
  assert.equal(await worker.deliver(f.key), 'pending');
  assert.equal(calls, 0);
  assert.equal((await f.row())!.dueAt, leaseUntil + 1);
  assert.equal((await f.row())!.value.attempts, 0);
  f.setTime(leaseUntil + 1);
  assert.equal(await worker.deliver(f.key), 'pending');
  assert.equal(calls, 1);
});

for (const status of [410, 413]) {
  test(`HTTP ${status} is terminal and never retried by later sweeps`, async () => {
    const f = await fixture('event');
    let calls = 0;
    const worker = f.worker(async () => { calls++; return { status, body: '' }; });
    assert.equal(await worker.deliver(f.key), 'dead');
    assert.equal((await f.row())!.value.lastError, `http_${status}`);
    f.advance(86_400_000);
    assert.deepEqual(await worker.drain(), []);
    assert.equal(await worker.deliver(f.key), 'skipped');
    assert.equal(calls, 1);
  });
}

test('network retry preserves event identity/body and refreshes a verifiable signature', async () => {
  const f = await fixture('event');
  const calls: PostCall[] = [];
  const worker = f.worker(async (url, body, headers) => {
    calls.push({ url, body, headers });
    if (calls.length === 1) throw new Error('Synthetic network failure with secret-bearing upstream detail');
    return { status: 204, body: '' };
  });
  assert.equal(await worker.deliver(f.key), 'pending');
  assert.equal((await f.row())!.value.lastError, 'network_error');
  assert.equal((await f.row())!.dueAt, start + config.retryMs);
  f.advance(config.retryMs);
  assert.equal(await worker.deliver(f.key), 'done');
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.body, calls[1]!.body);
  assert.equal(calls[0]!.headers['webhook-id'], calls[1]!.headers['webhook-id']);
  assert.equal(calls[0]!.headers['x-mcp-subscription-id'], f.subscriptionKey.sk);
  assert.equal(calls[1]!.headers['x-mcp-subscription-id'], f.subscriptionKey.sk);
  assert.notEqual(calls[0]!.headers['webhook-timestamp'], calls[1]!.headers['webhook-timestamp']);
  assert.notEqual(calls[0]!.headers['webhook-signature'], calls[1]!.headers['webhook-signature']);
  assert.equal(verifyWebhook(secret, calls[0]!.body, calls[0]!.headers, start), 'delivery_1');
  assert.equal(verifyWebhook(secret, calls[1]!.body, calls[1]!.headers, f.now()), 'delivery_1');
  const event = JSON.parse(calls[1]!.body);
  assert.equal(event.data.correlationId, 'correlation_1');
  assert.equal(event.data.timestamp, new Date(start).toISOString());
  assert.equal(event.data.text, undefined);
  assert.equal((await f.row())!.value.attempts, 2);
  assert.equal((await f.row())!.dueAt, undefined);
});

for (const state of ['revoked', 'expired', 'removed'] as const) {
  test(`${state} subscription prevents an already queued event from leaving the bridge`, async () => {
    const f = await fixture('event');
    const sub = (await f.store.get<Subscription>(f.subscriptionKey))!;
    await f.store.commit([{ ...f.subscriptionKey, expected: sub.version,
      ...(state === 'removed' ? {} : { value: { ...sub.value, active: state !== 'revoked', expiresAt: state === 'expired' ? start : sub.value.expiresAt } }) }]);
    f.store.reads.length = 0;
    const worker = f.worker(async () => { assert.fail('Inactive callback must not receive delivery'); });
    assert.equal(await worker.deliver(f.key), 'done');
    assert.equal((await f.row())!.value.lastError, 'subscription_inactive');
    assert.equal((await f.row())!.value.attempts, 0);
    assert.equal(wasRead(f.store.reads, f.subscriptionSecretKey), false, 'Inactive subscriptions must not trigger a secret read');
  });
}

test('bounded retry exhaustion leaves the failed delivery durable and no longer scheduled', async () => {
  const f = await fixture('webhook', { maxAttempts: 3 });
  let calls = 0;
  const worker = f.worker(async () => { calls++; return { status: 503, body: '' }; });
  assert.equal(await worker.deliver(f.key), 'pending');
  f.advance(config.retryMs);
  assert.equal(await worker.deliver(f.key), 'pending');
  f.advance(config.retryMs * 2);
  assert.equal(await worker.deliver(f.key), 'dead');
  const row = (await f.row())!;
  assert.equal(row.value.attempts, 3);
  assert.equal(row.value.lastError, 'http_503');
  assert.equal(row.dueAt, undefined);
  assert.equal(calls, 3);
  f.advance(86_400_000);
  assert.deepEqual(await worker.drain(), []);
});

test('accepted wakes without a claim are bounded and end as exhausted instead of looping forever', async () => {
  const f = await fixture('webhook', { maxAttempts: 2 });
  let calls = 0;
  const worker = f.worker(async () => { calls++; return { status: 200, body: '' }; });
  assert.equal(await worker.deliver(f.key), 'pending');
  f.advance(config.responseWaitMs);
  assert.equal(await worker.deliver(f.key), 'pending');
  f.advance(config.responseWaitMs);
  assert.equal(await worker.deliver(f.key), 'dead');
  assert.equal((await f.row())!.value.lastError, 'attempts_exhausted');
  assert.equal(calls, 2);
});

test('lost workers consume a durable attempt before each POST and cannot evade retry exhaustion', async () => {
  const f = await fixture('event', { maxAttempts: 2 });
  const started = [deferred<void>(), deferred<void>()];
  const responses = [deferred<{ status: number; body: string }>(), deferred<{ status: number; body: string }>()];
  let calls = 0;
  const worker = f.worker(async () => {
    const index = calls++;
    started[index]!.resolve();
    return responses[index]!.promise;
  });
  const first = worker.deliver(f.key);
  await started[0]!.promise;
  assert.equal((await f.row())!.value.attempts, 1, 'First attempt must already be durable while POST is in flight');
  f.advance(config.leaseMs + 1);
  const second = worker.deliver(f.key);
  await started[1]!.promise;
  assert.equal((await f.row())!.value.attempts, 2, 'Recovered worker consumes its own attempt before posting');
  f.advance(config.leaseMs + 1);
  assert.equal(await worker.deliver(f.key), 'dead');
  assert.equal(calls, 2);
  assert.equal((await f.row())!.value.lastError, 'attempts_exhausted');
  responses[0]!.resolve({ status: 204, body: '' });
  responses[1]!.resolve({ status: 204, body: '' });
  assert.deepEqual(await Promise.all([first, second]), ['fenced', 'fenced']);
  assert.equal((await f.row())!.value.status, 'dead');
  assert.equal((await f.row())!.value.attempts, 2);
});

test('subscription metadata and outbox contain no callback URL, signing secret or message body', async () => {
  const f = await fixture('event');
  const metadata = (await f.store.get<Subscription>(f.subscriptionKey))!.value;
  const delivery = (await f.row())!.value;
  const signing = (await f.store.get<SubscriptionSecret>(f.subscriptionSecretKey))!.value;
  assert.equal('secret' in metadata, false);
  assert.equal('url' in metadata, false);
  assert.equal(JSON.stringify(metadata).includes(callbackUrl), false);
  assert.equal(JSON.stringify(delivery).includes(callbackUrl), false);
  assert.equal('secret' in delivery, false);
  assert.equal(JSON.stringify(metadata).includes(secret), false);
  assert.equal(JSON.stringify(delivery).includes(secret), false);
  assert.deepEqual(Object.keys(delivery.message).sort(), ['conversationId', 'correlationId', 'id', 'recipient', 'sender', 'timestamp'].sort());
  assert.equal(signing.secret, secret);
  assert.equal(signing.url, callbackUrl);
});

for (const state of ['missing', 'cleared', 'missing_url'] as const) {
  test(`${state} signing secret prevents callback delivery and leaves a terminal diagnostic`, async () => {
    const f = await fixture('event');
    const current = (await f.store.get<SubscriptionSecret>(f.subscriptionSecretKey))!;
    await f.store.commit([{ ...f.subscriptionSecretKey, expected: current.version, ...(state === 'cleared' ? { value: {} } : state === 'missing_url' ? { value: { secret } } : {}) }]);
    f.store.reads.length = 0;
    let calls = 0;
    const worker = f.worker(async () => { calls++; return { status: 204, body: '' }; });
    assert.equal(await worker.deliver(f.key), 'dead');
    assert.equal(calls, 0);
    assert.equal((await f.row())!.value.lastError, 'subscription_secret_missing');
    assert.equal((await f.row())!.value.attempts, 0);
    assert.equal(wasRead(f.store.reads, f.subscriptionSecretKey), true);
    assert.equal((await f.row())!.dueAt, undefined);
  });
}

for (const mismatch of ['owner', 'tenant'] as const) {
  test(`subscription ${mismatch} mismatch cannot select a signing secret or receive a callback`, async () => {
    const f = await fixture('event');
    const current = (await f.store.get<Subscription>(f.subscriptionKey))!;
    const other = mismatch === 'owner' ? 'agent_other' : 'team_other';
    await f.store.commit([{ ...f.subscriptionKey, expected: current.version, value: { ...current.value, [mismatch]: other } }]);
    f.store.reads.length = 0;
    let calls = 0;
    const worker = f.worker(async () => { calls++; return { status: 204, body: '' }; });
    assert.equal(await worker.deliver(f.key), 'done');
    assert.equal(calls, 0);
    assert.equal((await f.row())!.value.lastError, 'subscription_inactive');
    assert.equal(wasRead(f.store.reads, f.subscriptionSecretKey), false);
    assert.equal(f.store.reads.some(read => read.pk.includes('#subscription-secrets#')), false);
  });
}

test('event rotation signs identical bytes with both keys until grace expiry and signs retries freshly',async()=>{
  const f=await fixture('event');
  const old=`whsec_${Buffer.alloc(32,22).toString('base64')}`;
  const row=(await f.store.get<SubscriptionSecret>(f.subscriptionSecretKey))!;
  await f.store.commit([{...f.subscriptionSecretKey,expected:row.version,value:{...row.value,previousSecret:old,previousSecretExpiresAt:start+SIGNING_ROTATION_WINDOW_MS}}]);
  const calls:PostCall[]=[];
  const worker=f.worker(async(url,body,headers)=>{calls.push({url,body,headers});return {status:calls.length<3?503:204,body:''};});
  assert.equal(await worker.deliver(f.key),'pending');
  f.advance(config.retryMs);
  assert.equal(await worker.deliver(f.key),'pending');
  for(const call of calls){
    assert.equal(call.headers['webhook-signature']!.split(' ').length,2);
    assert.equal(verifyWebhook(secret,call.body,call.headers,Number(call.headers['webhook-timestamp'])*1000),'delivery_1');
    assert.equal(verifyWebhook(old,call.body,call.headers,Number(call.headers['webhook-timestamp'])*1000),'delivery_1');
  }
  assert.equal(calls[0]!.body,calls[1]!.body);
  assert.notEqual(calls[0]!.headers['webhook-signature'],calls[1]!.headers['webhook-signature']);
  f.setTime(start+SIGNING_ROTATION_WINDOW_MS);
  assert.equal(await worker.deliver(f.key),'done');
  const current=calls[2]!;
  assert.equal(current.headers['webhook-signature']!.split(' ').length,1);
  assert.equal(current.body,calls[0]!.body);
  assert.equal(verifyWebhook(secret,current.body,current.headers,f.now()),'delivery_1');
  assert.throws(()=>verifyWebhook(old,current.body,current.headers,f.now()),/invalid_signature/);
  assert.throws(()=>verifyWebhook(old,calls[0]!.body,calls[0]!.headers,f.now()+1000),/stale_signature/);
});

for(const state of ['revoked','missing','different_epoch','legacy_delivery','legacy_subscription'] as const){
  test(`${state} event authorization stops delivery before signing-secret access`,async()=>{
    const f=await fixture('event');
    const authKey=eventAuthorizationKey('team_a','agent_b');
    const auth=(await f.store.get(authKey))!;
    if(state==='missing')await f.store.commit([{...authKey,expected:auth.version}]);
    if(state==='revoked'||state==='different_epoch')await setEventAuthorization(f.store,{tenant:'team_a',owner:'agent_b'},{epoch:'2',active:state==='different_epoch'},'1');
    if(state==='legacy_delivery'){
      const row=(await f.row())!;const value={...row.value};delete value.subscriptionAuthorizationEpoch;
      await f.store.commit([{...f.key,expected:row.version,value,dueAt:start}]);
    }
    if(state==='legacy_subscription'){
      const row=(await f.store.get<Subscription>(f.subscriptionKey))!;const value={...row.value};delete value.authorizationEpoch;
      await f.store.commit([{...f.subscriptionKey,expected:row.version,value}]);
    }
    f.store.reads.length=0;
    assert.equal(await f.worker(async()=>{assert.fail('Unauthorized callback');}).deliver(f.key),'done');
    assert.equal((await f.row())!.value.lastError,'event_access_revoked');
    assert.equal((await f.row())!.value.attempts,0);
    assert.equal(wasRead(f.store.reads,f.subscriptionSecretKey),false);
  });
}

test('revocation after the durable attempt is reread before the outbound POST',async()=>{
  const f=await fixture('event');
  const originalCommit=f.store.commit.bind(f.store);let revoked=false;
  f.store.commit=async(writes:Write[])=>{
    await originalCommit(writes);
    if(!revoked&&writes.some(write=>write.pk===f.key.pk&&(write.value as Delivery)?.attempts===1)){
      revoked=true;
      await setEventAuthorization(f.store,{tenant:'team_a',owner:'agent_b'},{epoch:'2',active:false},'1');
    }
  };
  assert.equal(await f.worker(async()=>{assert.fail('Revoked during attempt persistence');}).deliver(f.key),'done');
  assert.equal((await f.row())!.value.attempts,1);
  assert.equal((await f.row())!.value.lastError,'event_access_revoked');
});

test('reauthorizing and refreshing an owner cannot revive an event queued under an old epoch',async()=>{
  const f=await fixture('event');
  await setEventAuthorization(f.store,{tenant:'team_a',owner:'agent_b'},{epoch:'2',active:false},'1');
  await setEventAuthorization(f.store,{tenant:'team_a',owner:'agent_b'},{epoch:'3',active:true},'2');
  const sub=(await f.store.get<Subscription>(f.subscriptionKey))!;
  await f.store.commit([{...f.subscriptionKey,expected:sub.version,value:{...sub.value,authorizationEpoch:'3'}}]);
  assert.equal(await f.worker(async()=>{assert.fail('Old-epoch outbox was revoked');}).deliver(f.key),'done');
  assert.equal((await f.row())!.value.lastError,'event_access_revoked');
  assert.equal((await f.row())!.value.attempts,0);
});

for(const update of ['unsubscribe','rotation','reactivation'] as const){
  test(`${update} during final signing-secret read is observed before delivery`,async()=>{
    const f=await fixture('event');
    const read=f.store.get.bind(f.store);let reads=0;let changed=false;
    const newer=`whsec_${Buffer.alloc(32,23).toString('base64')}`;
    f.store.get=async<T=Record<string,unknown>>(key:Key):Promise<Row<T>|undefined>=>{
      const result=await read<T>(key);
      if(key.pk===f.subscriptionSecretKey.pk&&key.sk===f.subscriptionSecretKey.sk&&++reads===2){
        const sub=(await read<Subscription>(f.subscriptionKey))!;
        const signing=(await read<SubscriptionSecret>(f.subscriptionSecretKey))!;
        await f.store.commit([
          {...f.subscriptionKey,expected:sub.version,value:{...sub.value,active:update!=='unsubscribe',generation:update==='reactivation'?'00000000-0000-4000-8000-000000000002':sub.value.generation}},
          {...f.subscriptionSecretKey,expected:signing.version,value:update==='rotation'?{url:callbackUrl,secret:newer,previousSecret:secret,previousSecretExpiresAt:start+SIGNING_ROTATION_WINDOW_MS}:update==='reactivation'?{url:callbackUrl,secret}:{}},
        ]);
        changed=true;
      }
      return result;
    };
    let calls=0;
    const worker=f.worker(async(_url,body,headers)=>{
      calls++;
      assert.equal(verifyWebhook(newer,body,headers,f.now()),'delivery_1');
      assert.equal(verifyWebhook(secret,body,headers,f.now()),'delivery_1');
      return {status:204,body:''};
    });
    assert.equal(await worker.deliver(f.key),update==='rotation'?'pending':'done');
    assert.equal(changed,true);assert.equal(calls,0);
    if(update==='rotation'){
      assert.equal((await f.row())!.value.lastError,'subscription_changed');
      assert.equal(await worker.deliver(f.key),'done');
      assert.equal(calls,1);
    }else assert.equal((await f.row())!.value.lastError,update==='reactivation'?'subscription_generation_changed':'subscription_inactive');
  });
}

test('real publication stores message text only in history and needs no signing-secret access', async () => {
  class IngressStore extends MemoryStore {
    secretsBlocked = false;
    override async get<T = Record<string, unknown>>(key: Key) {
      if (this.secretsBlocked && key.pk.includes('#subscription-secrets#')) throw new Error('Ingress cannot read signing secrets');
      return super.get<T>(key);
    }
  }
  const store = new IngressStore();
  const recipient: Principal = { id: 'agent_b', tenant: 'team_a', scopes: ['events:subscribe'], peers: ['agent_a'], eventAuthorizationEpoch:'1' };
  const sender: Principal = { id: 'agent_a', tenant: 'team_a', scopes: ['messages:send', 'messages:read'], peers: ['agent_b'] };
  const events = new Events(store, async (_url, body) => ({ status: 200, body: JSON.stringify({ challenge: JSON.parse(body).challenge }) }), () => start);
  await setEventAuthorization(store,{tenant:recipient.tenant,owner:recipient.id},{epoch:'1',active:true},null);
  const subscription = await events.subscribe(recipient, { name: 'message.received', arguments: {}, delivery: { mode: 'webhook', url: callbackUrl, secret } });
  const metadata = (await store.get<Subscription>({ pk: tenantKey(recipient.tenant, 'subscriptions', recipient.id), sk: subscription.id }))!.value;
  assert.equal('url' in metadata, false);
  assert.equal('secret' in metadata, false);
  assert.ok(!JSON.stringify(metadata).includes(callbackUrl));
  assert.ok(!JSON.stringify(metadata).includes(secret));
  store.secretsBlocked = true;
  const bridge = new Bridge(store, { maxTurns: 10, messagesPerMinute: 10, claimMs: 1000, webhookRecipients: ['team_a:agent_b'] }, () => start);
  const text = 'Synthetic private message retained in authorized history';
  await bridge.send(sender, { id: 'private_message', conversationId: 'private_conversation', recipient: 'agent_b', text });
  const queued = await store.query<Delivery>(tenantKey('team_a', 'outbox', 'agent_b'), '', 100);
  assert.equal(queued.items.length, 2, 'Webhook and event notices share the persisted message reference');
  for (const row of queued.items) {
    assert.deepEqual(Object.keys(row.value.message).sort(), ['conversationId', 'correlationId', ...(EMIT_MESSAGE_GENERATION ? ['generation'] : []), 'id', 'recipient', 'sender', 'timestamp']);
    assert.ok(!JSON.stringify(row).includes(text));
    assert.ok(!JSON.stringify(row).includes(secret));
    assert.ok(!JSON.stringify(row).includes(callbackUrl));
  }
  assert.equal((await bridge.history(sender, 'private_conversation')).messages[0]!.text, text);
});

for(const interruption of ['unsubscribe','expiration'] as const){
  test(`${interruption} followed by the same protocol subscription blocks its old outbox and delivers only its new generation`,async()=>{
    const store=new MemoryStore();let now=start;
    const recipient:Principal={id:'agent_b',tenant:'team_a',scopes:['events:subscribe'],peers:[],eventAuthorizationEpoch:'1'};
    const sender:Principal={id:'agent_a',tenant:'team_a',scopes:['messages:send','messages:read'],peers:['agent_b']};
    await setEventAuthorization(store,{tenant:recipient.tenant,owner:recipient.id},{epoch:'1',active:true},null);
    const params={name:'message.received',ttlMs:60_000,delivery:{mode:'webhook',url:callbackUrl,secret}};
    const events=new Events(store,async(_url,body)=>({status:200,body:JSON.stringify({challenge:JSON.parse(body).challenge})}),()=>now);
    const initial=await events.subscribe(recipient,params);
    const subKey={pk:tenantKey(recipient.tenant,'subscriptions',recipient.id),sk:initial.id};
    const initialGeneration=(await store.get<Subscription>(subKey))!.value.generation;
    const bridge=new Bridge(store,{maxTurns:10,messagesPerMinute:10,claimMs:1000,webhookRecipients:[]},()=>now);
    await bridge.send(sender,{id:'old_message',conversationId:'conversation',recipient:recipient.id,text:'Synthetic old-generation message'});
    if(interruption==='unsubscribe')await events.unsubscribe(recipient,initial.id);else now+=60_000;
    const renewed=await events.subscribe(recipient,params);
    assert.equal(renewed.id,initial.id,'Protocol identity stays canonical across activations');
    const newGeneration=(await store.get<Subscription>(subKey))!.value.generation;
    assert.notEqual(newGeneration,initialGeneration);
    await bridge.send(sender,{id:'new_message',conversationId:'conversation',recipient:recipient.id,text:'Synthetic new-generation message'});
    const outbox=(await store.query<Delivery>(tenantKey(recipient.tenant,'outbox',recipient.id),'',10)).items;
    const old=outbox.find(row=>row.value.message.id==='old_message')!;
    const fresh=outbox.find(row=>row.value.message.id==='new_message')!;
    assert.equal(old.value.subscriptionGeneration,initialGeneration);
    assert.equal(fresh.value.subscriptionGeneration,newGeneration);
    const received:string[]=[];
    const worker=new Worker(store,{...config,routes:{}},async(_url,body,headers)=>{
      const event=JSON.parse(body);received.push(event.data.messageId);
      assert.equal(verifyWebhook(secret,body,headers,now),event.eventId);
      return {status:204,body:''};
    },()=>now);
    assert.equal(await worker.deliver(old),'done');
    assert.equal((await store.get<Delivery>(old))!.value.lastError,'subscription_generation_changed');
    assert.equal((await store.get<Delivery>(old))!.value.attempts,0);
    assert.deepEqual(received,[]);
    assert.equal(await worker.deliver(fresh),'done');
    assert.deepEqual(received,['new_message']);
  });
}

test('active renewal and key rotation preserve the activation generation and permit its queued event',async()=>{
  const store=new MemoryStore();let now=start;
  const recipient:Principal={id:'agent_b',tenant:'team_a',scopes:['events:subscribe'],peers:[],eventAuthorizationEpoch:'1'};
  const sender:Principal={id:'agent_a',tenant:'team_a',scopes:['messages:send','messages:read'],peers:['agent_b']};
  await setEventAuthorization(store,{tenant:recipient.tenant,owner:recipient.id},{epoch:'1',active:true},null);
  const params={name:'message.received',ttlMs:60_000,delivery:{mode:'webhook',url:callbackUrl,secret}};
  const events=new Events(store,async(_url,body)=>({status:200,body:JSON.stringify({challenge:JSON.parse(body).challenge})}),()=>now);
  const initial=await events.subscribe(recipient,params);
  const subKey={pk:tenantKey(recipient.tenant,'subscriptions',recipient.id),sk:initial.id};
  const initialGeneration=(await store.get<Subscription>(subKey))!.value.generation;
  const bridge=new Bridge(store,{maxTurns:10,messagesPerMinute:10,claimMs:1000,webhookRecipients:[]},()=>now);
  await bridge.send(sender,{id:'queued_message',conversationId:'conversation',recipient:recipient.id,text:'Synthetic queued message'});
  now+=1000;
  assert.equal((await events.subscribe(recipient,params)).id,initial.id);
  assert.equal((await store.get<Subscription>(subKey))!.value.generation,initialGeneration);
  const replacement=`whsec_${Buffer.alloc(32,28).toString('base64')}`;
  assert.equal((await events.subscribe(recipient,{...params,delivery:{...params.delivery,secret:replacement}})).id,initial.id);
  assert.equal((await store.get<Subscription>(subKey))!.value.generation,initialGeneration);
  const queued=(await store.query<Delivery>(tenantKey(recipient.tenant,'outbox',recipient.id),'',10)).items[0]!;
  let calls=0;
  const worker=new Worker(store,{...config,routes:{}},async(_url,body,headers)=>{
    calls++;assert.equal(JSON.parse(body).data.messageId,'queued_message');
    assert.equal(verifyWebhook(secret,body,headers,now),queued.value.id);
    assert.equal(verifyWebhook(replacement,body,headers,now),queued.value.id);
    return {status:204,body:''};
  },()=>now);
  assert.equal(await worker.deliver(queued),'done');assert.equal(calls,1);
});

for(const missing of ['subscription','delivery','malformed'] as const){
  test(`a ${missing} activation generation fails closed before reading signing secrets`,async()=>{
    const f=await fixture('event');
    if(missing==='delivery'){
      const row=(await f.row())!;const value={...row.value};delete value.subscriptionGeneration;
      await f.store.commit([{...f.key,expected:row.version,value,dueAt:start}]);
    }else{
      const row=(await f.store.get<Subscription>(f.subscriptionKey))!;const value={...row.value};
      if(missing==='subscription')delete value.generation;else value.generation='not-an-activation-id';
      await f.store.commit([{...f.subscriptionKey,expected:row.version,value}]);
    }
    f.store.reads.length=0;
    assert.equal(await f.worker(async()=>{assert.fail('No legacy-generation delivery');}).deliver(f.key),'done');
    assert.equal((await f.row())!.value.lastError,'subscription_generation_changed');
    assert.equal(wasRead(f.store.reads,f.subscriptionSecretKey),false);
  });
}

for (const kind of ['event', 'webhook'] as const) {
  test(`bootstrap mode terminates ${kind} delivery without reading credentials or calling outside`, async () => {
    const f = await fixture(kind);
    if (kind === 'event') {
      const metadata = (await f.store.get<Subscription>(f.subscriptionKey))!;
      await f.store.commit([{ ...f.subscriptionKey, expected: metadata.version,
        value: { ...metadata.value, owner: 'forged_owner', tenant: 'forged_team', active: true } }]);
    }
    const routes = new Proxy(config.routes, { get() { assert.fail('Bootstrap must not inspect outbound routes'); } });
    let calls = 0;
    const worker = new Worker(f.store, { ...config, routes, deliveryEnabled: false }, async () => {
      calls++; return { status: 204, body: '' };
    }, f.now);
    f.store.reads.length = 0;
    assert.equal(await worker.deliver(f.key), 'dead');
    assert.equal(calls, 0);
    assert.deepEqual(f.store.reads, [f.key], 'Only the outbox row is read, even when a forged active subscription exists');
    const row = (await f.row())!;
    assert.equal(row.value.status, 'dead');
    assert.equal(row.value.lastError, 'integration_not_configured');
    assert.equal(row.value.attempts, 0);
    assert.equal(row.value.leaseUntil, 0);
    assert.equal(row.dueAt, undefined);
    assert.deepEqual(await worker.drain(), []);
  });
}

test('Phase B generation stays out of strict event payloads and eventId/body are stable across retries',async()=>{
  const store=new MemoryStore();let now=start;
  const recipient:Principal={id:'agent_b',tenant:'team_a',scopes:['events:subscribe'],peers:[],eventAuthorizationEpoch:'1'};
  const sender:Principal={id:'agent_a',tenant:'team_a',scopes:['messages:send'],peers:['agent_b']};
  await setEventAuthorization(store,{tenant:recipient.tenant,owner:recipient.id},{epoch:'1',active:true},null);
  const events=new Events(store,async(_url,body)=>({status:200,body:JSON.stringify({challenge:JSON.parse(body).challenge})}),()=>now);
  await events.subscribe(recipient,{name:'message.received',delivery:{mode:'webhook',url:callbackUrl,secret}});
  const bridge=new Bridge(store,{messagesPerMinute:10,claimMs:1000,webhookRecipients:[]},()=>now,true);
  const published=await bridge.send(sender,{id:'generated',conversationId:'generated_conversation',recipient:recipient.id,text:'private'});
  assert.ok(published.message.generation);
  const row=(await store.query<Delivery>(tenantKey('team_a','outbox','agent_b'),'',100)).items[0]!;
  const bodies:string[]=[];
  const worker=new Worker(store,{...config,routes:{}},async(_url,body)=>{bodies.push(body);return {status:bodies.length===1?503:200,body:''};},()=>now);
  assert.equal(await worker.deliver(row),'pending');now=(await store.get<Delivery>(row))!.dueAt!;
  assert.equal(await worker.deliver(row),'done');assert.equal(bodies.length,2);assert.equal(bodies[0],bodies[1]);
  const payload=JSON.parse(bodies[0]!);
  assert.deepEqual(Object.keys(payload).sort(),['cursor','data','eventId','name','timestamp']);
  assert.deepEqual(Object.keys(payload.data).sort(),['conversationId','correlationId','messageId','recipient','sender','timestamp']);
  assert.equal(payload.eventId,row.value.id);assert.ok(!bodies[0]!.includes(published.message.generation!));
});

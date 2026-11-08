import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import type { ClientRequest, IncomingMessage } from 'node:http';
import type { request as HttpsRequest, RequestOptions } from 'node:https';
import { Events, activeSubscriptions, subscriptionId, SIGNING_ROTATION_WINDOW_MS } from '../src/events.js';
import { setEventAuthorization, eventAuthorizationKey } from '../src/event-authorization.js';
import { MemoryStore } from '../src/memory-store.js';
import type { Key, Row, Write, Store } from '../src/store.js';
import { createOutboundPost, isPublicAddress, resolvePublicAddress, signWebhook, validateCallbackUrl, verifyWebhook } from '../src/transport.js';
import { tenantKey, validSubscriptionGeneration, type OutboundPost, type Principal, type Subscription, type SubscriptionSecret } from '../src/types.js';

const clock = Date.parse('2026-01-01T00:00:00Z');
// Fixed test-only key, never sent to a live destination.
const secret = `whsec_${Buffer.alloc(32, 7).toString('base64')}`;
const principal: Principal = { id: 'agent-alpha', tenant: 'sample', scopes: ['events:subscribe'], peers: ['agent-beta'], eventAuthorizationEpoch: '1' };
const authorizeFixture = (store: Store) => setEventAuthorization(store, {tenant:principal.tenant,owner:principal.id}, {epoch:'1',active:true}, null);
const params = (conversationId?: string) => ({
  name: 'message.received', arguments: conversationId ? { conversationId } : {},
  delivery: { mode: 'webhook', url: 'https://callback.example.test/receive', secret }, cursor: null,
});
const callback: OutboundPost = async (_url, body, headers) => {
  verifyWebhook(secret, body, headers, clock);
  assert.ok(headers['X-MCP-Subscription-Id']?.startsWith('sub_'));
  return { status: 200, body: JSON.stringify({ challenge: JSON.parse(body).challenge }) };
};

test('Standard Webhooks signature covers exact body, id and timestamp, with constant test vector', () => {
  const raw = '{"text":"sample"}';
  const headers = signWebhook(secret, 'evt_sample', raw, clock);
  const digest = createHmac('sha256', Buffer.alloc(32, 7)).update(`evt_sample.${clock / 1000}.${raw}`).digest('base64');
  assert.equal(headers['webhook-signature'], `v1,${digest}`);
  assert.equal(verifyWebhook(secret, raw, headers, clock), 'evt_sample');
  assert.equal(verifyWebhook(secret, raw, { ...headers, 'webhook-signature': `v1,invalid ${headers['webhook-signature']}` }, clock), 'evt_sample');
  assert.throws(() => verifyWebhook(secret, raw + ' ', headers, clock), /invalid_signature/);
  assert.throws(() => verifyWebhook(secret, raw, { ...headers, 'webhook-id': 'evt_other' }, clock), /invalid_signature/);
  assert.throws(() => verifyWebhook(secret, raw, headers, clock + 301_000), /stale_signature/);
  assert.throws(() => verifyWebhook(secret, raw, headers, clock - 301_000), /stale_signature/);
  assert.throws(() => signWebhook(secret, 'bad.id', raw, clock), /invalid_webhook_id/);
  assert.throws(() => signWebhook('whsec_a', 'evt_sample', raw, clock), /invalid_webhook_secret/);
  assert.throws(() => signWebhook(secret, 'evt_sample', 'x'.repeat(262145), clock), /payload_too_large/);
});

test('SSRF rejects localhost, metadata, reserved, multicast, IPv6 mapping and alternate IP encodings', async () => {
  for (const url of [
    'http://callback.example.test/hook', 'https://localhost/hook', 'https://sub.localhost/hook',
    'https://127.0.0.1', 'https://2130706433/', 'https://0x7f000001/', 'https://0177.0.0.1/',
    'https://169.254.169.254/', 'https://10.0.0.1/', 'https://192.168.0.1/', 'https://172.16.0.1/',
    'https://100.64.0.1/', 'https://[::1]/', 'https://[::ffff:127.0.0.1]/', 'https://[fc00::1]/',
    'https://user:password@callback.example.test/', 'https://callback.example.test/#fragment',
  ]) assert.throws(() => validateCallbackUrl(url), /invalid_callback_url/, url);
  for (const address of ['0.0.0.0', '192.0.2.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '240.0.0.1',
    '::', 'fe80::1', 'ff02::1', '2001:db8::1', '64:ff9b::7f00:1', '2002:7f00:1::', 'not-an-ip']) {
    assert.equal(isPublicAddress(address), false, address);
  }
  assert.equal(isPublicAddress('8.8.8.8'), true);
  assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
  const url = validateCallbackUrl('https://callback.example.test/');
  await assert.rejects(resolvePublicAddress(url, async () => [{ address: '127.0.0.1', family: 4 }]), /callback_address_blocked/);
  await assert.rejects(resolvePublicAddress(url, async () => [
    { address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 },
  ]), /callback_address_blocked/);
  assert.deepEqual(await resolvePublicAddress(url, async () => [{ address: '8.8.8.8', family: 4 }]), { address: '8.8.8.8', family: 4 });
});

test('outbound DNS validation happens each request, stops rebinding, body bounds and resolution timeout', async () => {
  let calls = 0;
  const post = createOutboundPost({ resolve: async () => { calls++; return [{ address: '127.0.0.1', family: 4 }]; } });
  await assert.rejects(post('https://callback.example.test/', '{}', {}), /callback_address_blocked/);
  await assert.rejects(post('https://callback.example.test/', '{}', {}), /callback_address_blocked/);
  assert.equal(calls, 2);
  await assert.rejects(post('https://callback.example.test/', 'x'.repeat(262145), {}), /payload_too_large/);
  assert.equal(calls, 2);
  const timeout = createOutboundPost({ timeoutMs: 10, resolve: () => new Promise(() => {}) });
  await assert.rejects(timeout('https://callback.example.test/', '{}', {}), /callback_timeout/);
});

test('subscribe verifies first, returns deterministic identity and finite TTL, renews without extra row', async () => {
  const store = new MemoryStore();
  await authorizeFixture(store);
  let now = clock;
  const events = new Events(store, callback, () => now);
  const first = await events.subscribe(principal, { ...params(), ttlMs: 60_000 });
  assert.equal(first.id, subscriptionId(principal, params()));
  assert.equal(first.refreshBefore, new Date(clock + 60_000).toISOString());
  assert.equal(first.cursor, null);
  assert.equal(first.truncated, false);
  now += 10_000;
  const second = await events.subscribe(principal, { ...params(), ttlMs: 30_000 });
  assert.equal(second.id, first.id);
  assert.equal(second.refreshBefore, new Date(now + 30_000).toISOString());
  const rows = await store.query<Subscription>(tenantKey(principal.tenant, 'subscriptions', principal.id), 'sub_', 100);
  assert.equal(rows.items.length, 1);
  assert.equal(rows.items[0]?.version, 2);
  assert.equal('secret' in rows.items[0]!.value, false);
  assert.equal('url' in rows.items[0]!.value, false);
  assert.ok(!JSON.stringify(rows.items).includes('callback.example.test'));
  const signing = await store.get<SubscriptionSecret>({ pk: tenantKey(principal.tenant, 'subscription-secrets', principal.id), sk: first.id });
  assert.equal(signing?.version, 2);
  assert.equal(signing?.value.secret, secret);
  assert.equal(signing?.value.url, params().delivery.url);
  assert.equal((await activeSubscriptions(store, principal.tenant, principal.id, now)).length, 1);
  assert.equal((await activeSubscriptions(store, principal.tenant, principal.id, now + 30_000)).length, 0);
});

test('failed callback verification never persists a subscription or emits application data', async () => {
  for (const response of [{ status: 500, body: '{}' }, { status: 200, body: '{"challenge":"wrong"}' }, { status: 200, body: 'not-json' }]) {
    const store = new MemoryStore();
  await authorizeFixture(store);
    const events = new Events(store, async (_url, body) => {
      assert.equal(JSON.parse(body).type, 'verification');
      assert.equal(Object.keys(JSON.parse(body)).length, 2);
      return response;
    }, () => clock);
    await assert.rejects(events.subscribe(principal, params()), /callback_challenge_failed/);
    assert.equal((await store.query(tenantKey(principal.tenant, 'subscriptions', principal.id), 'sub_', 100)).items.length, 0);
    assert.equal((await store.query(tenantKey(principal.tenant, 'subscription-secrets', principal.id), 'sub_', 100)).items.length, 0);
  }
});

test('subscriptions enforce scopes, tenant isolation and ownership, unsubscribe is idempotent', async () => {
  const store = new MemoryStore();
  await authorizeFixture(store);
  const events = new Events(store, callback, () => clock);
  assert.throws(() => events.list({ ...principal, scopes: [] }), /forbidden/);
  await assert.rejects(events.subscribe({ ...principal, scopes: [] }, params()), /forbidden/);
  const subscribed = await events.subscribe(principal, params());
  const other = { ...principal, id: 'agent-other' };
  const otherTenant = { ...principal, tenant: 'other-sample' };
  assert.notEqual(subscriptionId(other, params()), subscribed.id);
  assert.notEqual(subscriptionId(otherTenant, params()), subscribed.id);
  await events.unsubscribe(other, subscribed.id);
  await events.unsubscribe(otherTenant, subscribed.id);
  assert.equal((await activeSubscriptions(store, principal.tenant, principal.id, clock)).length, 1);
  await assert.rejects(events.unsubscribe({ ...principal, scopes: [] }, subscribed.id), /forbidden/);
  assert.deepEqual(await events.unsubscribe(principal, subscribed.id), {});
  assert.deepEqual(await events.unsubscribe(principal, subscribed.id), {});
  assert.equal((await activeSubscriptions(store, principal.tenant, principal.id, clock)).length, 0);
  const signing = await store.get<SubscriptionSecret>({ pk: tenantKey(principal.tenant, 'subscription-secrets', principal.id), sk: subscribed.id });
  assert.deepEqual(signing?.value, {});
});

test('concurrent creation cannot bypass the bounded per-owner subscription registry', async () => {
  const store = new MemoryStore();
  await authorizeFixture(store);
  const events = new Events(store, callback, () => clock);
  const results = await Promise.allSettled(Array.from({ length: 25 }, (_, index) => events.subscribe(principal, params(`topic_${index}`))));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 20);
  for (const result of results) if (result.status === 'rejected') assert.match(String(result.reason), /subscription_limit/);
  assert.equal((await activeSubscriptions(store, principal.tenant, principal.id, clock)).length, 20);
});

test('expired rows do not hide active subscriptions and invalid subscription input cannot persist', async () => {
  const store = new MemoryStore();
  await authorizeFixture(store);
  let now = clock;
  const events = new Events(store, async (_url, raw) => ({ status: 200, body: JSON.stringify({ challenge: JSON.parse(raw).challenge }) }), () => now);
  for (let index = 0; index < 105; index++) {
    await events.subscribe(principal, { ...params(`old_${index}`), ttlMs: 1 });
    now++;
  }
  const fresh = await events.subscribe(principal, params('current'));
  assert.deepEqual((await activeSubscriptions(store, principal.tenant, principal.id, now)).map(sub => sub.id), [fresh.id]);
  await assert.rejects(events.subscribe(principal, { ...params(), cursor: 'unsupported' }), /replay_not_supported/);
  await assert.rejects(events.subscribe(principal, { ...params(), ttlMs: -1 }), /invalid_subscription_ttl/);
  await assert.rejects(events.subscribe(principal, { ...params(), arguments: { recipient: 'agent-other' } }), /invalid_subscription_arguments/);
  await assert.rejects(events.subscribe(principal, { ...params(), delivery: { ...params().delivery, url: 'https://127.0.0.1' } }), /invalid_callback_url/);
});


test('transport pins the validated IP and retains TLS hostname without following redirects', async () => {
  let requests = 0;
  const fakeRequest = ((url: URL, options: RequestOptions, receive: (response: IncomingMessage) => void) => {
    requests++;
    assert.equal(url.hostname, 'callback.example.test');
    assert.equal(options.family, 4);
    assert.equal(options.agent, false);
    assert.equal(options.rejectUnauthorized, undefined); // Node's secure default remains enabled.
    assert.equal(typeof options.lookup, 'function');
    (options.lookup as unknown as (host: string, opts: object, cb: (error: Error | null, address: string, family: number) => void) => void)(
      'callback.example.test', {}, (error, address, family) => {
        assert.equal(error, null);
        assert.equal(address, '8.8.8.8');
        assert.equal(family, 4);
      },
    );
    const response = Object.assign(new EventEmitter(), { statusCode: 302, destroy() {} });
    const req = Object.assign(new EventEmitter(), {
      end(body: string) {
        assert.equal(body, '{}');
        receive(response as IncomingMessage);
        queueMicrotask(() => { response.emit('data', Buffer.from('{}')); response.emit('end'); });
      },
      destroy() {},
    });
    return req as ClientRequest;
  }) as unknown as typeof HttpsRequest;
  const post = createOutboundPost({ resolve: async () => [{ address: '8.8.8.8', family: 4 }], request: fakeRequest });
  await assert.rejects(post('https://callback.example.test/', '{}', {}), /callback_redirect_blocked/);
  assert.equal(requests, 1);
});

test('active subscription discovery does not access or expose the signing partition', async () => {
  class RestrictedReaderStore extends MemoryStore {
    secretsBlocked = false;
    override async get<T = Record<string, unknown>>(key: Key): Promise<Row<T> | undefined> {
      if (this.secretsBlocked && key.pk.includes('#subscription-secrets#')) throw new Error('No signing permission');
      return super.get<T>(key);
    }
  }
  const store = new RestrictedReaderStore();
  await authorizeFixture(store);
  const events = new Events(store, callback, () => clock);
  const callbackUrl = 'https://callback.example.test/receive?token=synthetic-query-token';
  const result = await events.subscribe(principal, { ...params(), delivery: { ...params().delivery, url: callbackUrl } });
  const key = { pk: tenantKey(principal.tenant, 'subscriptions', principal.id), sk: result.id };
  const row = (await store.get<Subscription>(key))!;
  assert.equal('secret' in row.value, false);
  assert.equal('url' in row.value, false);
  assert.ok(!JSON.stringify(row).includes('synthetic-query-token'));
  const signing = await store.get<SubscriptionSecret>({ pk: tenantKey(principal.tenant, 'subscription-secrets', principal.id), sk: result.id });
  assert.equal(signing?.value.url, callbackUrl);
  // Even a legacy row cannot expose its old signing fields to the ingress discovery reader.
  await store.commit([{ ...key, expected: row.version, value: { ...row.value, secret: 'synthetic-legacy-secret', url: 'https://callback.example.test/?token=synthetic-query-token' } }]);
  store.secretsBlocked = true;
  const visible = await activeSubscriptions(store, principal.tenant, principal.id, clock);
  assert.equal(visible.length, 1);
  assert.equal('secret' in visible[0]!, false);
  assert.equal('url' in visible[0]!, false);
  assert.deepEqual(Object.keys(visible[0]!).sort(), ['active', 'authorizationEpoch', 'event', 'expiresAt', 'generation', 'id', 'owner', 'params', 'tenant']);
  assert.ok(!JSON.stringify(visible).includes('callback.example.test'));
  assert.ok(!JSON.stringify(visible).includes('synthetic-query-token'));
  assert.ok(!JSON.stringify(visible).includes(secret));
  assert.ok(!JSON.stringify(visible).includes('synthetic-legacy-secret'));
});

test('metadata, registry and signing value change atomically on renewal and revocation', async () => {
  class FailingStore extends MemoryStore {
    failNextCommit = false;
    override async commit(writes: Write[]): Promise<void> {
      if (this.failNextCommit) { this.failNextCommit = false; throw new Error('Synthetic transaction failure'); }
      return super.commit(writes);
    }
  }
  const store = new FailingStore();
  await authorizeFixture(store);
  const replacement = `whsec_${Buffer.alloc(32, 8).toString('base64')}`;
  let callbackSecret = secret;
  const events = new Events(store, async (_url, body, headers) => {
    verifyWebhook(callbackSecret, body, headers, clock);
    return { status: 200, body: JSON.stringify({ challenge: JSON.parse(body).challenge }) };
  }, () => clock);
  const subscribed = await events.subscribe(principal, { ...params(), ttlMs: 1000 });
  const metadataKey = { pk: tenantKey(principal.tenant, 'subscriptions', principal.id), sk: subscribed.id };
  const registryKey = { ...metadataKey, sk: '_registry' };
  const signingKey = { pk: tenantKey(principal.tenant, 'subscription-secrets', principal.id), sk: subscribed.id };
  const before = await Promise.all([store.get(metadataKey), store.get(registryKey), store.get(signingKey)]);
  callbackSecret = replacement;
  const renewal = { ...params(), ttlMs: 2000, delivery: { ...params().delivery, secret: replacement } };
  store.failNextCommit = true;
  await assert.rejects(events.subscribe(principal, renewal), /Synthetic transaction failure/);
  assert.deepEqual(await Promise.all([store.get(metadataKey), store.get(registryKey), store.get(signingKey)]), before);
  await events.subscribe(principal, renewal);
  assert.equal((await store.get<Subscription>(metadataKey))?.value.expiresAt, clock + 2000);
  assert.equal((await store.get<SubscriptionSecret>(signingKey))?.value.secret, replacement);
  assert.equal('secret' in (await store.get<Subscription>(metadataKey))!.value, false);
  assert.equal('url' in (await store.get<Subscription>(metadataKey))!.value, false);
  assert.equal((await store.get<SubscriptionSecret>(signingKey))?.value.url, params().delivery.url);
  store.failNextCommit = true;
  await assert.rejects(events.unsubscribe(principal, subscribed.id), /Synthetic transaction failure/);
  assert.equal((await activeSubscriptions(store, principal.tenant, principal.id, clock)).length, 1);
  assert.equal((await store.get<SubscriptionSecret>(signingKey))?.value.secret, replacement);
  await events.unsubscribe(principal, subscribed.id);
  assert.equal((await activeSubscriptions(store, principal.tenant, principal.id, clock)).length, 0);
  assert.equal((await store.get<Subscription>(metadataKey))?.value.active, false);
  const erased = await store.get<SubscriptionSecret>(signingKey);
  assert.deepEqual(erased?.value, {});
  await events.unsubscribe(principal, subscribed.id);
  assert.deepEqual(await store.get<SubscriptionSecret>(signingKey), erased, 'Idempotent revocation performs no replacement write');
});

test('a failed verification cannot replace an existing signing value or metadata', async () => {
  const store = new MemoryStore();
  await authorizeFixture(store);
  let valid = true;
  const events = new Events(store, async (_url, body) => ({ status: 200, body: JSON.stringify({ challenge: valid ? JSON.parse(body).challenge : 'invalid' }) }), () => clock);
  const subscribed = await events.subscribe(principal, params());
  const signingKey = { pk: tenantKey(principal.tenant, 'subscription-secrets', principal.id), sk: subscribed.id };
  const before = await store.get(signingKey);
  valid = false;
  const replacement = `whsec_${Buffer.alloc(32, 9).toString('base64')}`;
  await assert.rejects(events.subscribe(principal, { ...params(), delivery: { ...params().delivery, secret: replacement } }), /callback_challenge_failed/);
  assert.deepEqual(await store.get(signingKey), before);
  assert.equal((await activeSubscriptions(store, principal.tenant, principal.id, clock)).length, 1);
});

test('rotation retains two keys for a bounded window that repeated refresh and restart cannot extend',async()=>{
  const store=new MemoryStore();await authorizeFixture(store);
  let now=clock;
  const echo:OutboundPost=async(_url,body)=>({status:200,body:JSON.stringify({challenge:JSON.parse(body).challenge})});
  let events=new Events(store,echo,()=>now);
  const second=`whsec_${Buffer.alloc(32,18).toString('base64')}`;
  const third=`whsec_${Buffer.alloc(32,19).toString('base64')}`;
  const request=(key:string)=>({...params(),delivery:{...params().delivery,secret:key}});
  const subscribed=await events.subscribe(principal,request(secret));
  const key={pk:tenantKey(principal.tenant,'subscription-secrets',principal.id),sk:subscribed.id};
  now+=1000;
  await events.subscribe(principal,request(second));
  const deadline=now+SIGNING_ROTATION_WINDOW_MS;
  let signing=(await store.get<SubscriptionSecret>(key))!.value;
  assert.deepEqual(signing,{url:params().delivery.url,secret:second,previousSecret:secret,previousSecretExpiresAt:deadline});
  events=new Events(store,echo,()=>now); // No reliance on process memory for grace state.
  now+=1000;
  await events.subscribe(principal,request(second));
  assert.equal((await store.get<SubscriptionSecret>(key))!.value.previousSecretExpiresAt,deadline);
  await assert.rejects(events.subscribe(principal,request(third)),/signing_rotation_in_progress/);
  await assert.rejects(events.subscribe(principal,request(secret)),/signing_rotation_in_progress/);
  assert.equal((await store.get<SubscriptionSecret>(key))!.value.secret,second);
  now=deadline;
  await events.subscribe(principal,request(second));
  signing=(await store.get<SubscriptionSecret>(key))!.value;
  assert.deepEqual(signing,{url:params().delivery.url,secret:second});
  await events.subscribe(principal,request(third));
  assert.equal((await store.get<SubscriptionSecret>(key))!.value.previousSecret,second);
  await events.unsubscribe(principal,subscribed.id);
  assert.deepEqual((await store.get<SubscriptionSecret>(key))!.value,{},'Unsubscribe erases both keys and their deadline');
});

test('competing different rotations cannot discard the winning grace key',async()=>{
  const store=new MemoryStore();await authorizeFixture(store);
  const events=new Events(store,async(_url,body)=>({status:200,body:JSON.stringify({challenge:JSON.parse(body).challenge})}),()=>clock);
  const subscribed=await events.subscribe(principal,params());
  const replacements=[18,19].map(fill=>`whsec_${Buffer.alloc(32,fill).toString('base64')}`);
  const results=await Promise.allSettled(replacements.map(replacement=>events.subscribe(principal,{...params(),delivery:{...params().delivery,secret:replacement}})));
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
  assert.match(String(results.find(result=>result.status==='rejected')?.reason),/signing_rotation_in_progress/);
  const signing=(await store.get<SubscriptionSecret>({pk:tenantKey(principal.tenant,'subscription-secrets',principal.id),sk:subscribed.id}))!.value;
  assert.ok(replacements.includes(signing.secret!));
  assert.equal(signing.previousSecret,secret);
  assert.equal(signing.previousSecretExpiresAt,clock+SIGNING_ROTATION_WINDOW_MS);
});

test('expired or reauthorized subscriptions do not retain a key from the former grant',async()=>{
  for(const reason of ['expired','reauthorized'] as const){
    const store=new MemoryStore();await authorizeFixture(store);let now=clock;
    const events=new Events(store,async(_url,body)=>({status:200,body:JSON.stringify({challenge:JSON.parse(body).challenge})}),()=>now);
    const subscribed=await events.subscribe(principal,{...params(),ttlMs:1000});
    const metadataKey={pk:tenantKey(principal.tenant,'subscriptions',principal.id),sk:subscribed.id};
    const oldGeneration=(await store.get<Subscription>(metadataKey))!.value.generation;
    let renewedPrincipal=principal;
    if(reason==='expired')now+=1000;
    else{
      await setEventAuthorization(store,{tenant:principal.tenant,owner:principal.id},{epoch:'2',active:false},'1');
      await setEventAuthorization(store,{tenant:principal.tenant,owner:principal.id},{epoch:'3',active:true},'2');
      renewedPrincipal={...principal,eventAuthorizationEpoch:'3'};
    }
    const replacement=`whsec_${Buffer.alloc(32,21).toString('base64')}`;
    await events.subscribe(renewedPrincipal,{...params(),delivery:{...params().delivery,secret:replacement}});
    const renewed=(await store.get<Subscription>(metadataKey))!.value;
    assert.ok(validSubscriptionGeneration(renewed.generation));
    assert.notEqual(renewed.generation,oldGeneration);
    assert.deepEqual((await store.get<SubscriptionSecret>({pk:tenantKey(principal.tenant,'subscription-secrets',principal.id),sk:subscribed.id}))!.value,{url:params().delivery.url,secret:replacement});
  }
});

test('legacy or malformed activation metadata is not advertised as an active subscription',async()=>{
  for(const invalid of [undefined,'legacy-generation']){
    const store=new MemoryStore();await authorizeFixture(store);
    const events=new Events(store,callback,()=>clock);
    const subscribed=await events.subscribe(principal,params());
    const key={pk:tenantKey(principal.tenant,'subscriptions',principal.id),sk:subscribed.id};
    const row=(await store.get<Subscription>(key))!;
    await store.commit([{...key,expected:row.version,value:{...row.value,generation:invalid}}]);
    assert.deepEqual(await activeSubscriptions(store,principal.tenant,principal.id,clock),[]);
    await events.subscribe(principal,params());
    const renewed=(await store.get<Subscription>(key))!.value;
    assert.ok(validSubscriptionGeneration(renewed.generation));
    assert.equal((await activeSubscriptions(store,principal.tenant,principal.id,clock)).length,1);
  }
});

test('a refresh that races unsubscribe creates a new activation generation after its CAS retry',async()=>{
  const store=new MemoryStore();await authorizeFixture(store);
  const firstEvents=new Events(store,callback,()=>clock);
  const subscribed=await firstEvents.subscribe(principal,params());
  const key={pk:tenantKey(principal.tenant,'subscriptions',principal.id),sk:subscribed.id};
  const before=(await store.get<Subscription>(key))!.value.generation;
  let entered!:()=>void;let release!:()=>void;
  const started=new Promise<void>(resolve=>{entered=resolve;});
  const continueVerification=new Promise<void>(resolve=>{release=resolve;});
  const refreshingEvents=new Events(store,async(url,body,headers)=>{entered();await continueVerification;return callback(url,body,headers);},()=>clock);
  const refreshing=refreshingEvents.subscribe(principal,params());
  await started;await firstEvents.unsubscribe(principal,subscribed.id);release();
  assert.equal((await refreshing).id,subscribed.id);
  const after=(await store.get<Subscription>(key))!.value.generation;
  assert.ok(validSubscriptionGeneration(after));assert.notEqual(after,before);
});

test('idempotent unsubscribe also clears an inactive record containing only a residual grace key',async()=>{
  const store=new MemoryStore();await authorizeFixture(store);
  const events=new Events(store,callback,()=>clock);
  const subscribed=await events.subscribe(principal,params());
  await events.unsubscribe(principal,subscribed.id);
  const key={pk:tenantKey(principal.tenant,'subscription-secrets',principal.id),sk:subscribed.id};
  const row=(await store.get<SubscriptionSecret>(key))!;
  await store.commit([{...key,expected:row.version,value:{previousSecret:secret,previousSecretExpiresAt:clock+1000}}]);
  await events.unsubscribe(principal,subscribed.id);
  assert.deepEqual((await store.get<SubscriptionSecret>(key))!.value,{});
});

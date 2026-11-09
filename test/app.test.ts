import { claimSortKey } from '../src/retention.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { createHash, webcrypto } from 'node:crypto';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createApp, type AppConfig } from '../src/app.js';
import { Bridge } from '../src/bridge.js';
import { advertisedOAuthScopes, createAuthenticator, privateConfigSchema } from '../src/config.js';
import { activeSubscriptions, Events } from '../src/events.js';
import { setEventAuthorization } from '../src/event-authorization.js';
import { MemoryStore } from '../src/memory-store.js';
import { signWebhook, verifyWebhook } from '../src/transport.js';
import { tenantKey, type Message, type OutboundPost, type Principal } from '../src/types.js';

const issuer = 'https://issuer.example.test';
const resource = 'https://bridge.example.test/bridge/mcp';
const signing = await generateKeyPair('ES256');
const signingJwk = { ...await exportJWK(signing.publicKey), kid: 'test-runtime-key', alg: 'ES256' };
const keys = createLocalJWKSet({ keys: [signingJwk] });
const webhookSecret = `whsec_${Buffer.alloc(32, 11).toString('base64')}`;
const allScopes = ['messages:send', 'messages:read', 'messages:claim', 'events:subscribe'];
const alpha: Principal = { eventAuthorizationEpoch: '1', id: 'alpha', tenant: 'team_sample', scopes: allScopes, peers: ['beta'] };
const beta: Principal = { ...alpha, id: 'beta', peers: ['alpha'] };
const gamma: Principal = { ...alpha, id: 'gamma', peers: ['delta'] };
const delta: Principal = { ...alpha, id: 'delta', peers: ['gamma'] };
const reader: Principal = { id: 'reader', tenant: 'team_sample', scopes: ['history:read'], peers: [], readParticipants: ['alpha'] };
const privateConfig = privateConfigSchema.parse({ subjects: { alpha, beta, gamma, delta, reader }, callbacks: { peer_beta: { principal: beta, secret: webhookSecret } } });
const authenticate = createAuthenticator(privateConfig, issuer, resource, `${issuer}/jwks`, keys);
const now = () => Date.now();
type Era = 'legacy' | 'modern';
type JsonRecord = Record<string, any>;

async function token(subject: string, scope = [...allScopes, 'history:read'].join(' '), overrides: Record<string, unknown> = {}) {
  const at = Math.floor(Date.now() / 1000);
  return new SignJWT({ sub: subject, iss: issuer, aud: resource, iat: at, exp: at + 300, scope, ...overrides })
    .setProtectedHeader({ alg: 'ES256', kid: signingJwk.kid }).sign(signing.privateKey);
}

async function fixture(post?: OutboundPost) {
  const store = new MemoryStore();
  for (const principal of [alpha, beta, gamma, delta]) {
    await setEventAuthorization(store, {tenant: principal.tenant, owner: principal.id}, {epoch: principal.eventAuthorizationEpoch!, active: true}, null);
  }
  const callbackBodies: JsonRecord[] = [];
  const callback: OutboundPost = post ?? (async (_url, raw, headers) => {
    verifyWebhook(webhookSecret, raw, headers);
    assert.match(headers['X-MCP-Subscription-Id'] ?? '', /^sub_/);
    const body = JSON.parse(raw);
    callbackBodies.push(body);
    assert.equal(body.type, 'verification');
    return { status: 200, body: JSON.stringify({ challenge: body.challenge }) };
  });
  const bridge = new Bridge(store, { maxTurns: 20, messagesPerMinute: 30, claimMs: 60_000, webhookRecipients: ['team_sample:beta'] }, now);
  const events = new Events(store, callback, now);
  const config: AppConfig = { resourceUrl: resource, issuer, origins: ['https://viewer.example.test'], authenticate, callbacks: privateConfig.callbacks };
  return { app: createApp(bridge, events, config), store, bridge, events, callbackBodies };
}

async function decode(response: Response): Promise<JsonRecord> {
  const raw = await response.text();
  if (response.headers.get('content-type')?.includes('text/event-stream')) {
    const messages = raw.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).filter(Boolean);
    assert.ok(messages.length > 0, 'SSE response must contain a JSON-RPC message');
    return JSON.parse(messages.at(-1)!);
  }
  return JSON.parse(raw);
}

async function rpc(app: ReturnType<typeof createApp>, subject: string, era: Era, method: string, params: JsonRecord = {}, bearer?: string) {
  const meta = era === 'modern' ? { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} } } : {};
  const request = new Request(resource, {
    method: 'POST',
    headers: { authorization: `Bearer ${bearer ?? await token(subject)}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': era === 'modern' ? '2026-07-28' : '2025-03-26', ...(era === 'modern' ? { 'mcp-method': method, ...(method === 'tools/call' ? { 'mcp-name': String(params.name) } : {}) } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { ...params, ...meta } }),
  });
  const response = await app.fetch(request);
  const body = await decode(response);
  return { status: response.status, body, headers: response.headers };
}
async function tool(app: ReturnType<typeof createApp>, subject: string, era: Era, name: string, args: JsonRecord, bearer?: string) {
  const response = await rpc(app, subject, era, 'tools/call', { name, arguments: args }, bearer);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.error, undefined, JSON.stringify(response.body));
  assert.equal(response.body.result.isError, undefined, JSON.stringify(response.body));
  return response.body.result.structuredContent as JsonRecord;
}
function message(id = 'message_1', conversationId = 'conversation_1') {
  return { id, conversationId, recipient: 'beta', text: 'Synthetic request' };
}

for (const era of ['legacy', 'modern'] as const) {
  test(`${era}: inbox/status tools are gated, authenticated and support recipient-wide discovery`,async()=>{
    const f=await fixture();
    const disabled=await rpc(f.app,'beta',era,'tools/list');
    assert.equal(disabled.body.result.tools.some((t:JsonRecord)=>t.name==='bridge_list_pending'),false);
    f.bridge.config.inboxEnabled=true;
    await tool(f.app,'alpha',era,'bridge_send_message',message('pending_one','one'));
    await tool(f.app,'alpha',era,'bridge_send_message',message('pending_two','two'));
    const first=await tool(f.app,'beta',era,'bridge_list_pending',{limit:1});assert.equal(first.messages.length,1);assert.ok(first.cursor);
    const second=await tool(f.app,'beta',era,'bridge_list_pending',{limit:1,cursor:first.cursor});assert.equal(second.messages.length,1);
    assert.notEqual(first.messages[0].conversationId,second.messages[0].conversationId);
    assert.equal('text' in first.messages[0],false);
    const status=await tool(f.app,'beta',era,'bridge_delivery_status',{});assert.equal(status.deliveries.length,2);
    assert.equal(status.deliveries[0].processing,'unconfirmed');assert.equal(status.deliveries[0].acceptanceEvidence,'unknown');
    const foreign=await rpc(f.app,'alpha',era,'tools/call',{name:'bridge_list_pending',arguments:{cursor:first.cursor}});
    assert.equal(foreign.body.result.isError,true);
    const readerTools=await rpc(f.app,'reader',era,'tools/list');assert.equal(readerTools.body.result.tools.some((t:JsonRecord)=>t.name==='bridge_delivery_status'),false);
  });
  test(`${era}: subscription health discloses no callback or signing value and cannot expand access`,async()=>{
    const f=await fixture();
    await f.events.subscribe(alpha,{name:'message.received',delivery:{mode:'webhook',url:'https://callback.example.test/events',secret:webhookSecret}});
    const health=await tool(f.app,'alpha',era,'bridge_subscription_status',{});
    assert.equal(health.subscriptions.length,1);assert.equal(health.subscriptions[0].authorized,true);assert.equal(health.subscriptions[0].expired,false);
    const serialized=JSON.stringify(health);assert.equal(serialized.includes(webhookSecret),false);assert.equal(serialized.includes('callback.example.test'),false);
    assert.equal((await tool(f.app,'beta',era,'bridge_subscription_status',{})).subscriptions.length,0);
  });
  test(`${era}: SDK discovery advertises events and tools expose nonempty JSON schemas`, async () => {
    const { app } = await fixture();
    const discovery = await rpc(app, 'alpha', era, era === 'legacy' ? 'initialize' : 'server/discover', era === 'legacy' ? {
      protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'synthetic-client', version: '1.0.0' },
    } : {});
    assert.equal(discovery.status, 200, JSON.stringify(discovery.body));
    assert.deepEqual(discovery.body.result.capabilities.events, {});
    if (era === 'modern') {
      assert.equal(discovery.body.result.resultType, 'complete');
      assert.ok(discovery.body.result.supportedVersions.includes('2026-07-28'));
    } else assert.equal(discovery.body.result.protocolVersion, '2025-03-26');
    const catalog = await rpc(app, 'alpha', era, 'tools/list');
    assert.equal(catalog.status, 200, JSON.stringify(catalog.body));
    const send = catalog.body.result.tools.find((item: JsonRecord) => item.name === 'bridge_send_message');
    assert.equal(send.inputSchema.type, 'object');
    assert.deepEqual(new Set(send.inputSchema.required), new Set(['id', 'conversationId', 'recipient', 'text']));
    assert.equal(send.inputSchema.additionalProperties, false);
    assert.equal(send.inputSchema.properties.text.type, 'string');
    const acknowledge = catalog.body.result.tools.find((item: JsonRecord) => item.name === 'bridge_acknowledge_message');
    assert.deepEqual(new Set(acknowledge.inputSchema.required), new Set(['conversationId', 'messageId', 'fence']));
    assert.equal(acknowledge.inputSchema.additionalProperties, false);
    assert.equal(acknowledge.inputSchema.properties.fence.type, 'integer');
    assert.equal(acknowledge.annotations.idempotentHint, true);
    assert.equal(acknowledge.annotations.readOnlyHint, false);
    assert.equal(acknowledge.annotations.openWorldHint, false);
  });

  test(`${era}: two identities send, claim and complete through real SDK tools with idempotent history`, async () => {
    const { app } = await fixture();
    const sent = await tool(app, 'alpha', era, 'bridge_send_message', message());
    assert.equal(sent.message.sender, 'alpha');
    assert.equal(sent.duplicate, false);
    assert.equal((await tool(app, 'alpha', era, 'bridge_send_message', message())).duplicate, true);
    const claimed = await tool(app, 'beta', era, 'bridge_claim_message', { conversationId: 'conversation_1', messageId: 'message_1' });
    assert.equal(claimed.status, 'claimed');
    assert.equal(claimed.fence, 1);
    const response = { id: 'reply_1', conversationId: 'conversation_1', recipient: 'alpha', text: 'Synthetic response', replyTo: 'message_1', fence: claimed.fence };
    const completed = await tool(app, 'beta', era, 'bridge_complete_message', response);
    assert.equal(completed.message.replyTo, 'message_1');
    assert.equal(completed.message.sender, 'beta');
    assert.equal((await tool(app, 'beta', era, 'bridge_complete_message', response)).duplicate, true);
    const history = await tool(app, 'alpha', era, 'bridge_read_history', { conversationId: 'conversation_1' });
    assert.deepEqual(history.messages.map((item: Message) => item.text), ['Synthetic request', 'Synthetic response']);
    assert.deepEqual(history.messages.map((item: Message) => item.turn), [1, 2]);
  });

  test(`${era}: SDK limita elementos dos argumentos antes da validação sem limitar o texto válido`, async () => {
    const { app, store } = await fixture();
    for (const extra of [
      { nested: { values: Array(128).fill(null) } },
      Object.fromEntries(Array.from({ length: 129 }, (_, index) => [`extra_${index}`, null])),
    ]) {
      const args = { ...message(), ...extra };
      assert.ok(Buffer.byteLength(JSON.stringify(args)) < 65_536);
      const rejected = await rpc(app, 'alpha', era, 'tools/call', { name: 'bridge_send_message', arguments: args });
      assert.equal(rejected.status, 200);
      assert.equal(rejected.body.result.isError, true, JSON.stringify(rejected.body));
      assert.match(rejected.body.result.content[0].text, /arguments contain more than the maximum of 128 elements/);
      assert.equal((await store.query(tenantKey(alpha.tenant, 'history', 'conversation_1'), '', 100)).items.length, 0);
      assert.equal((await store.query(tenantKey(alpha.tenant, 'outbox', beta.id), '', 100)).items.length, 0);
    }
    const args = { ...message(), text: 'x'.repeat(16_384) };
    const accepted = await tool(app, 'alpha', era, 'bridge_send_message', args);
    assert.equal(accepted.message.text, args.text);
    assert.equal(accepted.duplicate, false);
    assert.equal((await tool(app, 'beta', era, 'bridge_read_history', { conversationId: 'conversation_1' })).messages.length, 1);
  });

  test(`${era}: ACK terminal pelo SDK é idempotente e não publica outra mensagem`, async () => {
    const { app } = await fixture();
    await tool(app, 'alpha', era, 'bridge_send_message', message());
    const requestClaim = await tool(app, 'beta', era, 'bridge_claim_message', { conversationId: 'conversation_1', messageId: 'message_1' });
    await tool(app, 'beta', era, 'bridge_complete_message', {
      id: 'terminal_reply', conversationId: 'conversation_1', recipient: 'alpha', text: 'Synthetic terminal response', replyTo: 'message_1', fence: requestClaim.fence,
    });
    const replyClaim = await tool(app, 'alpha', era, 'bridge_claim_message', { conversationId: 'conversation_1', messageId: 'terminal_reply' });
    const args = { conversationId: 'conversation_1', messageId: 'terminal_reply', fence: replyClaim.fence };
    const forbidden = await rpc(app, 'beta', era, 'tools/call', { name: 'bridge_acknowledge_message', arguments: args });
    assert.equal(forbidden.body.result.isError, true);
    assert.equal(forbidden.body.result.content[0].text, 'claim_forbidden');
    const result = await tool(app, 'alpha', era, 'bridge_acknowledge_message', args);
    assert.deepEqual(result, { status: 'done', outcome: 'acknowledged', messageId: 'terminal_reply', duplicate: false });
    assert.deepEqual(await tool(app, 'alpha', era, 'bridge_acknowledge_message', args), { ...result, duplicate: true });
    assert.deepEqual(await tool(app, 'alpha', era, 'bridge_claim_message', { conversationId: 'conversation_1', messageId: 'terminal_reply' }), { status: 'done', outcome: 'acknowledged' });
    const history = await tool(app, 'alpha', era, 'bridge_read_history', { conversationId: 'conversation_1' });
    assert.deepEqual(history.messages.map((item: Message) => item.id), ['message_1', 'terminal_reply']);
    assert.deepEqual(history.messages.map((item: Message) => item.turn), [1, 2]);
  });

  test(`${era}: ACK exige escopos atuais e rejeita argumentos fora do contrato sem alterar a reserva`, async () => {
    const { app, bridge, store } = await fixture();
    await bridge.send(alpha, message());
    const firstClaim = await bridge.claim(beta, 'conversation_1', 'message_1');
    assert.equal(firstClaim.status, 'claimed');
    await bridge.complete(beta, { id: 'terminal_reply', conversationId: 'conversation_1', recipient: 'alpha', text: 'Synthetic terminal response', replyTo: 'message_1', fence: firstClaim.fence! });
    const replyClaim = await bridge.claim(alpha, 'conversation_1', 'terminal_reply');
    assert.equal(replyClaim.status, 'claimed');
    const args = { conversationId: 'conversation_1', messageId: 'terminal_reply', fence: replyClaim.fence };
    const key = { pk: tenantKey(alpha.tenant, 'claims', 'conversation_1'), sk: claimSortKey(await bridge.getMessage(alpha,'conversation_1','terminal_reply')) };
    const before = await store.get(key);
    for (const invalid of [{ ...args, sender: 'alpha' }, { ...args, recipient: 'alpha' }, { ...args, fence: 0 }, { ...args, fence: 1.5 }, { ...args, fence: Number.MAX_SAFE_INTEGER + 1 }, { conversationId: args.conversationId, messageId: args.messageId }]) {
      const denied = await rpc(app, 'alpha', era, 'tools/call', { name: 'bridge_acknowledge_message', arguments: invalid });
      assert.ok(denied.body.error || denied.body.result?.isError, JSON.stringify(denied.body));
      assert.deepEqual(await store.get(key), before);
    }
    const readOnlyToken = await token('alpha', 'messages:read');
    const catalog = await rpc(app, 'alpha', era, 'tools/list', {}, readOnlyToken);
    assert.ok(!catalog.body.result.tools.some((item: JsonRecord) => item.name === 'bridge_acknowledge_message'));
    const unavailable = await rpc(app, 'alpha', era, 'tools/call', { name: 'bridge_acknowledge_message', arguments: args }, readOnlyToken);
    assert.ok(unavailable.body.error || unavailable.body.result?.isError, JSON.stringify(unavailable.body));
    const claimOnlyToken = await token('alpha', 'messages:claim');
    const unreadable = await rpc(app, 'alpha', era, 'tools/call', { name: 'bridge_acknowledge_message', arguments: args }, claimOnlyToken);
    assert.equal(unreadable.body.result.isError, true);
    assert.equal(unreadable.body.result.content[0].text, 'forbidden');
    assert.deepEqual(await store.get(key), before);
    const claimReadToken = await token('alpha', 'messages:claim messages:read');
    assert.equal((await tool(app, 'alpha', era, 'bridge_acknowledge_message', args, claimReadToken)).duplicate, false);
  });

  test(`${era}: event list, subscribe and unsubscribe use authenticated raw protocol extension methods`, async () => {
    const { app, callbackBodies, store } = await fixture();
    const list = await rpc(app, 'beta', era, 'events/list');
    assert.equal(list.status, 200, JSON.stringify(list.body));
    assert.equal(list.body.result.events[0].name, 'message.received');
    assert.deepEqual(list.body.result.events[0].delivery, ['webhook']);
    const params = { name: 'message.received', arguments: { conversationId: 'conversation_1' }, delivery: { mode: 'webhook', url: 'https://callback.example.test/event', secret: webhookSecret }, cursor: null };
    const sub = await rpc(app, 'beta', era, 'events/subscribe', params);
    assert.equal(sub.status, 200, JSON.stringify(sub.body));
    assert.equal(sub.body.error, undefined, JSON.stringify(sub.body));
    assert.match(sub.body.result.id, /^sub_/);
    assert.equal(sub.body.result.cursor, null);
    assert.equal(callbackBodies.length, 1);
    await tool(app, 'alpha', era, 'bridge_send_message', message());
    const outbox = await store.query(tenantKey(alpha.tenant, 'outbox', beta.id), '', 100);
    assert.equal(outbox.items.filter(row => row.value.kind === 'event').length, 1);
    const unsubscribe = await rpc(app, 'beta', era, 'events/unsubscribe', { name: params.name, arguments: params.arguments, delivery: { mode: 'webhook', url: params.delivery.url } });
    assert.equal(unsubscribe.status, 200, JSON.stringify(unsubscribe.body));
    assert.equal(unsubscribe.body.error, undefined, JSON.stringify(unsubscribe.body));
    assert.equal((await activeSubscriptions(store, beta.tenant, beta.id)).length, 0);
  });
}

test('MCP callback failures return the ChatGPT extension error without saving a subscription', async () => {
  const { app, store } = await fixture(async () => ({ status: 200, body: '{"challenge":"incorrect"}' }));
  const sub = await rpc(app, 'beta', 'modern', 'events/subscribe', { name: 'message.received', arguments: {}, delivery: { mode: 'webhook', url: 'https://callback.example.test/event', secret: webhookSecret } });
  assert.equal(sub.body.error.code, -32015, JSON.stringify(sub.body));
  assert.equal(sub.body.error.data.reason, 'callback_challenge_failed');
  assert.equal((await activeSubscriptions(store, beta.tenant, beta.id)).length, 0);
});

test('request boundary rejects missing auth, malformed/oversize bodies and unapproved Origin', async () => {
  const { app } = await fixture();
  const unauthorized = await app.fetch(new Request(resource, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }));
  assert.equal(unauthorized.status, 401);
  assert.equal(unauthorized.headers.get('www-authenticate'), 'Bearer resource_metadata="https://bridge.example.test/.well-known/oauth-protected-resource/bridge/mcp"');
  const headers = { authorization: `Bearer ${await token('alpha')}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  const malformed = await app.fetch(new Request(resource, { method: 'POST', headers, body: 'not-json' }));
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).error.code, -32700);
  const oversize = await app.fetch(new Request(resource, { method: 'POST', headers, body: JSON.stringify({ padding: 'x'.repeat(70_000) }) }));
  assert.equal(oversize.status, 413);
  const preParsed = await app.fetch(new Request(resource, { method: 'POST', headers }), { parsedBody: { padding: 'x'.repeat(70_000) } });
  assert.equal(preParsed.status, 413);
  const forbiddenOrigin = await app.fetch(new Request(resource, { method: 'POST', headers: { ...headers, origin: 'https://unapproved.example.test' }, body: '{}' }));
  assert.equal(forbiddenOrigin.status, 403);
  const validOrigin = await rpc(app, 'alpha', 'modern', 'tools/list');
  assert.equal(validOrigin.status, 200);
  const metadata = await app.fetch(new Request('https://bridge.example.test/.well-known/oauth-protected-resource/bridge/mcp'));
  assert.equal(metadata.status, 200);
  assert.equal((await metadata.json()).resource, resource);
});

test('signed peer callback rejects wrong signer before storage and distinguishes delivery replay from message retry', async () => {
  const { app, store, bridge } = await fixture();
  const body = JSON.stringify({ action: 'send', arguments: { id: 'peer_message', conversationId: 'peer_conversation', recipient: 'alpha', text: 'Synthetic peer request' } });
  async function peer(deliveryId: string, key = webhookSecret, raw = body) {
    return app.fetch(new Request('https://bridge.example.test/peer', { method: 'POST', body: raw, headers: { ...signWebhook(key, deliveryId, raw), 'x-bridge-key-id': 'peer_beta' } }));
  }
  const wrong = await peer('delivery_wrong', `whsec_${Buffer.alloc(32, 12).toString('base64')}`);
  assert.equal(wrong.status, 401);
  assert.equal((await store.query(tenantKey(beta.tenant, 'callback', beta.id), '', 100)).items.length, 0);
  assert.equal((await store.query(tenantKey(beta.tenant, 'history', 'peer_conversation'), '', 100)).items.length, 0);
  const accepted = await peer('delivery_first');
  assert.equal(accepted.status, 200, await accepted.clone().text());
  assert.equal((await accepted.json()).duplicate, false);
  assert.equal((await peer('delivery_first')).status, 409);
  const retry = await peer('delivery_second');
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).duplicate, true);
  assert.equal((await bridge.history(alpha, 'peer_conversation')).messages.length, 1);
  const tampered = await app.fetch(new Request('https://bridge.example.test/peer', { method: 'POST', body: body + ' ', headers: { ...signWebhook(webhookSecret, 'delivery_tamper', body), 'x-bridge-key-id': 'peer_beta' } }));
  assert.equal(tampered.status, 401);
});

test('ACK assinado mantém autenticação e distingue replay do envelope de retry idempotente', async () => {
  const { app, bridge, store } = await fixture();
  await bridge.send(beta, { id: 'peer_request', conversationId: 'peer_conversation', recipient: 'alpha', text: 'Synthetic peer request' });
  const requestClaim = await bridge.claim(alpha, 'peer_conversation', 'peer_request');
  assert.equal(requestClaim.status, 'claimed');
  await bridge.complete(alpha, { id: 'peer_terminal_reply', conversationId: 'peer_conversation', recipient: 'beta', text: 'Synthetic terminal response', replyTo: 'peer_request', fence: requestClaim.fence! });
  const terminalClaim = await bridge.claim(beta, 'peer_conversation', 'peer_terminal_reply');
  assert.equal(terminalClaim.status, 'claimed');
  const args = { conversationId: 'peer_conversation', messageId: 'peer_terminal_reply', fence: terminalClaim.fence };
  const body = JSON.stringify({ action: 'acknowledge', arguments: args });
  const key = { pk: tenantKey(beta.tenant, 'claims', 'peer_conversation'), sk: claimSortKey(await bridge.getMessage(beta,'peer_conversation','peer_terminal_reply')) };
  const before = await store.get(key);
  async function peer(deliveryId: string, secret = webhookSecret) {
    return app.fetch(new Request('https://bridge.example.test/peer', { method: 'POST', body, headers: { ...signWebhook(secret, deliveryId, body), 'x-bridge-key-id': 'peer_beta' } }));
  }
  const wrong = await peer('ack_wrong_signer', `whsec_${Buffer.alloc(32, 12).toString('base64')}`);
  assert.equal(wrong.status, 401);
  assert.deepEqual(await store.get(key), before);
  const accepted = await peer('ack_first_envelope');
  assert.equal(accepted.status, 200);
  const result = await accepted.json();
  assert.deepEqual(result, { status: 'done', outcome: 'acknowledged', messageId: 'peer_terminal_reply', duplicate: false });
  assert.equal((await peer('ack_first_envelope')).status, 409);
  const retry = await peer('ack_second_envelope');
  assert.equal(retry.status, 200);
  assert.deepEqual(await retry.json(), { ...result, duplicate: true });
  assert.deepEqual((await bridge.history(beta, 'peer_conversation')).messages.map(item => item.id), ['peer_request', 'peer_terminal_reply']);
});

test('JWT validation rejects expiry, issuer, audience, unknown subject, bad signing key and missing required claims', async () => {
  const at = Math.floor(Date.now() / 1000);
  for (const overrides of [{ exp: at - 10 }, { iss: 'https://wrong.example.test' }, { aud: 'wrong-audience' }, { sub: 'unknown' }, { iat: undefined }, { exp: undefined }]) {
    const request = new Request(resource, { headers: { authorization: `Bearer ${await token('alpha', allScopes.join(' '), overrides)}` } });
    await assert.rejects(authenticate(request), /unauthorized/, JSON.stringify(overrides));
  }
  const otherSigning = await generateKeyPair('ES256');
  const wrongKey = await new SignJWT({ sub: 'alpha', iss: issuer, aud: resource, iat: at, exp: at + 60, scope: allScopes.join(' ') }).setProtectedHeader({ alg: 'ES256', kid: signingJwk.kid }).sign(otherSigning.privateKey);
  await assert.rejects(authenticate(new Request(resource, { headers: { authorization: `Bearer ${wrongKey}` } })), /unauthorized/);
  const scoped = await authenticate(new Request(resource, { headers: { authorization: `Bearer ${await token('alpha', 'messages:read history:read admin:all')}` } }));
  assert.deepEqual(scoped.scopes, ['messages:read']);
  assert.equal(scoped.id, 'alpha');
  assert.deepEqual(scoped.peers, ['beta']);
});

test('human history identity sees permitted conversations only and cannot discover or call mutations', async () => {
  const { app, bridge } = await fixture();
  await bridge.send(alpha, message('allowed'));
  await bridge.send(gamma, { id: 'hidden', conversationId: 'private_other', recipient: 'delta', text: 'Unrelated synthetic conversation' });
  const catalog = await rpc(app, 'reader', 'modern', 'tools/list');
  assert.deepEqual(catalog.body.result.tools.map((item: JsonRecord) => item.name), ['bridge_read_history']);
  const allowed = await tool(app, 'reader', 'modern', 'bridge_read_history', { conversationId: 'conversation_1' });
  assert.equal(allowed.messages[0].id, 'allowed');
  const denied = await rpc(app, 'reader', 'modern', 'tools/call', { name: 'bridge_read_history', arguments: { conversationId: 'private_other' } });
  assert.equal(denied.body.result.isError, true);
  assert.match(denied.body.result.content[0].text, /conversation_not_found/);
  const mutation = await rpc(app, 'reader', 'modern', 'tools/call', { name: 'bridge_send_message', arguments: message('forbidden') });
  assert.ok(mutation.body.error || mutation.body.result?.isError, JSON.stringify(mutation.body));
  const auth = { authorization: `Bearer ${await token('reader')}` };
  const restHistory = await app.fetch(new Request('https://bridge.example.test/history?conversationId=conversation_1', { headers: auth }));
  assert.equal(restHistory.status, 200);
  assert.equal((await restHistory.json()).messages.length, 1);
  const otherHistory = await app.fetch(new Request('https://bridge.example.test/history?conversationId=private_other', { headers: auth }));
  assert.equal(otherHistory.status, 404);
  const viewer = await app.fetch(new Request('https://bridge.example.test/viewer'));
  const viewerHtml = await viewer.text();
  assert.match(viewerHtml, /type="password"/);
  assert.match(viewerHtml, /Authorization:'Bearer '\+currentToken/);
  assert.doesNotMatch(viewerHtml, /localStorage|document.cookie/);
  assert.doesNotMatch(viewerHtml, /Synthetic request|Unrelated synthetic conversation/);
  const anonymousHistory = await app.fetch(new Request('https://bridge.example.test/history?conversationId=conversation_1'));
  assert.equal(anonymousHistory.status, 401);
  assert.equal(viewer.status, 200);
  assert.match(viewer.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
});


test('history viewer sends its in-memory token only as a header and renders message content as text', async () => {
  const { app } = await fixture();
  const response = await app.fetch(new Request('https://bridge.example.test/viewer'));
  const html = await response.text();
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1];
  assert.ok(script);
  const requests: { url: string; init: { headers: { Authorization: string } } }[] = [];
  const rendered: { textContent: string }[] = [];
  const tokenInput = { value: 'synthetic-access-token' };
  const form = { onsubmit: undefined as ((event: object) => void) | undefined };
  const more = { hidden: true, onclick: undefined as (() => void) | undefined };
  const clear = { onclick: undefined as (() => void) | undefined };
  const main = { textContent: '', append: (node: { textContent: string }) => rendered.push(node) };
  const elements: Record<string, unknown> = { '#token': tokenInput, form, '#more': more, '#clear': clear, '#status': { textContent: '' }, main };
  runInNewContext(script, {
    URLSearchParams,
    document: { querySelector: (selector: string) => elements[selector], createElement: () => ({ textContent: '' }) },
    fetch: async (url: string, init: { headers: { Authorization: string } }) => {
      requests.push({ url, init });
      return { ok: true, json: async () => ({ messages: [{ timestamp: '2026-01-01T00:00:00Z', sender: 'alpha', recipient: 'beta', text: '<script>untrusted text</script>' }] }) };
    },
  });
  form.onsubmit!({ preventDefault() {}, target: { conversation: { value: 'conversation_1' } } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.url, '/history?conversationId=conversation_1');
  assert.equal(requests[0]?.init.headers.Authorization, 'Bearer synthetic-access-token');
  assert.match(rendered[0]?.textContent ?? '', /<script>untrusted text<\/script>/);
  clear.onclick!();
  assert.equal(tokenInput.value, '');
  assert.equal(main.textContent, '');
  assert.equal(more.hidden, true);
});


test('MCP maps the same JWT subject to separate client principals with exact external scope aliases', async () => {
  const f = await fixture();
  const config = privateConfigSchema.parse({
    // Legacy entries must not act as fallback when client namespaces are enabled.
    subjects: { shared_subject: reader },
    clientSubjects: { client_alpha: { shared_subject: alpha }, client_beta: { shared_subject: beta } },
    scopeAliases: { 'service/read': 'messages:read', 'service/send': 'messages:send', 'service/claim': 'messages:claim' },
  });
  const app = createApp(f.bridge, f.events, {
    resourceUrl: resource, issuer, origins: [], callbacks: {},
    authenticate: createAuthenticator(config, issuer, resource, `${issuer}/jwks`, keys),
  });
  const scopes = 'service/read service/send service/claim';
  const alphaToken = await token('shared_subject', scopes, { client_id: 'client_alpha' });
  const betaToken = await token('shared_subject', scopes, { azp: 'client_beta' });
  const sent = await tool(app, 'ignored', 'modern', 'bridge_send_message', message(), alphaToken);
  assert.equal(sent.message.sender, 'alpha');
  const claimed = await tool(app, 'ignored', 'modern', 'bridge_claim_message', { conversationId: 'conversation_1', messageId: 'message_1' }, betaToken);
  const completed = await tool(app, 'ignored', 'modern', 'bridge_complete_message', {
    id: 'reply_client', conversationId: 'conversation_1', recipient: 'alpha', text: 'Synthetic client response', replyTo: 'message_1', fence: claimed.fence,
  }, betaToken);
  assert.equal(completed.message.sender, 'beta');
  const history = await tool(app, 'ignored', 'modern', 'bridge_read_history', { conversationId: 'conversation_1' }, alphaToken);
  assert.deepEqual(history.messages.map((item: Message) => item.sender), ['alpha', 'beta']);
  const missingClient = await rpc(app, 'shared_subject', 'modern', 'tools/list');
  assert.equal(missingClient.status, 401);
});


const viewerOAuth = {
  authorizeUrl: 'https://login.example.test/oauth2/authorize', tokenUrl: 'https://login.example.test/oauth2/token',
  clientId: 'reader-public-client', redirectUri: 'https://bridge.example.test/viewer', resource, scopes: ['bridge/history:read'],
  authorizationResponseIssuerRequired: false,
};
const pkceStorageKey = 'agent-message-bridge.viewer.pkce.v1';
test('OAuth resource metadata advertises configured external scopes without private identity mappings',async()=>{
  const f=await fixture();
  const config=privateConfigSchema.parse({
    subjects:{private_subject:alpha},
    scopeAliases:{'bridge/messages:send':'messages:send','bridge/messages:read':'messages:read','bridge/history:read':'history:read'},
  });
  const app=createApp(f.bridge,f.events,{resourceUrl:resource,issuer,origins:[],callbacks:{},authenticate,advertisedScopes:advertisedOAuthScopes(config)});
  const response=await app.fetch(new Request('https://bridge.example.test/.well-known/oauth-protected-resource/bridge/mcp'));
  assert.equal(response.status,200);
  const metadata=await response.json() as {scopes_supported:string[]};
  assert.deepEqual(metadata.scopes_supported,['bridge/messages:send','bridge/messages:read','bridge/history:read']);
  assert.doesNotMatch(JSON.stringify(metadata),/private_subject|team_sample/);
  assert.equal(metadata.scopes_supported.includes('messages:send'),false);
});

async function oauthPage(overrides: Partial<typeof viewerOAuth> = {}, audience = resource) {
  const f = await fixture();
  const app = createApp(f.bridge, f.events, {
    resourceUrl: resource, issuer, origins: [], callbacks: {}, authenticate,
    viewerOAuth: { ...viewerOAuth, ...overrides }, oauthAudience: audience,
  });
  return app.fetch(new Request(viewerOAuth.redirectUri));
}
interface BrowserOptions {
  url?: string;
  storage?: Map<string, string>;
  at?: number;
  fetch?: (url: string, init: Record<string, any>) => Promise<any>;
}
async function browser(html: string, options: BrowserOptions = {}) {
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1];
  assert.ok(script);
  const storage = options.storage ?? new Map<string, string>();
  const writes: string[] = [];
  const navigations: string[] = [];
  const replacements: string[] = [];
  const requests: { url: string; init: Record<string, any> }[] = [];
  const rendered: { textContent: string }[] = [];
  const status = { textContent: '' };
  const form = { onsubmit: undefined as ((event: object) => Promise<void>) | undefined };
  const login = { disabled: false, onclick: undefined as (() => Promise<void>) | undefined };
  const clear = { onclick: undefined as (() => void) | undefined };
  const more = { hidden: true, onclick: undefined as (() => Promise<void>) | undefined };
  const main = { textContent: '', append: (node: { textContent: string }) => rendered.push(node) };
  const elements: Record<string, unknown> = { form, '#login': login, '#clear': clear, '#more': more, '#status': status, main };
  let at = options.at ?? Date.now();
  const location = { href: options.url ?? viewerOAuth.redirectUri, assign: (url: string) => navigations.push(url) };
  const ready = runInNewContext(script + ';oauthReady;', {
    URL, URLSearchParams, TextEncoder, Uint8Array, crypto: webcrypto, AbortSignal,
    btoa: (input: string) => Buffer.from(input, 'binary').toString('base64'),
    Date: class extends Date { static override now() { return at; } },
    location,
    history: { replaceState: (_state: unknown, _title: string, url: string) => { replacements.push(url); location.href = url; } },
    sessionStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { writes.push(value); storage.set(key, value); },
      removeItem: (key: string) => storage.delete(key),
    },
    document: { querySelector: (selector: string) => elements[selector], createElement: () => ({ textContent: '' }) },
    fetch: async (url: string, init: Record<string, any>) => {
      requests.push({ url, init });
      assert.ok(replacements.length > 0, 'callback URL must be scrubbed before any exchange or authenticated read');
      assert.equal(storage.has(pkceStorageKey), false, 'PKCE verifier must be consumed before exchange');
      return options.fetch ? options.fetch(url, init) : { ok: true, status: 200, json: async () => ({ access_token: 'ephemeral-access-token', refresh_token: 'discard-refresh-token', id_token: 'discard-id-token', token_type: 'Bearer', expires_in: 60 }) };
    },
  }) as Promise<void>;
  await ready;
  return { storage, writes, navigations, replacements, requests, rendered, status, login, clear, more, main, advance: (ms: number) => { at += ms; }, submit: () => form.onsubmit!({ preventDefault() {}, target: { conversation: { value: 'conversation_1' } } }) };
}
function pendingTransaction(at = Date.now(), issuerRequired = viewerOAuth.authorizationResponseIssuerRequired) {
  return { verifier: 'V'.repeat(43), state: 'S'.repeat(43), createdAt: at, clientId: viewerOAuth.clientId, redirectUri: viewerOAuth.redirectUri, resource, tokenUrl: viewerOAuth.tokenUrl, issuer, issuerRequired };
}

test('optional OAuth viewer uses real WebCrypto S256 and completes public-client code exchange without persisting tokens', async () => {
  const response = await oauthPage();
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.match(response.headers.get('content-security-policy') ?? '', /connect-src 'self' https:\/\/login.example.test/);
  const html = await response.text();
  assert.doesNotMatch(html, /type="password"/);
  const first = await browser(html);
  await first.login.onclick!();
  assert.equal(first.navigations.length, 1);
  const authorization = new URL(first.navigations[0]!);
  const pending = JSON.parse(first.storage.get(pkceStorageKey)!);
  assert.match(pending.verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.match(pending.state, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(pending.verifier, pending.state);
  assert.equal(pending.issuer, issuer);
  assert.equal(pending.issuerRequired, viewerOAuth.authorizationResponseIssuerRequired);
  assert.equal(authorization.searchParams.get('code_challenge'), createHash('sha256').update(pending.verifier).digest('base64url'));
  for (const [key, value] of Object.entries({ response_type: 'code', client_id: viewerOAuth.clientId, redirect_uri: viewerOAuth.redirectUri, resource, scope: 'bridge/history:read', code_challenge_method: 'S256', state: pending.state })) {
    assert.equal(authorization.searchParams.get(key), value);
  }
  const callback = await browser(html, {
    storage: first.storage,
    url: viewerOAuth.redirectUri + '?code=synthetic-code&state=' + pending.state + '&iss=' + encodeURIComponent(issuer),
    fetch: async (url, init) => url === viewerOAuth.tokenUrl
      ? { ok: true, json: async () => ({ access_token: 'ephemeral-access-token', refresh_token: 'discard-refresh-token', id_token: 'discard-id-token', token_type: 'Bearer', expires_in: 60 }) }
      : { ok: true, json: async () => ({ messages: [{ timestamp: '2026-01-01T00:00:00Z', sender: 'alpha', recipient: 'beta', text: 'Visible history' }] }) },
  });
  assert.deepEqual(callback.replacements, [viewerOAuth.redirectUri]);
  assert.equal(callback.storage.size, 0);
  assert.match(callback.status.textContent, /Signed in/);
  const exchange = callback.requests[0]!;
  assert.equal(exchange.url, viewerOAuth.tokenUrl);
  assert.equal(exchange.init.method, 'POST');
  assert.equal(exchange.init.credentials, 'omit');
  assert.equal(exchange.init.redirect, 'error');
  const form = new URLSearchParams(exchange.init.body);
  assert.equal(form.get('grant_type'), 'authorization_code');
  assert.equal(form.get('code'), 'synthetic-code');
  assert.equal(form.get('code_verifier'), pending.verifier);
  assert.equal(form.get('client_id'), viewerOAuth.clientId);
  assert.equal(form.get('redirect_uri'), viewerOAuth.redirectUri);
  assert.equal(form.get('resource'), authorization.searchParams.get('resource'));
  assert.equal(form.has('client_secret'), false);
  assert.equal(exchange.init.headers.Authorization, undefined);
  await callback.submit();
  assert.equal(callback.requests[1]?.url, '/history?conversationId=conversation_1');
  assert.equal(callback.requests[1]?.init.headers.Authorization, 'Bearer ephemeral-access-token');
  assert.match(callback.rendered[0]?.textContent ?? '', /Visible history/);
  assert.equal(callback.writes.length, 0);
  assert.doesNotMatch(first.writes.join(''), /access_token|refresh_token|id_token|synthetic-code/);
  callback.advance(60_001);
  await callback.submit();
  assert.equal(callback.requests.length, 2, 'expired tokens must not be sent');
  callback.clear.onclick!();
  assert.equal(callback.storage.size, 0);
});

test('OAuth callback rejects wrong/missing/expired/replayed state and issuer before any exchange', async () => {
  const html = await (await oauthPage()).text();
  const at = Date.now();
  for (const scenario of [
    { query: '?code=test&state=wrong', pending: pendingTransaction(at) },
    { query: '?code=test', pending: pendingTransaction(at) },
    { query: '?code=test&state=' + 'S'.repeat(43), pending: pendingTransaction(at - 600_001) },
    { query: '?code=test&state=' + 'S'.repeat(43), pending: undefined },
    { query: '?code=test&state=' + 'S'.repeat(43) + '&state=' + 'S'.repeat(43), pending: pendingTransaction(at) },
    { query: '?code=test&state=' + 'S'.repeat(43) + '&iss=https%3A%2F%2Fwrong.example.test', pending: pendingTransaction(at) },
    { query: '?code=test&state=' + 'S'.repeat(43) + '&iss=' + encodeURIComponent(issuer) + '&iss=' + encodeURIComponent(issuer), pending: pendingTransaction(at) },
    { query: '?error=access_denied&state=' + 'S'.repeat(43), pending: pendingTransaction(at) },
    { query: '?code=test&state=' + 'S'.repeat(43), pending: { ...pendingTransaction(at), clientId: 'other-client' } },
    { query: '?code=test&state=' + 'S'.repeat(43), pending: { ...pendingTransaction(at), resource: 'https://other.example.test/mcp' } },
    { query: '?code=test&state=' + 'S'.repeat(43), pending: { ...pendingTransaction(at), issuer: 'https://old-issuer.example.test' } },
    { query: '?code=test&state=' + 'S'.repeat(43), pending: { ...pendingTransaction(at), issuerRequired: true } },
    { query: '?code=test&state=' + 'S'.repeat(43), pending: pendingTransaction(at + 1000) },
  ]) {
    const storage = new Map(scenario.pending ? [[pkceStorageKey, JSON.stringify(scenario.pending)]] : []);
    const page = await browser(html, { url: viewerOAuth.redirectUri + scenario.query, storage, at });
    assert.equal(page.requests.length, 0, scenario.query);
    assert.equal(page.storage.size, 0);
    assert.deepEqual(page.replacements, [viewerOAuth.redirectUri]);
    assert.match(page.status.textContent, /Sign-in failed or expired/);
  }
});

test('OAuth viewer enforces the configured issuer policy before exchanging a code', async () => {
  const at = Date.now();
  for (const required of [false, true]) {
    const html = await (await oauthPage({ authorizationResponseIssuerRequired: required })).text();
    for (const scenario of [
      { suffix: '', succeeds: !required },
      { suffix: '&authorizationResponseIssuerRequired=false', succeeds: !required },
      { suffix: '&iss=' + encodeURIComponent(issuer), succeeds: true },
      { suffix: '&iss=', succeeds: false },
      { suffix: '&iss=' + encodeURIComponent(issuer + '/'), succeeds: false },
      { suffix: '&iss=' + encodeURIComponent(issuer) + '&iss=' + encodeURIComponent(issuer), succeeds: false },
    ]) {
      const storage = new Map([[pkceStorageKey, JSON.stringify(pendingTransaction(at, required))]]);
      const page = await browser(html, { url: viewerOAuth.redirectUri + '?code=test&state=' + 'S'.repeat(43) + scenario.suffix, storage, at });
      assert.equal(page.requests.length, scenario.succeeds ? 1 : 0, JSON.stringify({ required, ...scenario }));
      assert.match(page.status.textContent, scenario.succeeds ? /Signed in/ : /Sign-in failed or expired/);
      assert.equal(page.storage.size, 0);
    }
    const changedPolicy = new Map([[pkceStorageKey, JSON.stringify(pendingTransaction(at, !required))]]);
    const page = await browser(html, { url: viewerOAuth.redirectUri + '?code=test&state=' + 'S'.repeat(43) + '&iss=' + encodeURIComponent(issuer), storage: changedPolicy, at });
    assert.equal(page.requests.length, 0, 'changing issuer policy must invalidate an existing transaction');
  }
});

test('OAuth token exchange uses the authorized resource even when callback query supplies another', async () => {
  const html = await (await oauthPage()).text();
  const at = Date.now();
  const storage = new Map([[pkceStorageKey, JSON.stringify(pendingTransaction(at))]]);
  const page = await browser(html, {
    url: viewerOAuth.redirectUri + '?code=test&state=' + 'S'.repeat(43) + '&resource=https%3A%2F%2Fother.example.test%2Fmcp', storage, at,
    fetch: async (_url, init) => {
      const form = new URLSearchParams(init.body);
      if (form.get('resource') !== resource) return { ok: false, status: 400 };
      return { ok: true, json: async () => ({ access_token: 'resource-bound-token', token_type: 'Bearer', expires_in: 60 }) };
    },
  });
  assert.equal(page.requests.length, 1);
  assert.match(page.status.textContent, /Signed in/);
  assert.deepEqual(new URLSearchParams(page.requests[0]!.init.body).getAll('resource'), [resource]);
});

test('OAuth exchange failures discard PKCE state and do not retain a token or expose provider response details', async () => {
  const html = await (await oauthPage()).text();
  const at = Date.now();
  const failures = [
    async () => ({ ok: false, status: 400, json: async () => ({ error_description: 'SYNTHETIC_PRIVATE_ERROR' }) }),
    async () => { throw new Error('SYNTHETIC_PRIVATE_ERROR'); },
    async () => ({ ok: true, json: async () => ({ refresh_token: 'discard-refresh-token' }) }),
    async () => ({ ok: true, json: async () => ({ access_token: 'not-saved', token_type: 'Bearer', expires_in: 0 }) }),
  ];
  for (const fetch of failures) {
    const storage = new Map([[pkceStorageKey, JSON.stringify(pendingTransaction(at))]]);
    const page = await browser(html, { url: viewerOAuth.redirectUri + '?code=test&state=' + 'S'.repeat(43), storage, at, fetch });
    assert.equal(page.requests.length, 1);
    assert.equal(page.storage.size, 0);
    assert.equal(page.writes.length, 0);
    assert.doesNotMatch(page.status.textContent, /SYNTHETIC_PRIVATE_ERROR/);
    await page.submit();
    assert.equal(page.requests.length, 1, 'failed exchange must not authorize history requests');
  }
});

test('OAuth viewer rejects resource/audience mismatch and escapes public configuration in inline scripts', async () => {
  await assert.rejects(oauthPage({ resource: 'https://other.example.test/mcp' }), /Invalid viewer OAuth configuration/);
  await assert.rejects(oauthPage({}, 'different-audience'), /Invalid viewer OAuth configuration/);
  await assert.rejects(oauthPage({ redirectUri: 'https://other.example.test/viewer' }), /Invalid viewer OAuth configuration/);
  const html = await (await oauthPage({ clientId: '</script><script>bad</script>' })).text();
  assert.equal((html.match(/<script>/g) ?? []).length, 1);
  assert.equal((html.match(/<\/script>/g) ?? []).length, 1);
});

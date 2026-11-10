import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Bridge } from '../src/bridge.js';
import { MemoryStore } from '../src/memory-store.js';
import { HISTORY_RETENTION_MS } from '../src/retention.js';
import { tenantKey, type Principal } from '../src/types.js';
const alpha: Principal = {
  id: 'alpha',
  tenant: 'sample',
  scopes: ['messages:send'],
  peers: ['beta'],
};
const reader: Principal = {
  id: 'reader',
  tenant: 'sample',
  scopes: ['history:read'],
  peers: [],
  readParticipants: ['alpha', 'beta'],
};
function fixture() {
  let at = Date.UTC(2026, 10, 10);
  const store = new MemoryStore();
  const bridge = new Bridge(
    store,
    {
      viewerCatalog: 'complete',
      messagesPerMinute: 1000,
      claimMs: 1000,
      webhookRecipients: [],
    },
    () => at,
  );
  return {
    store,
    bridge,
    advance: (ms: number) => {
      at += ms;
    },
    send: (id: string, conversationId = 'demo', text = 'Synthetic text') =>
      bridge.send(alpha, { id, conversationId, recipient: 'beta', text }),
  };
}
test('catalog is atomic, deduplicated across participants and isolated by tenant/grant', async () => {
  const f = fixture();
  await f.send('m1');
  await f.send('m2', 'other');
  let cursor: string | undefined;
  const ids: string[] = [];
  do {
    const page = await f.bridge.viewer(reader, {
      operation: 'conversations',
      limit: 1,
      cursor,
    });
    assert.ok(page.conversations);
    ids.push(...page.conversations.map((c) => c.conversationId));
    cursor = 'cursor' in page ? page.cursor : undefined;
  } while (cursor);
  assert.deepEqual(ids, ['demo', 'other']);
  for (const principal of [
    { ...reader, tenant: 'another' },
    { ...reader, readParticipants: ['gamma'] },
  ]) {
    const page = await f.bridge.viewer(principal, {
      operation: 'conversations',
    });
    assert.ok('conversations' in page);
    assert.deepEqual(page.conversations, []);
    await assert.rejects(
      f.bridge.viewer(principal, {
        operation: 'messages',
        conversationId: 'demo',
      }),
      /conversation_not_found/,
    );
  }
  await assert.rejects(
    f.bridge.viewer(alpha, { operation: 'conversations' }),
    /forbidden/,
  );
  const duplicate = await f.send('m1');
  assert.equal(duplicate.duplicate, true);
  assert.equal(
    (await f.store.query(tenantKey('sample', 'catalog', 'alpha'), '', 100))
      .items.length,
    2,
  );
});
test('bounded search preserves empty continuation, binds cursors and resumes after the last examined row', async () => {
  const f = fixture();
  await f.send('m1', 'demo', 'first');
  await f.send('m2', 'demo', 'MATCH <script>data</script>');
  const args = {
    operation: 'messages',
    conversationId: 'demo',
    term: 'match',
    limit: 1,
  };
  const first = await f.bridge.viewer(reader, args);
  assert.ok('messages' in first);
  assert.deepEqual(first.messages, []);
  assert.ok(first.cursor);
  assert.equal(first.examined, 1);
  for (const changed of [
    { term: '' },
    { conversationId: 'other' },
    { limit: 2 },
  ]) {
    await assert.rejects(
      f.bridge.viewer(reader, { ...args, ...changed, cursor: first.cursor }),
      /invalid_cursor/,
    );
  }
  await assert.rejects(
    f.bridge.viewer(
      { ...reader, id: 'another' },
      { ...args, cursor: first.cursor },
    ),
    /invalid_cursor/,
  );
  await assert.rejects(
    f.bridge.viewer(
      { ...reader, readParticipants: ['alpha'] },
      { ...args, cursor: first.cursor },
    ),
    /invalid_cursor/,
  );
  const second = await f.bridge.viewer(reader, {
    ...args,
    cursor: first.cursor,
  });
  assert.ok('messages' in second);
  assert.equal(second.messages[0]?.text, 'MATCH <script>data</script>');
  assert.equal(second.cursor, undefined);
  await f.send('m3', 'demo', 'new match');
  const updated = await f.bridge.viewer(reader, {
    ...args,
    cursor: second.resume,
  });
  assert.ok('messages' in updated);
  assert.deepEqual(
    updated.messages.map((m) => m.id),
    ['m3'],
  );
});
test('newest-first viewer reads the latest page first and continues older work without duplicates', async () => {
  const f = fixture();
  for (let n = 1; n <= 65; n++) await f.send(`m${n}`);
  const args = { operation: 'messages', conversationId: 'demo', order: 'desc' };
  const first = await f.bridge.viewer(reader, args);
  assert.ok('messages' in first);
  assert.deepEqual(first.messages.map(m => m.id), Array.from({ length: 30 }, (_, n) => `m${65 - n}`));
  assert.equal(first.examined, 30);
  await f.send('m66');
  const second = await f.bridge.viewer(reader, { ...args, cursor: first.cursor });
  assert.ok('messages' in second);
  assert.deepEqual(second.messages.map(m => m.id), Array.from({ length: 30 }, (_, n) => `m${35 - n}`));
  const third = await f.bridge.viewer(reader, { ...args, cursor: second.cursor });
  assert.ok('messages' in third);
  assert.deepEqual(third.messages.map(m => m.id), ['m5', 'm4', 'm3', 'm2', 'm1']);
  assert.equal(third.cursor, undefined);
  const refreshed = await f.bridge.viewer(reader, args);
  assert.ok('messages' in refreshed);
  assert.equal(refreshed.messages[0]?.id, 'm66');
  assert.equal(refreshed.messages.length, 30);
  await assert.rejects(f.bridge.viewer(reader, { ...args, order: 'asc', cursor: first.cursor }), /invalid_cursor/);
  await assert.rejects(f.bridge.viewer({ ...reader, tenant: 'other' }, { ...args, cursor: first.cursor }), /invalid_cursor/);
  await assert.rejects(f.bridge.viewer({ ...reader, readParticipants: ['gamma'] }, args), /conversation_not_found/);
  // The agent/human legacy history API remains oldest-first.
  assert.equal((await f.bridge.history(reader, 'demo')).messages[0]?.id, 'm1');
});
test('ascending REST cursors issued before the order option remain usable', async () => {
  const f = fixture();await f.send('m1');await f.send('m2');
  const args = { operation: 'messages', term: '', limit: 1, conversationId: 'demo' };
  const page = await f.bridge.viewer(reader, args);
  assert.ok('messages' in page);assert.ok(page.cursor);
  const saved = JSON.parse(Buffer.from(page.cursor, 'base64url').toString('utf8'));
  saved.binding = createHash('sha256').update(JSON.stringify([
    reader.tenant, reader.id, [...reader.scopes].sort(), [...reader.readParticipants!].sort(), args,
  ])).digest('hex');
  const next = await f.bridge.viewer(reader, { ...args, cursor: Buffer.from(JSON.stringify(saved)).toString('base64url') });
  assert.ok('messages' in next);assert.equal(next.messages[0]?.id, 'm2');
});
test('reverse search keeps empty pages and period/retention filters without scanning past its budget', async () => {
  const f = fixture();
  await f.send('expired', 'demo', 'match');f.advance(HISTORY_RETENTION_MS);
  await f.send('older', 'demo', 'match');f.advance(100);
  await f.send('newer', 'demo', 'no result');
  const args = { operation: 'messages', conversationId: 'demo', order: 'desc', term: 'match', limit: 1 };
  const first = await f.bridge.viewer(reader, args);
  assert.ok('messages' in first);assert.deepEqual(first.messages, []);assert.ok(first.cursor);assert.equal(first.examined, 1);
  const second = await f.bridge.viewer(reader, { ...args, cursor: first.cursor });
  assert.ok('messages' in second);assert.deepEqual(second.messages.map(m => m.id), ['older']);
  const last = await f.bridge.viewer(reader, { ...args, cursor: second.cursor });
  assert.ok('messages' in last);assert.deepEqual(last.messages, []);assert.equal(last.cursor, undefined);
  await assert.rejects(f.bridge.viewer(reader, { ...args, term: '', cursor: first.cursor }), /invalid_cursor/);
  const period = await f.bridge.viewer(reader, { ...args, limit: 30, until: '2026-11-24T00:00:00.000Z' });
  assert.ok('messages' in period);assert.deepEqual(period.messages.map(m => m.id), ['older']);
});
test('logical retention hides catalog and messages even before physical deletion', async () => {
  const f = fixture();
  await f.send('m1');
  f.advance(HISTORY_RETENTION_MS);
  const catalog = await f.bridge.viewer(reader, { operation: 'conversations' });
  assert.ok('conversations' in catalog);
  assert.deepEqual(catalog.conversations, []);
  const history = await f.bridge.viewer(reader, {
    operation: 'messages',
    conversationId: 'demo',
  });
  assert.ok('messages' in history);
  assert.deepEqual(history.messages, []);
  await f.send('m2');
  const renewed = await f.bridge.viewer(reader, { operation: 'conversations' });
  assert.ok(renewed.conversations);
  assert.equal(renewed.conversations.length, 1);
});
test('disabled catalog neither adds writes nor assumes discovery coverage', async () => {
  const store = new MemoryStore();
  const bridge = new Bridge(store, {
    messagesPerMinute: 100,
    claimMs: 1000,
    webhookRecipients: [],
  });
  await bridge.send(alpha, {
    id: 'm',
    conversationId: 'demo',
    recipient: 'beta',
    text: 'Synthetic',
  });
  assert.equal(
    (await store.query(tenantKey('sample', 'catalog', 'alpha'), '', 100)).items
      .length,
    0,
  );
  assert.deepEqual(
    await bridge.viewer(reader, { operation: 'conversations' }),
    { conversations: [], coverage: 'disabled' },
  );
  const history = await bridge.viewer(reader, {
    operation: 'messages',
    conversationId: 'demo',
  });
  assert.ok('messages' in history);
  assert.equal(history.messages.length, 1);
});
test('catalog rechecks canonical ACL and validates filters and cursors', async () => {
  const f = fixture();
  await f.send('m1');
  const key = { pk: tenantKey('sample', 'meta', 'demo'), sk: 'meta' };
  const row = await f.store.get(key);
  await f.store.commit([
    {
      ...key,
      expected: row!.version,
      value: { ...row!.value, participants: ['gamma', 'delta'] },
    },
  ]);
  const catalog = await f.bridge.viewer(reader, { operation: 'conversations' });
  assert.ok('conversations' in catalog);
  assert.deepEqual(catalog.conversations, []);
  for (const bad of [
    { operation: 'conversations', cursor: 'invalid' },
    { operation: 'conversations', limit: 101 },
    { operation: 'conversations', participants: ['gamma'] },
    {
      operation: 'messages',
      conversationId: 'demo',
      since: '2026-11-10T00:00:00Z',
      until: '2026-11-01T00:00:00Z',
    },
  ])
    await assert.rejects(f.bridge.viewer(reader, bad));
});

test('publicações concorrentes mantêm um único índice por conversa e participante', async () => {
  const f = fixture();
  await Promise.all(Array.from({ length: 8 }, (_, index) => f.send(`parallel_${index}`)));
  const metadata = await f.store.get({ pk: tenantKey('sample', 'meta', 'demo'), sk: 'meta' });
  assert.equal(metadata?.value.count, 8);
  for (const member of ['alpha', 'beta']) {
    const rows = await f.store.query(tenantKey('sample', 'catalog', member), 'conversation#', 100);
    assert.equal(rows.items.length, 1);
    assert.deepEqual(rows.items[0]?.value, metadata?.value.latest);
  }
});

test('período compara instantes com precisões diferentes e inclui os limites', async () => {
  const f = fixture();
  await f.send('m1');
  f.advance(100);
  await f.send('m2');
  const query = { operation: 'messages', conversationId: 'demo' };
  for (const period of [
    { since: '2026-11-10T00:00:00Z', until: '2026-11-10T00:00:00.000Z' },
    { since: '2026-11-10T00:00:00.000Z', until: '2026-11-10T00:00:00Z' },
  ]) {
    const page = await f.bridge.viewer(reader, { ...query, ...period });
    assert.ok('messages' in page);
    assert.deepEqual(page.messages.map((m) => m.id), ['m1']);
  }
  await assert.rejects(f.bridge.viewer(reader, {
    ...query,
    since: '2026-11-10T00:00:00.1Z',
    until: '2026-11-10T00:00:00Z',
  }));
});

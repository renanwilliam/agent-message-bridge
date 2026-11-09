import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { MemoryStore } from '../src/memory-store.js';
import { SqliteStore } from '../src/sqlite-store.js';
import { DynamoStore } from '../src/dynamo-store.js';
import { Conflict, type Write } from '../src/store.js';

for (const kind of ['memory', 'sqlite']) {
  test(`${kind}: retention metadata persists without hiding expired rows or changing leases`, async () => {
    const store = kind === 'memory' ? new MemoryStore() : new SqliteStore(':memory:');
    const key = { pk: 'tenant', sk: 'message' };
    const value = { expiresAt: 123_456, leaseUntil: 654_321 };
    try {
      await store.commit([{ ...key, expected: null, value, dueAt: 1000, retentionExpiresAt: 0 }]);
      const row = { ...key, version: 1, value, dueAt: 1000, retentionExpiresAt: 0 };
      assert.deepEqual(await store.get(key), row);
      assert.deepEqual((await store.query(key.pk, '', 10)).items, [row]);
      assert.deepEqual(await store.due(1000, 10), [{ ...key, dueAt: 1000 }]);
      await assert.rejects(store.commit([{ ...key, expected: null, value }]), Conflict);
      await store.commit([{ ...key, expected: 1, value, retentionExpiresAt: Number.MAX_SAFE_INTEGER }]);
      assert.equal((await store.get(key))?.retentionExpiresAt, Number.MAX_SAFE_INTEGER);
      await store.commit([{ ...key, expected: 2, value }]);
      assert.deepEqual(await store.get(key), { ...key, version: 3, value });
    } finally { if (store instanceof SqliteStore) store.close(); }
  });
}

for (const kind of ['memory', 'sqlite', 'dynamo']) {
  test(`${kind}: invalid retention timestamps reject the full transaction before writing`, async () => {
    let sends = 0;
    const client = { send: async () => { sends++; return {}; } } as unknown as Pick<DynamoDBDocumentClient, 'send'>;
    const store = kind === 'memory' ? new MemoryStore() : kind === 'sqlite' ? new SqliteStore(':memory:') : new DynamoStore('fixture', client);
    try {
      for (const invalid of [-1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, null, '123']) {
        await assert.rejects(store.commit([
          { pk: 'tenant', sk: 'valid', expected: null, value: {} },
          { pk: 'tenant', sk: 'invalid', expected: null, value: {}, retentionExpiresAt: invalid } as Write,
        ]), /Invalid retention expiration timestamp/);
      }
      assert.equal(sends, 0);
      if (kind !== 'dynamo') assert.equal(await store.get({ pk: 'tenant', sk: 'valid' }), undefined);
    } finally { if (store instanceof SqliteStore) store.close(); }
  });
}

test('SQLite migrates old schema additively and preserves retention through reopen', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'bridge-retention-'));
  const path = join(directory, 'state.sqlite');
  const key = { pk: 'tenant', sk: 'legacy' };
  const value = { expiresAt: 15, leaseUntil: 25 };
  const legacy = new DatabaseSync(path);
  legacy.exec(`CREATE TABLE records (pk TEXT NOT NULL, sk TEXT NOT NULL, version INTEGER NOT NULL,
    value_json TEXT NOT NULL, due_at INTEGER, PRIMARY KEY (pk, sk)) WITHOUT ROWID;`);
  legacy.prepare('INSERT INTO records VALUES (?, ?, ?, ?, ?)').run(key.pk, key.sk, 7, JSON.stringify(value), 35);
  legacy.close();
  let store = new SqliteStore(path);
  try {
    assert.deepEqual(await store.get(key), { ...key, version: 7, value, dueAt: 35 });
    await store.commit([{ ...key, expected: 7, value, dueAt: 35, retentionExpiresAt: 1_800_000_000 }]);
    store.close();
    store = new SqliteStore(path);
    assert.deepEqual(await store.get(key), { ...key, version: 8, value, dueAt: 35, retentionExpiresAt: 1_800_000_000 });
    assert.deepEqual((await store.query('tenant', '', 10)).items, [await store.get(key)]);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('Dynamo serializes top-level retention and decodes get/query without filtering or changing nested expiry', async () => {
  const commands: { input: Record<string, unknown> }[] = [];
  const value = { expiresAt: 100, leaseUntil: 200 };
  const row = { pk: 'tenant', sk: 'message', version: 1, value, dueAt: 300, retentionExpiresAt: 0 };
  const responses = [{}, { Item: row }, { Items: [row] }];
  const client = { send: async (command: typeof commands[number]) => { commands.push(command); return responses.shift(); } } as unknown as Pick<DynamoDBDocumentClient, 'send'>;
  const store = new DynamoStore('fixture', client);
  await store.commit([{ pk: row.pk, sk: row.sk, expected: null, value, dueAt: 300, retentionExpiresAt: 0 },
    { pk: row.pk, sk: 'legacy', expected: null, value }]);
  const items = commands[0]!.input.TransactItems as { Put: { Item: Record<string, unknown> } }[];
  assert.deepEqual(items[0]!.Put.Item, { ...row, duePk: 'DUE' });
  assert.deepEqual(items[1]!.Put.Item, { pk: 'tenant', sk: 'legacy', version: 1, value });
  assert.deepEqual(await store.get({ pk: row.pk, sk: row.sk }), row);
  assert.deepEqual((await store.query(row.pk, '', 10)).items, [row]);
  assert.equal(commands[2]!.input.FilterExpression, undefined);
});

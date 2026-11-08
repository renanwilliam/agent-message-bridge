import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { Conflict, type Store } from '../src/store.js';
import { MemoryStore } from '../src/memory-store.js';
import { SqliteStore } from '../src/sqlite-store.js';
import { DynamoStore } from '../src/dynamo-store.js';

function fixture(kind: string): { store: Store; close: () => void } {
  if (kind === 'memory') return { store: new MemoryStore(), close() {} };
  const directory = mkdtempSync(join(tmpdir(), 'bridge-store-'));
  const store = new SqliteStore(join(directory, 'state.sqlite'));
  return { store, close() { store.close(); rmSync(directory, { recursive: true, force: true }); } };
}

for (const kind of ['memory', 'sqlite']) {
  test(`${kind}: atomic CAS rejects conflicts without partial writes`, async () => {
    const { store, close } = fixture(kind);
    try {
      await store.commit([{ pk: 'tenant', sk: 'counter', expected: null, value: { count: 1 } }]);
      await assert.rejects(store.commit([
        { pk: 'tenant', sk: 'message', expected: null, value: { text: 'Example' } },
        { pk: 'tenant', sk: 'counter', expected: 7, value: { count: 2 } },
      ]), Conflict);
      assert.equal(await store.get({ pk: 'tenant', sk: 'message' }), undefined);
      assert.equal((await store.get({ pk: 'tenant', sk: 'counter' }))!.version, 1);
      const writes = [1, 2, 3, 4].map(count => store.commit([
        { pk: 'tenant', sk: 'counter', expected: 1, value: { count } },
      ]));
      const results = await Promise.allSettled(writes);
      assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
      assert.equal((await store.get({ pk: 'tenant', sk: 'counter' }))!.version, 2);
      await store.commit([{ pk: 'tenant', sk: 'counter', expected: 2 }]);
      assert.equal(await store.get({ pk: 'tenant', sk: 'counter' }), undefined);
    } finally { close(); }
  });

  test(`${kind}: scoped cursor pagination and prefix ordering`, async () => {
    const { store, close } = fixture(kind);
    try {
      await store.commit(['other', 'message#003', 'message#001', 'message#002', 'message#\u{10ffff}'].map(sk =>
        ({ pk: 'tenant', sk, expected: null, value: { sk } })));
      await store.commit([{ pk: 'other-tenant', sk: 'message#001', expected: null, value: {} }]);
      const first = await store.query('tenant', 'message#', 2);
      assert.deepEqual(first.items.map(item => item.sk), ['message#001', 'message#002']);
      assert.ok(first.cursor);
      const second = await store.query('tenant', 'message#', 2, first.cursor);
      assert.deepEqual(second.items.map(item => item.sk), ['message#003', 'message#\u{10ffff}']);
      assert.equal(second.cursor, undefined);
      await assert.rejects(store.query('other-tenant', 'message#', 2, first.cursor), /cursor/);
      await assert.rejects(store.query('tenant', 'other', 2, first.cursor), /cursor/);
      await assert.rejects(store.query('tenant', 'message#', 2, 'not-a-cursor'), /cursor/);
      await assert.rejects(store.query('tenant', '', 101), /Limit/);
      await assert.rejects(store.query('tenant', '', 0), /Limit/);
      first.items[0]!.value.sk = 'mutated';
      assert.equal((await store.get({ pk: 'tenant', sk: 'message#001' }))!.value.sk, 'message#001');
    } finally { close(); }
  });

  test(`${kind}: due selection is bounded, ordered and removes completed rows`, async () => {
    const { store, close } = fixture(kind);
    try {
      await store.commit([
        { pk: 'tenant', sk: 'early', expected: null, value: { message: 'Synthetic private message', secret: 'SYNTHETIC_SECRET' }, dueAt: 10 },
        { pk: 'tenant', sk: 'late', expected: null, value: {}, dueAt: 100 },
        { pk: 'tenant', sk: 'middle', expected: null, value: {}, dueAt: 30 },
        { pk: 'tenant', sk: 'done', expected: null, value: {} },
      ]);
      const due = await store.due(50, 1);
      assert.deepEqual(due, [{ pk: 'tenant', sk: 'early', dueAt: 10 }]);
      assert.deepEqual(Object.keys(due[0]!).sort(), ['dueAt', 'pk', 'sk']);
      assert.ok(!JSON.stringify(due).includes('Synthetic private message'));
      assert.ok(!JSON.stringify(due).includes('SYNTHETIC_SECRET'));
      due[0]!.sk = 'mutated';
      assert.equal((await store.due(50, 1))[0]!.sk, 'early');
      assert.deepEqual((await store.due(50, 100)).map(item => item.sk), ['early', 'middle']);
      await store.commit([{ pk: 'tenant', sk: 'early', expected: 1, value: { status: 'done' } }]);
      assert.deepEqual((await store.due(50, 100)).map(item => item.sk), ['middle']);
      assert.equal((await store.get({ pk: 'tenant', sk: 'early' }))!.dueAt, undefined);
      await assert.rejects(store.commit([
        { pk: 'tenant', sk: 'duplicate', expected: null, value: {} },
        { pk: 'tenant', sk: 'duplicate', expected: null, value: {} },
      ]), /Duplicate/);
      assert.equal(await store.get({ pk: 'tenant', sk: 'duplicate' }), undefined);
    } finally { close(); }
  });
}

test('SQLite survives restart and independent connections cannot both reserve the same version', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'bridge-restart-'));
  const path = join(directory, 'state.sqlite');
  const first = new SqliteStore(path);
  try {
    await first.commit([{ pk: 'tenant', sk: 'delivery', expected: null, value: { fence: 1 }, dueAt: 100 }]);
    first.close();
    const second = new SqliteStore(path);
    const third = new SqliteStore(path);
    try {
      assert.deepEqual((await second.get({ pk: 'tenant', sk: 'delivery' }))!.value, { fence: 1 });
      const attempts = await Promise.allSettled([second.commit([
        { pk: 'tenant', sk: 'delivery', expected: 1, value: { fence: 2 }, dueAt: 200 },
      ]), third.commit([
        { pk: 'tenant', sk: 'delivery', expected: 1, value: { fence: 2 }, dueAt: 200 },
      ])]);
      assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1);
      assert.equal((await second.get({ pk: 'tenant', sk: 'delivery' }))!.version, 2);
    } finally { second.close(); third.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('SQLite serializes competing process transactions', { timeout: 15_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'bridge-concurrency-'));
  const path = join(directory, 'state.sqlite');
  const initial = new SqliteStore(path);
  await initial.commit([{ pk: 'tenant', sk: 'lease', expected: null, value: { fence: 0 } }]);
  initial.close();
  const sourceUrl = new URL('../src/sqlite-store.ts', import.meta.url).href;
  const code = `import { SqliteStore } from ${JSON.stringify(sourceUrl)};
    const store = new SqliteStore(process.argv[1]);
    process.send('ready');
    process.once('message', async () => {
      try { await store.commit([{pk:'tenant',sk:'lease',expected:1,value:{fence:1}}]); process.send('won'); }
      catch (error) { if (error.message.includes('Concurrent update')) process.send('conflict'); else { process.send('unexpected'); process.exitCode=1; } }
      finally { store.close(); process.disconnect(); }
    });`;
  const children = [0, 1].map(() => spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code, path], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] }));
  try {
    const outputs: string[][] = [[], []];
    const completions = children.map(child => once(child, 'exit'));
    await Promise.all(children.map((child, index) => new Promise<void>((resolve, reject) => {
      child.on('error', reject);
      child.on('message', data => {
        outputs[index]!.push(String(data));
        if (data === 'ready') resolve();
      });
      child.once('exit', code => { if (!outputs[index]!.includes('ready')) reject(new Error(`Worker exited before ready: ${code}`)); });
    })));
    children.forEach(child => child.send('go'));
    const exits = await Promise.all(completions);
    assert.deepEqual(exits.map(([code]) => code), [0, 0]);
    assert.equal(outputs.filter(output => output.includes('won')).length, 1);
    assert.equal(outputs.filter(output => output.includes('conflict')).length, 1);
  } finally {
    children.forEach(child => child.kill());
    rmSync(directory, { recursive: true, force: true });
  }
});

test('DynamoDB uses conditional transactions, consistent history reads and an eventual due GSI', async () => {
  const commands: { constructor: { name: string }; input: Record<string, unknown> }[] = [];
  const responses: unknown[] = [{}, { Item: { pk: 'tenant', sk: 'a', version: 1, value: {} } },
    { Items: [], LastEvaluatedKey: { pk: 'tenant', sk: 'msg#2' } }, { Items: [] }, { Items: [{ pk: 'tenant', sk: 'a', dueAt: 20 }] }];
  const client = { send: async (command: typeof commands[number]) => { commands.push(command); return responses.shift(); } } as unknown as Pick<DynamoDBDocumentClient, 'send'>;
  const store = new DynamoStore('fixture-table', client);
  await store.commit([
    { pk: 'tenant', sk: 'a', expected: null, value: { text: 'Example' }, dueAt: 20 },
    { pk: 'tenant', sk: 'b', expected: 7 },
  ]);
  const transaction = commands[0]!.input as { TransactItems: { Put?: Record<string, unknown>; Delete?: Record<string, unknown> }[]; ClientRequestToken: string };
  assert.equal(commands[0]!.constructor.name, 'TransactWriteCommand');
  assert.match(transaction.ClientRequestToken, /^[a-f0-9-]{36}$/);
  assert.equal(transaction.TransactItems[0]!.Put!.ConditionExpression, 'attribute_not_exists(#pk)');
  assert.deepEqual(transaction.TransactItems[0]!.Put!.Item, { pk: 'tenant', sk: 'a', version: 1, value: { text: 'Example' }, dueAt: 20, duePk: 'DUE' });
  assert.equal(transaction.TransactItems[1]!.Delete!.ConditionExpression, '#version = :expected');
  assert.deepEqual(transaction.TransactItems[1]!.Delete!.ExpressionAttributeValues, { ':expected': 7 });
  await store.get({ pk: 'tenant', sk: 'a' });
  assert.equal(commands[1]!.input.ConsistentRead, true);
  const page = await store.query('tenant', 'msg#', 2);
  assert.equal(commands[2]!.constructor.name, 'QueryCommand');
  assert.equal(commands[2]!.input.Limit, 2);
  assert.equal(commands[2]!.input.ConsistentRead, true);
  assert.ok(page.cursor);
  await store.query('tenant', 'msg#', 2, page.cursor);
  assert.deepEqual(commands[3]!.input.ExclusiveStartKey, { pk: 'tenant', sk: 'msg#2' });
  assert.deepEqual(await store.due(100, 5), [{ pk: 'tenant', sk: 'a', dueAt: 20 }]);
  assert.equal(commands[4]!.input.Select, 'SPECIFIC_ATTRIBUTES');
  assert.equal(commands[4]!.input.ProjectionExpression, '#pk, #sk, #dueAt');
  assert.deepEqual(commands[4]!.input.ExpressionAttributeNames, { '#duePk': 'duePk', '#dueAt': 'dueAt', '#pk': 'pk', '#sk': 'sk' });
  assert.equal(commands[4]!.input.IndexName, 'due-index');
  assert.equal(commands[4]!.input.ConsistentRead, undefined);
  assert.equal(commands[4]!.input.Limit, 5);
  assert.equal(commands[4]!.input.FilterExpression, undefined);
  assert.equal(commands[4]!.constructor.name, 'QueryCommand');
});

test('DynamoDB translates only CAS cancellation into Conflict and leaves availability errors visible', async () => {
  let failure: unknown = { name: 'TransactionCanceledException', CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }] };
  const client = { send: async () => { throw failure; } } as unknown as Pick<DynamoDBDocumentClient, 'send'>;
  const store = new DynamoStore('fixture-table', client);
  const write = [{ pk: 'tenant', sk: 'delivery', expected: 1, value: {} }];
  await assert.rejects(store.commit(write), Conflict);
  failure = new Error('Service unavailable');
  await assert.rejects(store.commit(write), error => error === failure);
  failure = { name: 'TransactionCanceledException', CancellationReasons: [{ Code: 'ProvisionedThroughputExceeded' }] };
  await assert.rejects(store.commit(write), error => error === failure);
});


test('DynamoDB due results expose only keys and due time even if an adapter returns extra attributes', async () => {
  const client = { send: async () => ({ Items: [{
    pk: 'tenant', sk: 'delivery', dueAt: 50, version: 9, duePk: 'DUE',
    value: { message: { text: 'Synthetic private message' }, secret: 'SYNTHETIC_SECRET' },
  }] }) } as unknown as Pick<DynamoDBDocumentClient, 'send'>;
  const due = await new DynamoStore('fixture-table', client).due(100, 10);
  assert.deepEqual(due, [{ pk: 'tenant', sk: 'delivery', dueAt: 50 }]);
  assert.deepEqual(Object.keys(due[0]!).sort(), ['dueAt', 'pk', 'sk']);
  assert.ok(!JSON.stringify(due).includes('Synthetic private message'));
  assert.ok(!JSON.stringify(due).includes('SYNTHETIC_SECRET'));
});

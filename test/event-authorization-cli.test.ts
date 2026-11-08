import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { SqliteStore } from '../src/sqlite-store.js';

const execute = promisify(execFile);
test('operator event authorization CLI defaults to dry-run, fences changes and advances epochs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-grant-cli-'));
  const database = join(directory, 'fixture.sqlite');
  const env: NodeJS.ProcessEnv = { ...process.env, BRIDGE_DB_FILE: database };
  delete env.TABLE_NAME;
  delete env.NODE_TEST_CONTEXT;
  const script = fileURLToPath(new URL('../scripts/event-authorization.ts', import.meta.url));
  const run = (...args: string[]) => execute(process.execPath, ['--import', 'tsx', script, 'sample', 'alpha', ...args], { env });
  const read = async () => {
    const store = new SqliteStore(database);
    try { return await store.get<{ epoch: string; active: boolean }>({ pk: 'sample#subscriptions#alpha', sk: '_authorization' }); }
    finally { store.close(); }
  };
  try {
    assert.equal(JSON.parse((await run('grant', 'none')).stdout).applied, false);
    assert.equal(await read(), undefined);
    await run('grant', 'none', '--apply');
    assert.deepEqual((await read())?.value, { epoch: '1', active: true });
    await assert.rejects(run('revoke', 'none', '--apply'), /Event authorization changed/);
    assert.deepEqual((await read())?.value, { epoch: '1', active: true });
    await run('revoke', '1', '--apply');
    assert.deepEqual((await read())?.value, { epoch: '2', active: false });
    await run('grant', '2', '--apply');
    assert.deepEqual((await read())?.value, { epoch: '3', active: true });
    await assert.rejects(run('grant', '3', '--apply', 'unexpected'), /Usage:/);
    assert.deepEqual((await read())?.value, { epoch: '3', active: true });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

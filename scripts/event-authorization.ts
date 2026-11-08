import { DynamoStore } from '../src/dynamo-store.js';
import { SqliteStore } from '../src/sqlite-store.js';
import { eventAuthorizationKey, setEventAuthorization } from '../src/event-authorization.js';
import type { EventAuthorization } from '../src/types.js';

// Operator-only. Dry-run is the default; no runtime identity gets an administration tool.
const [tenant, owner, action, expected, apply, ...extra] = process.argv.slice(2);
if (!tenant || !owner || !['grant', 'revoke'].includes(action ?? '') ||
    !expected || !/^(none|[1-9][0-9]{0,15})$/.test(expected) ||
    (apply !== undefined && apply !== '--apply') || extra.length) {
  throw new Error('Usage: event-authorization.ts <installation> <owner> <grant|revoke> <expected-epoch|none> [--apply]');
}
const key = eventAuthorizationKey(tenant, owner);
const table = process.env.TABLE_NAME, database = process.env.BRIDGE_DB_FILE;
if (Boolean(table) === Boolean(database)) throw new Error('Set exactly one of TABLE_NAME or BRIDGE_DB_FILE');
const store = database ? new SqliteStore(database) : new DynamoStore(table!);
try {
  const current = await store.get<EventAuthorization>(key);
  const expectedEpoch = expected === 'none' ? null : expected;
  if ((current?.value.epoch ?? null) !== expectedEpoch) throw new Error('Event authorization changed; inspect the current epoch before retrying');
  const next = { epoch: (BigInt(expectedEpoch ?? '0') + 1n).toString(), active: action === 'grant' };
  if (!/^[1-9][0-9]{0,15}$/.test(next.epoch)) throw new Error('Event authorization epoch limit reached');
  if (apply === '--apply') await setEventAuthorization(store, { tenant, owner }, next, expectedEpoch);
  console.log(JSON.stringify({ applied: apply === '--apply', backend: database ? 'sqlite' : 'dynamodb', tenant, owner, expectedEpoch, next }));
} finally { if (store instanceof SqliteStore) store.close(); }

import type { Key, Row, Write } from './store.js';

export function keyId(key: Key): string { return JSON.stringify([key.pk, key.sk]); }
export function validateKey(key: Key): void {
  if (typeof key.pk !== 'string' || !key.pk || Buffer.byteLength(key.pk) > 2048 ||
      typeof key.sk !== 'string' || !key.sk || Buffer.byteLength(key.sk) > 1024 ||
      Buffer.from(key.pk).toString('utf8') !== key.pk || Buffer.from(key.sk).toString('utf8') !== key.sk) throw new Error('Invalid store key');
}
export function validateLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Limit must be between 1 and 100');
}
export function validateDue(now: number): void {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('Invalid due timestamp');
}
export function validateQuery(pk: string, prefix: string, limit: number): void {
  validateKey({ pk, sk: prefix || '_' });
  validateLimit(limit);
}
export function cursorFor(pk: string, prefix: string, sk: string): string {
  return Buffer.from(JSON.stringify({ v: 1, pk, prefix, sk })).toString('base64url');
}
export function readCursor(cursor: string | undefined, pk: string, prefix: string): string | undefined {
  if (cursor === undefined) return undefined;
  try {
    if (!cursor || cursor.length > 8192 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!parsed || typeof parsed !== 'object') throw new Error();
    const item = parsed as Record<string, unknown>;
    if (Object.keys(item).length !== 4 || item.v !== 1 || item.pk !== pk || item.prefix !== prefix ||
        typeof item.sk !== 'string' || !item.sk.startsWith(prefix)) throw new Error();
    validateKey({ pk, sk: item.sk });
    return item.sk;
  } catch { throw new Error('Invalid or out-of-scope cursor'); }
}
export function compareKeys(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}
export function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
export function validateWrites(writes: Write[]): Write[] {
  if (!Array.isArray(writes) || writes.length > 100) throw new Error('A transaction supports at most 100 writes');
  const keys = new Set<string>();
  let bytes = 0;
  return writes.map(write => {
    validateKey(write);
    if (write.expected !== null && (!Number.isSafeInteger(write.expected) || write.expected < 1 || write.expected >= Number.MAX_SAFE_INTEGER)) throw new Error('Invalid expected version');
    if (write.dueAt !== undefined) validateDue(write.dueAt);
    const key = keyId(write);
    if (keys.has(key)) throw new Error('Duplicate key in transaction');
    keys.add(key);
    if (write.value === undefined) return { pk: write.pk, sk: write.sk, expected: write.expected };
    const serialized = JSON.stringify(write.value);
    if (serialized === undefined) throw new Error('Value must be JSON serializable');
    const size = Buffer.byteLength(serialized) + Buffer.byteLength(key);
    bytes += size;
    if (size > 350_000 || bytes > 3_500_000) throw new Error('Transaction exceeds storage size limit');
    return { ...write, value: JSON.parse(serialized) as unknown };
  });
}
export function nextRow(write: Write): Row<unknown> {
  return {
    pk: write.pk, sk: write.sk, version: (write.expected ?? 0) + 1, value: write.value,
    ...(write.dueAt === undefined ? {} : { dueAt: write.dueAt }),
  };
}

import { Conflict, type DueKey, type Key, type Page, type Row, type Store, type Write } from './store.js';
import { clone, compareKeys, cursorFor, keyId, nextRow, readCursor, validateDue, validateKey, validateLimit, validateQuery, validateWrites } from './store-utils.js';

/** Test/local ephemeral implementation. Every commit runs without an async yield. */
export class MemoryStore implements Store {
  private readonly rows = new Map<string, Row<unknown>>();
  async get<T = Record<string, unknown>>(key: Key): Promise<Row<T> | undefined> {
    validateKey(key);
    const row = this.rows.get(keyId(key));
    return row ? clone(row) as Row<T> : undefined;
  }
  async query<T = Record<string, unknown>>(pk: string, prefix: string, limit: number, cursor?: string): Promise<Page<T>> {
    validateQuery(pk, prefix, limit);
    const after = readCursor(cursor, pk, prefix);
    const matches = [...this.rows.values()].filter(row => row.pk === pk && row.sk.startsWith(prefix) &&
      (after === undefined || compareKeys(row.sk, after) > 0)).sort((a, b) => compareKeys(a.sk, b.sk));
    const items = matches.slice(0, limit).map(row => clone(row) as Row<T>);
    return { items, ...(matches.length > limit ? { cursor: cursorFor(pk, prefix, items.at(-1)!.sk) } : {}) };
  }
  async due(now: number, limit: number): Promise<DueKey[]> {
    validateDue(now); validateLimit(limit);
    return [...this.rows.values()].filter(row => row.dueAt !== undefined && row.dueAt <= now)
      .sort((a, b) => a.dueAt! - b.dueAt! || compareKeys(a.pk, b.pk) || compareKeys(a.sk, b.sk))
      .slice(0, limit).map(row => ({ pk: row.pk, sk: row.sk, dueAt: row.dueAt! }));
  }
  async commit(writes: Write[]): Promise<void> {
    const valid = validateWrites(writes);
    for (const write of valid) {
      const row = this.rows.get(keyId(write));
      if ((row?.version ?? null) !== write.expected) throw new Conflict();
    }
    for (const write of valid) {
      if (write.value === undefined) this.rows.delete(keyId(write));
      else this.rows.set(keyId(write), nextRow(write));
    }
  }
}

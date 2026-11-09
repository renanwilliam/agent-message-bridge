import { DatabaseSync } from 'node:sqlite';
import { Conflict, type DueKey, type Key, type Page, type Row, type Store, type Write } from './store.js';
import { cursorFor, readCursor, validateDue, validateKey, validateLimit, validateQuery, validateWrites } from './store-utils.js';

type SqlRow = { pk: string; sk: string; version: number; value_json: string; due_at: number | null; retention_expires_at: number | null };
function rowFromSql<T>(row: SqlRow): Row<T> {
  return { pk: row.pk, sk: row.sk, version: row.version, value: JSON.parse(row.value_json) as T,
    ...(row.due_at === null ? {} : { dueAt: row.due_at }),
    ...(row.retention_expires_at === null ? {} : { retentionExpiresAt: row.retention_expires_at }) };
}
function upperPrefix(prefix: string): string | undefined {
  const characters = [...prefix];
  while (characters.length) {
    const last = characters.pop()!.codePointAt(0)!;
    if (last < 0x10ffff) return characters.join('') + String.fromCodePoint(last === 0xd7ff ? 0xe000 : last + 1);
  }
  return undefined;
}
/** Durable local store. Call close before deleting its database or reopening a fixture. */
export class SqliteStore implements Store {
  private readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS records (
        pk TEXT NOT NULL, sk TEXT NOT NULL, version INTEGER NOT NULL,
        value_json TEXT NOT NULL, due_at INTEGER, retention_expires_at INTEGER, PRIMARY KEY (pk, sk)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS records_due ON records (due_at, pk, sk) WHERE due_at IS NOT NULL;`);
    // Additive migration preserves pre-retention databases and their CAS versions.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const columns = this.db.prepare('PRAGMA table_info(records)').all() as { name: string }[];
      if (!columns.some(column => column.name === 'retention_expires_at')) {
        this.db.exec('ALTER TABLE records ADD COLUMN retention_expires_at INTEGER');
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      this.db.close();
      throw error;
    }
  }
  close(): void { this.db.close(); }
  async get<T = Record<string, unknown>>(key: Key): Promise<Row<T> | undefined> {
    validateKey(key);
    const row = this.db.prepare('SELECT * FROM records WHERE pk = ? AND sk = ?').get(key.pk, key.sk) as SqlRow | undefined;
    return row ? rowFromSql<T>(row) : undefined;
  }
  async query<T = Record<string, unknown>>(pk: string, prefix: string, limit: number, cursor?: string): Promise<Page<T>> {
    validateQuery(pk, prefix, limit);
    const after = readCursor(cursor, pk, prefix);
    const upper = upperPrefix(prefix);
    const clauses = ['pk = ?', 'sk >= ?'];
    const args: (string | number)[] = [pk, prefix];
    if (upper !== undefined) { clauses.push('sk < ?'); args.push(upper); }
    if (after !== undefined) { clauses.push('sk > ?'); args.push(after); }
    args.push(limit + 1);
    const rows = this.db.prepare(`SELECT * FROM records WHERE ${clauses.join(' AND ')} ORDER BY sk LIMIT ?`).all(...args) as SqlRow[];
    const items = rows.slice(0, limit).map(row => rowFromSql<T>(row));
    return { items, ...(rows.length > limit ? { cursor: cursorFor(pk, prefix, items.at(-1)!.sk) } : {}) };
  }
  async due(now: number, limit: number): Promise<DueKey[]> {
    validateDue(now); validateLimit(limit);
    const rows = this.db.prepare('SELECT pk, sk, due_at FROM records WHERE due_at <= ? ORDER BY due_at, pk, sk LIMIT ?').all(now, limit) as { pk: string; sk: string; due_at: number }[];
    return rows.map(row => ({ pk: row.pk, sk: row.sk, dueAt: row.due_at }));
  }
  async commit(writes: Write[]): Promise<void> {
    const valid = validateWrites(writes);
    if (!valid.length) return;
    let began = false;
    try {
      this.db.exec('BEGIN IMMEDIATE'); began = true;
      const lookup = this.db.prepare('SELECT version FROM records WHERE pk = ? AND sk = ?');
      for (const write of valid) {
        const row = lookup.get(write.pk, write.sk) as { version: number } | undefined;
        if ((row?.version ?? null) !== write.expected) throw new Conflict();
      }
      const remove = this.db.prepare('DELETE FROM records WHERE pk = ? AND sk = ?');
      const put = this.db.prepare(`INSERT INTO records (pk, sk, version, value_json, due_at, retention_expires_at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (pk, sk) DO UPDATE SET version = excluded.version, value_json = excluded.value_json, due_at = excluded.due_at, retention_expires_at = excluded.retention_expires_at`);
      for (const write of valid) {
        if (write.value === undefined) remove.run(write.pk, write.sk);
        else put.run(write.pk, write.sk, (write.expected ?? 0) + 1, JSON.stringify(write.value), write.dueAt ?? null, write.retentionExpiresAt ?? null);
      }
      this.db.exec('COMMIT'); began = false;
    } catch (error) {
      if (began) this.db.exec('ROLLBACK');
      if (error && typeof error === 'object' && 'errcode' in error && [5, 6].includes(Number(error.errcode))) throw new Conflict();
      throw error;
    }
  }
}

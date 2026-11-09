export interface Key { pk: string; sk: string }
export interface DueKey extends Key { dueAt: number }
export interface Row<T = Record<string, unknown>> extends Key { version: number; value: T; dueAt?: number; retentionExpiresAt?: number }
export interface Write<T = unknown> extends Key { expected: number | null; value?: T; dueAt?: number; retentionExpiresAt?: number }
export interface Page<T = Record<string, unknown>> { items: Row<T>[]; cursor?: string }
export interface Store {
  get<T = Record<string, unknown>>(key: Key): Promise<Row<T> | undefined>;
  query<T = Record<string, unknown>>(pk: string, prefix: string, limit: number, cursor?: string): Promise<Page<T>>;
  due(now: number, limit: number): Promise<DueKey[]>;
  commit(writes: Write[]): Promise<void>;
}
export class Conflict extends Error { constructor() { super('Concurrent update; retry with fresh state'); } }

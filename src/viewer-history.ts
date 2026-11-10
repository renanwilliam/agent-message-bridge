import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  BridgeError,
  requireScope,
  tenantKey,
  type Message,
  type Principal,
} from './types.js';
import { messageExpired } from './retention.js';
import { cursorFor } from './store-utils.js';
import type { Store } from './store.js';

const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const common = {
  term: z.string().trim().max(200).default(''),
  limit: z.number().int().min(1).max(100).default(30),
  cursor: z.string().max(8192).optional(),
};
export const viewerQuerySchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('conversations'), ...common }).strict(),
  z
    .object({
      operation: z.literal('messages'),
      ...common,
      conversationId: identifier,
      order: z.enum(['asc', 'desc']).default('asc'),
      since: z.string().datetime().optional(),
      until: z.string().datetime().optional(),
    })
    .strict()
    .refine((v) => !v.since || !v.until || Date.parse(v.since) <= Date.parse(v.until), {
      message: 'Invalid period',
    }),
]);
type Query = z.infer<typeof viewerQuerySchema>;
export interface ConversationSummary {
  conversationId: string;
  participants: string[];
  timestamp: string;
}
export interface ConversationMetadata {
  participants: string[];
  count: number;
  correlationId: string;
  claimFence?: number;
  latest?: ConversationSummary;
}
export type CatalogCoverage = 'disabled' | 'partial' | 'complete';
const positionSchema = z
  .object({
    binding: z.string(),
    participant: z.number().int().min(0),
    after: z.string().max(8192).optional(),
  })
  .strict();

// O cursor delimita uma posição, nunca concede acesso. A ACL é relida em toda chamada.
function position(p: Principal, query: Query) {
  const { cursor, ...filters } = query;
  // Preserve existing ascending REST cursors; only reverse traversal adds a binding field.
  const bindingFilters: Record<string, unknown> = { ...filters };
  if (bindingFilters.order === 'asc') delete bindingFilters.order;
  const binding = createHash('sha256')
    .update(
      JSON.stringify([
        p.tenant,
        p.id,
        [...p.scopes].sort(),
        [...(p.readParticipants ?? [])].sort(),
        bindingFilters,
      ]),
    )
    .digest('hex');
  let participant = 0,
    after: string | undefined;
  if (cursor) {
    try {
      if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
      const parsed = positionSchema.parse(
        JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')),
      );
      if (parsed.binding !== binding) throw new Error();
      ({ participant, after } = parsed);
    } catch {
      throw new BridgeError('invalid_cursor');
    }
  }
  return {
    participant,
    after,
    encode: (participant: number, after?: string) =>
      Buffer.from(JSON.stringify({ binding, participant, after })).toString(
        'base64url',
      ),
  };
}

export async function queryViewer(
  store: Store,
  p: Principal,
  query: Query,
  coverage: CatalogCoverage,
  authorize: (conversationId: string) => Promise<ConversationMetadata>,
  now: () => number,
) {
  requireScope(p, 'history:read');
  const pos = position(p, query);
  if (query.operation === 'messages') {
    await authorize(query.conversationId);
    if (pos.participant !== 0) throw new BridgeError('invalid_cursor');
    const pk = tenantKey(p.tenant, 'history', query.conversationId);
    let page;
    try {
      page = await store.query<Message>(pk, 'message#', query.limit, pos.after, query.order);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === 'Invalid or out-of-scope cursor'
      )
        throw new BridgeError('invalid_cursor');
      throw error;
    }
    const term = query.term.toLocaleLowerCase('pt-BR');
    const messages = page.items
      .filter(
        ({ value: m }) =>
          !messageExpired(m, now()) &&
          (!query.since || Date.parse(m.timestamp) >= Date.parse(query.since)) &&
          (!query.until || Date.parse(m.timestamp) <= Date.parse(query.until)) &&
          m.text.toLocaleLowerCase('pt-BR').includes(term),
      )
      .map((row) => row.value);
    const last = page.items.at(-1);
    const after = last ? cursorFor(pk, 'message#', last.sk, query.order) : pos.after;
    return {
      messages,
      ...(page.cursor ? { cursor: pos.encode(0, page.cursor) } : {}),
      resume: pos.encode(0, after),
      examined: page.items.length,
    };
  }
  if (coverage === 'disabled') return { conversations: [], coverage };
  const participants = [
    ...new Set([p.id, ...(p.readParticipants ?? [])]),
  ].sort();
  if (pos.participant >= participants.length)
    throw new BridgeError('invalid_cursor');
  const member = participants[pos.participant]!;
  let page;
  try {
    page = await store.query<ConversationSummary>(
      tenantKey(p.tenant, 'catalog', member),
      'conversation#',
      query.limit,
      pos.after,
    );
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === 'Invalid or out-of-scope cursor'
    )
      throw new BridgeError('invalid_cursor');
    throw error;
  }
  const conversations: ConversationSummary[] = [];
  for (const row of page.items) {
    if (messageExpired(row.value, now())) continue;
    let meta: ConversationMetadata;
    try {
      meta = await authorize(row.value.conversationId);
    } catch (error) {
      if (
        error instanceof BridgeError &&
        error.code === 'conversation_not_found'
      )
        continue;
      throw error;
    }
    // Um dono determinístico evita repetir conversas em páginas de participantes distintos.
    if (
      participants.find((id) => meta.participants.includes(id)) !== member ||
      !meta.latest ||
      messageExpired(meta.latest, now())
    )
      continue;
    const summary = { ...meta.latest, participants: meta.participants };
    if (
      ![summary.conversationId, ...summary.participants].some((value) =>
        value
          .toLocaleLowerCase('pt-BR')
          .includes(query.term.toLocaleLowerCase('pt-BR')),
      )
    )
      continue;
    conversations.push(summary);
  }
  const cursor = page.cursor
    ? pos.encode(pos.participant, page.cursor)
    : pos.participant + 1 < participants.length
      ? pos.encode(pos.participant + 1)
      : undefined;
  return {
    conversations,
    coverage,
    ...(cursor ? { cursor } : {}),
    examined: page.items.length,
  };
}

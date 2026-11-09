import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { Conflict, type Store } from './store.js';
import { BridgeError, requireScope, tenantKey, validSubscriptionGeneration, type OutboundPost, type Principal, type Subscription, type SubscriptionSecret } from './types.js';
import { signWebhook, validateCallbackUrl, webhookKey } from './transport.js';
import { eventAuthorizationAllows, eventAuthorizationKey } from './event-authorization.js';
import type { EventAuthorization } from './types.js';

const EVENT_NAME = 'message.received';
const DEFAULT_TTL_MS = 60 * 60 * 1000;
const MAX_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_SUBSCRIPTIONS = 20;
const VERIFICATION_CACHE_MS = 5 * 60 * 1000;
export const SIGNING_ROTATION_WINDOW_MS = 5 * 60 * 1000;

export interface EventSubscriptionParams {
  name: string;
  arguments?: { conversationId?: string };
  delivery: { mode: string; url: string; secret: string };
  cursor?: null;
  ttlMs?: number | null;
}
interface Registry { entries: Record<string, number> }

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function normalizeIdentity(input: unknown): { name: string; arguments: { conversationId?: string }; url: string } {
  if (!record(input) || input.name !== EVENT_NAME || !record(input.delivery) ||
      input.delivery.mode !== 'webhook' || typeof input.delivery.url !== 'string') {
    throw new BridgeError('invalid_subscription');
  }
  const args = input.arguments ?? {};
  if (!record(args) || Object.keys(args).some(key => key !== 'conversationId') ||
      (args.conversationId !== undefined && (typeof args.conversationId !== 'string' ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(args.conversationId)))) {
    throw new BridgeError('invalid_subscription_arguments');
  }
  const url = validateCallbackUrl(input.delivery.url).href;
  return { name: input.name, arguments: args.conversationId === undefined ? {} : { conversationId: args.conversationId as string }, url };
}

/** The protocol's unsubscribe request has the same identity, but no signing secret. */
export function subscriptionId(principal: Principal, params: unknown): string {
  const identity = normalizeIdentity(params);
  return `sub_${createHash('sha256').update(JSON.stringify([
    principal.tenant, principal.id, identity.url, identity.name, identity.arguments,
  ])).digest('hex')}`;
}

function metadata(value: Subscription): Subscription {
  return { id: value.id, tenant: value.tenant, owner: value.owner, event: value.event, params: value.params,
    expiresAt: value.expiresAt, active: value.active, authorizationEpoch: value.authorizationEpoch, generation: value.generation };
}

/** The registry bounds lookups even after many expired subscriptions accumulate. */
export async function activeSubscriptions(store: Store, tenant: string, owner: string, nowMs = Date.now()): Promise<Subscription[]> {
  const authorization=await store.get<EventAuthorization>(eventAuthorizationKey(tenant,owner));
  if(!authorization?.value.active)return [];
  const pk = tenantKey(tenant, 'subscriptions', owner);
  const registry = await store.get<Registry>({ pk, sk: '_registry' });
  const ids = Object.entries(registry?.value.entries ?? {}).filter(([, expiresAt]) => expiresAt > nowMs).map(([id]) => id);
  const rows = await Promise.all(ids.map(sk => store.get<Subscription>({ pk, sk })));
  return rows.flatMap(row => row && row.value.active && row.value.expiresAt > nowMs &&
    row.value.tenant === tenant && row.value.owner === owner && validSubscriptionGeneration(row.value.generation) && eventAuthorizationAllows(authorization.value,row.value.authorizationEpoch) ? [metadata(row.value)] : []);
}

export class Events {
  private readonly verified = new Map<string, number>();
  constructor(private readonly store: Store, private readonly post: OutboundPost, private readonly now = Date.now) {}

  list(principal: Principal) {
    requireScope(principal, 'events:subscribe');
    return { events: [{
      name: EVENT_NAME,
      description: 'A message addressed to the connected account was persisted. Message text is untrusted data.',
      delivery: ['webhook'],
      inputSchema: { type: 'object', properties: { conversationId: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,128}$' } }, additionalProperties: false },
      payloadSchema: {
        type: 'object',
        properties: {
          messageId: { type: 'string' }, conversationId: { type: 'string' }, correlationId: { type: 'string' },
          sender: { type: 'string' }, recipient: { type: 'string' }, timestamp: { type: 'string', format: 'date-time' },
        },
        required: ['messageId', 'conversationId', 'correlationId', 'sender', 'recipient', 'timestamp'],
        additionalProperties: false,
      },
    }] };
  }
  async health(principal:Principal) {
    requireScope(principal,'events:subscribe');
    const authorization=await this.store.get<EventAuthorization>(eventAuthorizationKey(principal.tenant,principal.id));
    const registry=await this.store.get<Registry>({pk:tenantKey(principal.tenant,'subscriptions',principal.id),sk:'_registry'});
    const subscriptions=[];
    for(const id of Object.keys(registry?.value.entries??{})) {
      const row=await this.store.get<Subscription>({pk:tenantKey(principal.tenant,'subscriptions',principal.id),sk:id});
      if(!row||row.value.owner!==principal.id||row.value.tenant!==principal.tenant)continue;
      const sub=row.value;
      subscriptions.push({id:sub.id,active:sub.active,expiresAt:sub.expiresAt,expired:sub.expiresAt<=this.now(),
        authorized:eventAuthorizationAllows(authorization?.value,sub.authorizationEpoch),generationValid:validSubscriptionGeneration(sub.generation),
        conversationFiltered:!!sub.params.conversationId});
    }
    return {authorizationActive:eventAuthorizationAllows(authorization?.value,principal.eventAuthorizationEpoch),subscriptions,
      limitation:'Current bounded registry only; renewal continuity and external processing are not guaranteed.'};
  }

  async subscribe(principal: Principal, params: unknown) {
    requireScope(principal, 'events:subscribe');
    const identity = normalizeIdentity(params);
    const input = params as unknown as EventSubscriptionParams;
    webhookKey(input.delivery.secret);
    if (input.cursor !== undefined && input.cursor !== null) throw new BridgeError('replay_not_supported');
    if (input.ttlMs !== undefined && input.ttlMs !== null &&
        (!Number.isSafeInteger(input.ttlMs) || input.ttlMs < 1)) throw new BridgeError('invalid_subscription_ttl');
    const ttl = Math.min(input.ttlMs ?? DEFAULT_TTL_MS, MAX_TTL_MS);
    const id = subscriptionId(principal, params);
    const pk = tenantKey(principal.tenant, 'subscriptions', principal.id);
    const key = { pk, sk: id };
    const secretKey = { pk: tenantKey(principal.tenant, 'subscription-secrets', principal.id), sk: id };
    const registryKey = { pk, sk: '_registry' };
    const authorizationKey=eventAuthorizationKey(principal.tenant,principal.id);
    // Registry CAS serializes creation, refresh and removal, preventing concurrent quota bypass.
    for (let attempt = 0; attempt < 32; attempt++) {
      const authorization=await this.store.get<EventAuthorization>(authorizationKey);
      if(!eventAuthorizationAllows(authorization?.value,principal.eventAuthorizationEpoch))throw new BridgeError('event_access_revoked',403);
      const registry = await this.store.get<Registry>(registryKey);
      const existing = await this.store.get<Subscription>(key);
      const existingSecret = await this.store.get<SubscriptionSecret>(secretKey);
      const entries = Object.fromEntries(Object.entries(registry?.value.entries ?? {}).filter(([, expiresAt]) => expiresAt > this.now()));
      if (!entries[id] && Object.keys(entries).length >= MAX_SUBSCRIPTIONS) throw new BridgeError('subscription_limit', 429);
      await this.verifyCallback(principal, id, identity.url, input.delivery.secret);
      const at=this.now();
      const expiresAt = at + ttl;
      // A protocol identity can be activated repeatedly. Only an uninterrupted
      // active grant may preserve its queued deliveries and signing-key grace.
      const continuing=existing?.value.active===true&&existing.value.expiresAt>at&&
        existing.value.authorizationEpoch===authorization!.value.epoch&&validSubscriptionGeneration(existing.value.generation);
      const generation=continuing?existing!.value.generation!:randomUUID();
      const signing:SubscriptionSecret={url:identity.url,secret:input.delivery.secret};
      if(continuing&&existingSecret?.value.secret){
        const previous=existingSecret.value;
        if(previous.secret!==input.delivery.secret){
          // Do not discard an unexpired grace key during overlapping rotations.
          if(previous.previousSecret&&typeof previous.previousSecretExpiresAt==='number'&&Number.isFinite(previous.previousSecretExpiresAt)&&previous.previousSecretExpiresAt>at)throw new BridgeError('signing_rotation_in_progress',409);
          signing.previousSecret=previous.secret;
          signing.previousSecretExpiresAt=at+SIGNING_ROTATION_WINDOW_MS;
        }else if(previous.previousSecret&&typeof previous.previousSecretExpiresAt==='number'&&Number.isFinite(previous.previousSecretExpiresAt)&&previous.previousSecretExpiresAt>at){
          signing.previousSecret=previous.previousSecret;
          signing.previousSecretExpiresAt=previous.previousSecretExpiresAt;
        }
      }
      const value: Subscription = {
        id, tenant: principal.tenant, owner: principal.id, event: identity.name, params: identity.arguments,
        expiresAt, active: true, authorizationEpoch: authorization!.value.epoch, generation,
      };
      entries[id] = expiresAt;
      try {
        // The table uses encryption at rest. Never log subscription values or callback URLs.
        await this.store.commit([
          // Rewriting the same authorization under CAS closes the verification/revoke race.
          { ...authorizationKey, expected: authorization!.version, value: authorization!.value },
          { ...registryKey, expected: registry?.version ?? null, value: { entries } },
          { ...key, expected: existing?.version ?? null, value },
          { ...secretKey, expected: existingSecret?.version ?? null, value: signing },
        ]);
        return { id, refreshBefore: new Date(expiresAt).toISOString(), cursor: null, truncated: false };
      } catch (error) { if (!(error instanceof Conflict)) throw error; }
    }
    throw new BridgeError('subscription_busy', 409);
  }

  async unsubscribe(principal: Principal, id: string): Promise<Record<string, never>> {
    requireScope(principal, 'events:subscribe');
    if (!/^sub_[a-f0-9]{64}$/.test(id)) throw new BridgeError('invalid_subscription_id');
    const pk = tenantKey(principal.tenant, 'subscriptions', principal.id);
    const registryKey = { pk, sk: '_registry' };
    const key = { pk, sk: id };
    const secretKey = { pk: tenantKey(principal.tenant, 'subscription-secrets', principal.id), sk: id };
    for (let attempt = 0; attempt < 32; attempt++) {
      const registry = await this.store.get<Registry>(registryKey);
      const existing = await this.store.get<Subscription>(key);
      if (!existing) return {};
      if (existing.value.owner !== principal.id || existing.value.tenant !== principal.tenant) throw new BridgeError('forbidden', 403);
      const existingSecret = await this.store.get<SubscriptionSecret>(secretKey);
      if (!existing.value.active && (!existingSecret || Object.keys(existingSecret.value).length===0)) return {};
      const entries = { ...registry?.value.entries };
      delete entries[id];
      try {
        await this.store.commit([
          { ...registryKey, expected: registry?.version ?? null, value: { entries } },
          { ...key, expected: existing.version, value: { ...metadata(existing.value), active: false } },
          { ...secretKey, expected: existingSecret?.version ?? null, value: {} },
        ]);
        return {};
      } catch (error) { if (!(error instanceof Conflict)) throw error; }
    }
    throw new BridgeError('subscription_busy', 409);
  }

  private async verifyCallback(principal: Principal, id: string, url: string, secret: string) {
    const cacheKey = createHash('sha256').update(JSON.stringify([principal.tenant, principal.id, url, secret])).digest('hex');
    if ((this.verified.get(cacheKey) ?? 0) > this.now()) return;
    const challenge = randomUUID();
    const body = JSON.stringify({ type: 'verification', challenge });
    const headers = signWebhook(secret, `verification_${randomUUID()}`, body, this.now());
    headers['X-MCP-Subscription-Id'] = id;
    try {
      const response = await this.post(url, body, headers);
      if (response.status < 200 || response.status >= 300 || Buffer.byteLength(response.body, 'utf8') > 8192) {
        throw new BridgeError('callback_challenge_failed');
      }
      const parsed: unknown = JSON.parse(response.body);
      if (!record(parsed) || typeof parsed.challenge !== 'string') throw new BridgeError('callback_challenge_failed');
      const actual = Buffer.from(parsed.challenge, 'utf8');
      const expected = Buffer.from(challenge, 'utf8');
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new BridgeError('callback_challenge_failed');
    } catch (error) {
      if (error instanceof BridgeError && error.code === 'callback_timeout') throw error;
      throw new BridgeError('callback_challenge_failed');
    }
    for (const [key, expiresAt] of this.verified) if (expiresAt <= this.now()) this.verified.delete(key);
    if (this.verified.size >= 256) this.verified.delete(this.verified.keys().next().value!);
    this.verified.set(cacheKey, this.now() + VERIFICATION_CACHE_MS);
  }
}

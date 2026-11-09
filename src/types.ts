export interface Principal { id: string; tenant: string; scopes: string[]; peers: string[]; readParticipants?: string[]; eventAuthorizationEpoch?: string;
  /** Derived only from the configured grant after authentication; never grants an effective scope. */
  canRequestEventScope?: boolean;
}
export interface Message { generation?: string; id: string; conversationId: string; correlationId: string; sender: string; recipient: string; text: string; timestamp: string; turn: number; replyTo?: string }
export interface MessageInput { id: string; conversationId: string; recipient: string; text: string; replyTo?: string }
export interface EventAuthorization { epoch: string; active: boolean }
export interface Subscription { id: string; tenant: string; owner: string; event: string; params: { conversationId?: string }; expiresAt: number; active: boolean; authorizationEpoch?: string; generation?: string }
export interface SubscriptionSecret { url?: string; secret?: string; previousSecret?: string; previousSecretExpiresAt?: number }
export type MessageNotice = Pick<Message, 'id'|'conversationId'|'correlationId'|'sender'|'recipient'|'timestamp'|'generation'>;
export interface Delivery { id: string; kind: 'webhook'|'event'; tenant: string; owner: string; message: MessageNotice; subscriptionId?: string; subscriptionAuthorizationEpoch?: string; subscriptionGeneration?: string; attempts: number; fence: number; leaseUntil: number; status: 'pending'|'done'|'dead'; lastError?: string; attemptedAt?: number; acceptedAt?: number; processing?: 'unconfirmed'|'confirmed'; recoveryCount?: number; recoveredAttempts?: number; }
export type OutboundPost = (url: string, body: string, headers: Record<string, string>) => Promise<{ status: number; body: string }>;
export class BridgeError extends Error { constructor(public code: string, public status: number = 400) { super(code); } }
export function requireScope(p: Principal, scope: string) { if (!p.scopes.includes(scope)) throw new BridgeError('forbidden', 403); }
export function tenantKey(tenant: string, kind: string, id: string) { return `${tenant}#${kind}#${id}`; }
export function validSubscriptionGeneration(value:unknown):value is string {return typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);}

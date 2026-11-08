import { createHmac, timingSafeEqual } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import ipaddr from 'ipaddr.js';
import { BridgeError, type OutboundPost } from './types.js';

export const MAX_WEBHOOK_BYTES = 256 * 1024;

/** Standard Webhooks uses a base64 encoded, endpoint-specific HMAC key. */
export function webhookKey(secret: string): Buffer {
  if (typeof secret !== 'string' || !/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret)) {
    throw new BridgeError('invalid_webhook_secret');
  }
  const encoded = secret.slice(6);
  const key = Buffer.from(encoded, 'base64');
  if (key.length < 24 || key.length > 64 || encoded.length % 4 === 1 ||
      key.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')) {
    throw new BridgeError('invalid_webhook_secret');
  }
  return key;
}

function safeWebhookId(id: string): void {
  // A dot would make the signature's id.timestamp.body delimiter ambiguous.
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(id)) {
    throw new BridgeError('invalid_webhook_id');
  }
}

export function signWebhook(secret: string | readonly string[], id: string, rawBody: string, nowMs = Date.now()): Record<string, string> {
  safeWebhookId(id);
  if (Buffer.byteLength(rawBody, 'utf8') > MAX_WEBHOOK_BYTES) throw new BridgeError('payload_too_large', 413);
  if (!Number.isFinite(nowMs) || nowMs < 0) throw new BridgeError('invalid_signing_time');
  const timestamp = String(Math.floor(nowMs / 1000));
  const secrets=[...new Set(typeof secret==='string'?[secret]:secret)];
  if(secrets.length<1||secrets.length>2)throw new BridgeError('invalid_webhook_signing_keys');
  const signature = secrets.map(key=>`v1,${createHmac('sha256', webhookKey(key)).update(`${id}.${timestamp}.${rawBody}`, 'utf8').digest('base64')}`).join(' ');
  return {
    'content-type': 'application/json',
    'webhook-id': id,
    'webhook-timestamp': timestamp,
    'webhook-signature': signature,
  };
}

/** Verify exact bytes before JSON parsing; callers must separately deduplicate the returned ID. */
export function verifyWebhook(
  secret: string,
  rawBody: string,
  headers: Record<string, string | undefined>,
  nowMs = Date.now(),
  toleranceMs = 300_000,
): string {
  if (Buffer.byteLength(rawBody, 'utf8') > MAX_WEBHOOK_BYTES) throw new BridgeError('payload_too_large', 413);
  const normalized = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const id = normalized['webhook-id'];
  const timestamp = normalized['webhook-timestamp'];
  const signatures = normalized['webhook-signature'];
  if (!id || !timestamp || !signatures || !/^\d{1,13}$/.test(timestamp) || signatures.length > 2048) {
    throw new BridgeError('invalid_signature', 401);
  }
  try { safeWebhookId(id); } catch { throw new BridgeError('invalid_signature', 401); }
  const signedAt = Number(timestamp) * 1000;
  if (!Number.isSafeInteger(signedAt) || Math.abs(nowMs - signedAt) > toleranceMs) {
    throw new BridgeError('stale_signature', 401);
  }
  const expected = createHmac('sha256', webhookKey(secret)).update(`${id}.${timestamp}.${rawBody}`, 'utf8').digest();
  let valid = false;
  for (const item of signatures.split(' ')) {
    const [version, encoded, extra] = item.split(',');
    if (version !== 'v1' || !encoded || extra !== undefined || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) continue;
    const candidate = Buffer.from(encoded, 'base64');
    if (candidate.length === expected.length && timingSafeEqual(candidate, expected)) valid = true;
  }
  if (!valid) throw new BridgeError('invalid_signature', 401);
  return id;
}

/** Only globally routed unicast addresses may be callback destinations. */
export function isPublicAddress(address: string): boolean {
  try {
    if (address.includes('%')) return false;
    const parsed = ipaddr.parse(address);
    if (parsed.kind() === 'ipv6' && (parsed as ipaddr.IPv6).isIPv4MappedAddress()) {
      return (parsed as ipaddr.IPv6).toIPv4Address().range() === 'unicast';
    }
    return parsed.range() === 'unicast';
  } catch { return false; }
}

export function validateCallbackUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new BridgeError('invalid_callback_url'); }
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (url.protocol !== 'https:' || !hostname || url.username || url.password || url.hash ||
      value.length > 2048 || url.port === '0' || hostname.includes('%') ||
      hostname.toLowerCase() === 'localhost' || hostname.toLowerCase().endsWith('.localhost') ||
      (ipaddr.isValid(hostname) && !isPublicAddress(hostname))) {
    throw new BridgeError('invalid_callback_url');
  }
  return url;
}

export interface ResolvedAddress { address: string; family: number }
export type ResolveAddresses = (hostname: string) => Promise<ResolvedAddress[]>;
const resolveAddresses: ResolveAddresses = async hostname => dnsLookup(hostname, { all: true, verbatim: true });

export async function resolvePublicAddress(url: URL, resolve: ResolveAddresses = resolveAddresses): Promise<ResolvedAddress> {
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = ipaddr.isValid(hostname)
    ? [{ address: hostname, family: ipaddr.parse(hostname).kind() === 'ipv4' ? 4 : 6 }]
    : await resolve(hostname);
  // Reject mixed public/private answers rather than retrying another address.
  if (!addresses.length || addresses.some(item => ![4, 6].includes(item.family) || !isPublicAddress(item.address))) {
    throw new BridgeError('callback_address_blocked');
  }
  return addresses[0]!;
}

export interface OutboundOptions {
  timeoutMs?: number;
  maxResponseBytes?: number;
  resolve?: ResolveAddresses;
  request?: typeof httpsRequest;
}

/** Resolve on every call and pin that exact public IP, retaining the URL hostname for TLS. */
export function createOutboundPost(options: OutboundOptions = {}): OutboundPost {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maxResponseBytes = options.maxResponseBytes ?? 8192;
  return async (value, body, headers) => {
    if (Buffer.byteLength(body, 'utf8') > MAX_WEBHOOK_BYTES) throw new BridgeError('payload_too_large', 413);
    const url = validateCallbackUrl(value);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let abortLookup: (() => void) | undefined;
    try {
      const destination = await Promise.race([
        resolvePublicAddress(url, options.resolve),
        new Promise<never>((_, reject) => {
          abortLookup = () => reject(new BridgeError('callback_timeout', 504));
          controller.signal.addEventListener('abort', abortLookup, { once: true });
        }),
      ]);
      if (abortLookup) controller.signal.removeEventListener('abort', abortLookup);
      return await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = (options.request ?? httpsRequest)(url, {
          method: 'POST', headers: { ...headers, 'content-length': String(Buffer.byteLength(body, 'utf8')) },
          signal: controller.signal,
          agent: false,
          family: destination.family,
          // Node connects to this answer, never performs a second DNS lookup.
          lookup: (_hostname, _options, callback) => callback(null, destination.address, destination.family),
        }, response => {
          const chunks: Buffer[] = [];
          let bytes = 0;
          response.on('data', (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > maxResponseBytes) {
              response.destroy();
              req.destroy();
              reject(new BridgeError('callback_response_too_large', 502));
            } else chunks.push(chunk);
          });
          response.on('error', () => reject(new BridgeError('callback_network_error', 502)));
          response.on('end', () => {
            // https.request never follows redirects. Make that boundary explicit.
            const status = response.statusCode ?? 502;
            if (status >= 300 && status < 400) reject(new BridgeError('callback_redirect_blocked', 502));
            else resolve({ status, body: Buffer.concat(chunks).toString('utf8') });
          });
        });
        req.on('error', () => reject(new BridgeError(controller.signal.aborted ? 'callback_timeout' : 'callback_network_error', 502)));
        req.end(body);
      });
    } catch (error) {
      if (error instanceof BridgeError) throw error;
      throw new BridgeError('callback_network_error', 502);
    } finally {
      clearTimeout(timeout);
      if (abortLookup) controller.signal.removeEventListener('abort', abortLookup);
    }
  };
}

export const outboundPost: OutboundPost = createOutboundPost();

import { createHash, randomBytes } from 'node:crypto';

/** Public configuration only. Authorization codes and tokens stay in memory. */
export interface OAuthFlowProbeProfile {
  /** Authorization-server/response issuer. Access-token trust is supplied by the verifier. */
  issuer: string;
  authorizeUrl: string;
  tokenUrl: string;
  revokeUrl: string;
  clientId: string;
  redirectUri: string;
  resource: string;
  scopes: string[];
  authorizationResponseIssuerRequired: boolean;
  refreshGraceSeconds: number;
}

export type OAuthFlowProbeScenario = 'code_s256_and_replay' | 'wrong_pkce' | 'missing_pkce' | 'authorize_missing_challenge' | 'pkce_downgrade' | 'refresh_rotation_and_replay' | 'refresh_revocation';
export interface OAuthFlowProbeDependencies {
  /** The caller supplies an authorized transport; this module never calls global fetch. */
  transport(request: Request): Promise<Response>;
  /** Complete one authorized login/consent and return its callback URL, without logging it.
   * The driver owns cancellation/deadlines for human interaction; the probe supplies no timeout. */
  authorize(input: { url: string; scenario: OAuthFlowProbeScenario }): Promise<string>;
  /** Must verify signature, issuer, resource audience, client, access-token kind and scopes. */
  verifyAccessToken(token: string): Promise<void>;
  /** Explicit scheduler hook, responsible for waiting out the actual provider grace period.
   * No built-in sleep, deadline, or claim of replay proof without this wait. */
  waitForReplayWindow?(seconds: number): Promise<void>;
}
export interface OAuthFlowProbeCheck {
  id: OAuthFlowProbeScenario;
  status: 'passed' | 'failed' | 'skipped';
  reason?: 'request_or_contract_rejected' | 'replay_wait_not_supplied' | 'protected_at_authorization_token_probe_not_reached' | 'downgrade_rejected_at_token';
}
export interface OAuthFlowProbeReport {
  execution: 'injected_transport';
  conformant: boolean;
  checks: OAuthFlowProbeCheck[];
  limitations: string[];
}

const scenarios: OAuthFlowProbeScenario[] = ['code_s256_and_replay', 'wrong_pkce', 'missing_pkce', 'authorize_missing_challenge', 'pkce_downgrade', 'refresh_rotation_and_replay', 'refresh_revocation'];
const limitations = [
  'Injected fixtures prove the harness, not an AWS deployment or connector.',
  'JWT signature validation alone cannot observe provider-side revocation before token expiry.',
  'This probe does not prove concurrent refresh-family invalidation, browser CORS, or connector execution.',
  'Authorization and grace-wait hooks own their deadlines; the probe does not verify wall-clock passage.',
];
const invalid = () => new Error('OAuth flow probe contract rejected');
function endpoint(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash && !url.search;
  } catch { return false; }
}
export function parseOAuthFlowProbeProfile(value: unknown): OAuthFlowProbeProfile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const p = value as Record<string, unknown>;
  const allowed = ['issuer', 'authorizeUrl', 'tokenUrl', 'revokeUrl', 'clientId', 'redirectUri', 'resource', 'scopes', 'authorizationResponseIssuerRequired', 'refreshGraceSeconds'];
  if (Object.keys(p).some(key => !allowed.includes(key)) ||
      !['issuer', 'authorizeUrl', 'tokenUrl', 'revokeUrl', 'redirectUri', 'resource'].every(key => endpoint(p[key])) ||
      typeof p.clientId !== 'string' || !p.clientId || p.clientId.length > 1024 || /\s/.test(p.clientId) ||
      !Array.isArray(p.scopes) || p.scopes.length === 0 || p.scopes.length > 20 ||
      !p.scopes.every(scope => typeof scope === 'string' && /^[\x21\x23-\x5b\x5d-\x7e]{1,256}$/.test(scope)) ||
      new Set(p.scopes).size !== p.scopes.length ||
      typeof p.authorizationResponseIssuerRequired !== 'boolean' ||
      !Number.isInteger(p.refreshGraceSeconds) || (p.refreshGraceSeconds as number) < 0 || (p.refreshGraceSeconds as number) > 60) throw invalid();
  return { ...(p as unknown as OAuthFlowProbeProfile), scopes: [...p.scopes] as string[] };
}
export function planOAuthFlowProbe(value: unknown) {
  parseOAuthFlowProbeProfile(value);
  return {
    execution: 'plan_only' as const,
    networkRequests: 0,
    clientAuthentication: 'none' as const,
    scenarios: [...scenarios],
    prerequisites: ['Authorized OAuth client, user, disposable grants and callback driver', 'Verified signing keys and exact issuer/resource/client checks', 'Explicit transport and replay-window wait when nonzero'],
    limitations: [...limitations],
  };
}

interface TokenResponse { accessToken: string; refreshToken: string }
interface Grant { code: string; verifier: string }
type AuthorizationOutcome = { grant: Grant } | { error: string };
async function body(response: Response): Promise<Record<string, unknown>> {
  if (response.redirected || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '') || !response.body) throw invalid();
  const reader = response.body.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > 65536) throw invalid();
      chunks.push(result.value);
    }
  } catch { void reader.cancel().catch(() => undefined); throw invalid(); }
  finally { reader.releaseLock(); }
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw invalid(); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw invalid();
  return parsed as Record<string, unknown>;
}
function token(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 32768; }

/** Runs only through injected capabilities. Never returns secrets or upstream diagnostics. */
export async function runOAuthFlowProbe(value: OAuthFlowProbeProfile, dependencies: OAuthFlowProbeDependencies): Promise<OAuthFlowProbeReport> {
  const profile = parseOAuthFlowProbeProfile(value);
  const checks: OAuthFlowProbeCheck[] = [];
  const post = async (url: string, parameters: Record<string, string>) => dependencies.transport(new Request(url, {
    method: 'POST', redirect: 'error', credentials: 'omit', cache: 'no-store',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(parameters), signal: AbortSignal.timeout(10000),
  }));
  const authorization = async (scenario: OAuthFlowProbeScenario, challenge = true): Promise<AuthorizationOutcome> => {
    const verifier = randomBytes(48).toString('base64url');
    const state = randomBytes(32).toString('base64url');
    const authorizeUrl = new URL(profile.authorizeUrl);
    authorizeUrl.search = new URLSearchParams({ response_type: 'code', client_id: profile.clientId,
      redirect_uri: profile.redirectUri, scope: profile.scopes.join(' '), resource: profile.resource,
      ...(challenge ? { code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url') } : {}), state }).toString();
    const callback = new URL(await dependencies.authorize({ url: authorizeUrl.toString(), scenario }));
    if (`${callback.origin}${callback.pathname}` !== profile.redirectUri || callback.username || callback.password || callback.hash ||
      callback.searchParams.getAll('state').length !== 1 || callback.searchParams.get('state') !== state ||
      callback.searchParams.getAll('error').length > 1 || callback.searchParams.getAll('code').length > 1 || callback.searchParams.getAll('iss').length > 1 ||
      (profile.authorizationResponseIssuerRequired && !callback.searchParams.has('iss')) ||
      (callback.searchParams.has('iss') && callback.searchParams.get('iss') !== profile.issuer)) throw invalid();
    if (callback.searchParams.has('error')) {
      if (callback.searchParams.has('code')) throw invalid();
      return { error: callback.searchParams.get('error')! };
    }
    const code = callback.searchParams.get('code');
    if (!code || code.length > 4096) throw invalid();
    return { grant: { code, verifier } };
  };
  const begin = async (scenario: OAuthFlowProbeScenario): Promise<Grant> => {
    const result = await authorization(scenario);
    if (!('grant' in result)) throw invalid();
    return result.grant;
  };
  const exchange = (grant: Grant, verifier = grant.verifier) => post(profile.tokenUrl, {
    grant_type: 'authorization_code', client_id: profile.clientId, redirect_uri: profile.redirectUri,
    resource: profile.resource, code: grant.code, code_verifier: verifier,
  });
  const tokens = async (response: Response): Promise<TokenResponse> => {
    if (response.status !== 200) { void response.body?.cancel().catch(() => undefined); throw invalid(); }
    const parsed = await body(response);
    if (!token(parsed.access_token) || !token(parsed.refresh_token) ||
      typeof parsed.token_type !== 'string' || parsed.token_type.toLowerCase() !== 'bearer' ||
      typeof parsed.expires_in !== 'number' || !Number.isFinite(parsed.expires_in) || parsed.expires_in <= 0) throw invalid();
    await dependencies.verifyAccessToken(parsed.access_token);
    return { accessToken: parsed.access_token, refreshToken: parsed.refresh_token };
  };
  const rejected = async (response: Response, allowed: string[] = ['invalid_grant']) => {
    if (response.status !== 400) { void response.body?.cancel().catch(() => undefined); throw invalid(); }
    const parsed = await body(response);
    if (typeof parsed.error !== 'string' || !allowed.includes(parsed.error)) throw invalid();
  };
  const refresh = (refreshToken: string) => post(profile.tokenUrl, {
    grant_type: 'refresh_token', client_id: profile.clientId, refresh_token: refreshToken,
  });
  const fresh = async (scenario: OAuthFlowProbeScenario) => tokens(await exchange(await begin(scenario)));
  const check = async (id: OAuthFlowProbeScenario, action: () => Promise<OAuthFlowProbeCheck['reason'] | void>) => {
    try { const reason = await action(); checks.push({ id, status: 'passed', ...(reason ? { reason } : {}) }); }
    catch { checks.push({ id, status: 'failed', reason: 'request_or_contract_rejected' }); }
  };
  await check('code_s256_and_replay', async () => {
    const grant = await begin('code_s256_and_replay');
    await tokens(await exchange(grant));
    await rejected(await exchange(grant));
  });
  await check('wrong_pkce', async () => {
    const grant = await begin('wrong_pkce');
    await rejected(await exchange(grant, randomBytes(48).toString('base64url')), ['invalid_grant', 'invalid_request']);
  });
  await check('missing_pkce', async () => {
    const grant = await begin('missing_pkce');
    // Passing undefined to a default argument would restore the verifier.
    const response = await post(profile.tokenUrl, { grant_type: 'authorization_code', client_id: profile.clientId,
      redirect_uri: profile.redirectUri, resource: profile.resource, code: grant.code });
    await rejected(response, ['invalid_grant', 'invalid_request']);
  });
  await check('authorize_missing_challenge', async () => {
    const result = await authorization('authorize_missing_challenge', false);
    if (!('error' in result) || result.error !== 'invalid_request') throw invalid();
  });
  await check('pkce_downgrade', async () => {
    const result = await authorization('pkce_downgrade', false);
    if ('error' in result) {
      if (result.error !== 'invalid_request') throw invalid();
      return 'protected_at_authorization_token_probe_not_reached';
    }
    await rejected(await exchange(result.grant), ['invalid_grant', 'invalid_request']);
    return 'downgrade_rejected_at_token';
  });
  if (profile.refreshGraceSeconds > 0 && !dependencies.waitForReplayWindow) {
    checks.push({ id: 'refresh_rotation_and_replay', status: 'skipped', reason: 'replay_wait_not_supplied' });
  } else await check('refresh_rotation_and_replay', async () => {
    const original = await fresh('refresh_rotation_and_replay');
    // Deliberately omit resource on refresh: the resulting token must retain it.
    const rotated = await tokens(await refresh(original.refreshToken));
    if (rotated.refreshToken === original.refreshToken) throw invalid();
    if (profile.refreshGraceSeconds > 0) await dependencies.waitForReplayWindow!(profile.refreshGraceSeconds);
    await rejected(await refresh(original.refreshToken));
  });
  await check('refresh_revocation', async () => {
    const original = await fresh('refresh_revocation');
    const response = await post(profile.revokeUrl, { client_id: profile.clientId, token: original.refreshToken, token_type_hint: 'refresh_token' });
    if (response.status !== 200 || response.redirected) throw invalid();
    void response.body?.cancel().catch(() => undefined);
    await rejected(await refresh(original.refreshToken));
  });
  return { execution: 'injected_transport', conformant: checks.every(check => check.status === 'passed'), checks, limitations: [...limitations] };
}

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';
import { parseOAuthFlowProbeProfile, planOAuthFlowProbe, runOAuthFlowProbe, type OAuthFlowProbeDependencies, type OAuthFlowProbeProfile, type OAuthFlowProbeScenario } from '../src/oauth-flow-probe.js';
import { createAuthenticator, parsePrivateConfig } from '../src/config.js';

const profile: OAuthFlowProbeProfile = {
  issuer: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_EXAMPLE', authorizeUrl: 'https://login.example.test/oauth2/authorize',
  tokenUrl: 'https://login.example.test/oauth2/token', revokeUrl: 'https://login.example.test/oauth2/revoke',
  clientId: 'fixture-public-client', redirectUri: 'https://client.example.test/callback',
  resource: 'https://bridge.example.test/mcp', scopes: ['bridge/read'],
  authorizationResponseIssuerRequired: true, refreshGraceSeconds: 0,
};
const signing = await generateKeyPair('RS256');
const wrongSigning = await generateKeyPair('RS256');
const publicJwk = { ...await exportJWK(signing.publicKey), kid: 'fixture-signing', alg: 'RS256' };
const keys = createLocalJWKSet({ keys: [publicJwk] });
const authenticate = createAuthenticator(parsePrivateConfig(JSON.stringify({
  clientSubjects: { [profile.clientId]: { 'fixture-subject': { id: 'fixture-agent', tenant: 'fixture-team', scopes: ['messages:read'], peers: [] } } },
  scopeAliases: { 'bridge/read': 'messages:read' },
})), profile.issuer, profile.resource, `${profile.issuer}/.well-known/jwks.json`, keys, { profile: 'cognito-access-token' });
const secretMarker = 'FICTITIOUS_TOKEN_MUST_NOT_APPEAR';
type Phase = 'initial' | 'refresh';
interface FixtureOptions {
  allowMissingChallenge?: boolean;
  acceptDowngrade?: boolean;
  ignorePkce?: boolean;
  codeReusable?: boolean;
  reuseRefresh?: boolean;
  omitRefresh?: boolean;
  ineffectiveRevoke?: boolean;
  signedClaims?: (claims: JWTPayload, phase: Phase) => JWTPayload;
  wrongSigningKey?: boolean;
  callback?: (callback: URL, scenario: OAuthFlowProbeScenario) => URL;
  response?: (response: Response, request: Request) => Response | Promise<Response>;
}
/** A deterministic protocol fixture, not an OAuth provider or Cognito emulator. */
function fixture(options: FixtureOptions = {}) {
  const codes = new Map<string, { challenge: string | null; resource: string; used: boolean }>();
  const refreshTokens = new Map<string, { resource: string; active: boolean }>();
  const requests: Request[] = [];
  const authorizations: { url: URL; scenario: OAuthFlowProbeScenario }[] = [];
  let verified = 0;
  const issue = async (resource: string, phase: Phase, existing?: string) => {
    const now = Math.floor(Date.now() / 1000);
    const claims = options.signedClaims?.({ iss: profile.issuer, aud: resource, sub: 'fixture-subject',
      client_id: profile.clientId, token_use: 'access', scope: profile.scopes.join(' '), iat: now, exp: now + 300 }, phase) ??
      { iss: profile.issuer, aud: resource, sub: 'fixture-subject', client_id: profile.clientId,
        token_use: 'access', scope: profile.scopes.join(' '), iat: now, exp: now + 300 };
    const accessToken = await new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: publicJwk.kid, typ: 'JWT' })
      .sign(options.wrongSigningKey ? wrongSigning.privateKey : signing.privateKey);
    const refreshToken = options.reuseRefresh && existing ? existing : `${secretMarker}-${randomUUID()}`;
    refreshTokens.set(refreshToken, { resource, active: true });
    return Response.json({ access_token: accessToken, token_type: 'Bearer', expires_in: 300,
      ...(phase === 'refresh' && options.omitRefresh ? {} : { refresh_token: refreshToken }) });
  };
  const reject = (error = 'invalid_grant') => Response.json({ error, error_description: secretMarker }, { status: 400 });
  const handle = async (request: Request) => {
    const parameters = new URLSearchParams(await request.text());
    assert.equal(request.headers.has('authorization'), false);
    assert.equal(parameters.has('client_secret'), false);
    assert.equal(parameters.get('client_id'), profile.clientId);
    if (request.url === profile.revokeUrl) {
      assert.equal(parameters.get('token_type_hint'), 'refresh_token');
      const row = refreshTokens.get(parameters.get('token') ?? '');
      if (row && !options.ineffectiveRevoke) row.active = false;
      return new Response(null, { status: 200 });
    }
    assert.equal(request.url, profile.tokenUrl);
    if (parameters.get('grant_type') === 'authorization_code') {
      assert.equal(parameters.get('redirect_uri'), profile.redirectUri);
      assert.equal(parameters.get('resource'), profile.resource, 'code exchange must request the original resource');
      const row = codes.get(parameters.get('code') ?? '');
      if (!row || (row.used && !options.codeReusable)) return reject();
      const verifier = parameters.get('code_verifier');
      if (!options.ignorePkce && (row.challenge
        ? !verifier || createHash('sha256').update(verifier).digest('base64url') !== row.challenge
        : verifier && !options.acceptDowngrade)) return reject();
      row.used = true;
      return issue(row.resource, 'initial');
    }
    assert.equal(parameters.get('grant_type'), 'refresh_token');
    assert.equal(parameters.has('resource'), false, 'refresh must prove original binding without resupplying resource');
    const refreshToken = parameters.get('refresh_token') ?? '';
    const row = refreshTokens.get(refreshToken);
    if (!row?.active) return reject();
    if (!options.reuseRefresh) row.active = false;
    return issue(row.resource, 'refresh', refreshToken);
  };
  const deps: OAuthFlowProbeDependencies = {
    authorize: async ({ url, scenario }) => {
      const request = new URL(url);
      authorizations.push({ url: request, scenario });
      assert.equal(request.origin + request.pathname, profile.authorizeUrl);
      assert.equal(request.searchParams.get('client_id'), profile.clientId);
      assert.equal(request.searchParams.get('resource'), profile.resource);
      assert.equal(request.searchParams.get('response_type'), 'code');
      assert.equal(request.searchParams.get('scope'), profile.scopes.join(' '));
      const callback = new URL(profile.redirectUri);
      callback.searchParams.set('state', request.searchParams.get('state')!);
      callback.searchParams.set('iss', profile.issuer);
      if (!request.searchParams.has('code_challenge') && !options.allowMissingChallenge) callback.searchParams.set('error', 'invalid_request');
      else {
        if (request.searchParams.has('code_challenge')) assert.equal(request.searchParams.get('code_challenge_method'), 'S256');
        const code = `${secretMarker}-${randomUUID()}`;
        codes.set(code, { challenge: request.searchParams.get('code_challenge'), resource: request.searchParams.get('resource')!, used: false });
        callback.searchParams.set('code', code);
      }
      return (options.callback?.(callback, scenario) ?? callback).toString();
    },
    transport: async request => {
      requests.push(request.clone());
      const snapshot = request.clone();
      const response = await handle(request);
      return options.response?.(response, snapshot) ?? response;
    },
    verifyAccessToken: async token => {
      const principal = await authenticate(new Request(profile.resource, { headers: { authorization: `Bearer ${token}` } }));
      assert.equal(principal.id, 'fixture-agent');
      assert.deepEqual(principal.scopes, ['messages:read']);
      verified++;
    },
  };
  return { deps, requests, authorizations, get verified() { return verified; } };
}
const check = (report: Awaited<ReturnType<typeof runOAuthFlowProbe>>, id: OAuthFlowProbeScenario) => report.checks.find(check => check.id === id)!;

test('local fixture proves harness requests, signature checks and separate PKCE, replay and revoke branches', async () => {
  const f = fixture();
  const report = await runOAuthFlowProbe(profile, f.deps);
  assert.equal(report.conformant, true);
  assert.equal(report.checks.length, 7);
  assert.equal(f.verified, 4);
  assert.equal(new Set(f.authorizations.map(item => item.url.searchParams.get('state'))).size, 7);
  assert.equal(new Set(f.authorizations.filter(item => item.url.searchParams.has('code_challenge')).map(item => item.url.searchParams.get('code_challenge'))).size, 5);
  for (const request of f.requests) {
    assert.equal(request.method, 'POST');
    assert.equal(request.redirect, 'error');
    assert.equal(request.credentials, 'omit');
    assert.equal(request.cache, 'no-store');
    assert.equal(request.headers.get('content-type'), 'application/x-www-form-urlencoded');
  }
  assert.equal(check(report, 'pkce_downgrade').reason, 'protected_at_authorization_token_probe_not_reached');
  assert(!JSON.stringify(report).includes(secretMarker));
  assert(report.limitations.some(value => value.includes('not an AWS deployment')));
  assert(report.limitations.some(value => value.includes('revocation before token expiry')));
});

test('probe detects missing or wrong PKCE acceptance and reused authorization codes', async () => {
  const f = fixture({ ignorePkce: true, codeReusable: true });
  const report = await runOAuthFlowProbe(profile, f.deps);
  for (const id of ['wrong_pkce', 'missing_pkce', 'code_s256_and_replay'] as const) assert.equal(check(report, id).status, 'failed');
});

test('public authorize rejection and token downgrade rejection remain independent findings', async () => {
  const guarded = await runOAuthFlowProbe(profile, fixture({ allowMissingChallenge: true }).deps);
  assert.equal(check(guarded, 'authorize_missing_challenge').status, 'failed');
  assert.deepEqual(check(guarded, 'pkce_downgrade'), { id: 'pkce_downgrade', status: 'passed', reason: 'downgrade_rejected_at_token' });
  const vulnerable = await runOAuthFlowProbe(profile, fixture({ allowMissingChallenge: true, acceptDowngrade: true }).deps);
  assert.equal(check(vulnerable, 'authorize_missing_challenge').status, 'failed');
  assert.equal(check(vulnerable, 'pkce_downgrade').status, 'failed');
});

for (const [name, change] of Object.entries({
  issuer: (p: JWTPayload) => ({ ...p, iss: 'https://other.example.test/pool' }),
  resource: (p: JWTPayload) => ({ ...p, aud: 'https://other.example.test/mcp' }),
  client: (p: JWTPayload) => ({ ...p, client_id: 'other-client' }),
  id_token: (p: JWTPayload) => ({ ...p, token_use: 'id' }),
  expired: (p: JWTPayload) => ({ ...p, exp: Math.floor(Date.now() / 1000) - 60 }),
  scope: (p: JWTPayload) => ({ ...p, scope: 'other/read' }),
})) test(`signed ${name} mismatch rejects the initial flow`, async () => {
  const report = await runOAuthFlowProbe(profile, fixture({ signedClaims: change }).deps);
  assert.equal(check(report, 'code_s256_and_replay').status, 'failed');
  assert.equal(report.conformant, false);
});

test('untrusted signing key and loss of resource audience after refresh are rejected', async () => {
  const untrusted = await runOAuthFlowProbe(profile, fixture({ wrongSigningKey: true }).deps);
  assert.equal(check(untrusted, 'code_s256_and_replay').status, 'failed');
  const resourceLost = await runOAuthFlowProbe(profile, fixture({ signedClaims: (claims, phase) => phase === 'refresh' ? { ...claims, aud: undefined } : claims }).deps);
  assert.equal(check(resourceLost, 'code_s256_and_replay').status, 'passed');
  assert.equal(check(resourceLost, 'refresh_rotation_and_replay').status, 'failed');
});

test('rotation must return a different refresh token and revocation must prevent refresh', async () => {
  for (const option of [{ reuseRefresh: true }, { omitRefresh: true }]) {
    const report = await runOAuthFlowProbe(profile, fixture(option).deps);
    assert.equal(check(report, 'refresh_rotation_and_replay').status, 'failed');
  }
  const report = await runOAuthFlowProbe(profile, fixture({ ineffectiveRevoke: true }).deps);
  assert.equal(check(report, 'refresh_revocation').status, 'failed');
});

test('nonzero grace requires explicit wait capability and never silently claims a replay proof', async () => {
  const noWait = fixture();
  const skipped = await runOAuthFlowProbe({ ...profile, refreshGraceSeconds: 30 }, noWait.deps);
  assert.deepEqual(check(skipped, 'refresh_rotation_and_replay'), { id: 'refresh_rotation_and_replay', status: 'skipped', reason: 'replay_wait_not_supplied' });
  assert.equal(skipped.conformant, false);
  assert(!noWait.authorizations.some(item => item.scenario === 'refresh_rotation_and_replay'));
  const waits: number[] = [];
  const waited = await runOAuthFlowProbe({ ...profile, refreshGraceSeconds: 30 }, { ...fixture().deps,
    waitForReplayWindow: async seconds => { waits.push(seconds); } });
  assert.equal(check(waited, 'refresh_rotation_and_replay').status, 'passed');
  assert.deepEqual(waits, [30]);
});

test('callback state, issuer, duplicates, fragment and wrong redirect are rejected before token transmission', async () => {
  const mutations = [
    (url: URL) => { url.searchParams.set('state', 'wrong-state'); return url; },
    (url: URL) => { url.searchParams.set('iss', 'https://other.example.test'); return url; },
    (url: URL) => { url.searchParams.delete('iss'); return url; },
    (url: URL) => { url.searchParams.append('state', url.searchParams.get('state')!); return url; },
    (url: URL) => { url.hash = 'fragment'; return url; },
    (url: URL) => { url.hostname = 'other.example.test'; return url; },
  ];
  for (const callback of mutations) {
    const f = fixture({ callback });
    const report = await runOAuthFlowProbe(profile, f.deps);
    assert(report.checks.every(check => check.status === 'failed'));
    assert.equal(f.requests.length, 0);
  }
});

test('OAuth rejects require protocol error, not HTML login, server error or client authentication error', async () => {
  for (const response of [new Response('<html>login</html>', { status: 400 }),
    Response.json({ error: 'invalid_grant' }, { status: 500 }), Response.json({ error: 'invalid_client' }, { status: 400 })]) {
    const f = fixture({ response: original => original.status === 400 ? response.clone() : original });
    const report = await runOAuthFlowProbe(profile, f.deps);
    assert.equal(check(report, 'wrong_pkce').status, 'failed');
    assert.equal(check(report, 'missing_pkce').status, 'failed');
  }
});

test('untrusted errors and oversized or malformed token responses never enter the report', async () => {
  for (const deps of [
    { ...fixture().deps, transport: async () => { throw new Error(secretMarker); } },
    fixture({ response: () => new Response(secretMarker.repeat(5000), { headers: { 'content-type': 'application/json' } }) }).deps,
    fixture({ response: () => Response.json({ access_token: secretMarker, refresh_token: secretMarker, token_type: 'MAC', expires_in: 300 }) }).deps,
  ]) {
    const report = await runOAuthFlowProbe(profile, deps);
    assert.equal(report.conformant, false);
    assert(!JSON.stringify(report).includes(secretMarker));
  }
});

test('public profile validation rejects downgrade endpoints, secrets, invalid grace and unknown options', () => {
  for (const value of [{ ...profile, tokenUrl: 'http://login.example.test/token' },
    { ...profile, issuer: 'https://user:secret@issuer.example.test' }, { ...profile, tokenUrl: 'https://login.example.test/token?secret=value' },
    { ...profile, clientSecret: secretMarker }, { ...profile, refreshGraceSeconds: 61 },
    { ...profile, scopes: [] }, { ...profile, scopes: ['read write'] }]) {
    assert.throws(() => parseOAuthFlowProbeProfile(value), /OAuth flow probe contract rejected/);
  }
  assert.equal(planOAuthFlowProbe(profile).networkRequests, 0);
});

test('CLI supports plan only and emits neither configuration values nor input errors', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'oauth-probe-plan-'));
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const execute = promisify(execFile);
  const run = async (...args: string[]) => {
    try { return { status: 0, ...await execute(process.execPath, ['--import', 'tsx', 'scripts/oauth-flow-probe.ts', ...args], { env }) }; }
    catch (error) {
      const result = error as { code: number; stdout: string; stderr: string };
      return { status: result.code, stdout: result.stdout, stderr: result.stderr };
    }
  };
  try {
    const file = join(directory, 'profile.json');
    await writeFile(file, JSON.stringify(profile));
    const planned = await run('--plan', file);
    assert.equal(planned.status, 0, planned.stderr);
    assert.equal(JSON.parse(planned.stdout).execution, 'plan_only');
    const live = await run('--execute', file);
    assert.equal(live.status, 1);
    assert(live.stderr.includes('No network request was made'));
    await writeFile(file, `${secretMarker}{`);
    const invalid = await run('--plan', file);
    assert.equal(invalid.status, 1);
    assert(!`${invalid.stdout}${invalid.stderr}`.includes(secretMarker));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

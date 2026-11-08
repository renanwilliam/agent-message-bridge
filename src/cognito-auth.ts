import type { JWTPayload } from 'jose';

export type TokenProfile = 'generic-jwt' | 'cognito-access-token';
export interface AuthenticatorOptions { profile?: TokenProfile }
export interface AuthorizationServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  revocation_endpoint: string;
  jwks_uri: string;
  response_types_supported: string[];
  grant_types_supported: string[];
  code_challenge_methods_supported: string[];
  token_endpoint_auth_methods_supported: string[];
  scopes_supported: string[];
}

/** Cognito remains the trusted token issuer; discovery never chooses that trust. */
export function validateCognitoEndpoints(issuer: string, jwksUrl: string) {
  const url = new URL(issuer);
  const host = url.hostname.match(/^(?:issuer-)?cognito-idp\.([a-z]{2}(?:-[a-z]+)+-\d)\.(amazonaws\.com(?:\.cn)?)$/);
  if (!host || url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash ||
      !new RegExp(`^/${host[1]}_[A-Za-z0-9]+$`).test(url.pathname)) throw new Error('Invalid Cognito token issuer');
  const suffix = `${url.pathname}/.well-known/jwks.json`;
  const allowed = [
    `https://cognito-idp.${host[1]}.${host[2]}${suffix}`,
    `https://issuer-cognito-idp.${host[1]}.${host[2]}${suffix}`,
  ];
  if (!allowed.includes(jwksUrl)) throw new Error('Cognito JWKS must belong to the configured pool');
  return { region: host[1]!, partitionDomain: host[2]! };
}

/** Applied only after jose has verified signature, issuer, audience and lifetime. */
export function validateCognitoAccessClaims(payload: JWTPayload, audience: string): void {
  if (payload.token_use !== 'access' || payload.aud !== audience ||
      typeof payload.client_id !== 'string' || !payload.client_id ||
      (payload.azp !== undefined && payload.azp !== payload.client_id) ||
      typeof payload.scope !== 'string' || !payload.scope.trim()) throw new Error('Invalid Cognito access token');
}

/** Static RFC 8414 advertisement, not an OIDC issuer or a token-minting broker. */
export function cognitoAuthorizationMetadata(input: {
  issuer: string; tokenIssuer: string; jwksUrl: string; loginOrigin: string; resource: string; scopes: string[];
}): AuthorizationServerMetadata {
  const pool = validateCognitoEndpoints(input.tokenIssuer, input.jwksUrl);
  const issuer = new URL(input.issuer);
  const resource = new URL(input.resource);
  const login = new URL(input.loginOrigin);
  if (issuer.protocol !== 'https:' || issuer.origin !== input.issuer || issuer.origin !== resource.origin ||
      resource.protocol !== 'https:' || resource.username || resource.password || resource.search || resource.hash ||
      login.origin !== input.loginOrigin || login.protocol !== 'https:' ||
      !new RegExp(`^[a-z0-9][a-z0-9-]{0,62}\\.auth\\.${pool.region}\\.amazoncognito\\.com(?:\\.cn)?$`).test(login.hostname) ||
      !input.scopes.length || input.scopes.some(scope => !/^\S{1,1024}$/.test(scope))) {
    throw new Error('Invalid Cognito discovery configuration');
  }
  return {
    issuer: input.issuer,
    authorization_endpoint: `${input.loginOrigin}/oauth2/authorize`,
    token_endpoint: `${input.loginOrigin}/oauth2/token`,
    revocation_endpoint: `${input.loginOrigin}/oauth2/revoke`,
    jwks_uri: input.jwksUrl,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [...new Set(input.scopes)],
  };
}

export function oauthRuntimeSettings(environment: Record<string, string | undefined>) {
  const issuer = environment.OAUTH_ISSUER;
  const profile = environment.OAUTH_TOKEN_PROFILE ?? 'generic-jwt';
  if (!issuer || !['generic-jwt', 'cognito-access-token'].includes(profile)) throw new Error('Invalid OAuth runtime configuration');
  const tokenIssuer = environment.OAUTH_TOKEN_ISSUER ?? (profile === 'generic-jwt' ? issuer : undefined);
  if (!tokenIssuer) throw new Error('Cognito requires an explicit token issuer');
  return { issuer, tokenIssuer, profile: profile as TokenProfile };
}

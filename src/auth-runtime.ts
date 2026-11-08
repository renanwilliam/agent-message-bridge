import type { AppConfig } from './app.js';
import { advertisedOAuthScopes, createAuthenticator, type PrivateConfig } from './config.js';
import { cognitoAuthorizationMetadata, oauthRuntimeSettings } from './cognito-auth.js';

/** One explicit selection; an untrusted token can never select its own provider. */
export function createOAuthAppConfig(config: PrivateConfig, environment: Record<string, string | undefined>): AppConfig {
  const required = (name: string) => {
    const value = environment[name];
    if (!value) throw new Error(`${name} required`);
    return value;
  };
  const { issuer, tokenIssuer, profile } = oauthRuntimeSettings(environment);
  const resourceUrl = required('MCP_RESOURCE_URL');
  const audience = required('OAUTH_AUDIENCE');
  const jwksUrl = required('OAUTH_JWKS_URL');
  const scopes = advertisedOAuthScopes(config);
  if (config.cognitoDiscovery && profile !== 'cognito-access-token') throw new Error('Cognito discovery requires the Cognito token profile');
  if (profile === 'cognito-access-token' && audience !== resourceUrl) throw new Error('Cognito audience must equal the protected resource');
  const metadata = config.cognitoDiscovery ? cognitoAuthorizationMetadata({
    issuer, tokenIssuer, jwksUrl, resource: resourceUrl, scopes, loginOrigin: config.cognitoDiscovery.loginOrigin,
  }) : undefined;
  return {
    resourceUrl, issuer, oauthAudience: audience, viewerOAuth: config.viewerOAuth,
    advertisedScopes: scopes, scopeAliases: config.scopeAliases, origins: config.origins, callbacks: config.callbacks,
    ...(metadata ? { authorizationServerMetadata: metadata } : {}),
    authenticate: createAuthenticator(config, tokenIssuer, audience, jwksUrl, undefined, { profile }),
  };
}

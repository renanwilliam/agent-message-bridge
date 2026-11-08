/** Operator preflight for the JWT provider contract; no credentials or grants are created. */
export interface OAuthReadiness {
  compatibleMetadata: boolean;
  errors: string[];
  authorizationResponseIssuerRequired: boolean;
  endpoints?: { issuer: string; authorizeUrl: string; tokenUrl: string; jwksUrl: string };
  flowTestsRequired: string[];
}

function httpsEndpoint(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}

export function discoveryUrls(issuer: string): string[] {
  if (!httpsEndpoint(issuer)) throw new Error('Issuer must be an HTTPS URL without credentials, query or fragment');
  const url = new URL(issuer);
  const path = url.pathname.replace(/\/$/, '');
  return [
    `${url.origin}/.well-known/oauth-authorization-server${path}`,
    `${url.origin}${path}/.well-known/openid-configuration`,
  ];
}

export function inspectOAuthMetadata(value: unknown, issuer: string, clientMethod = 'none'): OAuthReadiness {
  discoveryUrls(issuer);
  if (!['none', 'client_secret_basic', 'client_secret_post'].includes(clientMethod)) throw new Error('Unsupported client authentication method');
  const metadata = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const errors: string[] = [];
  const includes = (field: string, item: string) => Array.isArray(metadata[field]) && metadata[field].every(entry => typeof entry === 'string') && metadata[field].includes(item);
  if (metadata.issuer !== issuer) errors.push('issuer_mismatch');
  if (!includes('code_challenge_methods_supported', 'S256')) errors.push('s256_not_advertised');
  if (!includes('response_types_supported', 'code')) errors.push('authorization_code_response_not_advertised');
  // RFC 8414 defaults an omitted token authentication list to client_secret_basic.
  const methods = metadata.token_endpoint_auth_methods_supported === undefined ? ['client_secret_basic'] : metadata.token_endpoint_auth_methods_supported;
  if (!Array.isArray(methods) || !methods.every(entry => typeof entry === 'string') || !methods.includes(clientMethod)) errors.push('client_authentication_method_not_advertised');
  if (metadata.grant_types_supported !== undefined && !includes('grant_types_supported', 'authorization_code')) errors.push('authorization_code_grant_not_advertised');
  if (metadata.authorization_response_iss_parameter_supported !== undefined &&
      typeof metadata.authorization_response_iss_parameter_supported !== 'boolean') errors.push('invalid_issuer_response_metadata');
  for (const field of ['authorization_endpoint', 'token_endpoint', 'jwks_uri']) {
    if (!httpsEndpoint(metadata[field])) errors.push(`invalid_${field}`);
  }
  return {
    compatibleMetadata: errors.length === 0,
    errors,
    authorizationResponseIssuerRequired: metadata.authorization_response_iss_parameter_supported === true,
    ...(errors.length ? {} : { endpoints: {
      issuer, authorizeUrl: metadata.authorization_endpoint as string,
      tokenUrl: metadata.token_endpoint as string, jwksUrl: metadata.jwks_uri as string,
    } }),
    flowTestsRequired: ['code_and_s256', 'resource_audience_binding', 'client_subject_and_scopes',
      'refresh_and_revocation', 'viewer_token_endpoint_cors', 'connector_webhook_execution'],
  };
}

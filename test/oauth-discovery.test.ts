import assert from 'node:assert/strict';
import test from 'node:test';
import { discoveryUrls, inspectOAuthMetadata } from '../src/oauth-discovery.js';

const issuer = 'https://issuer.example.test/authorization';
const metadata = {
  issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`,
  response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
  code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none', 'client_secret_basic'],
  authorization_response_iss_parameter_supported: true,
};

test('metadata preflight keeps issuer path and distinct RFC 8414 / OIDC discovery locations', () => {
  assert.deepEqual(discoveryUrls(issuer), ['https://issuer.example.test/.well-known/oauth-authorization-server/authorization', `${issuer}/.well-known/openid-configuration`]);
  for (const invalid of ['http://issuer.example.test', 'https://user:secret@issuer.example.test', `${issuer}?token=secret`, `${issuer}#fragment`]) {
    assert.throws(() => discoveryUrls(invalid), /Issuer must/);
  }
});

test('metadata preflight derives required issuer response without claiming a successful OAuth flow', () => {
  const result = inspectOAuthMetadata(metadata, issuer);
  assert.equal(result.compatibleMetadata, true);
  assert.equal(result.authorizationResponseIssuerRequired, true);
  assert.ok(result.flowTestsRequired.includes('resource_audience_binding'));
  assert.equal(inspectOAuthMetadata({ ...metadata, authorization_response_iss_parameter_supported: false }, issuer).authorizationResponseIssuerRequired, false);
  assert.equal(inspectOAuthMetadata({ ...metadata, authorization_response_iss_parameter_supported: undefined }, issuer).authorizationResponseIssuerRequired, false);
});

test('missing S256, wrong issuer and unsupported public clients fail before creating configuration', () => {
  const result = inspectOAuthMetadata({ ...metadata, issuer: `${issuer}/`, code_challenge_methods_supported: undefined, token_endpoint_auth_methods_supported: ['client_secret_post'] }, issuer);
  assert.equal(result.compatibleMetadata, false);
  assert.deepEqual(result.errors, ['issuer_mismatch', 's256_not_advertised', 'client_authentication_method_not_advertised']);
  assert.equal(result.endpoints, undefined);
  assert.equal(inspectOAuthMetadata({ ...metadata, token_endpoint_auth_methods_supported: undefined }, issuer, 'client_secret_basic').compatibleMetadata, true);
  for (const malformed of [null, 'client_secret_basic', [1, 'client_secret_basic']]) {
    assert.equal(inspectOAuthMetadata({ ...metadata, token_endpoint_auth_methods_supported: malformed }, issuer, 'client_secret_basic').compatibleMetadata, false);
  }
});

test('invalid endpoints, metadata types and unsupported grants are rejected without reflecting arbitrary metadata', () => {
  const result = inspectOAuthMetadata({ ...metadata, authorization_response_iss_parameter_supported: 'true', token_endpoint: 'https://user:secret@issuer.example.test/token', jwks_uri: 'http://issuer.example.test/jwks', grant_types_supported: ['client_credentials'], untrusted: 'sensitive-value' }, issuer);
  assert.equal(result.compatibleMetadata, false);
  assert.ok(result.errors.includes('invalid_issuer_response_metadata'));
  assert.ok(result.errors.includes('invalid_token_endpoint'));
  assert.ok(result.errors.includes('authorization_code_grant_not_advertised'));
  assert.ok(!JSON.stringify(result).includes('sensitive-value'));
});

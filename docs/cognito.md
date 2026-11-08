# Cognito integration candidate

This integration keeps Cognito responsible for login, authorization codes, token issuance, refresh and revocation. The bridge verifies access tokens and can publish static OAuth authorization-server metadata for pre-registered public clients. It does not register clients, mint tokens, proxy credentials or create users. The message store, claims, fencing, outbox and Events remain provider-independent.

The implementation and tests are local. They do not certify Cognito, a deployed gateway or a connector. Keep `BOOTSTRAP_MODE=true` until the installation's real flows pass the checks below. Publishing metadata is not evidence that a connector has completed authorization.

## Explicit token and discovery identities

Select `oauthTokenProfile=cognito-access-token`. Configure `oauthTokenIssuer` with the actual pool issuer and `oauthJwksUrl` with that pool's public keys. `oauthIssuer` remains the authorization-server identity advertised to clients. These values are independent and never selected from an unverified token. The generic JWT profile retains the previous default of using `oauthIssuer` for both purposes.

The Cognito profile accepts only RS256 access tokens with the configured issuer, an exact string `aud` equal to `MCP_RESOURCE_URL`/`oauthAudience`, expiry, issued-at, subject, `token_use=access`, nonempty `client_id` and scope. It does not substitute the client ID for the resource audience. If `azp` is present it must agree with `client_id`; `azp` alone is insufficient. It rejects ID/session tokens, other algorithms, array audiences and subject-only mappings. It intersects token scopes with the configured `(client_id, sub)` principal grant. An empty grant configuration denies all requests, including on runtime roles that never authenticate HTTP traffic.

Use distinct public app clients for the event-capable agent, peer and human reader. Register only authorization code, exact redirects and their respective scopes. Do not create client secrets for this mode. Enable and test public-client refresh rotation. A connector shared across an account proves the account/connection identity, not the individual bot that invoked it. A webhook can select a routine but does not strengthen that identity claim.

## Align the resource server and external scopes

For this integration, set the Cognito resource server's **Identifier** to the exact canonical HTTPS MCP resource URL. Use that same string for the OAuth `resource` parameter, `MCP_RESOURCE_URL`, `oauthAudience` and the access token's expected `aud`. The resource server's display **Name** is not its identifier. Preserve the full path and trailing-slash choice consistently; the verifier does not replace this audience with the pool issuer, login domain, origin or app client ID. AWS documents URL-formatted resource-server identifiers and resource binding to the requested access-token audience. [Cognito resource binding](https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-define-resource-servers.html)

Cognito constructs an external custom scope as `Identifier + '/' + ScopeName`. With the fictional resource `https://bridge.example.com/mcp` and `ScopeName` `history:read`, the OAuth scope is `https://bridge.example.com/mcp/history:read`. The internal bridge permission remains `history:read`; `scopeAliases` maps the full external string to that permission. An alias only interprets a token already issued by the provider. It cannot reassign a Cognito scope to another resource or repair a rejected authorization request. [CreateResourceServer — Identifier](https://docs.aws.amazon.com/cognito-user-identity-pools/latest/APIReference/API_CreateResourceServer.html#CognitoUserPools-CreateResourceServer-request-Identifier)

An actual authorization-endpoint check rejected a short-identifier custom scope combined with a different URL resource, returning `invalid_request` because the requested custom scopes were not assigned to that resource. The check stopped before login: it demonstrates a configuration rejection, not a successful token exchange. For example, `scope=bridge/history:read` belongs to identifier `bridge`; setting `resource=https://bridge.example.com/mcp` does not move that scope into the URL resource server. The authorization documentation's illustrative resource-binding request uses a scheme-less scope prefix; do not treat that example as proof that differing identifiers are interchangeable. [Cognito authorize — resource binding](https://docs.aws.amazon.com/cognito/latest/developerguide/authorization-endpoint.html)

Before an approved activation, align the resource server, each app client's allowed OAuth scopes, connector requests, `viewerOAuth.scopes`, all `scopeAliases` keys and the advertised subset. Changing the resource-server identifier changes the external scope names; updating aliases alone is insufficient. Keep the existing four/three/one internal principal grants. The example below uses one fictional canonical resource throughout.

Retain `resource` and exact audience validation during compatibility testing and activation. A password-setting or onboarding flow that omits resource binding is a separate task; reaching its login page or completing it does not prove MCP authorization. Activation still requires a successful S256 code exchange and refreshed access tokens with the exact canonical `aud`, intended client/subject and allowed scopes.

## Verify SDK sign-in behavior separately

`ExplicitAuthFlows: []` is not a verified switch for disabling SDK sign-in. Deployment checks have observed this field absent from `DescribeUserPoolClient` while `USER_SRP_AUTH` still returned a challenge and `CUSTOM_AUTH` reached the missing-trigger check. AWS documents SRP, custom auth and refresh as defaults when the setting is omitted. Preserve the actual readback and test behavior; do not interpret an absent field as an empty effective permission set. [App-client authentication flows](https://docs.aws.amazon.com/cognito-user-identity-pools/latest/APIReference/API_CreateUserPoolClient.html).

Use nonexistent synthetic usernames and valid request shapes to probe each relevant flow. Under user-existence suppression, an SRP challenge can be simulated: it establishes that the flow was reached, not that a user authenticated. An explicit flow-disabled response differs from an incorrect-password or missing-trigger error. Include `USER_AUTH`, which can permit password/SRP independently of the corresponding individual flow settings. Refresh-rotation rejection of `REFRESH_TOKEN_AUTH` does not prove other SDK flows are disabled. Record only the flow, error class and sanitized outcome; discard challenge parameters and session values. Recheck after any client or pool-trigger change. [User-existence responses](https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pool-managing-errors.html), [InitiateAuth](https://docs.aws.amazon.com/cognito-user-identity-pools/latest/APIReference/API_InitiateAuth.html).

The bridge independently requires its exact resource audience, operation scopes and private client/subject grant. Default SDK sign-in tokens carry the Cognito self-service scope rather than bridge scopes and cannot authorize bridge operations; a valid pool signature or client ID alone is insufficient. Review any token-customization trigger separately. This is claim-based validation, not a blanket rejection of SDK transport: `GetTokensFromRefreshToken` can refresh tokens originally issued through managed login. [Access-token claims](https://docs.aws.amazon.com/cognito/latest/developerguide/amazon-cognito-user-pools-using-the-access-token.html), [Refresh tokens](https://docs.aws.amazon.com/cognito/latest/developerguide/amazon-cognito-user-pools-using-the-refresh-token.html).

## Optional static authorization metadata

The **history-role** configuration can include:

```json
{
  "cognitoDiscovery": {
    "loginOrigin": "https://example-login.auth.us-east-1.amazoncognito.com"
  },
  "scopeAliases": {
    "https://bridge.example.com/mcp/messages:send": "messages:send",
    "https://bridge.example.com/mcp/messages:read": "messages:read",
    "https://bridge.example.com/mcp/messages:claim": "messages:claim",
    "https://bridge.example.com/mcp/events:subscribe": "events:subscribe",
    "https://bridge.example.com/mcp/history:read": "history:read"
  },
  "advertisedScopes": [
    "https://bridge.example.com/mcp/messages:send",
    "https://bridge.example.com/mcp/messages:read",
    "https://bridge.example.com/mcp/messages:claim"
  ]
}
```

These fields do not grant any scope. Keep the reader's actual `clientSubjects` principal limited to `history:read`; the MCP role receives only its agent mappings. Scopes advertised here must also be defined and constrained on the approved Cognito clients.

`advertisedScopes` optionally selects 1–20 unique external scope names from `scopeAliases`, or from the five built-in names when aliases are absent. Unknown names are rejected. The application uses that exact subset in both authorization-server metadata and protected-resource metadata; omitting the field preserves the complete existing list. Token verification and private principal grants continue to use all configured aliases. Both metadata specifications permit disclosing a subset of supported scopes; the published list is not an instruction to request every scope. [RFC 8414 §2](https://www.rfc-editor.org/rfc/rfc8414.html#section-2), [RFC 9728 §2](https://www.rfc-editor.org/rfc/rfc9728.html#section-2), [RFC 9728 §7.2](https://www.rfc-editor.org/rfc/rfc9728.html#section-7.2).

The proposed client setup advertises the three message scopes shown above. Configure the event-capable agent's connection UI to request those three plus `https://bridge.example.com/mcp/events:subscribe` explicitly; configure the peer for the three message scopes and `viewerOAuth.scopes` for only `https://bridge.example.com/mcp/history:read`. Their private principal grants remain four, three and one scopes respectively. Metadata alone cannot grant or remove those permissions, and this example does not change any real installation.

For this option, `oauthIssuer` must be the bridge's HTTPS origin, and `oauthTokenIssuer` must explicitly name its Cognito pool. The application serves `GET /.well-known/oauth-authorization-server` with OAuth-only metadata and Cognito endpoints. GET/OPTIONS support public CORS, including `mcp-protocol-version`. No OIDC alias, registration endpoint, CIMD, RFC 9207 or resource-capability flag is invented. The deployment template routes this endpoint to the existing history function; it does not add a runtime role. Runtime bootstrap suppresses it along with all application routes.

This is an RFC 8414 composition with Cognito's proprietary access-token profile. It does **not** claim that the facade is an OIDC issuer or implements the RFC 9068 JWT profile, which has its own issuer requirement. A connector may impose additional rules; test the actual connector. A callback containing `iss` must still match the configured authorization-server identity. Do not ignore a mismatch or use the stable callback reserved for providers that support RFC 9207. [RFC 8414](https://www.rfc-editor.org/rfc/rfc8414.html), [RFC 9068](https://www.rfc-editor.org/rfc/rfc9068.html#section-4), [OpenAI authentication](https://developers.openai.com/plugins/build/auth).

Serverless publishes protected-resource metadata as its own API Gateway MOCK integration. The application tests do not certify that deployed response, its scope list, headers or bootstrap suppression. The private bootstrap template must continue omitting native `oauthDiscovery`; review the newly packaged routes before an approved activation and probe the actual gateway afterward. The authorization-server route added here is a separate application route.

The native gateway metadata currently omits `scopes_supported`; the new application setting does not modify that integration. During deployment review, verify the connector's fallback to the authorization server's three advertised scopes when the native list is absent. If a native list is introduced, it must match the selected subset rather than silently restoring all five scopes. No gateway or IAM change is included in this setting.

Static registration is deliberate. A DCR endpoint that merely stores client metadata cannot create a usable Cognito app client or bind a new grant by itself. Supporting DCR/CIMD could require a privileged Cognito registrar or a broker with its own code/token state. Choose such a component only after the actual connector demonstrates that pre-registration is insufficient, and review its independent state, permissions and revocation contract.

## Executable flow checks

`src/oauth-flow-probe.ts` drives a complete code/PKCE flow through injected authorization, HTTP transport and token-verification capabilities. Tests use an in-process provider fixture with real S256 and RS256 verification; they exercise requests and malicious-provider variants. This proves the harness and bridge verifier, not AWS behavior. No production user, client or credential is created.

The CLI is intentionally plan-only:

```sh
node --import tsx scripts/oauth-flow-probe.ts --plan examples/cognito-flow-probe.json
```

The execution API requires an independently authorized callback driver and transport. Do not capture another connector's authorization code: its verifier belongs to that connector. Do not add a localhost callback or temporary app client without approving that exact access. Keep callbacks, authorization codes, verifiers, tokens and credentials in memory; the report includes only fixed scenario names and results. A nonzero refresh grace requires an explicit wait capability before a replay result is claimed.

Required actual-provider checks:

1. The canonical URL resource-server identifier and its custom scopes pass authorization validation; reaching the login page alone is not a pass for the flow. S256 code exchange succeeds with a public client, `resource` and no client secret. Missing/wrong verifiers, code reuse, wrong client/redirect and wrong resource fail.
2. Authorization without `code_challenge` is rejected for a public client. Separately, a code issued without a challenge must not be redeemed with an arbitrary verifier. A relay that only checks its own incoming request cannot prove either property of the directly reachable Cognito endpoint.
3. Code and refreshed tokens carry the canonical resource audience, trusted pool issuer, access-token kind, intended client/subject and authorized scopes. Refresh rotation, replay after grace and refresh after revoke are exercised. A successful revoke response alone is insufficient evidence.
4. The actual connector accepts the static registration and callback; the viewer's token endpoint CORS works; the deployed gateway preserves `WWW-Authenticate` and the protected-resource metadata URL. Test the peer's connector during a webhook-triggered execution.
5. Operational revocation advances the durable Events authorization epoch and removes the private identity mapping as well as revoking the provider grant. Offline JWT validation does not immediately observe every Cognito revocation, and already-started requests cannot be recalled.

OAuth 2.1 requires a challenge for public clients, while the Cognito endpoint documentation describes the challenge as optional generally. Do not infer either conformity or a vulnerability from that wording alone. If the actual public-client flow accepts a missing challenge, record the normative discrepancy; token-level downgrade rejection is a separate result. If protection cannot be demonstrated, a static facade is not enough to certify this integration. A broker or different provider then needs a concrete design and tests, rather than a metadata-only workaround. [OAuth 2.1 authorization request](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-v2-1-13#section-4.1.2.1), [RFC 9700 downgrade](https://www.rfc-editor.org/rfc/rfc9700.html#section-4.8.2), [Cognito authorize](https://docs.aws.amazon.com/cognito/latest/developerguide/authorization-endpoint.html).

## Installation changes

This source change prepares two environment parameters and GET/OPTIONS routes. It is not a deployment or authorization to activate them. Review the generated infrastructure diff separately from a code-only release. Private client registrations, login branding, user onboarding, mappings, connector grants, webhook credentials and Events grants remain distinct installation actions. No identity-pool credentials, shared application access or authentication database is needed for the static candidate.

OAuth metadata omissions do not establish that a more expensive Cognito tier fixes them. Check the tier's documented feature requirements for the selected managed-login and refresh features; do not upgrade only to obtain DCR or advertise S256. [Cognito feature plans](https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-sign-in-feature-plans.html).

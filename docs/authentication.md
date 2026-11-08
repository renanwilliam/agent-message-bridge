# Authorization server readiness

Use an existing compatible authorization server when possible. The bridge verifies JWT signatures, issuer, exact resource audience, expiry, client identity and subject mappings. It does not create an identity provider or translate tokens issued for other resources.

Before creating clients, inspect the actual issuer's public metadata:

```sh
node --import tsx scripts/oauth-preflight.ts https://issuer.example.test none
```

This command only reads discovery documents. It checks exact issuer matching, HTTPS endpoints, authorization-code support, advertised S256, the selected client authentication method and JWKS. It returns `authorizationResponseIssuerRequired` for the viewer configuration. A passing result verifies metadata only: real code/PKCE, audience binding, scopes, refresh, revocation, browser CORS and connector execution still need tests. The tool does not obtain tokens or create grants. It is intended for the JWT verifier currently implemented; an opaque-token broker needs a different verifier.

The OpenAI client requires `code_challenge_methods_supported` to include `S256`; endpoint support alone is insufficient. Set `authorizationResponseIssuerRequired` from the verified issuer metadata. Advertise RFC 9207 only if every authorization response returns the exact issuer. Copy the connector's actual callback URI; do not infer a callback ID or allow a list of unrelated redirects. [OpenAI authentication](https://developers.openai.com/plugins/build/auth).

## Provider choices

The [Cognito integration candidate](cognito.md) includes a strict access-token profile, separate discovery/token issuers and an executable OAuth flow harness. Static metadata is only one part of it. The local tests do not establish that the real Cognito client or connector passes those flows, and no DCR or token broker is implicitly supplied.

| Choice | Fit and remaining checks |
| --- | --- |
| Existing compatible JWT provider | Smallest deployment when already available. Verify discovery, `resource`→`aud`, client/subject claims and the required scopes with real tokens. |
| Auth0 | Candidate that preserves the JWT verifier. Its Resource Parameter Compatibility Profile supports MCP resource indicators; enable and test the issuer response setting separately. Verify S256 in the actual tenant metadata and the plan's limits before creating clients. |
| Cognito directly | Resource binding and PKCE endpoint support do not establish the required discovery contract. Do not assume a pool is compatible when S256 is missing from metadata. |
| Isolated OAuth broker | Can implement the missing protocol contract, but adds issuance, refresh, revocation, state, key management and runtime permissions. It is a separate component to implement and review, not a metadata JSON shim. |

For a small installation, evaluating a managed provider's free tier can avoid building and operating a broker. Auth0 currently publishes a free tier with Auth for MCP, but no tenant is provisioned or certified by this project. Each installation owns its tenant and private grants; no central SaaS is required. Verify current pricing and capabilities before approval. [Auth0 pricing](https://auth0.com/pricing), [resource parameter profile](https://auth0.com/ai/docs/mcp/guides/resource-param-compatibility-profile), [discovery](https://auth0.com/docs/get-started/applications/configure-applications-with-oidc-discovery).

Use separate client registrations for the event-capable agent, webhook-driven peer and human reader. A shared human login can map to different bridge identities through validated `client_id`/`azp` plus `sub`. The viewer is a public PKCE client with only `history:read`; no client secret belongs in browser code. Agent grants and webhook credentials remain separate. The peer's authenticated connector must actually work during a webhook-triggered execution before the installation is considered operational.

## Discovering Events through the existing OAuth connection

`bridge_list_events` is a read-only tool that returns the same catalog as `events/list`. It accepts no arguments and performs no writes, callback verification, subscription creation or event-authorization activation. Listing a catalog does not prove that delivery is active; native `events/subscribe` still requires an active authorization epoch.

Only identities whose configured grant includes `events:subscribe` can discover this tool. The authenticator derives that eligibility after validating the client and subject; claims and tool arguments cannot supply it. Eligibility does not add an effective token scope. A peer or human reader without the grant cannot use the tool or initiate an Events scope upgrade.

For an eligible connection missing the token scope, the tool returns an OAuth error challenge in `_meta["mcp/www_authenticate"]`. Its `_meta.securitySchemes` and challenge request the same provider scopes: the principal's current effective scopes plus `events:subscribe`. This preserves existing message permissions even when the host starts authorization from tool metadata. Global AS/PRM `scopes_supported` remains unchanged. [OpenAI's tool-level authentication contract](https://developers.openai.com/plugins/build/auth#triggering-authentication-ui)

The helper resolves scope names through `scopeAliases`. When aliases are configured, each requested internal scope must have exactly one provider alias using valid OAuth scope-token syntax. Missing, ambiguous or invalid aliases hide only this helper; existing message operations remain available. Do not fix a missing helper by expanding the global advertised scope list or granting Events to a peer.

After deployment, refresh the existing plugin's tool discovery and invoke `bridge_list_events`. The server tests cover the SDK wire behavior; successful scope expansion in a particular host still requires a real consent flow. Verify the resulting connection retains its message scopes. Then refresh native Events discovery and verify the event appears before continuing with the authorized subscription workflow. A tool result alone does not register an event or automation in the host. [OpenAI's Events test workflow](https://developers.openai.com/plugins/build/mcp-events#test-in-chatgpt)

## Revocation contract

Provider refresh-token revocation does not necessarily invalidate an already issued JWT at an offline resource server. Remove the private access mapping to block subsequent authenticated calls after the configuration cache expires (up to 60 seconds), and invoke the bridge event revocation hook to stop asynchronous deliveries. The event grant is read from durable storage immediately before delivery; it is not inferred from a cached OAuth token or signing-key possession. See [the operator procedure](deployment.md#event-authorization-and-revocation).

An integration with provider lifecycle events must authenticate those events and invoke `setEventAuthorization` with the expected current epoch. No unauthenticated revocation endpoint is supplied. Without that integration, the operator must perform both provider and bridge revocation; the project does not claim automatic detection of every provider-side disconnect.

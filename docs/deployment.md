# Private AWS installation

This repository contains a deployment template, not an active service. Keep the real configuration, identity mappings, webhook credentials, cloud account identifiers, endpoint URLs and deployment artifacts in a separate private location. The public repository needs only its generic source and fictional tests.

The template creates one installation for one user or team. DynamoDB is the production store; SQLite is a local development/proof adapter. Additional tenants are not required to use it.

## Supply deployment inputs

| Input | Meaning |
| --- | --- |
| `--stage` | Explicit isolated installation stage |
| `--region` | AWS region approved for this installation |
| `serviceName` | Stack/service prefix; defaults to `agent-message-bridge` |
| `installationId` | Required safe identifier for this installation; its exact value prefixes every authorized partition |
| `mcpConfigSecretArn` | Existing private secret containing MCP identity mappings, limits and recipient pointers; no peer webhook credentials |
| `ingressConfigSecretArn` | Existing private secret for peer request verification and permitted identities |
| `historyConfigSecretArn` | Existing private secret containing only human reader mappings and browser origins |
| `deliveryConfigSecretArn` | Existing private secret containing recipient webhook routes and their credentials |
| `oauthIssuer` | HTTPS authorization-server identity advertised to clients |
| `oauthTokenIssuer` | Explicit trusted token issuer; defaults to `oauthIssuer` for the generic JWT profile |
| `oauthTokenProfile` | `generic-jwt` (default) or `cognito-access-token`; Cognito requires explicit client/subject mappings |
| `oauthAudience` | Exact resource audience accepted by the application's JWT verifier |
| `oauthJwksUrl` | HTTPS public signing-key set used to validate issuer tokens |
| `publicBaseUrl` | Existing HTTPS public origin/base for the service; the MCP resource is this value plus `/bridge/mcp` |

The template does not create an OAuth application, client secret, webhook credential, user, domain, certificate, DNS record or authentication provider. Supplying a URL advertises it; it does not create or map that URL. Verify an existing root mapping, or prepare its explicit approval separately. Interactive OAuth clients commonly look for metadata at the origin root, so a default API Gateway stage path is not sufficient for those clients. [Serverless MCP discovery](https://www.serverless.com/framework/docs/providers/aws/guide/mcp)

Use four separate configuration secrets; do not point these parameters at one shared secret. A local Serverless preflight rejects duplicate references and an unsafe `installationId` before packaging. The installation prefix must match the private identities configured for this deployment; IAM never uses a wildcard in place of it. The configuration for each function contains only that function's required fields. MCP and ingress use `webhookRecipients` pointers instead of outbound credentials; only delivery receives `routes`. The private application configuration must map each verified subject to its own identity, allowed peer identities and scopes. Use different identities for agents and the human history reader. A webhook URL and its Bearer credential belong to the recipient route; neither belongs in a message or wake payload. Follow the configuration shape in the application README.

For issuers that reuse one human `sub` across OAuth clients, configure `clientSubjects` for the MCP and history roles with a separate principal for each `(client_id or azp, sub)` pair. Both client claims, when present, must agree; missing and unrecognized clients are denied, and subject-only mappings are ignored while this mode is enabled. Configure `scopeAliases` for exact issuer scope strings (including any resource-server prefix) and keep each principal's bridge grants minimal. The verifier still requires the configured `aud`, `iss`, expiry and signing algorithm. In particular, a token with only `client_id` and no accepted resource audience is rejected; this implementation does not silently relax audience validation for Cognito or another issuer. Verify the actual token contract before deployment.

The application's resource metadata advertises the exact `scopeAliases` keys when configured, or the five plain bridge scope names when no aliases exist. Optional `advertisedScopes` selects a validated subset for application metadata without changing token authorization; see the [Cognito metadata example](cognito.md#optional-static-authorization-metadata). Public metadata never derives scopes from private subject grants. Native Serverless `oauthDiscovery` accepts only `issuer` and `publicUrl` and omits the optional `scopes_supported` list. Configure each OAuth client to request the exact external scope names explicitly; do not assume native discovery translates prefixes or supplies scopes. [Serverless OAuth discovery](https://www.serverless.com/framework/docs/providers/aws/guide/mcp)

The optional [Cognito integration](cognito.md) separately pins the token issuer and adds strict access-token validation. Static authorization metadata is enabled only by `cognitoDiscovery` in private configuration. Its GET/OPTIONS routes use the existing history function; they remain closed in runtime bootstrap. Actual PKCE/public-client/resource/refresh and connector behavior require the executable flow checks before activation.

Use the operator's existing AWS and Serverless authentication. Creating credentials or expanding persistent access is a separate approval. A customer-managed KMS key on the existing secret additionally requires narrowly scoped decrypt permission and a compatible key policy; this template currently assumes the Secrets Manager managed-key path. Do not work around that with wildcard KMS access.

After packaging, run `node --import tsx --test --test-isolation=none test/packaged-runtime.test.ts`. The test copies only the generated package manifest, application bundles and MCP wrapper into a temporary directory without `node_modules`, then starts plain Node with an explicit credential-free bootstrap environment. It checks the wrapper exports and REST bootstrap response plus all five AWS handlers and the history bootstrap response. This catches external SDK imports and CommonJS/ESM bundling failures that source tests can miss. A clean checkout without generated build artifacts skips these tests; a partial build fails. This is a local import/bootstrap check, not a Lambda streaming or AWS integration proof.

## Browser reader authentication

Optionally add the following public fields to the private **history-role** configuration. These fictional values describe a separately registered public OAuth client; the configuration never includes a client secret.

```json
{
  "viewerOAuth": {
    "authorizeUrl": "https://login.example.test/oauth2/authorize",
    "tokenUrl": "https://login.example.test/oauth2/token",
    "clientId": "reader-public-client",
    "redirectUri": "https://bridge.example.test/viewer",
    "resource": "https://bridge.example.test/bridge/mcp",
    "authorizationResponseIssuerRequired": true,
    "scopes": ["bridge/history:read"]
  }
}
```

Register the exact HTTPS `/viewer` redirect URI, on the same origin as the protected resource. All configured URLs must exclude credentials, fragments and query strings. `resource` must equal both `MCP_RESOURCE_URL` and `OAUTH_AUDIENCE`; mismatches fail application startup. Authorize only the reader scope and map its exact provider spelling through `scopeAliases` to `history:read`. Bind the reader client and subject to a separate principal with only `history:read`, no peers, and explicitly permitted `readParticipants`. Agent clients receive their own mappings. The browser does not choose its identity or grants; the history API validates every access token.

The boolean `authorizationResponseIssuerRequired` is required whenever `viewerOAuth` is configured. Set it to `true` when the verified authorization-server metadata advertises `authorization_response_iss_parameter_supported: true`; set it to `false` only after verifying the field is absent or false. Do not infer this policy from a callback query. When required, the viewer rejects missing `iss`; in both modes it rejects empty, duplicate or nonmatching values. Comparison is exact against `OAUTH_ISSUER`, without URL normalization. [RFC 9207 issuer validation](https://www.rfc-editor.org/rfc/rfc9207.html#section-2.4)

The viewer uses WebCrypto for a random verifier/state and S256 challenge. It stores only a pending login transaction in `sessionStorage`, including the expected issuer and issuer policy, rejects transactions older than ten minutes or changed configuration, consumes the transaction before exchanging a code, and clears it on success or failure. The callback query is removed from browser history before exchange. Access tokens stay in page memory and travel to `/history` only in the Authorization header; refresh and ID tokens are discarded. Reloading requires sign-in again. Without `viewerOAuth`, manual token entry remains available for local or operator use. `/viewer` itself exposes no conversation data, and `/history` always requires a valid reader token.

The provider's token endpoint must support browser CORS and public-client authorization-code exchange with `client_id`, the exact `redirect_uri`, `code_verifier` and the same `resource` sent during authorization, without a client secret. The viewer takes the resource from the validated pending transaction, never from callback parameters. Cognito documents token endpoint CORS and S256/resource support at authorization, but those capabilities alone do not prove discovery compatibility or this complete browser exchange. Verify the real provider accepts the request and issues the intended audience before activation. Use the configured issuer/JWKS for JWT validation, which may differ from the managed-login domain. [Cognito token endpoint](https://docs.aws.amazon.com/cognito/latest/developerguide/token-endpoint.html), [Cognito authorization endpoint](https://docs.aws.amazon.com/cognito/latest/developerguide/authorization-endpoint.html), [Cognito endpoint domains](https://docs.aws.amazon.com/cognito/latest/developerguide/federation-endpoints.html)

For Cognito, a resource-server identifier such as `bridge` makes the exact reader scope `bridge/history:read`; configure that full string in the client's allowed scopes, `viewerOAuth.scopes` and `scopeAliases`. Resource binding applies to managed-login user grants, not M2M client-credentials grants. Verify the actual issued access token has the configured `iss`, canonical resource `aud`, reader `client_id`, mapped `sub` and allowed scope. [Cognito scopes and resource binding](https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-define-resource-servers.html)

The automated browser-script tests use simulated token responses with real WebCrypto. They cover the PKCE challenge, resource binding during exchange, required and optional issuer validation, changed configuration, callback state and expiry, failed exchanges, URL cleanup and token storage boundaries. They do not prove a real provider's registered callback, CORS behavior, grants, audience issuance or a connector's ability to use OAuth during an agent wake. Perform those checks with the separately approved registrations before activation; no provider registration or login is created by this feature.

## Provision infrastructure before integration approval

`BOOTSTRAP_MODE=true` is an infrastructure-only mode. Every application HTTP request returns `503 integration_not_configured`, including MCP, peer ingress, history, the viewer and application OAuth metadata. The runtime uses an empty in-memory configuration without fetching a configuration secret or requiring issuer, audience, JWKS or resource settings. No HTTP request can publish or read messages in this mode. If an outbox job reaches the delivery worker, it is marked dead with `integration_not_configured` before loading recipient credentials or making an outbound callback; this internal bookkeeping can still write to the outbox.

A private bootstrap overlay must also remove native `mcp.servers.bridge.oauthDiscovery`, because API Gateway serves that metadata separately from the application. Omit `OAUTH_ISSUER`, `OAUTH_TOKEN_ISSUER`, `OAUTH_TOKEN_PROFILE`, `OAUTH_AUDIENCE`, `OAUTH_JWKS_URL` and `MCP_RESOURCE_URL` from the bootstrap Lambda environment rather than supplying a fictional issuer. The default API Gateway endpoint can be used to verify the disabled response without creating a domain or DNS record.

The private bootstrap plan may create four distinct Secrets Manager configuration containers with the literal value `{}` and no `GenerateSecretString`. Keep each role bound to its own container by an exact CloudFormation reference. These empty objects create no OAuth client, identity mapping, credential, webhook token, signing key or user grant. The generic public template still expects existing configuration references; the private overlay and its artifacts stay outside the repository.

Provisioning infrastructure is separate from activating integrations. Before disabling bootstrap mode, obtain any required approval for the real identity provider, clients, credentials and grants; configure each runtime separately; and verify the actual connector/token contract. Bootstrap success only proves the disabled service can run, not that agents can exchange messages.

## Review and package before deployment

Run `npm ci`, `npm run check`, and `npm run demo` first. They exercise fictional local identities and do not require a live webhook. Serverless Framework v4 may need network access and an existing account/license even for `print` or `package`; failure there does not mean AWS resources were deployed.

With approved private values provided through the operator's private environment or configuration, the package command has this shape:

```sh
npx serverless package \
  --stage "$BRIDGE_STAGE" \
  --region "$BRIDGE_REGION" \
  --param="serviceName=$BRIDGE_SERVICE" \
  --param="installationId=$BRIDGE_INSTALLATION_ID" \
  --param="mcpConfigSecretArn=$BRIDGE_MCP_CONFIG_SECRET_ARN" \
  --param="ingressConfigSecretArn=$BRIDGE_INGRESS_CONFIG_SECRET_ARN" \
  --param="historyConfigSecretArn=$BRIDGE_HISTORY_CONFIG_SECRET_ARN" \
  --param="deliveryConfigSecretArn=$BRIDGE_DELIVERY_CONFIG_SECRET_ARN" \
  --param="oauthIssuer=$BRIDGE_OAUTH_ISSUER" \
  --param="oauthAudience=$BRIDGE_OAUTH_AUDIENCE" \
  --param="oauthJwksUrl=$BRIDGE_OAUTH_JWKS_URL" \
  --param="publicBaseUrl=$BRIDGE_PUBLIC_BASE_URL"
```

Only references and non-secret deployment settings appear in these arguments. The preflight is local configuration validation, not a grant of permission to deploy. Never substitute raw credentials or a private JSON configuration into a CLI argument, committed file or CI log. Inspect the generated CloudFormation and ZIP contents before approval. `.private`, environment files, databases, tests and documentation are excluded from packaging.

Deploying the reviewed package creates billable AWS resources and IAM roles. Use it only within an installation approved by its owner. Approval to provision infrastructure does not automatically approve new agent credentials, new end-user grants or public publication. Do not use `serverless dev` as a purely local validation command: it works through deployed infrastructure. [Serverless MCP development and packaging](https://www.serverless.com/framework/docs/providers/aws/guide/mcp)

When deploying through a reviewed CloudFormation change set, specify `--no-disable-rollback` explicitly on `execute-change-set`; the documented default preserves provisioned resources on failure. Record each upload or change-set request before sending it. If a request times out or its result is uncertain, inspect the object, change set and stack before considering another attempt. Keep the same request token for any separately authorized retry, and do not treat a transport error as proof that no resource was created. [AWS CLI ExecuteChangeSet](https://docs.aws.amazon.com/cli/latest/reference/cloudformation/execute-change-set.html)

## Resources and permissions

- The MCP route uses the native `mcp.servers.bridge` integration. `src/remote.ts` must default-export a Fetch handler and authenticate every call. OAuth discovery is public metadata, not an access gate.
- `ingress` serves signed peer requests on `POST /peer`. `history` serves authenticated `GET /history`; the browser interface uses its own route and the human reader identity. The data-read policy remains separate from agent send/claim permissions. Neither route logs request bodies or headers through API Gateway.
- One DynamoDB table separates `meta`, `history`, `claims`, `dedup`, `rate`, `outbox`, `subscriptions`, `subscription-secrets` and `callback` partitions. Message text stays in `history`; dedup and outbox store fingerprints/pointers or notice metadata. Subscription secrets have their own namespace. The table has encryption at rest, point-in-time recovery and retention on stack deletion/replacement. No TTL can remove history when a lease expires.
- DynamoDB Streams uses `KEYS_ONLY`. The event-source filter accepts `INSERT`; `streamWake` examines `record.Keys` and enqueues only outbox keys as `{pk, sk}`. It receives no record values. Delivery state stays in DynamoDB. Updates for leases or retries do not create a feedback loop of queue writes.
- `delivery` receives SQS pointers and returns partial-batch failures for infrastructure failures. The queue visibility timeout is six times the function timeout. The queue and both failure queues use managed encryption.
- `sweep` queries the `KEYS_ONLY` due index every minute with an explicit key/time projection and requeues due keys, including expired leases. Its role cannot fetch the underlying record values. This is a recovery mechanism, not a latency guarantee.
- The stream consumer, sweeper, delivery worker, ingress, history reader and MCP function have separate roles. A seventh role lets only EventBridge Scheduler invoke the recovery function. Table access is scoped to this table and the exact installation prefix. Each runtime writes only to its own log group. Secret reads are limited to that role's configuration secret; stream and sweep have neither secret references in their environment nor secret-read permission. `ListStreams` is the sole wildcard resource grant, for AWS's stream discovery action.

The table policies grant the following operations. Each listed namespace means only `${installationId}#<namespace>#*`, with the actual operator-supplied installation value substituted before deployment.

| Runtime | `GetItem` namespaces | `Query` | Transactional `PutItem` namespaces |
| --- | --- | --- | --- |
| MCP | `meta`, `history`, `claims`, `dedup`, `rate`, `subscriptions`, `subscription-secrets` | `history` only | `meta`, `history`, `claims`, `dedup`, `rate`, `outbox`, `subscriptions`, `subscription-secrets` |
| Peer ingress | `meta`, `history`, `claims`, `dedup`, `rate`, `subscriptions` | `history` only | `meta`, `history`, `claims`, `dedup`, `rate`, `outbox`, `callback` |
| Delivery | `outbox`, `claims`, `subscriptions`, `subscription-secrets` | None | `outbox` only |
| Human history | `meta` only | `history` only | None |
| Recovery sweep | None | `due-index` only, with `SPECIFIC_ATTRIBUTES` restricted to keys/time | None |
| Stream publisher | None | None | None |

Delivery cannot read plaintext message history or publish a response. Human history cannot read claim state, outbox, callback replay or either subscription namespace. No runtime receives `DeleteItem`, `UpdateItem` or `ConditionCheckItem` grants. The stream publisher reads only this table's keys-only stream; Scheduler has only permission to invoke the sweep function; its trust is constrained to this installation's dedicated schedule group and account. The deployment tests inspect both source policies and generated CloudFormation to catch broader grants. [DynamoDB condition keys](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/specifying-conditions.html)

DynamoDB transaction permissions use the underlying item actions, not an IAM action named `TransactWriteItems`. Writes are restricted by `dynamodb:EnclosingOperation` to transactions. [DynamoDB transaction IAM](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transaction-apis-iam.html)

Queue delivery uses partial batch responses; streaming retries and their failure queue are distinct from application delivery retry state. [Serverless SQS](https://www.serverless.com/framework/docs/providers/aws/events/sqs), [Serverless DynamoDB Streams](https://www.serverless.com/framework/docs/providers/aws/events/streams)

The template creates two CloudWatch queue-depth alarms, but no external notification destination. Configure an approved operations destination before unattended production. Detailed API Gateway metrics are disabled to avoid per-method metric charges; basic service metrics remain available. Application message/turn limits and reserved Lambda concurrency bound normal traffic; review API Gateway throttling and an appropriate edge policy for the intended audience before exposure. A front-door policy is an installation decision, not a substitute for authentication.

## Event authorization and revocation

An event-capable principal needs an `eventAuthorizationEpoch` in its private identity mapping and a matching active authorization row in the existing `subscriptions` partition. Epochs are decimal strings from `1` through sixteen digits. An authorized operator provisions the row; `events/subscribe` never creates or reactivates a grant. Missing, inactive, expired-subscription or mismatched authorization fails closed. This uses the existing table namespaces and seven-role permissions; the delivery worker does not read MCP configuration secrets.

The operator CLI defaults to a read-only plan. Set `TABLE_NAME` for an approved AWS target, or `BRIDGE_DB_FILE` for local SQLite, but never both. These examples use fictional installation/owner identifiers:

```sh
# Inspect the initial grant plan. No authorization row is written.
node --import tsx scripts/event-authorization.ts sample agent_alpha grant none

# After approving this exact persistent grant, apply epoch 1.
node --import tsx scripts/event-authorization.ts sample agent_alpha grant none --apply

# Preview revocation of the known current epoch, then explicitly apply it.
node --import tsx scripts/event-authorization.ts sample agent_alpha revoke 1
node --import tsx scripts/event-authorization.ts sample agent_alpha revoke 1 --apply
```

Each mutation requires the exact previous epoch and increments it. The first grant expects `none`; a stale expectation fails. Before subscribing, bind the returned active epoch to only the approved authenticated principal. A revoke advances to an inactive epoch, invalidating subscriptions and queued events from the previous epoch. Regrant advances again and requires updating the private mapping and creating/renewing subscriptions with that new epoch. Never delete the authorization row or reuse an old epoch; it is a durable revocation tombstone.

The underlying `setEventAuthorization` function is the hook for an authenticated provider revocation integration. It is not exposed as a client MCP tool. When disabling access, revoke the event grant first, remove its private MCP mapping and revoke/disconnect the provider grant; configuration mappings can remain cached for up to 60 seconds. Merely revoking a refresh token at an external provider does not notify this service or invalidate every issued JWT. Without a provider lifecycle integration, an operator must perform these steps explicitly. An HTTP request already authorized or in flight cannot be recalled.

The operator-only distinction is enforced by application interfaces, not a separate IAM boundary: the MCP role already has transactional writes to the `subscriptions` namespace and rewrites the authorization row under CAS when subscribing. A compromised MCP runtime is therefore within the trust boundary for that state. Separating its administration at the IAM layer would require a revised data layout and permissions, reviewed and approved separately.

Signing renewal verifies the new key and emits signatures with both current and previous keys for five minutes. Repeating the same key does not extend that deadline; another rotation during the overlap is rejected with `signing_rotation_in_progress`. After expiry only the current key signs; encrypted old key material remains until a refresh, unsubscribe or approved retention operation removes it. Cancelling a subscription clears its URL and all signing keys. An active renewal preserves the subscription's activation generation, while resubscription after cancellation/expiry creates a new generation. Outbox rows bind both the authorization epoch and activation generation, so regranting or resubscribing cannot revive old queued events. Rotation within an active subscription preserves event IDs.

Existing subscriptions/outbox records without epochs or activation generations fail closed under this version. Plan their authorization and re-subscription explicitly; do not auto-migrate them into granted access. All operator commands above require the existing caller identity and any approval needed for the selected installation; they do not create credentials or permissions.

## Prove the real path after approval

1. Review the existing OAuth issuer, audience, subject mapping and scope grants. Verify that a history-only human identity cannot send, claim or complete messages, and each agent can access only its configured peer conversations.
2. Deploy the reviewed package to the approved account, region and stage. Verify root-domain OAuth discovery and authentication using an existing authorized client. Rejected tokens must not return message content.
3. Provision the approved event authorization epoch and bind it to the intended client's private identity mapping. Connect its MCP plugin and register `message.received` through the client's supported event workflow. The client provides its callback URL and signing secret; the server verifies that endpoint before activating the subscription.
4. Configure the other agent's existing webhook and a least-privilege return identity. Approval is needed if this grants a new route or persistent API access. Send a fictional message, observe a signed wake, atomically claim it and publish a response with the current fence.
5. Verify the response appears once in authenticated history and that its event wakes the original client. Repeat the same message ID and simulate a retried webhook: history must remain deduplicated, and a second worker must not own the same unexpired claim.
6. Interrupt a worker after claim, wait for lease expiry, reclaim with a higher fence, and reject the stale completion. Verify recovery from a missed SQS wake via the durable outbox and sweeper.

MCP Events requires the client connection and a live subscription; implementing the server cannot establish those on the client's behalf. [OpenAI MCP Events](https://developers.openai.com/plugins/build/mcp-events)

### Verificação nativa do cliente

Antes de criar uma assinatura, consulte o estado disponível no host e os registros privados da instalação. Reutilize a assinatura aprovada quando ela já existir; depois de um resultado incerto, verifique se a operação ocorreu antes de repeti-la. Uma nova autenticação pode ampliar escopos, mas não comprova que a descoberta de eventos foi atualizada nem que há uma assinatura ativa.

1. Atualize a descoberta do conector e confirme `message.received` no catálogo nativo. `bridge_list_events` é apenas uma ferramenta de descoberta; uma resposta bem-sucedida não cria a assinatura.
2. Use o mecanismo nativo de assinatura oferecido pelo host, com o filtro aprovado. O host fornece o callback e o segredo de assinatura. Não invente um callback nem substitua uma integração indisponível por outro tipo de automação.
3. Verifique autorização ativa, época, geração, filtro e prazo da assinatura sem registrar segredos. Uma assinatura limitada a uma conversa só cobre mensagens dessa conversa.
4. Envie uma solicitação sintética nova com ID estável. Distinga mensagem persistida, aceite do callback, execução iniciada pelo evento no host, claim e resposta persistida. Compare `replyTo` com a solicitação original; `correlationId` sozinho não distingue solicitações na mesma conversa.
5. Repita com uma solicitação independente iniciada pelo outro participante, dentro do escopo aprovado. Inspecione também o estado final das entregas e as tentativas, sem responder automaticamente a toda resposta recebida. Use `bridge_complete_message` para publicar a resposta da solicitação e `bridge_acknowledge_message` para concluir uma resposta terminal reservada sem outra publicação. O [roteiro parametrizado](native-reproduction.md) exige a ferramenta implantada e disponível nas rotinas antes desse teste.

Uma prova em uma conversa específica do host demonstra o despertar dessa conversa. Ela não comprova o despertar de outra sessão ou de um assistente principal. Registre o destino efetivamente observado somente nas evidências privadas. Para validar continuidade, observe uma renovação real e uma nova entrega após o prazo original; o TTL e os testes locais de renovação não substituem essa observação.

### Respostas terminais em destinatários webhook

O runtime cria uma outbox webhook para toda mensagem dirigida a um participante configurado com esse transporte, inclusive uma resposta com `replyTo`. O worker encerra essa entrega quando encontra o claim concluído; um HTTP 2xx apenas agenda nova verificação. `bridge_complete_message` publica outra mensagem; `bridge_acknowledge_message` conclui somente a reserva de uma resposta terminal.

Sem ACK, uma resposta terminal que o participante apenas lê pode ser reenviada e acabar em `attempts_exhausted`, mesmo que tenha sido recebida. Reservar a mensagem apenas adia a entrega até o vencimento do claim. Responder a toda notificação para concluir o claim pode formar uma sequência de respostas entre agentes. Os limites de tentativas, taxa e turnos contêm essa sequência, mas não equivalem a uma confirmação terminal sem resposta.

Uma prova externa da versão anterior ao ACK confirmou resposta terminal recebida pelo participante webhook enquanto sua outbox continuava `pending` e o claim permanecia `running`. Uma segunda observação confirmou retentativa sem outra mensagem no histórico. Na validação posterior da versão com ACK, o claim terminal terminou como `done / acknowledged`, sem publicar outra resposta, e a outbox pendente passou a `done`. Sucesso do agente e conclusão da outbox continuam sendo verificações distintas.

Depois de implantar a versão revisada, atualize a descoberta de ferramentas e a rotina receptora para reservar respostas terminais e chamar ACK com o fence retornado. O scope `messages:claim` já existente autoriza essa operação; também é necessária a leitura da conversa. Não amplie grants nem crie credenciais só para descobrir a ferramenta. Confirme o claim `done / acknowledged` e aguarde a próxima execução elegível do worker fechar uma outbox ainda pendente. ACK não cancela um POST já em trânsito nem altera uma outbox `dead`.

Durante a prova, confirme a mensagem no histórico e inspecione separadamente a outbox terminal. Não publique uma resposta artificial só para obter estado `done`, não trate HTTP 2xx como conclusão e não crie um novo ID para contornar a entrega pendente. Repita ACK com os mesmos argumentos quando o resultado for incerto; uma reserva vencida ainda não concluída precisa ser adquirida novamente antes da confirmação.

## Recovery and retention

| Observation | Operator action |
| --- | --- |
| Webhook returns success but the agent has not responded | Treat delivery as accepted, not completed. Inspect the durable message and processing claim; do not resend under a different message ID. |
| SQS/stream failure queue has records | Investigate the failed transport or permissions. The durable outbox remains the source of truth; repair and retry using the original IDs. |
| Callback expires or is revoked | Reconnect/renew using the authorized client's event workflow; messages remain readable in history. |
| A worker's lease has expired | A new worker may reserve the message; stale fences cannot publish. |
| Repeated callback failures or terminal delivery | Inspect the delivery record without logging its secret. Resolve the recipient configuration before a deliberate replay. |

History retention is independent of lease and subscription expiry. There is no automatic history deletion in this version. The installation owner must choose and approve a later archival/deletion policy. Queue retention does not delete the persisted history or outbox. DynamoDB point-in-time recovery is recovery support, not proof of a tested restore; rehearse restoration privately before depending on it.

## Separate approval for access and identity

Before first activation, review the concrete IAM and authentication changes independently from storage/compute provisioning. The packaged infrastructure creates seven new execution roles, confined to this installation: MCP, ingress, history, stream, delivery, sweep and Scheduler invocation. It does not modify existing user policies. Four private configuration secrets are supplied separately; their values and the principal grants they contain are not part of the public repository.

Before creating an authorization server or clients, run the [provider readiness checks](authentication.md) against its actual discovery document. The client requires advertised S256, not just endpoint support for PKCE. A directly configured Cognito pool must not be assumed compatible when its discovery omits that field. A metadata wrapper that announces another issuer while forwarding unmodified provider tokens is not a complete OAuth broker. Prefer an existing compatible JWT provider when available; otherwise review a managed provider or implement a separate, isolated broker before requesting its additional resources and permissions.

The verifier supports explicit `clientSubjects` and `scopeAliases` mappings while retaining issuer, signature, expiry and audience checks. Any provider mapping needs real token validation; do not silently accept a different audience. Reusing one human subject through different connectors requires binding the principal to the verified OAuth client. The browser reader uses PKCE without a client secret. Exact connector callbacks, OAuth clients, credentials, persistent identity/event grants and webhook access require their own concrete approval.

A connector connection and its event subscription are also distinct activation steps. Keep OAuth application secrets out of plugin manifests and public files. [OpenAI plugin authentication](https://developers.openai.com/plugins/build/auth)

This schema is for a fresh installation. Earlier local prototypes used mixed conversation partitions and projected complete rows. No prototype data or deployed table is migrated automatically; do not apply this package to a table using that older layout.

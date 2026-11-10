# Agent Message Bridge

A private, reusable message bridge between MCP clients and webhook-driven agents. Messages are durable; notifications wake a recipient; the recipient claims a message before working and completes it with a fenced, idempotent response or acknowledges a terminal reply without another message. Agent messages are data, never user authorization for external actions.

The AWS target uses Serverless Framework's native MCP hosting, DynamoDB transactions, Streams, SQS, delivery and stream failure queues, and a scheduled outbox recovery task. SQLite supports local persistence. This is one installation per user or team, with explicit identity mappings.

## Run the local proof

Requires Node.js 24 and npm. No cloud credentials are used by the demo.

```sh
npm ci --ignore-scripts
npm run check
npm run demo
```

The demo starts two loopback HTTP servers and uses generated, temporary fixture identities. It sends through the real MCP SDK, wakes a simulated peer, claims/reads/responds through MCP, receives a signed event, reads human-visible history, and reopens the SQLite database. Its explicit fixture transport maps one reserved example hostname to loopback; production uses HTTPS with public-IP validation and DNS pinning. Passing this demo does not establish live platform connectivity.

## Interfaces

| Interface | Purpose |
| --- | --- |
| `POST /bridge/mcp` | Authenticated MCP, using the official server SDK |
| `bridge_send_message` | Persist an initial message and outbox entries atomically |
| `bridge_read_history` | Read an authorized page of conversation messages |
| `bridge_claim_message` | Reserve an incoming message with a lease and fencing number |
| `bridge_complete_message` | Persist one response and complete the reservation atomically |
| `bridge_acknowledge_message` | Concluir uma resposta terminal reservada, sem publicar outra mensagem |
| `events/list`, `events/subscribe`, `events/unsubscribe` | MCP Events discovery and verified webhook subscriptions |
| `POST /peer` | Optional signed HTTPS API with send/history/claim/complete/acknowledge actions |
| `GET /viewer` | Static history viewer; no messages are public |
| `GET /history?conversationId=...` | Human history, using a separate read-only principal |

Sender and installation identity come from authentication, not caller arguments. OAuth JWT verification pins issuer, resource audience, algorithms, expiry and an explicit identity mapping. Configure `clientSubjects[clientId][subject]` to isolate clients that share a human subject: the token must carry a known `client_id` or `azp`; if both are present they must agree. When `clientSubjects` is nonempty, unknown clients or subjects are rejected without falling back to `subjects`. An empty client map preserves explicit `subjects[subject]` mapping. Optional `scopeAliases` maps exact external scope strings to bridge scopes before intersecting them with the mapped principal's grants; no prefix or wildcard matching occurs. A client ID never substitutes for the required audience. A webhook wake Bearer token is separate from the recipient's MCP/OAuth identity. A peer's access to its connector during webhook execution must be demonstrated in the actual platform.

If a platform shares a connector across bots, its credential identifies the account connection, not an individual bot. A webhook can select a particular routine without proving which bot later called MCP. Bridge sender IDs are authenticated logical identities; bot names or instructions cannot strengthen that boundary. Include all users of the shared connection in the access review. See the [shared-connector threat model](docs/architecture.md#conectores-compartilhados-entre-bots).

The optional `viewerOAuth` configuration enables browser sign-in using authorization code and S256 PKCE with a public OAuth client. The viewer sends the resource during authorization and code exchange, checks callback state, and requires the exact issuer response when verified provider metadata advertises it. Issuer and policy are bound to the pending transaction. Access tokens stay in page memory; the verifier/state transaction expires after ten minutes and is removed before exchange. No refresh or ID token is retained. The token endpoint must allow browser CORS. Without this configuration, the viewer offers manual read-only token entry for local or operator use. See [viewer authentication setup](docs/deployment.md#browser-reader-authentication) and [provider readiness](docs/authentication.md).

## Delivery and recovery

See [delivery evidence, recipient-wide recovery and operational rollout](docs/reliability.md)
for the optional inbox, paginated status tools, safe dead recovery, EMF alarms and
the functional post-deploy probe. Inbox activation and notification destinations
require separately reviewed configuration; code-only CD does not apply IAM or alarms.

A successful webhook response acknowledges acceptance, not completion. For webhook recipients, the worker waits for a completed claim, postpones notifications while a live claim exists, and retries after expiry within the configured attempt budget. Completed claims close outstanding wake work. An accepted MCP Event is delivered once per outbox record with retries on uncertainty; the client owns processing recovery. This version has no event replay; history remains available through tools.

Para uma resposta terminal, reserve a mensagem e use `bridge_acknowledge_message` com o `fence` recebido. O ACK exige uma mensagem persistida com `replyTo`, o destinatário autenticado e uma reserva válida; usa o scope existente `messages:claim` e a permissão de leitura da conversa. Ele conclui apenas o claim, sem criar mensagem, turno ou nova entrega. A repetição da mesma confirmação é idempotente. Veja o [contrato e o roteiro nativo](docs/native-reproduction.md).

Message IDs remain stable across retries. A conflicting payload under the same ID is rejected. A stale or expired claim cannot publish a response; reusing an already published response ID retrieves that response. Attempts are recorded before network delivery, so worker crashes consume the bounded budget. Remote executions can still duplicate after uncertain network outcomes. There is no exactly-once execution guarantee.

Reservations and authorization expiry do not control history retention. Message visibility ends 14 days after publication, including legacy messages. New message history, deduplication, claims and outbox records carry a separate top-level `retentionExpiresAt` deadline. DynamoDB physical cleanup requires the separately approved TTL migration; the checked-in template does not enable it. Dead deliveries expire with their source message. Rate limiting and bounded delivery attempts remain; there is no configured conversation turn ceiling. Legacy `limits.maxTurns` settings are accepted but ignored. See [retention and migration](docs/retention.md), including permanent minimal conversation identity metadata, legacy backfill and backup limitations.

Events require an explicit, durable authorization epoch for the subscriber. Subscription refresh cannot create or reactivate that grant. Delivery rechecks the grant and subscription before sending; queued events carry their original epoch and remain invalid after revocation/regrant. Signing-key rotation emits both signatures for five minutes; renewing the same key does not extend that window. See [event authorization and revocation](docs/deployment.md#event-authorization-and-revocation) for provisioning and the provider revocation hook.

## Private configuration and deployment

Use [the deployment guide](docs/deployment.md) and [architecture notes](docs/architecture.md). Real configuration belongs in separate Secrets Manager secrets for each role, or in an ignored local `.private/` directory. The four [example configurations](examples/) show distinct MCP, human-reader, delivery and optional signed-ingress roles. Their IDs and webhook credential are placeholders; the ingress example grants no callback access. Examples use reserved domains and synthetic identities only. No private deployment configuration, credential, endpoint, account number or personal data belongs in source, examples, tests or Git history.

A delivery route may set `additionalAuthHeader`, for example `"X-Webhook-Key"`, when its receiver requires a second credential header. Webhook requests then send the same raw `bearer` value in that header while retaining `Authorization: Bearer …`; the option is absent by default and never applies to MCP Events. Names must be ASCII `X-` names with letters, digits and single hyphen separators, at most 64 characters. Routing, protocol and trace names are reserved. Header names are emitted lowercase. Keep this setting with the approved private route; do not duplicate credentials in message bodies or MCP configuration.

Criar ou ampliar identidades e acessos na nuvem exige aprovação específica do operador. Empacotar não equivale a implantar. A licença do código não concede acesso à infraestrutura de nenhuma instalação.

[CI and production CD](docs/ci-cd.md) are prepared for `master` and a single production environment. CI runs local checks; automatic deployment stays disabled until separately approved. The prepared CD preserves live infrastructure and authentication, updates existing Lambda code only, and tracks each first-parent master commit from a reviewed private baseline. No remote test environment is created.

## Validação externa e publicação

Uma implantação autorizada demonstrou troca autenticada nos dois sentidos, resposta persistida e despertar nativo do cliente por `message.received`. Essa evidência complementa os testes locais e não certifica outras instalações. A continuidade prolongada da assinatura permanece não comprovada. Veja os [limites da validação](docs/architecture.md#limites-da-validação) e o [procedimento de verificação nativa](docs/deployment.md#verificação-nativa-do-cliente).

Uma implantação autorizada demonstrou despertar nativo, resposta automática e confirmação terminal por ACK. O claim terminou como `done / acknowledged`, sem publicar outra resposta, e a entrega pendente foi encerrada. Também foi observada renovação nativa da assinatura; a continuidade prolongada permanece não comprovada, sem SLA ou continuidade indefinida estabelecidos.

A publicação e a manutenção do projeto exigem revisar também o histórico Git e os artefatos e preservar a rastreabilidade entre fonte e implantação. O [guia de publicação](docs/publication.md) separa essa revisão da ativação do CD. Registros da instalação e conversas reais permanecem fora do repositório.

## Licença

O código deste projeto é distribuído sob a [licença MIT](LICENSE). As dependências mantêm suas próprias licenças e condições de uso, incluindo as do Serverless Framework; esta licença não as substitui.

## Known operational limits

- AWS behavior, client connection and a real agent wake must be verified separately from fixture tests.
- Respostas destinadas a um participante webhook também criam uma entrega. Após o ACK, a outbox pendente só fecha na próxima execução elegível do worker; uma chamada já em trânsito pode chegar. O ACK não reabre nem altera entregas `dead`. Instalações e rotinas sem ACK continuam sujeitas à [reentrega de respostas terminais](docs/deployment.md#respostas-terminais-em-destinatários-webhook).
- MCP Events uses the documented ChatGPT callback error code `-32015`, isolated at the protocol adapter. The upstream experimental proposal uses a different code.
- Revocation in an external IdP is not automatically visible to an offline JWT verifier. The installation must also revoke the bridge's event grant and remove its access mapping. An HTTP request already authorized or in flight cannot be recalled.
- A second signing-key rotation inside the five-minute overlap is rejected; retry it after the window. At most two keys are retained for signing.
- An expired previous signing key stops signing immediately but remains encrypted in storage until refresh/unsubscribe or an approved retention operation removes it.
- Legacy historical rows and deduplication records require the reviewed retention backfill. Authorization, expired subscriptions, subscription secrets and callback replay records retain their existing separate operator retention policy; this change does not expire security state. Bounded registry reads prevent expired subscriptions from hiding active ones.
- Viewer OAuth is covered by browser-script simulations with real WebCrypto, not a live provider grant. Reloading the viewer requires sign-in again; there is no persistent session or refresh flow.
- Callback event signing keys are in the encrypted DynamoDB table. IAM roles restrict access; application-level field encryption is not implemented.

## Source contracts

[OpenAI MCP Events](https://developers.openai.com/plugins/build/mcp-events), [Serverless AWS MCP](https://www.serverless.com/framework/docs/providers/aws/guide/mcp), [DynamoDB transactions](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transaction-apis.html), and [SQS duplicate delivery](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/standard-queues-at-least-once-delivery.html).

## Viewer de histórico

O viewer em `/viewer` usa shadcn/ui, com navegação por conversas autorizadas, busca na conversa e atualização explícita. Consulte [contratos, limites, desenvolvimento e ativação do catálogo](docs/viewer.md). Instalações existentes precisam publicar a rota de consulta e revisar as permissões do catálogo antes da ativação; este código não realiza migração automática.

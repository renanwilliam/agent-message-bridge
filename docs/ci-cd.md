# CI and production deployment

The repository prepares one production environment. It does not create a remote
test environment. CI runs local tests and the HTTP fixture demonstration on pull
requests and pushes to `master`; it has no AWS identity. Production deployment is
**disabled by default**. Neither adding these files nor running the tests creates
an OIDC provider, IAM role, GitHub environment, secret or deployment.

## Deployment contract

`.github/workflows/deploy.yml` runs only when the **repository variable**
`ENABLE_PRODUCTION_CD` equals `true`, the ref is `refs/heads/master`, and the event
is a push or manual dispatch. The environment is always `production`. Actions are
pinned to full commit hashes; checkout does not retain Git credentials. Before
requesting AWS credentials, the job installs locked dependencies without package
install scripts and runs type checking, tests and the local HTTP demonstration.

The deployment script reads a reviewed baseline from private, versioned S3
storage. For each first-parent commit between that baseline and the requested
`master` SHA, it checks out the exact commit, reruns checks, packages the six
functions and deploys them sequentially. A grouped push therefore does not skip
intermediate first-parent commits. Merge commits represent the merged change;
individual commits on a merged side branch are not separate master releases.
A failed commit stops subsequent releases. Missing baselines and rewritten
history fail closed. An older queued target cannot roll production backwards.

Concurrency uses `production`, `cancel-in-progress: false`, and `queue: max`.
GitHub permits up to 100 pending runs and may cancel further arrivals; queue order
does not guarantee Git commit order. The durable baseline determines release
order, and a later/manual run catches up to its requested SHA. This is not an
unlimited event queue or a guarantee that every dispatched workflow runs.
[GitHub concurrency](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)

The 60-minute job limit does not exceed the requested 60-minute AWS session,
which starts after initial checks. A large backlog or slow update can still time
out. Reconcile the pending release on the next run; do not extend access or
remove checks to make a timeout look successful.

## Scope of automatic updates

The candidate starts as a copy of the **live stack template**. Only `Code` on the
existing Lambda resources and `Metadata.BridgeRelease` may change. The script
rejects missing/new functions, runtime/architecture/handler changes, resource
replacement, and change-set details outside static Lambda code updates. It also
compares the change set's actual template with the reviewed template digest.

The seven runtime roles, four configuration containers, authentication settings,
`BOOTSTRAP_MODE`, subscription storage, queues, schedules and all other resources
stay byte-for-byte equivalent in the template. The packaged template supplies
only code references and runtime compatibility checks. Its configuration values
do not overwrite the live template. Infrastructure changes, authentication
activation and migrations need a separate reviewed deployment.

Six Lambda updates are not an atomic application release. Old and new code can
coexist during update or rollback, and queues can hold older messages. Every
automatic release must remain compatible with the current data and message
schema. The pipeline verifies CloudFormation completion and each deployed ZIP's
SHA-256. The workflow then runs the optional authorized functional probe described
in [reliability operations](reliability.md#functional-post-deploy-probe). Missing
credentials or independent receiver evidence produce an explicit partial result,
not a live acceptance claim. Deployment state and functional acceptance are separate.

## Prerequisites requiring separate approval

Before enabling the flag, prepare and review each concrete target and permission:

| Item | Proposed scope and purpose |
| --- | --- |
| GitHub OIDC provider/trust | Only the intended repository and protected production environment; audience `sts.amazonaws.com`; verify the repository's actual subject format. |
| GitHub deployment role | Read the exact versioned private configuration; read/write the exact release and state S3 prefixes; inspect the selected stack/change sets, including `cloudformation:ListStackResources`; read `lambda:GetFunctionConfiguration` for only its six functions to verify deployed hashes; create and execute updates only for that stack; pass only the separate CloudFormation execution role. No IAM mutation or secret-value access. |
| CloudFormation execution role | Assumed by CloudFormation; read the selected package versions and inspect/update code for only the six existing functions. No create/delete function, IAM mutation, runtime-role passing, configuration change or Secrets Manager access. Verify the final required read actions against the real stack before activation. |
| Private artifact/configuration storage | Existing approved private bucket/prefix with versioning and all four S3 public-access blocks enabled. Any new bucket, policy, versioning change or access grant needs its own review. |
| Ambiente `production` do GitHub | Criar previamente e restringir a `master`, sem aprovação manual por release no modo automático solicitado. Proteger e revisar o código, os workflows e os scripts de implantação antes de entrarem em `master`. |
| Variáveis do GitHub e secrets do ambiente | Referências privadas no ambiente protegido `production`, além da região pública e da variável de ativação do repositório listadas abaixo; método de autenticação do Serverless aprovado, caso a licença existente o exija. |
| Activation | Explicit approval to set repository variable `ENABLE_PRODUCTION_CD=true`. |

These are **two additional deployment roles**, separate from the seven application
roles. They are not created by the application stack or this preparation. A single
OIDC role could combine deployment and Lambda update privileges, but would expose
those service permissions directly to every privileged build step. This script
requires a separate CloudFormation execution role to keep those capabilities
separate. Its creation/attachment is persistent access and must be approved.

With an environment, the OIDC subject refers to that environment; protect the
environment's allowed branches as well. Newer repositories can use immutable
owner/repository IDs in their subjects. Do not guess a wildcard trust from an
example. An environment name in YAML alone is not a protection rule: GitHub can
create a missing environment without the intended restrictions.
[GitHub AWS OIDC](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-aws),
[GitHub environments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)

The gated job runs repository packaging code with its deployment identity.
Template guards are useful for accidental changes; they are not a sandbox for
malicious code on `master`. Review and protect that code, and constrain the actual
IAM roles independently of these JavaScript checks. Reviewers of production code
must understand that it will execute under the six existing application roles.

`id-token: write` vale para todo o job de implantação. A verificação de
dependências, os testes e a demonstração podem solicitar um token OIDC antes da
etapa `configure-aws-credentials` e obter credenciais AWS se a relação de confiança
da role permitir. A ordem dessas etapas não isola o acesso às credenciais.
Proteja todo o código executado por esse job e o ambiente de produção,
independentemente da variável de ativação do workflow. Desabilitar
`ENABLE_PRODUCTION_CD` impede esse job de executar; não revoga a relação de
confiança IAM existente nem impede outro workflow aceito por ela de utilizá-la.
Criar ou alterar esse acesso persistente continua exigindo aprovação específica.

## Private inputs and baseline

Armazene `AWS_DEPLOY_ROLE_ARN`, `AWS_DEPLOY_ROLE_ID`, `AWS_ACCOUNT_ID`,
`BRIDGE_CD_CONFIG_URI` e `BRIDGE_CD_CONFIG_VERSION` como secrets no ambiente
protegido `production`. Os dois últimos identificam a versão exata de um objeto
privado de configuração no S3. Mantenha a região pública `AWS_REGION` e
`ENABLE_PRODUCTION_CD` como variáveis do repositório; deixe a variável de ativação
ausente ou com valor `false` até a ativação ser autorizada. Se necessário,
`SERVERLESS_ACCESS_KEY` é um secret nesse ambiente com aprovação separada;
nenhuma chave de acesso AWS fica armazenada no GitHub.

Logs de um repositório público podem expor entradas de actions e variáveis de
ambiente das etapas. As variáveis do repositório não recebem mascaramento
automático; por isso, referências privadas da implantação não devem ficar nelas.
O mascaramento de secrets protege valores correspondentes, mas não garante
proteção para valores transformados, parciais ou derivados. O mascaramento do ID
da conta pela action AWS não cobre todos os identificadores de roles ou locais de
configuração. Revise mensagens de status das actions, saídas de scripts e qualquer
upload de artefatos antes de ativar. Nunca imprima configuração privada nem trate
o mascaramento como autorização para publicá-la.

`AWS_DEPLOY_ROLE_ID` é um metadado privado de identidade, não uma credencial.
Ele deve conter o `RoleId` real da role IAM indicada pelo `AWS_DEPLOY_ROLE_ARN`
aprovado; obtenha e confira essa correspondência durante a configuração aprovada
separadamente. Recriar uma role muda seu RoleId mesmo quando o ARN é reutilizado;
por isso, atualize e revise esse secret antes de outra implantação. O workflow
verifica a sintaxe, mas não consulta a correspondência real entre ARN e RoleId.

A versão fixada da action AWS imprime um identificador da role assumida no STS
durante a autenticação. Antes de executá-la, `mask-deployment-identity` valida o
ARN e o RoleId fornecidos e registra máscaras para o RoleId e o nome da role
derivado do ARN. Entradas ausentes ou inválidas interrompem o job antes dessa
action, sem imprimir seus valores. O mascaramento do ID da conta permanece
habilitado. Essas máscaras reduzem a exposição conhecida nos logs de status;
não restringem código malicioso em `master`, não protegem todo valor transformado
nem certificam saídas de depuração ou futuras versões de actions e plugins.
Revise essas saídas novamente ao mudar as ferramentas de implantação.

The JSON configuration accepted by `validateConfig` contains exactly:

- `schemaVersion: 1`, `region`, `stage`, `stackName`, `cloudFormationRoleArn`;
- `artifactBucket`, immutable `artifactPrefix`, and a `stateKey` outside that prefix;
- `serverlessParams`: `serviceName`, `installationId`, the four configuration
  **secret ARNs**, `oauthIssuer`, `oauthAudience`, `oauthJwksUrl`, `publicBaseUrl`.

These values are references and deployment metadata, never token values, subject
grants or secret documents. Put them in private storage, not a public example or
workflow artifact. The pipeline suppresses raw command failures and does not
upload templates, manifests or configuration to GitHub artifacts.

Em caso de falha, são impressas apenas mensagens de validação controladas, sem
identificadores de recursos. Erros inesperados de JSON, sistema de arquivos ou
bibliotecas geram uma mensagem genérica e um código de saída diferente de zero.
A leitura de YAML desabilita trechos de diagnóstico e avisos; documentos
malformados e tags não suportadas interrompem a implantação sem imprimir o
conteúdo privado dos templates. Para diagnosticar, inspecione o estado privado do
serviço; não habilite saída bruta em logs públicos para contornar esse limite.

After a reviewed manual installation, initialize a private release manifest and
state object for the exact deployed code commit. The state records
`schemaVersion: 1`, `stackId`, full `commit`, canonical `templateDigest`,
`manifestKey` and **`manifestVersion`**. The manifest records the template key/version/digest, the six code
bucket/key/version references, and their SHA-256 checksums. Use the exported
`digest` helper for canonical JSON hashing. Verify the template against
CloudFormation and the packages against the deployed code before accepting this
baseline. Never choose an arbitrary old commit or initialize all Git history as
pending work. If the current deployment packages lack immutable object versions,
prepare and review the versioned baseline separately before enabling CD.

The source commit recorded during a build is not proof that the deployment came
from that commit. A dirty build or an installation with functions from different
releases must be reconciled first. The prepared pipeline has no automatic mixed
baseline adoption: do not label existing ZIPs with the current `HEAD` merely to
clear the gate. Prepare a reviewed code-only rollforward built from a clean,
identified commit; verify all six functions and the application's acceptance
checks; then initialize its versioned manifest and state. Any alternative adoption
needs an explicit provenance model and a separate review before using this pipeline.

Every run validates the baseline even when the requested commit is already
deployed or older. It reads the **exact manifest and template versions**, requires
the complete function/artifact/checksum set, downloads each referenced ZIP version
and verifies its bytes, then compares the checksums with the functions' actual
`CodeSha256` values. A function must be `Active` with `LastUpdateStatus=Successful`.
The CLI returns only hash and status fields to the script. Template equivalence
alone cannot detect an out-of-band `UpdateFunctionCode` call. These checks run
again before changing production and after CloudFormation completion; a mismatch
stops the run without advancing the release state. Downloaded immutable ZIPs are
verified once per process and removed from temporary storage after verification.
[AWS GetFunctionConfiguration](https://docs.aws.amazon.com/cli/latest/reference/lambda/get-function-configuration.html)

### Reviewable activation sequence

1. Identify the exact clean baseline commit, six artifact hashes and versioned
   references, live stack identity and canonical template digest. Prepare the
   code-only reconciliation candidate and acceptance results privately. This is
   separate from approval to create persistent deployment access.
2. Present the exact OIDC trust (repository/environment subject and audience),
   both deployment-role policy documents, existing bucket/prefix boundaries,
   permitted stack and six function ARNs. Include the read actions above and
   `iam:PassRole` restricted to the single execution role and CloudFormation.
   Confirm any bucket-policy or versioning change separately. Do not apply a
   placeholder or wildcard trust as an activation shortcut.
3. Obtain the specific approval for those persistent access and protection
   changes, and any Serverless credential. Apply the approved configuration,
   protected `production` environment and branch restrictions, keeping CD disabled.
4. Complete the separately reviewed baseline deployment/reconciliation and
   initialize its private manifest/state only after live hashes and acceptance
   tests pass. Record exact object versions; never substitute the latest manifest.
5. After explicit activation approval, enable the flag and run against the exact
   baseline commit first. That run must perform verification without a new
   deployment. Then validate a reviewed subsequent `master` release and its final
   state. Failure or uncertainty stops activation for reconciliation.

These steps describe work still requiring real target review and authorization.
Local preparation does not create roles, credentials, repository settings, S3
objects or deployments, and does not establish that OIDC or rollback works live.

## Recovery and rollback

Artifacts, templates and manifests use immutable keys plus S3 version IDs.
The script first attempts each immutable upload with `If-None-Match: *`. Only a
confirmed `PreconditionFailed`/HTTP 412 response permits reading and verifying an
existing object. Access denial, HTTP 409, network uncertainty and other errors
stop the run without automatically retrying the mutation. This avoids requiring
bucket-wide `s3:ListBucket` access to distinguish a missing object from a denied
GET/HEAD. Required configuration and state reads still fail closed when unavailable.
Existing objects must match the expected digest/version. State writes use ETag
conditions; a concurrent change stops the run. Before creating a change set, the
script durably records its commit, manifest key **and version**, template digest, deterministic name
and client token. It resolves and stores the ARN before executing it. On resume,
it inspects that same change set and the stack, rather than beginning an unrelated
deployment. Denied reads and network uncertainty are not treated as absence.
The completed state and manifest retain the previous manifest's key and version.
An older state or pending record without `manifestVersion` is rejected for manual
reconciliation; the script never silently substitutes the current S3 version.

Execution specifies `--no-disable-rollback` explicitly. Rollback, a mismatched
template, missing state, unexpected access change or ambiguous outcome stops
deployment and leaves the pending record for review. A timed-out job is not proof
that CloudFormation stopped; inspect AWS before starting another operation.
[ExecuteChangeSet](https://docs.aws.amazon.com/AWSCloudFormation/latest/APIReference/API_ExecuteChangeSet.html)

For an operational rollback after a completed release:

1. Disable automatic CD and inspect the stack and pending state. If CloudFormation
   is still working, wait for or repair that operation before another deployment.
2. Select the previous verified manifest by its exact key **and version**, verify every stored checksum/version,
   and prepare a code-only candidate using those exact packages on the current
   template. Preserve current IAM, authentication, data and retention settings.
   Do not rebuild an old checkout and call it the same artifact.
3. Review and execute that candidate through the same change-set restrictions,
   with rollback enabled, then verify the final stack and application behavior.
4. Reconcile the private state against the verified template and Git history.
   Add/review a revert or fix on `master` before enabling CD again, so the next
   catch-up cannot silently reinstall the bad release. Document the rollback's
   artifact commit and the baseline decision separately.

`RollbackStack` is for stacks in `CREATE_FAILED` or `UPDATE_FAILED`, not arbitrary
release rollback. `ContinueUpdateRollback` addresses `UPDATE_ROLLBACK_FAILED`.
Do not automatically skip resources or delete retained data to resolve failure.
[RollbackStack](https://docs.aws.amazon.com/AWSCloudFormation/latest/APIReference/API_RollbackStack.html),
[ContinueUpdateRollback](https://docs.aws.amazon.com/AWSCloudFormation/latest/APIReference/API_ContinueUpdateRollback.html)

## Validation limits

Local tests cover template/access isolation, change-set restrictions, missing
versus denied reads, pending-state outcomes, baseline ordering and workflow
gating. A synthetic CLI test also runs the actual script with no AWS credentials
or network, including an already-current baseline, missing manifest versions,
corrupted stored ZIP bytes, out-of-band deployed-code drift, and recovery after
CloudFormation completion that must not advance state on a hash mismatch.
Conditional-upload CLI tests cover first creation, identical/divergent collisions,
denied reads and writes, and uncertain/conflicting results without mutation retries.
These tests do not yet simulate every cross-service interruption between S3 and
CloudFormation. No GitHub-hosted deployment, OIDC exchange, service-role policy,
versioned baseline or real rollback has been exercised by adding this pipeline.
Those checks remain part of the separately approved activation on the existing
production installation; no second remote environment is required or created.

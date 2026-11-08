#!/usr/bin/env node
// Prepared production CD. No AWS operation occurs merely by importing this file.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { parseDocument, stringify } from 'yaml';

const shaPattern = /^[a-f0-9]{40}$/;
const checksumPattern = /^[a-f0-9]{64}$/;
const stableStatuses = new Set(['CREATE_COMPLETE', 'UPDATE_COMPLETE', 'UPDATE_ROLLBACK_COMPLETE']);
const roleIds = ['McpRole', 'IngressRole', 'HistoryRole', 'StreamRole', 'DeliveryRole', 'SweepRole', 'RecoveryScheduleRole'];
const params = new Set(['serviceName', 'installationId', 'mcpConfigSecretArn', 'ingressConfigSecretArn', 'historyConfigSecretArn', 'deliveryConfigSecretArn', 'oauthIssuer', 'oauthAudience', 'oauthJwksUrl', 'publicBaseUrl']);
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export const digest = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : canonical(value)).digest('hex');
// Serverless can read YAML with 1.1 timestamp coercion. Preserve IAM policy
// versions and every other string when emitting our temporary configuration.
export const serializePackageConfig = value => stringify(value, { defaultStringType: 'QUOTE_DOUBLE' });
class PublicCdError extends Error {}
const ensure = (condition, message) => { if (!condition) throw new PublicCdError(message); };
// Só erros controlados deste módulo podem expor diagnóstico; erros de parsers/FS ficam genéricos.
export const publicFailureMessage = error => error instanceof PublicCdError
  ? error.message
  : 'Production deployment failed; private diagnostics suppressed. Inspect the private service state before retrying.';
export function parseDeploymentYaml(source) {
  // Warnings do parser também podem conter valores: rejeitar sem emitir trechos do documento.
  const document = parseDocument(source, { logLevel: 'silent', prettyErrors: false });
  ensure(document.errors.length === 0 && document.warnings.length === 0, 'Deployment YAML is invalid or uses unsupported tags');
  return document.toJS();
}
const same = (a, b) => canonical(a) === canonical(b);
const lambdas = template => Object.entries(template.Resources ?? {}).filter(([, resource]) => resource.Type === 'AWS::Lambda::Function');
// S3 version IDs are opaque UTF-8 strings, at most 1,024 bytes. Do not assume
// a fixed length or alphabet. The placeholder names below are reserved by this
// workflow; syntactic validation does not establish that an S3 version exists.
const versionSentinels = new Set(['null', 'undefined', 'placeholder', 'placeholder-version', 'validation', 'fixture-version', 'version', 'version-id', 'versionid', 'your-version-id', 'replace-me', 'changeme']);
export const validObjectVersion = value => typeof value === 'string' && value.length > 0 &&
  Buffer.byteLength(value, 'utf8') <= 1024 && !/[\s\p{Cc}]/u.test(value) &&
  !/[<>{}]/.test(value) && !/^PENDING_UPLOAD(?:__|$)/i.test(value) && !versionSentinels.has(value.toLowerCase());
const validCode = code => code && typeof code === 'object' && !Array.isArray(code) &&
  same(Object.keys(code).sort(), ['S3Bucket', 'S3Key', 'S3ObjectVersion']) &&
  typeof code.S3Bucket === 'string' && code.S3Bucket.trim().length > 0 &&
  typeof code.S3Key === 'string' && code.S3Key.trim().length > 0 && validObjectVersion(code.S3ObjectVersion);
const assertReleaseReference = release => ensure(release && shaPattern.test(release.commit ?? '') &&
  typeof release.manifestKey === 'string' && release.manifestKey.length > 0 &&
  validObjectVersion(release.manifestVersion) && checksumPattern.test(release.templateDigest ?? ''),
  'Reviewed release with an immutable manifest version required');

export function assertReleaseManifest(release, manifest, template) {
  assertReleaseReference(release);
  ensure(manifest?.schemaVersion === 1 && manifest.commit === release.commit &&
    manifest.templateDigest === release.templateDigest, 'Release manifest mismatch');
  ensure(typeof manifest.templateKey === 'string' && manifest.templateKey.length > 0 &&
    validObjectVersion(manifest.templateVersion), 'Immutable template version missing');
  ensure(digest(template) === release.templateDigest, 'Stored template digest mismatch');
  const ids = lambdas(template).map(([id]) => id).sort();
  ensure(ids.length > 0 && same(ids, Object.keys(manifest.artifacts ?? {}).sort()) &&
    same(ids, Object.keys(manifest.checksums ?? {}).sort()), 'Manifest Lambda artifact/checksum set mismatch');
  for (const id of ids) {
    ensure(validCode(manifest.artifacts[id]) && same(template.Resources[id].Properties.Code, manifest.artifacts[id]), 'Lambda immutable artifact differs from template');
    ensure(checksumPattern.test(manifest.checksums[id] ?? ''), 'Invalid Lambda artifact checksum');
  }
}

export function assertDeployedCode(manifest, deployed) {
  const ids = Object.keys(manifest.checksums).sort();
  ensure(same(ids, Object.keys(deployed).sort()), 'Deployed Lambda set differs from the reviewed manifest');
  for (const id of ids) {
    const actual = deployed[id];
    ensure(actual?.State === 'Active' && actual.LastUpdateStatus === 'Successful', 'Lambda is not ready for release verification');
    const expected = Buffer.from(manifest.checksums[id], 'hex').toString('base64');
    ensure(actual.CodeSha256 === expected, 'Lambda deployed code differs from the reviewed artifact');
  }
}

export function validateConfig(config) {
  const keys = ['schemaVersion', 'region', 'stage', 'stackName', 'cloudFormationRoleArn', 'artifactBucket', 'artifactPrefix', 'stateKey', 'serverlessParams'];
  ensure(config && Object.keys(config).every(key => keys.includes(key)), 'Unsupported CD configuration field');
  ensure(config.schemaVersion === 1, 'Unsupported CD configuration schema');
  ensure(/^[a-z]{2}-[a-z]+-\d$/.test(config.region), 'Invalid AWS region');
  ensure(/^[a-zA-Z][a-zA-Z0-9-]{0,127}$/.test(config.stackName), 'Invalid stack name');
  ensure(/^[a-zA-Z0-9-]+$/.test(config.stage), 'Explicit installation stage required');
  ensure(/^arn:aws:iam::\d{12}:role\/[a-zA-Z0-9_+=,.@/-]+$/.test(config.cloudFormationRoleArn), 'Explicit CloudFormation execution role required');
  ensure(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(config.artifactBucket), 'Invalid private artifact bucket');
  for (const key of ['artifactPrefix', 'stateKey']) ensure(typeof config[key] === 'string' && /^[a-zA-Z0-9_./-]+$/.test(config[key]) && !config[key].includes('..') && !config[key].startsWith('/'), 'Invalid private S3 prefix');
  ensure(!config.stateKey.startsWith(`${config.artifactPrefix}/`), 'Mutable state must be outside immutable releases');
  ensure(config.serverlessParams && Object.keys(config.serverlessParams).length === params.size && Object.keys(config.serverlessParams).every(key => params.has(key)), 'Only the documented non-secret packaging parameters are allowed');
  ensure(Object.values(config.serverlessParams).every(value => typeof value === 'string' && value.length > 0 && !/[\r\n]/.test(value)), 'Invalid packaging parameter');
  for (const key of ['mcpConfigSecretArn', 'ingressConfigSecretArn', 'historyConfigSecretArn', 'deliveryConfigSecretArn']) ensure(/^arn:aws:secretsmanager:[a-z0-9-]+:\d{12}:secret:[\w/-]+$/.test(config.serverlessParams[key]), 'Use secret references, never secret values');
  return config;
}

function assertPackageCompatibility(live, packaged) {
  const actualIds = lambdas(live).map(([id]) => id).sort();
  ensure(actualIds.length > 0 && same(actualIds, lambdas(packaged).map(([id]) => id).sort()), 'Lambda set changed: infrastructure approval required');
  ensure(roleIds.every(id => live.Resources[id]?.Type === 'AWS::IAM::Role'), 'Approved runtime role set missing');
  for (const [id, resource] of lambdas(live)) {
    const next = packaged.Resources[id];
    for (const key of ['Handler', 'Runtime', 'Architectures', 'PackageType']) ensure(same(resource.Properties[key], next.Properties[key]), 'Lambda runtime/handler change requires infrastructure approval');
  }
  return actualIds;
}

export function codeOnlyTemplate(live, packaged, uploadedCode, release) {
  const result = structuredClone(live);
  const actualIds = assertPackageCompatibility(live, packaged);
  ensure(uploadedCode && same(actualIds, Object.keys(uploadedCode).sort()), 'Missing or extra Lambda artifact');
  for (const id of actualIds) {
    const code = uploadedCode[id];
    ensure(validCode(code), 'Artifacts require immutable S3 object versions');
    result.Resources[id].Properties.Code = code;
  }
  result.Metadata = { ...result.Metadata, BridgeRelease: release };
  assertCodeOnly(live, result);
  return result;
}

export function assertCodeOnly(before, after) {
  const normalized = structuredClone(after);
  for (const [id, resource] of lambdas(before)) {
    ensure(normalized.Resources?.[id]?.Type === 'AWS::Lambda::Function', 'Lambda removed or replaced');
    normalized.Resources[id].Properties.Code = resource.Properties.Code;
  }
  normalized.Metadata = structuredClone(after.Metadata ?? {});
  if (before.Metadata?.BridgeRelease === undefined) delete normalized.Metadata.BridgeRelease;
  else normalized.Metadata.BridgeRelease = structuredClone(before.Metadata.BridgeRelease);
  if (before.Metadata === undefined && Object.keys(normalized.Metadata).length === 0) delete normalized.Metadata;
  ensure(same(before, normalized), 'Deployment may change only existing Lambda code and release metadata');
}

export function assertSafeChangeSet(changeSet, allowedIds) {
  ensure(changeSet.Status === 'CREATE_COMPLETE' && changeSet.ExecutionStatus === 'AVAILABLE', 'Change set is not executable');
  ensure(Array.isArray(changeSet.Changes) && changeSet.Changes.length > 0, 'Empty change set');
  const seen = new Set();
  for (const item of changeSet.Changes) {
    const change = item.ResourceChange;
    ensure(change?.Action === 'Modify' && change.ResourceType === 'AWS::Lambda::Function' && allowedIds.includes(change.LogicalResourceId), 'Change set contains infrastructure or access changes');
    ensure(!seen.has(change.LogicalResourceId), 'Duplicate logical resource ID in change set');
    seen.add(change.LogicalResourceId);
    ensure(change.Replacement === 'False', 'Resource replacement forbidden');
    ensure(same(change.Scope, ['Properties']) && change.Details?.length > 0, 'Missing change-set property details');
    for (const detail of change.Details) ensure(detail.Target?.Attribute === 'Properties' && detail.Target?.Name === 'Code' && detail.Target?.RequiresRecreation === 'Never' && detail.Evaluation === 'Static', 'Only static Lambda Code updates are allowed');
  }
}

export const describeChangeSetArgs = (stackName, id) => ['cloudformation', 'describe-change-set', '--stack-name', stackName, '--change-set-name', id, '--include-property-values'];

export function pendingOutcome(state, stack, templateDigest, changeSet) {
  ensure(state.pending, 'No pending release');
  if (stack.StackStatus.endsWith('_IN_PROGRESS')) return 'wait';
  if (stack.StackStatus === 'UPDATE_COMPLETE' && templateDigest === state.pending.templateDigest) return 'commit';
  if (stableStatuses.has(stack.StackStatus) && templateDigest === state.templateDigest && changeSet.ExecutionStatus === 'AVAILABLE') return 'execute';
  throw new PublicCdError('Pending release requires reconciliation: preserve the state and inspect CloudFormation before any retry');
}

export function awsErrorCode(stderr) {
  const details = String(stderr ?? '');
  const code = /An error occurred \(([a-zA-Z0-9.]+)\)/.exec(details)?.[1];
  return ['404', 'NoSuchKey', 'NotFound', 'ChangeSetNotFound'].includes(code) ||
    (code === 'ValidationError' && details.includes('does not exist')) ? 'NotFound' : code;
}

export function createImmutableObject(create, readVerifiedExisting) {
  try { return create(); }
  catch (error) {
    // Só 412 comprova a colisão da escrita condicional. Não repetir mutação após erro incerto.
    if (!['PreconditionFailed', '412'].includes(error.code)) throw error;
    return readVerifiedExisting();
  }
}

function run(command, args, cwd, env = process.env) {
  try { return execFileSync(command, args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 }); }
  catch (cause) {
    const error = new PublicCdError(`${basename(command)} operation failed; sensitive output suppressed. Inspect the private service state before retrying.`);
    error.code = awsErrorCode(cause.stderr);
    throw error;
  }
}
export function commitsAfterBaseline(repo, baseline, target) {
  ensure(shaPattern.test(baseline) && shaPattern.test(target), 'Full Git commit IDs required');
  const ancestor = (a, b) => { try { execFileSync('git', ['merge-base', '--is-ancestor', a, b], { cwd: repo, stdio: 'ignore' }); return true; } catch { return false; } };
  if (ancestor(target, baseline)) return [];
  ensure(ancestor(baseline, target), 'Non-fast-forward master history: manual reconciliation required');
  const firstParent = run('git', ['rev-list', '--first-parent', target], repo).trim().split('\n');
  ensure(firstParent.includes(baseline), 'Baseline must be on the master first-parent chain');
  return run('git', ['rev-list', '--reverse', '--first-parent', `${baseline}..${target}`], repo).trim().split('\n').filter(Boolean);
}

async function main() {
  ensure(process.env.ENABLE_PRODUCTION_CD === 'true' && process.env.GITHUB_ACTIONS === 'true' && process.env.GITHUB_REF === 'refs/heads/master', 'Production CD is disabled or not running on master in GitHub Actions');
  const target = process.env.TARGET_SHA;
  ensure(shaPattern.test(target ?? ''), 'Full target SHA required');
  const uri = /^s3:\/\/([a-z0-9.-]+)\/([^\r\n]+)$/.exec(process.env.BRIDGE_CD_CONFIG_URI ?? '');
  ensure(uri && validObjectVersion(process.env.BRIDGE_CD_CONFIG_VERSION), 'Explicit versioned private config reference required');
  const workspace = process.cwd();
  const temp = mkdtempSync(join(tmpdir(), 'bridge-cd-'));
  const aws = (...args) => JSON.parse(run('aws', [...args, '--region', process.env.AWS_REGION, '--output', 'json', '--no-cli-pager'], workspace) || '{}');
  const save = (name, value) => { const path = join(temp, name); writeFileSync(path, JSON.stringify(value), { mode: 0o600 }); return path; };
  let config;
  const getObject = (bucket, key, version) => {
    const path = join(temp, `read-${digest(`${bucket}/${key}`).slice(0, 16)}.json`);
    const response = aws('s3api', 'get-object', '--bucket', bucket, '--key', key, ...(version ? ['--version-id', version] : []), path);
    return { value: JSON.parse(readFileSync(path, 'utf8')), etag: response.ETag, version: response.VersionId };
  };
  const put = (key, file, condition = ['--if-none-match', '*']) => aws('s3api', 'put-object', '--bucket', config.artifactBucket, '--key', key, '--body', file, '--server-side-encryption', 'AES256', ...condition);
  const immutableJson = (key, value) => {
    const response = createImmutableObject(() => put(key, save(`write-${digest(key)}.json`, value)), () => {
      const existing = getObject(config.artifactBucket, key);
      ensure(same(existing.value, value) && validObjectVersion(existing.version), 'Immutable JSON content/version mismatch');
      return { VersionId: existing.version };
    });
    ensure(validObjectVersion(response.VersionId), 'Immutable JSON version missing');
    return response.VersionId;
  };
  const readState = () => getObject(config.artifactBucket, config.stateKey);
  const writeState = (state, etag) => { ensure(etag, 'State ETag required'); put(config.stateKey, save('state.json', state), ['--if-match', etag]); return readState(); };
  const stackNow = () => aws('cloudformation', 'describe-stacks', '--stack-name', config.stackName).Stacks[0];
  const templateNow = () => { const value = aws('cloudformation', 'get-template', '--stack-name', config.stackName, '--template-stage', 'Original').TemplateBody; return typeof value === 'string' ? parseDeploymentYaml(value) : value; };
  const describeChangeSet = id => aws(...describeChangeSetArgs(config.stackName, id));
  const verifiedArtifacts = new Set();
  const verifyStoredArtifacts = manifest => {
    for (const [id, code] of Object.entries(manifest.artifacts)) {
      const expected = manifest.checksums[id];
      const identity = digest({ code, expected });
      if (verifiedArtifacts.has(identity)) continue;
      const path = join(temp, `artifact-${identity}.zip`);
      try {
        const object = aws('s3api', 'get-object', '--bucket', code.S3Bucket, '--key', code.S3Key, '--version-id', code.S3ObjectVersion, path);
        ensure(object.VersionId === code.S3ObjectVersion && digest(readFileSync(path)) === expected, 'Lambda stored artifact checksum/version mismatch');
        verifiedArtifacts.add(identity);
      } finally { rmSync(path, { force: true }); }
    }
  };
  const readRelease = release => {
    assertReleaseReference(release);
    const stored = getObject(config.artifactBucket, release.manifestKey, release.manifestVersion);
    ensure(stored.version === release.manifestVersion, 'Stored manifest version mismatch');
    const manifest = stored.value;
    ensure(typeof manifest.templateKey === 'string' && validObjectVersion(manifest.templateVersion), 'Immutable template reference missing');
    const storedTemplate = getObject(config.artifactBucket, manifest.templateKey, manifest.templateVersion);
    ensure(storedTemplate.version === manifest.templateVersion, 'Stored template version mismatch');
    assertReleaseManifest(release, manifest, storedTemplate.value);
    verifyStoredArtifacts(manifest);
    return { manifest, template: storedTemplate.value };
  };
  const verifyDeployedCode = manifest => {
    const resources = aws('cloudformation', 'list-stack-resources', '--stack-name', config.stackName,
      '--query', "StackResourceSummaries[?ResourceType=='AWS::Lambda::Function'].{logicalId:LogicalResourceId,physicalId:PhysicalResourceId}");
    const ids = Object.keys(manifest.checksums).sort();
    ensure(Array.isArray(resources) && same(resources.map(resource => resource.logicalId).sort(), ids) &&
      resources.every(resource => typeof resource.physicalId === 'string' && resource.physicalId.length > 0) &&
      new Set(resources.map(resource => resource.physicalId)).size === ids.length, 'Stack Lambda identities differ from the reviewed manifest');
    // A consulta limita a saída do CLI: configuração, variáveis e referências privadas não entram nos logs.
    const deployed = Object.fromEntries(resources.map(resource => [resource.logicalId,
      aws('lambda', 'get-function-configuration', '--function-name', resource.physicalId,
        '--query', '{CodeSha256:CodeSha256,State:State,LastUpdateStatus:LastUpdateStatus}') ]));
    assertDeployedCode(manifest, deployed);
  };
  const verifyBaseline = state => {
    const stack = stackNow();
    ensure(stack.StackId === state.stackId && stableStatuses.has(stack.StackStatus), 'Stack identity or status mismatch');
    const live = templateNow();
    ensure(digest(live) === state.templateDigest, 'Production template drift: review and update baseline before continuing');
    const { manifest } = readRelease(state);
    verifyDeployedCode(manifest);
    return live;
  };
  const poll = async (read, ready, label) => {
    for (let count = 0; count < 160; count++) { const value = read(); if (ready(value)) return value; await new Promise(resolve => setTimeout(resolve, 15_000)); }
    throw new PublicCdError(`${label} still pending: check service state before retrying`);
  };
  const reconcile = async record => {
    let state = record.value;
    let pending = state.pending;
    if (!pending) return record;
    readRelease(state);
    const { manifest, template: candidate } = readRelease(pending);
    let stack = stackNow();
    ensure(stack.StackId === state.stackId, 'Stack identity changed');
    let changeSet;
    try { changeSet = describeChangeSet(pending.changeSetId ?? pending.changeSetName); }
    catch (error) {
      if (error.code !== 'NotFound' || pending.changeSetId) throw error;
      assertCodeOnly(verifyBaseline(state), candidate);
      const templateUrl = `https://${config.artifactBucket}.s3.${config.region}.amazonaws.com/${manifest.templateKey}?versionId=${encodeURIComponent(manifest.templateVersion)}`;
      aws('cloudformation', 'create-change-set', '--stack-name', config.stackName, '--change-set-name', pending.changeSetName, '--change-set-type', 'UPDATE', '--template-url', templateUrl, '--role-arn', config.cloudFormationRoleArn, '--capabilities', 'CAPABILITY_NAMED_IAM', '--client-token', pending.token);
      changeSet = describeChangeSet(pending.changeSetName);
    }
    if (['CREATE_PENDING', 'CREATE_IN_PROGRESS'].includes(changeSet.Status)) changeSet = await poll(() => describeChangeSet(pending.changeSetId ?? pending.changeSetName), value => !['CREATE_PENDING', 'CREATE_IN_PROGRESS'].includes(value.Status), 'Change set');
    ensure(changeSet.Status === 'CREATE_COMPLETE', 'Change set failed: inspect the durable pending release');
    if (!pending.changeSetId) {
      ensure(changeSet.ChangeSetId, 'Change-set ARN missing');
      record = writeState({ ...state, pending: { ...pending, changeSetId: changeSet.ChangeSetId } }, record.etag);
      state = record.value;
      pending = state.pending;
    }
    let outcome = pendingOutcome(state, stack, digest(templateNow()), changeSet);
    if (outcome === 'execute') {
      assertCodeOnly(verifyBaseline(state), candidate);
      assertSafeChangeSet(changeSet, lambdas(candidate).map(([id]) => id));
      const reviewedBody = aws('cloudformation', 'get-template', '--stack-name', config.stackName, '--change-set-name', pending.changeSetId, '--template-stage', 'Original').TemplateBody;
      ensure(digest(typeof reviewedBody === 'string' ? parseDeploymentYaml(reviewedBody) : reviewedBody) === pending.templateDigest, 'Change-set template differs from the reviewed artifact');
      // The reviewed ARN and client token survive job retries. Never create a new set here.
      aws('cloudformation', 'execute-change-set', '--change-set-name', pending.changeSetId, '--client-request-token', pending.token, '--no-disable-rollback');
      outcome = 'wait';
    }
    if (outcome === 'wait') {
      stack = await poll(stackNow, value => {
        if (value.StackStatus.endsWith('_IN_PROGRESS')) return false;
        if (value.StackStatus === 'UPDATE_COMPLETE' && digest(templateNow()) === pending.templateDigest) return true;
        // Immediately after ExecuteChangeSet, the previous completed state can
        // still be visible. Rollback/failure states must not be retried blindly.
        if (!['CREATE_COMPLETE', 'UPDATE_COMPLETE'].includes(value.StackStatus)) throw new PublicCdError('CloudFormation update failed or rolled back; inspect the pending release before retrying');
        return false;
      }, 'Stack update');
      changeSet = describeChangeSet(pending.changeSetId);
      outcome = pendingOutcome(state, stack, digest(templateNow()), changeSet);
    }
    ensure(outcome === 'commit', 'Release did not complete');
    // UPDATE_COMPLETE não prova o conteúdo do ZIP: só avançamos o estado após comparar cada Lambda.
    verifyDeployedCode(manifest);
    const completed = { schemaVersion: 1, stackId: state.stackId, commit: pending.commit, templateDigest: pending.templateDigest, manifestKey: pending.manifestKey, manifestVersion: pending.manifestVersion, previousManifestKey: state.manifestKey, previousManifestVersion: state.manifestVersion };
    const current = readState();
    if (same(current.value, completed)) return current;
    ensure(same(current.value, state), 'Concurrent state change; reconcile before retry');
    console.log(`Verified production release ${pending.commit}`);
    return writeState(completed, current.etag);
  };
  try {
    config = validateConfig(getObject(uri[1], uri[2], process.env.BRIDGE_CD_CONFIG_VERSION).value);
    ensure(config.region === process.env.AWS_REGION, 'Configured region mismatch');
    ensure(aws('s3api', 'get-bucket-versioning', '--bucket', config.artifactBucket).Status === 'Enabled', 'Private artifact bucket must already have versioning enabled');
    const protection = aws('s3api', 'get-public-access-block', '--bucket', config.artifactBucket).PublicAccessBlockConfiguration;
    ensure(['BlockPublicAcls', 'IgnorePublicAcls', 'BlockPublicPolicy', 'RestrictPublicBuckets'].every(key => protection?.[key] === true), 'Artifact bucket must block all public access');
    let record = readState(); // Missing state is a hard failure; never deploy all repository history.
    ensure(record.value.schemaVersion === 1 && typeof record.value.stackId === 'string' && record.value.stackId.length > 0, 'Reviewed deployment baseline required');
    assertReleaseReference(record.value);
    record = await reconcile(record);
    verifyBaseline(record.value);
    for (const commit of commitsAfterBaseline(workspace, record.value.commit, target)) {
      const live = verifyBaseline(record.value);
      const source = join(temp, commit);
      run('git', ['worktree', 'add', '--detach', source, commit], workspace);
      try {
        console.log(`Verifying commit ${commit}`);
        run('npm', ['ci', '--ignore-scripts'], source);
        run('npm', ['run', 'check'], source);
        run('npm', ['run', 'demo'], source);
        const service = parseDeploymentYaml(readFileSync(join(source, 'serverless.yml'), 'utf8'));
        service.provider.deploymentBucket = { name: config.artifactBucket };
        service.package.patterns = [...(service.package.patterns ?? []), '!serverless.ci.yml'];
        // A configured existing bucket avoids Serverless's managed bucket/SSM bootstrap.
        const packageConfig = join(source, 'serverless.ci.yml');
        writeFileSync(packageConfig, serializePackageConfig(service), { mode: 0o600 });
        run(join(source, 'node_modules/.bin/serverless'), ['package', '--config', packageConfig, '--stage', config.stage, '--region', config.region, ...Object.entries(config.serverlessParams).map(([key, value]) => `--param=${key}=${value}`)], source);
        // Verify the generated runtime without host dependencies before any upload.
        run(process.execPath, ['--import', 'tsx', '--test', '--test-isolation=none', 'test/infra.test.ts', 'test/packaged-runtime.test.ts'], source);
        const directory = join(source, '.serverless');
        const packaged = JSON.parse(readFileSync(join(directory, 'cloudformation-template-update-stack.json'), 'utf8'));
        const files = Object.fromEntries(lambdas(packaged).map(([id, resource]) => {
          const name = basename(resource.Properties.Code.S3Key);
          ensure(/^[a-zA-Z0-9_.-]+\.zip$/.test(name) && readdirSync(directory).includes(name), 'Invalid package artifact');
          const path = join(directory, name);
          return [id, { name, path, sha256: digest(readFileSync(path)) }];
        }));
        const bundleDigest = digest(Object.fromEntries(Object.entries(files).map(([id, file]) => [id, file.sha256])));
        const prefix = `${config.artifactPrefix}/${commit}/${bundleDigest}`;
        const codes = {};
        // Inspect structure before writing artifacts or creating a change set.
        assertPackageCompatibility(live, packaged);
        for (const [id, file] of Object.entries(files)) {
          const key = `${prefix}/${file.name}`;
          // A escrita condicional dispensa ListBucket para distinguir objeto ausente de acesso negado.
          const uploaded = createImmutableObject(() => put(key, file.path, ['--if-none-match', '*', '--metadata', `sha256=${file.sha256}`]), () => {
            const existing = aws('s3api', 'head-object', '--bucket', config.artifactBucket, '--key', key);
            ensure(existing.Metadata?.sha256 === file.sha256 && validObjectVersion(existing.VersionId), 'Existing artifact digest/version mismatch');
            return existing;
          });
          ensure(validObjectVersion(uploaded.VersionId), 'Artifact version missing');
          codes[id] = { S3Bucket: config.artifactBucket, S3Key: key, S3ObjectVersion: uploaded.VersionId };
        }
        const manifestKey = `${prefix}/manifest.json`;
        const candidate = codeOnlyTemplate(live, packaged, codes, { commit, manifestKey });
        const templateDigest = digest(candidate);
        const templateKey = `${prefix}/template-${templateDigest}.json`;
        const templateVersion = immutableJson(templateKey, candidate);
        const manifest = { schemaVersion: 1, commit, templateKey, templateVersion, templateDigest, artifacts: codes, checksums: Object.fromEntries(Object.entries(files).map(([id, file]) => [id, file.sha256])), previousManifestKey: record.value.manifestKey, previousManifestVersion: record.value.manifestVersion };
        const manifestVersion = immutableJson(manifestKey, manifest);
        const token = `release-${commit}-${templateDigest.slice(0, 20)}`;
        // Re-read the baseline after packaging to catch concurrent external updates.
        verifyBaseline(record.value);
        record = writeState({ ...record.value, pending: { commit, manifestKey, manifestVersion, templateDigest, changeSetName: token, token } }, record.etag);
        record = await reconcile(record);
      } finally { run('git', ['worktree', 'remove', '--force', source], workspace); }
    }
    console.log('Production is current for the requested master commit.');
  } finally { rmSync(temp, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(publicFailureMessage(error)); process.exitCode = 1; });

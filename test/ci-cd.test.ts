import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const scriptUrl = new URL('../scripts/ci-deploy.mjs', import.meta.url).href;
const { assertCodeOnly, codeOnlyTemplate, assertSafeChangeSet, pendingOutcome, commitsAfterBaseline, validateConfig, digest, awsErrorCode, serializePackageConfig, validObjectVersion, describeChangeSetArgs, assertReleaseManifest, assertDeployedCode, createImmutableObject } = await import(scriptUrl);
type Obj = Record<string, any>;
const roleIds = ['McpRole', 'IngressRole', 'HistoryRole', 'StreamRole', 'DeliveryRole', 'SweepRole', 'RecoveryScheduleRole'];
function template(): Obj {
  return {
    AWSTemplateFormatVersion: '2010-09-09',
    Resources: {
      ...Object.fromEntries(roleIds.map(id => [id, { Type: 'AWS::IAM::Role', Properties: { Policies: [], AssumeRolePolicyDocument: { Statement: [] } } }])),
      Worker: { Type: 'AWS::Lambda::Function', Properties: { Handler: 'index.handler', Runtime: 'nodejs24.x', Architectures: ['arm64'], Role: { 'Fn::GetAtt': ['McpRole', 'Arn'] }, Environment: { Variables: { BOOTSTRAP_MODE: 'true' } }, Code: { S3Bucket: 'example-private-releases', S3Key: 'previous.zip' } } },
      Configuration: { Type: 'AWS::SecretsManager::Secret', Properties: { SecretString: '{}' } },
      Data: { Type: 'AWS::DynamoDB::Table', DeletionPolicy: 'Retain', Properties: { BillingMode: 'PAY_PER_REQUEST' } },
    },
  };
}
const uploaded = { Worker: { S3Bucket: 'example-private-releases', S3Key: 'new.zip', S3ObjectVersion: 'opaqueVersion+123.abc-XYZ' } };
const changeSet = (): Obj => ({ Status: 'CREATE_COMPLETE', ExecutionStatus: 'AVAILABLE', Changes: [{ ResourceChange: { Action: 'Modify', LogicalResourceId: 'Worker', ResourceType: 'AWS::Lambda::Function', Replacement: 'False', Scope: ['Properties'], Details: [{ Target: { Attribute: 'Properties', Name: 'Code', RequiresRecreation: 'Never' }, Evaluation: 'Static' }] } }] });
function reviewedRelease(commit = 'a'.repeat(40)): Obj {
  const candidate = codeOnlyTemplate(template(), template(), uploaded, { commit });
  const checksum = digest('synthetic ZIP fixture');
  const state = { schemaVersion: 1, stackId: 'synthetic-stack-id', commit, templateDigest: digest(candidate), manifestKey: 'releases/manifest.json', manifestVersion: 'manifestVersion-123' };
  const manifest = { schemaVersion: 1, commit, templateDigest: state.templateDigest, templateKey: 'releases/template.json', templateVersion: 'templateVersion-123', artifacts: uploaded, checksums: { Worker: checksum } };
  const deployed = { Worker: { State: 'Active', LastUpdateStatus: 'Successful', CodeSha256: Buffer.from(checksum, 'hex').toString('base64') } };
  return { state, manifest, template: candidate, deployed };
}

test('CD exige manifesto e template versionados com referências e hashes completos', () => {
  const release = reviewedRelease();
  assert.doesNotThrow(() => assertReleaseManifest(release.state, release.manifest, release.template));
  for (const mutate of [
    (r: Obj) => { delete r.state.manifestVersion; },
    (r: Obj) => { r.manifest.commit = 'b'.repeat(40); },
    (r: Obj) => { r.manifest.templateVersion = 'null'; },
    (r: Obj) => { r.template.Metadata.BridgeRelease.commit = 'b'.repeat(40); },
    (r: Obj) => { delete r.manifest.artifacts.Worker; },
    (r: Obj) => { r.manifest.checksums.Other = 'b'.repeat(64); },
    (r: Obj) => { r.manifest.checksums.Worker = 'not-a-hash'; },
    (r: Obj) => { r.manifest.artifacts.Worker.S3ObjectVersion = 'anotherVersion-123'; },
  ]) {
    const invalid = structuredClone(release); mutate(invalid);
    assert.throws(() => assertReleaseManifest(invalid.state, invalid.manifest, invalid.template));
  }
});

test('CD detecta substituição de código fora do CloudFormation e Lambda ainda indisponível', () => {
  const { manifest, deployed } = reviewedRelease();
  assert.doesNotThrow(() => assertDeployedCode(manifest, deployed));
  for (const change of [{ CodeSha256: 'b'.repeat(44) }, { State: 'Pending' }, { LastUpdateStatus: 'InProgress' }, { LastUpdateStatus: 'Failed' }]) {
    assert.throws(() => assertDeployedCode(manifest, { Worker: { ...deployed.Worker, ...change } }));
  }
  assert.throws(() => assertDeployedCode(manifest, {}), /Lambda set/);
  assert.throws(() => assertDeployedCode(manifest, { ...deployed, Other: deployed.Worker }), /Lambda set/);
});

test('CD verifica hashes distintos por função sem inferir procedência a partir do SHA de Git', () => {
  const { manifest, deployed } = reviewedRelease();
  manifest.checksums.Other = digest('other package');
  deployed.Other = { ...deployed.Worker, CodeSha256: Buffer.from(manifest.checksums.Other, 'hex').toString('base64') };
  assert.doesNotThrow(() => assertDeployedCode(manifest, deployed));
  deployed.Other.CodeSha256 = deployed.Worker.CodeSha256;
  assert.throws(() => assertDeployedCode(manifest, deployed), /Lambda deployed code/);
});

test('CD valida baseline e bytes S3 mesmo sem novos commits; recuperação não avança após drift', () => {
  const directory = mkdtempSync(join(tmpdir(), 'bridge-cd-baseline-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    git('init', '-b', 'master');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'fixture');
    const release = reviewedRelease(git('rev-parse', 'HEAD'));
    const config = { schemaVersion: 1, region: 'us-east-1', stage: 'production', stackName: 'example-stack', cloudFormationRoleArn: 'arn:aws:iam::123456789012:role/example-deployment', artifactBucket: 'example-private-releases', artifactPrefix: 'releases', stateKey: 'state/production.json', serverlessParams: {
      serviceName: 'example', installationId: 'example', ...Object.fromEntries(['mcp', 'ingress', 'history', 'delivery'].map(name => [`${name}ConfigSecretArn`, `arn:aws:secretsmanager:us-east-1:123456789012:secret:example/${name}-AbCdEf`])), oauthIssuer: 'https://identity.example', oauthAudience: 'bridge', oauthJwksUrl: 'https://identity.example/jwks', publicBaseUrl: 'https://bridge.example',
    } };
    const fixture: Obj = { state: release.state, template: release.template, deployed: release.deployed, objects: {
      'config.json': { version: 'configVersion-123', value: config },
      [release.state.manifestKey]: { version: release.state.manifestVersion, value: release.manifest },
      [release.manifest.templateKey]: { version: release.manifest.templateVersion, value: release.template },
      [uploaded.Worker.S3Key]: { version: uploaded.Worker.S3ObjectVersion, bytes: 'synthetic ZIP fixture' },
    } };
    // CLI sintético falha em qualquer operação não prevista; o teste nunca usa AWS ou credenciais reais.
    writeFileSync(join(directory, 'aws'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const fixture = JSON.parse(fs.readFileSync(process.env.CD_FIXTURE, 'utf8'));
const operation = args.slice(0, 2).join(' ');
fs.appendFileSync(process.env.CD_CALLS, operation + '\\n');
if (fixture.rawStdout !== undefined) { process.stdout.write(fixture.rawStdout); process.exit(0); }
if (fixture.commandFailureOutput !== undefined) {
  process.stdout.write(fixture.commandFailureOutput);
  process.stderr.write(fixture.commandFailureOutput);
  process.exit(17);
}
const arg = name => args[args.indexOf(name) + 1];
let output;
if (operation === 's3api get-object') {
  const key = arg('--key');
  const object = key === 'state/production.json' ? { value: fixture.state, version: 'stateVersion-123' } : fixture.objects[key];
  if (!object || (args.includes('--version-id') && arg('--version-id') !== object.version)) throw Error('Unexpected object/version');
  fs.writeFileSync(args[args.indexOf('--region') - 1], object.bytes ?? JSON.stringify(object.value));
  output = { VersionId: object.version, ETag: 'synthetic-etag' };
} else if (operation === 's3api get-bucket-versioning') output = { Status: 'Enabled' };
else if (operation === 's3api get-public-access-block') output = { PublicAccessBlockConfiguration: Object.fromEntries(['BlockPublicAcls', 'IgnorePublicAcls', 'BlockPublicPolicy', 'RestrictPublicBuckets'].map(key => [key, true])) };
else if (operation === 'cloudformation describe-stacks') output = { Stacks: [{ StackId: fixture.state.stackId, StackStatus: 'UPDATE_COMPLETE' }] };
else if (operation === 'cloudformation get-template') output = { TemplateBody: fixture.template };
else if (operation === 'cloudformation list-stack-resources') output = [{ logicalId: 'Worker', physicalId: 'synthetic-function' }];
else if (operation === 'cloudformation describe-change-set') output = { Status: 'CREATE_COMPLETE', ExecutionStatus: 'EXECUTE_COMPLETE', ChangeSetId: 'synthetic-change-set' };
else if (operation === 'lambda get-function-configuration') output = fixture.deployed.Worker;
else throw Error('Unexpected operation: ' + operation);
process.stdout.write(JSON.stringify(output));
`, { mode: 0o700 });
    const fixturePath = join(directory, 'fixture.json');
    const callsPath = join(directory, 'calls.txt');
    const execute = (value: Obj) => {
      writeFileSync(fixturePath, JSON.stringify(value)); writeFileSync(callsPath, '');
      const result = spawnSync(process.execPath, [fileURLToPath(scriptUrl)], { cwd: directory, encoding: 'utf8', env: {
        PATH: `${directory}:${process.env.PATH}`, ENABLE_PRODUCTION_CD: 'true', GITHUB_ACTIONS: 'true', GITHUB_REF: 'refs/heads/master', TARGET_SHA: release.state.commit,
        AWS_REGION: 'us-east-1', BRIDGE_CD_CONFIG_URI: 's3://example-private-releases/config.json', BRIDGE_CD_CONFIG_VERSION: 'configVersion-123', CD_FIXTURE: fixturePath, CD_CALLS: callsPath,
      } });
      const calls = readFileSync(callsPath, 'utf8');
      assert.doesNotMatch(calls, /put-object|create-change-set|execute-change-set/, 'nenhuma mutação deve ocorrer');
      return { ...result, calls };
    };
    const verified = execute(fixture);
    assert.equal(verified.status, 0, `${verified.stdout}\n${verified.stderr}\n${verified.calls}\n${verified.error ?? ''}`);
    const drift = structuredClone(fixture); drift.deployed.Worker.CodeSha256 = 'mismatched';
    const driftResult = execute(drift);
    assert.equal(driftResult.status, 1); assert.match(driftResult.stderr, /deployed code differs/);
    const corrupted = structuredClone(fixture); corrupted.objects[uploaded.Worker.S3Key].bytes = 'changed bytes';
    const corruptionResult = execute(corrupted);
    assert.equal(corruptionResult.status, 1); assert.match(corruptionResult.stderr, /stored artifact checksum/);
    const mutable = structuredClone(fixture); delete mutable.state.manifestVersion;
    const mutableResult = execute(mutable);
    assert.equal(mutableResult.status, 1); assert.match(mutableResult.stderr, /immutable manifest version/);
    const resumed = structuredClone(drift);
    resumed.state.pending = { ...release.state, changeSetId: 'synthetic-change-set', changeSetName: 'synthetic-change-set', token: 'synthetic-token' };
    const recoveryResult = execute(resumed);
    assert.equal(recoveryResult.status, 1); assert.match(recoveryResult.stderr, /deployed code differs/);
    assert.match(recoveryResult.calls, /describe-change-set/);
    // Exercita a saída pública real do processo, inclusive warnings fora do catch do CLI.
    const marker = 'SECRET42';
    const invalidConfig = structuredClone(fixture); invalidConfig.objects['config.json'].bytes = marker;
    const invalidCliJson = structuredClone(fixture); invalidCliJson.rawStdout = marker;
    const failedCommand = structuredClone(fixture); failedCommand.commandFailureOutput = marker;
    const invalidYaml = structuredClone(fixture); invalidYaml.template = `Endpoint: "https://${marker}.example.test\n`;
    const warningYaml = structuredClone(fixture); warningYaml.template = `Endpoint: !Sub https://${marker}.example.test`;
    for (const [value, expectedError] of [
      [invalidConfig, /private diagnostics suppressed/],
      [invalidCliJson, /private diagnostics suppressed/],
      [failedCommand, /sensitive output suppressed/],
      [invalidYaml, /Deployment YAML is invalid/],
      [warningYaml, /Deployment YAML is invalid/],
    ] as [Obj, RegExp][]) {
      const result = execute(value);
      assert.equal(result.status, 1, 'o diagnóstico privado não pode virar sucesso');
      assert.match(result.stderr, expectedError);
      assert.equal(result.stdout.includes(marker) || result.stderr.includes(marker), false, 'stdout/stderr não podem conter o marcador privado');
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('CD cria objeto imutável antes de ler; só colisão 412 permite verificar existente', () => {
  const directory = mkdtempSync(join(tmpdir(), 'bridge-cd-put-first-'));
  const fixturePath = join(directory, 'fixture.json');
  const callsPath = join(directory, 'calls.txt');
  try {
    // CLI local sintético: toda chamada é registrada; nenhum comando toca rede ou credenciais.
    const cliPath = join(directory, 'synthetic-aws.cjs');
    writeFileSync(cliPath, `
const fs = require('node:fs');
const args = process.argv.slice(2);
const fixture = JSON.parse(fs.readFileSync(process.env.CD_FIXTURE, 'utf8'));
const operation = args[1];
fs.appendFileSync(process.env.CD_CALLS, operation + '\\n');
if (operation === 'put-object') {
  if (args[args.indexOf('--if-none-match') + 1] !== '*') throw Error('Conditional header required');
  if (fixture.putError) {
    process.stderr.write(fixture.putError === 'unknown' ? 'Connection timed out; outcome unknown' : 'An error occurred (' + fixture.putError + ') when calling the PutObject operation');
    process.exit(1);
  }
  process.stdout.write(JSON.stringify({ VersionId: 'createdVersion-123' }));
} else if (operation === 'get-object') {
  if (fixture.readError) {
    process.stderr.write('An error occurred (AccessDenied) when calling the GetObject operation');
    process.exit(1);
  }
  process.stdout.write(JSON.stringify({ VersionId: 'existingVersion-123', content: fixture.content }));
} else throw Error('Unexpected operation');
`);
    const cli = (...args: string[]) => {
      try {
        return JSON.parse(execFileSync(process.execPath, [cliPath, 's3api', ...args], { encoding: 'utf8', env: { CD_FIXTURE: fixturePath, CD_CALLS: callsPath }, stdio: ['ignore', 'pipe', 'pipe'] }));
      } catch (cause: any) {
        const error: any = new Error('synthetic CLI failure'); error.code = awsErrorCode(cause.stderr); throw error;
      }
    };
    const execute = (fixture: Obj) => {
      writeFileSync(fixturePath, JSON.stringify(fixture)); writeFileSync(callsPath, '');
      return () => createImmutableObject(() => cli('put-object', '--if-none-match', '*'), () => {
        const existing = cli('get-object');
        assert.equal(existing.content, 'reviewed synthetic content', 'existing content mismatch');
        assert.ok(validObjectVersion(existing.VersionId));
        return existing;
      });
    };
    const calls = () => readFileSync(callsPath, 'utf8').trim().split('\n');
    assert.equal(execute({})().VersionId, 'createdVersion-123');
    assert.deepEqual(calls(), ['put-object']);
    for (const putError of ['PreconditionFailed', '412']) {
      assert.equal(execute({ putError, content: 'reviewed synthetic content' })().VersionId, 'existingVersion-123');
      assert.deepEqual(calls(), ['put-object', 'get-object']);
    }
    assert.throws(execute({ putError: 'PreconditionFailed', content: 'divergent content' }), /content mismatch/);
    assert.deepEqual(calls(), ['put-object', 'get-object']);
    for (const putError of ['AccessDenied', '403', 'ConditionalRequestConflict', '409', 'unknown']) {
      assert.throws(execute({ putError }), /synthetic CLI failure/);
      assert.deepEqual(calls(), ['put-object'], '403, conflito e resultado incerto não autorizam ler ou repetir a mutação');
    }
    assert.throws(execute({ putError: 'PreconditionFailed', readError: true }), /synthetic CLI failure/);
    assert.deepEqual(calls(), ['put-object', 'get-object']);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('CD temporary YAML preserves IAM policy date strings when read with YAML 1.1', () => {
  const source = { service: 'example-bridge', resources: { Resources: { Role: {
    Type: 'AWS::IAM::Role', Properties: {
      AssumeRolePolicyDocument: { Version: '2012-10-17', Statement: [] },
      Policies: [{ PolicyName: 'fixture', PolicyDocument: { Version: '2012-10-17', Statement: [] } }],
    },
  } } } };
  const restored = parse(serializePackageConfig(source), { version: '1.1' });
  assert.deepEqual(restored, source);
  assert.equal(typeof restored.resources.Resources.Role.Properties.AssumeRolePolicyDocument.Version, 'string');
});

test('CD creates a code-only candidate and preserves live roles, secrets, auth and data resources', () => {
  const live = template();
  const packaged = template();
  packaged.Resources.Configuration.Properties.SecretString = 'untrusted-package-value';
  packaged.Resources.Worker.Properties.Environment.Variables.BOOTSTRAP_MODE = 'false';
  packaged.Resources.McpRole.Properties.Policies = [{ unapproved: true }];
  const candidate = codeOnlyTemplate(live, packaged, uploaded, { commit: 'a'.repeat(40) });
  assert.deepEqual(candidate.Resources.Worker.Properties.Code, uploaded.Worker);
  assert.deepEqual(candidate.Resources.Configuration, live.Resources.Configuration);
  assert.deepEqual(candidate.Resources.McpRole, live.Resources.McpRole);
  assert.deepEqual(candidate.Resources.Worker.Properties.Environment, live.Resources.Worker.Properties.Environment);
  assert.deepEqual(candidate.Resources.Data, live.Resources.Data);
  assert.deepEqual(live, template(), 'input must remain unchanged');
});

test('CD rejects new functions, handler changes and unversioned code', () => {
  const changed = template();
  changed.Resources.NewWorker = structuredClone(changed.Resources.Worker);
  assert.throws(() => codeOnlyTemplate(template(), changed, uploaded, {}), /Lambda set changed/);
  const handler = template(); handler.Resources.Worker.Properties.Handler = 'other.handler';
  assert.throws(() => codeOnlyTemplate(template(), handler, uploaded, {}), /runtime\/handler/);
  assert.throws(() => codeOnlyTemplate(template(), template(), { Worker: { S3Bucket: 'example', S3Key: 'mutable.zip' } }, {}), /immutable/);
});

test('CD rejects invalid, placeholder and unexpected-type S3 versions without assuming an ID alphabet', () => {
  const invalid = [undefined, null, true, false, 0, 123, {}, [], new String('opaque'), '', ' ', 'null', 'NULL', 'undefined', 'placeholder', 'placeholder-version', 'validation', 'fixture-version', 'version', '<VERSION_ID>', '${VERSION_ID}', 'with space', 'with\nnewline', 'with\u0000control', 'é'.repeat(513), 'a'.repeat(1025)];
  for (const version of invalid) {
    assert.equal(validObjectVersion(version), false);
    assert.throws(() => codeOnlyTemplate(template(), template(), { Worker: { ...uploaded.Worker, S3ObjectVersion: version } }, {}), /immutable S3/);
  }
  for (const version of ['111111', 'opaque+/_-.=value', 'é'.repeat(512), 'a'.repeat(1024)]) {
    assert.equal(validObjectVersion(version), true);
    assert.doesNotThrow(() => codeOnlyTemplate(template(), template(), { Worker: { ...uploaded.Worker, S3ObjectVersion: version } }, {}));
  }
});

test('CD requires exactly three S3 Code fields with concrete string values', () => {
  const invalidCodes = [undefined, null, true, 'code', [], { ...uploaded.Worker, ImageUri: 'example.invalid/image' }, { ...uploaded.Worker, ZipFile: 'code' }];
  for (const field of ['S3Bucket', 'S3Key']) {
    for (const value of [undefined, null, true, 123, {}, [], '', '   ']) invalidCodes.push({ ...uploaded.Worker, [field]: value } as any);
  }
  for (const code of invalidCodes) assert.throws(() => codeOnlyTemplate(template(), template(), { Worker: code }, {}), /immutable S3/);
});

test('CD rejects the reserved pending-upload marker before generating a release template', () => {
  for (const version of ['PENDING_UPLOAD', `PENDING_UPLOAD__${'a'.repeat(64)}`, `pending_upload__${'b'.repeat(64)}`]) {
    assert.equal(validObjectVersion(version), false);
    assert.throws(() => codeOnlyTemplate(template(), template(), { Worker: { ...uploaded.Worker, S3ObjectVersion: version } }, {}), /immutable S3/);
  }
  assert.equal(validObjectVersion('PENDING_UPLOADotherOpaqueValue'), true, 'Only the reserved marker/prefix is excluded');
});

test('CD detects direct access, secret, retention and environment mutations', () => {
  for (const mutate of [
    (t: Obj) => { t.Resources.McpRole.Properties.Policies.push({ Action: '*' }); },
    (t: Obj) => { t.Resources.Configuration.Properties.SecretString = 'changed'; },
    (t: Obj) => { t.Resources.Data.DeletionPolicy = 'Delete'; },
    (t: Obj) => { t.Resources.Worker.Properties.Environment.Variables.BOOTSTRAP_MODE = 'false'; },
    (t: Obj) => { t.Outputs = { leak: { Value: 'unexpected' } }; },
    (t: Obj) => { t.Metadata = { unexpected: 'changed' }; },
  ]) {
    const modified = template(); mutate(modified);
    assert.throws(() => assertCodeOnly(template(), modified), /only existing Lambda code/);
  }
});

test('CD distinguishes a missing change set from denied or uncertain AWS reads', () => {
  assert.equal(awsErrorCode('An error occurred (ChangeSetNotFound) when calling the DescribeChangeSet operation: absent'), 'NotFound');
  assert.equal(awsErrorCode('An error occurred (404) when calling the HeadObject operation: Not Found'), 'NotFound');
  assert.equal(awsErrorCode('An error occurred (AccessDenied) when calling the GetObject operation: denied'), 'AccessDenied');
  assert.equal(awsErrorCode('An error occurred (ExpiredToken) when calling the DescribeChangeSet operation: expired'), 'ExpiredToken');
  assert.equal(awsErrorCode('Connection timed out'), undefined);
});

test('CD change-set inspection allows only existing static Code modifications', () => {
  assert.doesNotThrow(() => assertSafeChangeSet(changeSet(), ['Worker']));
  const modifications = [
    (c: Obj) => { c.Changes[0].ResourceChange.Action = 'Add'; },
    (c: Obj) => { c.Changes[0].ResourceChange.ResourceType = 'AWS::IAM::Role'; },
    (c: Obj) => { c.Changes[0].ResourceChange.Replacement = 'Conditional'; },
    (c: Obj) => { c.Changes[0].ResourceChange.Details[0].Target.Name = 'Environment'; },
    (c: Obj) => { c.Changes[0].ResourceChange.Details[0].Evaluation = 'Dynamic'; },
    (c: Obj) => { c.Changes[0].ResourceChange.Details = []; },
  ];
  for (const mutate of modifications) { const changed = changeSet(); mutate(changed); assert.throws(() => assertSafeChangeSet(changed, ['Worker'])); }
  assert.throws(() => assertSafeChangeSet(changeSet(), ['AnotherWorker']));
});

test('CD rejects repeated logical resource IDs while accepting a changed subset of allowed Lambdas', () => {
  assert.doesNotThrow(() => assertSafeChangeSet(changeSet(), ['Worker', 'UnchangedWorker']));
  const repeated = changeSet();
  repeated.Changes.push(structuredClone(repeated.Changes[0]));
  assert.throws(() => assertSafeChangeSet(repeated, ['Worker', 'UnchangedWorker']), /Duplicate logical resource ID/);
});

test('CD always requests property-level change-set details and keeps dependent access changes forbidden', () => {
  assert.deepEqual(describeChangeSetArgs('example-stack', 'example-release'), ['cloudformation', 'describe-change-set', '--stack-name', 'example-stack', '--change-set-name', 'example-release', '--include-property-values']);
  const dependentRole = changeSet();
  dependentRole.Changes.push({ ResourceChange: { Action: 'Modify', LogicalResourceId: 'McpRole', ResourceType: 'AWS::IAM::Role', Replacement: 'False', Scope: ['Properties'], Details: [{ Target: { Attribute: 'Properties', Name: 'Policies', RequiresRecreation: 'Never' }, Evaluation: 'Dynamic' }] } });
  assert.throws(() => assertSafeChangeSet(dependentRole, ['Worker']), /infrastructure or access/);
});

test('CD pending state recovers successful or in-flight deployment and fails closed on rollback/drift', () => {
  const state = { templateDigest: 'before', pending: { templateDigest: 'after' } };
  assert.equal(pendingOutcome(state, { StackStatus: 'UPDATE_COMPLETE' }, 'after', { ExecutionStatus: 'EXECUTE_COMPLETE' }), 'commit');
  assert.equal(pendingOutcome(state, { StackStatus: 'UPDATE_IN_PROGRESS' }, 'after', {}), 'wait');
  assert.equal(pendingOutcome(state, { StackStatus: 'UPDATE_COMPLETE' }, 'before', { ExecutionStatus: 'AVAILABLE' }), 'execute');
  assert.throws(() => pendingOutcome(state, { StackStatus: 'UPDATE_ROLLBACK_COMPLETE' }, 'before', { ExecutionStatus: 'EXECUTE_COMPLETE' }), /reconciliation/);
  assert.throws(() => pendingOutcome(state, { StackStatus: 'UPDATE_COMPLETE' }, 'unrelated', { ExecutionStatus: 'AVAILABLE' }), /reconciliation/);
});

test('CD processes grouped commits after a reviewed first-parent baseline, skips stale targets, rejects rewritten history', () => {
  const repo = mkdtempSync(join(tmpdir(), 'bridge-cd-git-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const commit = (value: string) => { writeFileSync(join(repo, 'fixture.txt'), value); git('add', 'fixture.txt'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', value); return git('rev-parse', 'HEAD'); };
  try {
    git('init', '-b', 'master');
    const baseline = commit('baseline'); const one = commit('one'); const two = commit('two');
    assert.deepEqual(commitsAfterBaseline(repo, baseline, two), [one, two]);
    assert.deepEqual(commitsAfterBaseline(repo, two, one), []);
    git('checkout', '-b', 'divergent', baseline); const divergent = commit('divergent');
    assert.throws(() => commitsAfterBaseline(repo, two, divergent), /Non-fast-forward/);
    assert.throws(() => commitsAfterBaseline(repo, 'master', two), /Full Git commit/);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('CD private configuration allows references only and rejects unknown secret-value fields', () => {
  const config: Obj = { schemaVersion: 1, region: 'us-east-1', stage: 'production', stackName: 'example-bridge-production', cloudFormationRoleArn: 'arn:aws:iam::123456789012:role/example-execution', artifactBucket: 'example-private-releases', artifactPrefix: 'releases', stateKey: 'state/production.json', serverlessParams: { serviceName: 'example-bridge', installationId: 'example', mcpConfigSecretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:example/mcp-AbCdEf', ingressConfigSecretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:example/ingress-AbCdEf', historyConfigSecretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:example/history-AbCdEf', deliveryConfigSecretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:example/delivery-AbCdEf', oauthIssuer: 'https://identity.example', oauthAudience: 'bridge', oauthJwksUrl: 'https://identity.example/jwks', publicBaseUrl: 'https://bridge.example' } };
  assert.doesNotThrow(() => validateConfig(config));
  assert.throws(() => validateConfig({ ...config, webhookToken: 'fixture' }), /Unsupported/);
  assert.throws(() => validateConfig({ ...config, serverlessParams: { ...config.serverlessParams, mcpConfigSecretArn: 'fixture-token' } }), /references/);
  assert.throws(() => validateConfig({ ...config, stateKey: 'releases/state.json' }), /outside immutable/);
});

test('CI/CD workflows are pinned, production-only, disabled by default, and do not publish private artifacts', () => {
  const ci = parse(readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'));
  const deploy = parse(readFileSync(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8'));
  assert.deepEqual(ci.on.push.branches, ['master']);
  assert.ok('pull_request' in ci.on);
  assert.equal(ci.permissions['id-token'], undefined);
  assert.match(deploy.jobs.deploy.if, /vars.ENABLE_PRODUCTION_CD == 'true'/);
  assert.match(deploy.jobs.deploy.if, /refs\/heads\/master/);
  assert.equal(deploy.jobs.deploy.environment, 'production');
  assert.deepEqual(deploy.concurrency, { group: 'production', 'cancel-in-progress': false, queue: 'max' });
  assert.equal(deploy.jobs.deploy.permissions['id-token'], 'write');
  const deploySteps = deploy.jobs.deploy.steps as Obj[];
  const awsStep = deploySteps.find(step => step.uses?.startsWith('aws-actions/configure-aws-credentials@'))!;
  assert.equal(awsStep.with['role-to-assume'], '${{ secrets.AWS_DEPLOY_ROLE_ARN }}');
  assert.equal(awsStep.with['allowed-account-ids'], '${{ secrets.AWS_ACCOUNT_ID }}');
  assert.equal(awsStep.with['mask-aws-account-id'], true);
  const deployment = deploySteps.find(step => step.run === 'node scripts/ci-deploy.mjs')!;
  assert.equal(deployment.env.BRIDGE_CD_CONFIG_URI, '${{ secrets.BRIDGE_CD_CONFIG_URI }}');
  assert.equal(deployment.env.BRIDGE_CD_CONFIG_VERSION, '${{ secrets.BRIDGE_CD_CONFIG_VERSION }}');
  for (const workflow of [ci, deploy]) {
    for (const job of Object.values(workflow.jobs) as Obj[]) {
      const steps = job.steps as Obj[];
      for (const step of steps.filter(step => step.uses)) { assert.match(step.uses, /@[a-f0-9]{40}$/); assert.doesNotMatch(step.uses, /upload-artifact/); }
      assert.ok(steps.some(step => step.run === 'npm ci --ignore-scripts'));
      assert.ok(steps.some(step => step.run === 'npm run check'));
      assert.ok(steps.some(step => step.run === 'npm run demo'));
    }
  }
  assert.equal(digest({ b: 2, a: 1 }), digest({ a: 1, b: 2 }));
});

test('CD mascara RoleId e nome antes da action; entrada inválida falha sem emitir valores', () => {
  const workflow = parse(readFileSync(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8'));
  const steps = workflow.jobs.deploy.steps as Obj[];
  const maskIndex = steps.findIndex(step => step.id === 'mask-deployment-identity');
  const awsIndex = steps.findIndex(step => step.uses?.startsWith('aws-actions/configure-aws-credentials@'));
  assert.ok(maskIndex >= 0 && maskIndex < awsIndex);
  const masker = steps[maskIndex];
  assert.ok(masker);
  assert.equal(masker.env.AWS_DEPLOY_ROLE_ARN, '${{ secrets.AWS_DEPLOY_ROLE_ARN }}');
  assert.equal(masker.env.AWS_DEPLOY_ROLE_ID, '${{ secrets.AWS_DEPLOY_ROLE_ID }}');
  const roleId = `AROA${'A'.repeat(17)}`;
  const roleName = 'example-deployment';
  const arn = `arn:aws:iam::123456789012:role/example/path/${roleName}`;
  const execute = (roleArn: string, identity: string) => spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', masker.run], {
    encoding: 'utf8', env: { PATH: process.env.PATH, AWS_DEPLOY_ROLE_ARN: roleArn, AWS_DEPLOY_ROLE_ID: identity },
  });
  const valid = execute(arn, roleId);
  assert.equal(valid.status, 0);
  assert.equal(valid.stderr, '');
  // O runner consome esses comandos; não há saída humana com os identificadores.
  assert.deepEqual(valid.stdout.trim().split('\n'), [`::add-mask::${roleId}`, `::add-mask::${roleName}`]);
  let statusLog = `Authenticated as assumedRoleId ${roleId}:GitHubActions; assumed-role/${roleName}/GitHubActions`;
  for (const command of valid.stdout.trim().split('\n')) statusLog = statusLog.replaceAll(command.slice('::add-mask::'.length), '***');
  assert.equal(statusLog.includes(roleId) || statusLog.includes(roleName), false);
  for (const [roleArn, identity] of [[arn, ''], ['', roleId], [arn, `${roleId}\n::error::fixture`], [arn, 'invalid-fixture'], [`${arn}\nfixture`, roleId]] as [string, string][]) {
    const invalid = execute(roleArn, identity);
    assert.equal(invalid.status, 1);
    assert.equal(invalid.stdout, '');
    assert.match(invalid.stderr, /Missing or invalid private deployment identity/);
    for (const marker of [roleId, roleName, '123456789012', '::error::fixture', 'invalid-fixture']) assert.equal(invalid.stderr.includes(marker), false);
  }
});

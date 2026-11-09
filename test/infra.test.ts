import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'yaml';

type Obj = Record<string, any>;
const manifest = parse(readFileSync(new URL('../serverless.yml', import.meta.url), 'utf8')) as Obj;
const resources = manifest.resources.Resources as Obj;
const statements = (name: string, all: Obj = resources): Obj[] => all[name].Properties.Policies.flatMap((p: Obj) => p.PolicyDocument.Statement);
const actionList = (statement: Obj): string[] => Array.isArray(statement.Action) ? statement.Action : [statement.Action];
const actions = (name: string): string[] => statements(name).flatMap(actionList);
const require = createRequire(import.meta.url);
const { validateDeployment }: { validateDeployment: (config: Obj) => void } = require('../scripts/deployment-preflight.cjs');

const namespaceContract: Record<string, Record<string, string[]>> = {
  McpRole: {GetItem:['meta','history','claims','dedup','rate','subscriptions','subscription-secrets','inbox'],Query:['history','inbox','outbox'],PutItem:['meta','history','claims','dedup','rate','outbox','inbox','subscriptions','subscription-secrets'],DeleteItem:['inbox']},
  IngressRole: {GetItem:['meta','history','claims','dedup','rate','subscriptions','inbox'],Query:['history','inbox','outbox'],PutItem:['meta','history','claims','dedup','rate','outbox','inbox','callback'],DeleteItem:['inbox']},
  HistoryRole: {GetItem:['meta'],Query:['history']},
  DeliveryRole: {GetItem:['outbox','claims','subscriptions','subscription-secrets'],PutItem:['outbox']},
};
const logGroups: Record<string,string> = {McpRole:'BridgeLogGroup',IngressRole:'IngressLogGroup',HistoryRole:'HistoryLogGroup',DeliveryRole:'DeliveryLogGroup',StreamRole:'StreamWakeLogGroup',SweepRole:'SweepLogGroup'};
const secretParams: Record<string,string> = {McpRole:'mcpConfigSecretArn',IngressRole:'ingressConfigSecretArn',HistoryRole:'historyConfigSecretArn',DeliveryRole:'deliveryConfigSecretArn'};

function assertDataIsolation(all: Obj, installationId: string) {
  for (const [role, contract] of Object.entries(namespaceContract)) {
    const data = statements(role, all).filter(s => actionList(s).some(a => a.startsWith('dynamodb:')));
    assert.equal(data.length, Object.keys(contract).length, `${role} must not have additional table grants`);
    for (const statement of data) {
      assert.equal(actionList(statement).length, 1, 'Read and write operations need distinct namespace boundaries');
      const action = statement.Action.replace('dynamodb:', '');
      assert.ok(contract[action], `${role} must not grant ${action}`);
      assert.deepEqual(statement.Resource, {'Fn::GetAtt':['BridgeTable','Arn']});
      assert.deepEqual(statement.Condition['ForAllValues:StringLike']['dynamodb:LeadingKeys'], contract[action]!.map(ns => `${installationId}#${ns}#*`));
      assert.equal(statement.Condition.Null['dynamodb:LeadingKeys'], 'false');
      if (action === 'PutItem' || action === 'DeleteItem') assert.deepEqual(statement.Condition['ForAnyValue:StringEquals']['dynamodb:EnclosingOperation'], ['TransactWriteItems']);
    }
  }
  for (const [role, group] of Object.entries(logGroups)) {
    const logging = statements(role, all).filter(s => actionList(s).some(a => a.startsWith('logs:')));
    assert.equal(logging.length, 1);
    assert.deepEqual(logging[0]!.Resource, {'Fn::GetAtt':[group,'Arn']});
    assert.deepEqual(actionList(logging[0]!), ['logs:CreateLogStream','logs:PutLogEvents']);
  }
  const sweep = statements('SweepRole', all).filter(s => actionList(s).some(a => a.startsWith('dynamodb:')));
  assert.equal(sweep.length, 1);
  assert.equal(sweep[0]!.Action, 'dynamodb:Query');
  assert.deepEqual(sweep[0]!.Resource, {'Fn::Sub':'${BridgeTable.Arn}/index/due-index'});
  assert.equal(sweep[0]!.Condition.StringEquals['dynamodb:Select'], 'SPECIFIC_ATTRIBUTES');
  assert.deepEqual(sweep[0]!.Condition['ForAllValues:StringEquals']['dynamodb:Attributes'], ['pk','sk','dueAt','duePk']);
  assert.equal(sweep[0]!.Condition.Null['dynamodb:Attributes'], 'false');
}

function assertSchedulerRoles(all: Obj) {
  const schedule = all.RecoverySchedule.Properties;
  assert.deepEqual(schedule.GroupName, {Ref:'RecoveryScheduleGroup'});
  const role = all[schedule.Target.RoleArn['Fn::GetAtt'][0]].Properties;
  const trust = role.AssumeRolePolicyDocument.Statement.find((s: Obj) => s.Principal?.Service === 'scheduler.amazonaws.com');
  assert.ok(trust);
  assert.deepEqual(trust.Condition.ArnEquals['aws:SourceArn'], {'Fn::GetAtt':['RecoveryScheduleGroup','Arn']});
  assert.deepEqual(trust.Condition.StringEquals['aws:SourceAccount'], {Ref:'AWS::AccountId'});
  const policies = role.Policies.flatMap((p: Obj) => p.PolicyDocument.Statement);
  assert.equal(policies.length, 1);
  assert.equal(policies[0].Action, 'lambda:InvokeFunction');
  assert.deepEqual(policies[0].Resource, schedule.Target.Arn);
}

test('history and secrets cannot be exposed through the stream or due index', () => {
  const table = resources.BridgeTable;
  assert.equal(table.DeletionPolicy, 'Retain');
  assert.equal(table.UpdateReplacePolicy, 'Retain');
  assert.equal(table.Properties.TimeToLiveSpecification, undefined);
  assert.equal(table.Properties.PointInTimeRecoverySpecification.PointInTimeRecoveryEnabled, true);
  assert.equal(table.Properties.SSESpecification.SSEEnabled, true);
  assert.equal(table.Properties.GlobalSecondaryIndexes[0].IndexName, 'due-index');
  assert.deepEqual(table.Properties.GlobalSecondaryIndexes[0].Projection, {ProjectionType:'KEYS_ONLY'});
  assert.equal(table.Properties.StreamSpecification.StreamViewType, 'KEYS_ONLY');
  assert.deepEqual(manifest.functions.streamWake.events[0].stream.filterPatterns, [{eventName:['INSERT']}]);
});

test('IAM limits every data action to its installation and permitted namespaces', () => {
  assertDataIsolation(resources, '${param:installationId}');
  for (const [name, resource] of Object.entries(resources) as [string, Obj][]) {
    if (resource.Type !== 'AWS::IAM::Role') continue;
    for (const statement of statements(name)) {
      assert.ok(actionList(statement).every(a => !a.includes('*')), `${name}: wildcard action`);
      if (statement.Resource === '*') assert.deepEqual(actionList(statement), ['dynamodb:ListStreams']);
      if (statement.Action === 'secretsmanager:GetSecretValue') assert.equal(statement.Resource, '${param:' + secretParams[name] + '}');
    }
  }
  assert.ok(!actions('DeliveryRole').includes('dynamodb:Query'));
  assert.ok(!actions('SweepRole').includes('dynamodb:GetItem'));
  assert.ok(!actions('StreamRole').includes('dynamodb:GetItem'));
});

test('each secret-bearing runtime has a distinct reference; stream and sweep inherit none', () => {
  assert.equal(manifest.provider.environment.CONFIG_SECRET_ARN, undefined);
  const refs = [manifest.mcp.servers.bridge.environment.CONFIG_SECRET_ARN, ...['ingress','history','delivery'].map(name => manifest.functions[name].environment.CONFIG_SECRET_ARN)];
  assert.equal(new Set(refs).size, 4);
  assert.equal(manifest.functions.streamWake.environment.CONFIG_SECRET_ARN, undefined);
  assert.equal(manifest.functions.sweep.environment.CONFIG_SECRET_ARN, undefined);
});

test('preflight rejects wildcard installation IDs, duplicated secrets and secret inheritance', () => {
  const fixture: Obj = structuredClone(manifest);
  fixture.provider.environment.INSTALLATION_ID = 'fixture';
  fixture.mcp.servers.bridge.environment.CONFIG_SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:111111111111:secret:fixture-mcp-abcdef';
  for (const name of ['ingress','history','delivery']) fixture.functions[name].environment.CONFIG_SECRET_ARN = `arn:aws:secretsmanager:us-east-1:111111111111:secret:fixture-${name}-abcdef`;
  assert.doesNotThrow(() => validateDeployment(fixture));
  for (const invalid of ['*','#','fixture#history','fixture?','', 'x'.repeat(101)]) {
    const bad = structuredClone(fixture); bad.provider.environment.INSTALLATION_ID = invalid;
    assert.throws(() => validateDeployment(bad), /installationId/);
  }
  const duplicate = structuredClone(fixture); duplicate.functions.history.environment.CONFIG_SECRET_ARN = fixture.functions.delivery.environment.CONFIG_SECRET_ARN;
  assert.throws(() => validateDeployment(duplicate), /four distinct/);
  const inherited = structuredClone(fixture); inherited.provider.environment.CONFIG_SECRET_ARN = fixture.functions.delivery.environment.CONFIG_SECRET_ARN;
  assert.throws(() => validateDeployment(inherited), /inherited/);
});

test('queue recovery and scheduler use bounded delivery with a dedicated invocation role', () => {
  for (const queue of ['OutboxQueue','DeliveryFailureQueue','StreamFailureQueue']) assert.equal(resources[queue].Properties.SqsManagedSseEnabled, true);
  assert.ok(resources.OutboxQueue.Properties.VisibilityTimeout >= 6 * manifest.functions.delivery.timeout);
  assert.ok(resources.DeliveryFailureQueue.Properties.MessageRetentionPeriod > resources.OutboxQueue.Properties.MessageRetentionPeriod);
  assert.equal(manifest.functions.delivery.events[0].sqs.functionResponseType, 'ReportBatchItemFailures');
  assert.ok(manifest.functions.delivery.reservedConcurrency >= manifest.functions.delivery.events[0].sqs.maximumConcurrency);
  assertSchedulerRoles(resources);
});

test('dead-delivery and DLQ alarms share an optional operator-approved destination without provisioning notification access',()=>{
  const actions={'Fn::If':['HasAlarmTopic',["${param:alarmTopicArn, ''}"],[]]};
  for(const name of ['DeliveryDlqAlarm','StreamDlqAlarm','DeadDeliveryAlarm'])assert.deepEqual(resources[name].Properties.AlarmActions,actions);
  assert.equal(resources.DeadDeliveryAlarm.Properties.MetricName,'DeadDelivery');
  assert.deepEqual(resources.DeadDeliveryAlarm.Properties.Dimensions,[{Name:'FunctionName',Value:{Ref:'DeliveryLambdaFunction'}}]);
  assert.equal(Object.values(resources).some((r:any)=>r.Type==='AWS::SNS::Topic'||r.Type==='AWS::SNS::Subscription'),false);
  for(const name of ['OldPendingAlarm','UnconfirmedProcessingAlarm','DeadBacklogAlarm','SubscriptionHealthAlarm','ProcessingMonitorMissingAlarm']) {
    assert.equal(resources[name].Condition,name==='UnconfirmedProcessingAlarm'?'HasProcessingClaimsMonitor':'HasProcessingMonitor');
    assert.deepEqual(resources[name].Properties.AlarmActions,actions);
    assert.deepEqual(resources[name].Properties.Dimensions,[{Name:'Monitor',Value:"${param:processingMonitorName, ''}"}]);
  }
  assert.equal(resources.ProcessingMonitorMissingAlarm.Properties.TreatMissingData,'breaching');
  assert.deepEqual(manifest.resources.Conditions.HasProcessingClaimsMonitor,{'Fn::And':[{Condition:'HasProcessingMonitor'},{'Fn::Equals':["${param:processingClaimsExpected, 'false'}",'true']}]});
});

test('deployment archive excludes local secrets, histories, examples and preflight source', () => {
  for (const required of ['!.private/**','!.env*','!**/*.sqlite*','!**/*.pem','!**/*.key','!.git/**','!examples/**','!scripts/**']) assert.ok(manifest.package.patterns.includes(required));
  assert.equal(manifest.provider.logs, undefined);
  assert.ok(manifest.plugins.includes('./scripts/deployment-preflight.cjs'));
});

const compiledPath = new URL('../.serverless/cloudformation-template-update-stack.json', import.meta.url);
test('compiled CloudFormation preserves isolation and omits scheduler secrets', {skip: !existsSync(compiledPath)}, () => {
  const all = JSON.parse(readFileSync(compiledPath, 'utf8')).Resources;
  const installationId = all.BridgeLambdaFunction.Properties.Environment.Variables.INSTALLATION_ID;
  assert.ok(installationId);
  assertDataIsolation(all, installationId);
  assertSchedulerRoles(all);
  for (const functionName of ['StreamWakeLambdaFunction','SweepLambdaFunction']) assert.equal(all[functionName].Properties.Environment.Variables.CONFIG_SECRET_ARN, undefined);
  const refs = ['BridgeLambdaFunction','IngressLambdaFunction','HistoryLambdaFunction','DeliveryLambdaFunction'].map(name => all[name].Properties.Environment.Variables.CONFIG_SECRET_ARN);
  assert.equal(new Set(refs).size, 4);
});

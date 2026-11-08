/** Operator smoke test for a separately approved, already-deployed bootstrap stack.
 * No OAuth clients, credentials, grants, configuration secrets or public messages
 * are created. Never run this script merely to package or test the repository.
 *
 * Required: AWS_ACCOUNT_ID, TABLE_NAME, INSTALLATION_ID, AWS_REGION, LAMBDA_STREAM_NAME,
 * LAMBDA_DELIVERY_NAME, LAMBDA_SWEEP_NAME. Invoke with an explicit --execute.
 * Uses existing SDK/CLI AWS credentials. Evidence is written only under .private.
 * Fixture records are preserved; this script never deletes table records.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { DescribeTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { GetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';
import { Bridge } from '../src/bridge.js';
import { DynamoStore } from '../src/dynamo-store.js';
import { Conflict, type Key, type Store, type Write } from '../src/store.js';
import { tenantKey, type Delivery, type Principal } from '../src/types.js';

const executeFile=promisify(execFile);
const identifier=/^[A-Za-z0-9_-]{1,100}$/;
export interface SmokeOptions {
  accountId:string; tableName:string; installationId:string; region:string;
  streamFunction:string; deliveryFunction:string; sweepFunction:string; waitMs:number;
}
export function smokeOptions(args:string[],environment:Record<string,string|undefined>):SmokeOptions {
  if(args.length!==1||args[0]!=='--execute')throw new Error('explicit_execute_required');
  const required=(name:string)=>{const value=environment[name];if(!value||value.trim()!==value)throw new Error('missing_smoke_target');return value;};
  const accountId=required('AWS_ACCOUNT_ID'),tableName=required('TABLE_NAME'),installationId=required('INSTALLATION_ID'),region=required('AWS_REGION');
  const streamFunction=required('LAMBDA_STREAM_NAME'),deliveryFunction=required('LAMBDA_DELIVERY_NAME'),sweepFunction=required('LAMBDA_SWEEP_NAME');
  if(!/^\d{12}$/.test(accountId)||!/^[A-Za-z0-9_.-]{3,255}$/.test(tableName)||!identifier.test(installationId)||!/^[a-z]{2,8}(?:-[a-z]+)+-\d+$/.test(region))throw new Error('invalid_smoke_target');
  if([streamFunction,deliveryFunction,sweepFunction].some(value=>!/^[A-Za-z0-9_-]{1,64}$/.test(value)))throw new Error('invalid_smoke_function_name');
  if(new Set([streamFunction,deliveryFunction,sweepFunction]).size!==3)throw new Error('distinct_smoke_functions_required');
  const waitMs=Number(environment.AWS_SMOKE_WAIT_MS??45000);
  if(!Number.isSafeInteger(waitMs)||waitMs<1000||waitMs>180000)throw new Error('invalid_smoke_wait');
  return {accountId,tableName,installationId,region,streamFunction,deliveryFunction,sweepFunction,waitMs};
}
export interface OperatorEvidence {
  conversationId:string; messageIds:string[]; correlationId:string;
  principalIds:string[]; outboxKeys:Key[]; historyCount:number;
}
/** Runs application rules directly with the operator's store, not deployed MCP IAM. */
export async function operatorChecks(store:Store,installationId:string,runId:string):Promise<OperatorEvidence> {
  if(!identifier.test(installationId)||!/^smoke_[A-Za-z0-9_-]{1,60}$/.test(runId))throw new Error('invalid_smoke_fixture');
  const alpha:Principal={id:`${runId}_alpha`,tenant:installationId,scopes:['messages:send','messages:read','messages:claim'],peers:[`${runId}_beta`]};
  const beta:Principal={...alpha,id:`${runId}_beta`,peers:[alpha.id]};
  const reader:Principal={id:`${runId}_reader`,tenant:installationId,scopes:['history:read'],peers:[],readParticipants:[alpha.id]};
  const bridge=new Bridge(store,{maxTurns:20,messagesPerMinute:30,claimMs:120000,webhookRecipients:[`${installationId}:${beta.id}`]});
  const conversationId=`${runId}_conversation`,requestId=`${runId}_request`,responseId=`${runId}_response`;
  const request={id:requestId,conversationId,recipient:beta.id,text:'Synthetic infrastructure smoke request.'};
  const sent=await Promise.all(Array.from({length:4},()=>bridge.send(alpha,request)));
  assert.equal(sent.filter(result=>!result.duplicate).length,1,'duplicate_publication');
  assert.ok(sent.every(result=>result.message.id===requestId),'message_identity_changed');
  const claims=await Promise.all(Array.from({length:4},()=>bridge.claim(beta,conversationId,requestId)));
  const winner=claims.find(claim=>claim.status==='claimed');
  assert.equal(claims.filter(claim=>claim.status==='claimed').length,1,'multiple_claim_owners');
  if(!winner||winner.status!=='claimed')throw new Error('claim_missing');
  const reply={id:responseId,conversationId,recipient:alpha.id,text:'Synthetic infrastructure smoke response.',replyTo:requestId,fence:winner.fence};
  await assert.rejects(bridge.complete(beta,{...reply,fence:winner.fence+1}),{code:'stale_claim'});
  assert.equal((await bridge.history(reader,conversationId,10)).messages.length,1,'invalid_fence_published');
  const completed=await Promise.all(Array.from({length:3},()=>bridge.complete(beta,reply)));
  assert.equal(completed.filter(result=>!result.duplicate).length,1,'duplicate_response');
  assert.equal((await bridge.claim(beta,conversationId,requestId)).status,'done','claim_not_completed');
  const extraIds=[`${runId}_parallel_a`,`${runId}_parallel_b`];
  await Promise.all(extraIds.map(id=>bridge.send(alpha,{...request,id,text:'Synthetic concurrent smoke message.'})));
  const history=(await bridge.history(reader,conversationId,10)).messages;
  assert.equal(history.length,4,'history_count');
  assert.deepEqual(history.map(message=>message.turn),[1,2,3,4],'history_order');
  assert.ok(history.every(message=>message.correlationId===requestId),'correlation_changed');
  const rollbackKey={pk:tenantKey(installationId,'meta',`${runId}_rollback`),sk:'meta'};
  await assert.rejects(store.commit([
    {...rollbackKey,expected:null,value:{fixture:runId}},
    {pk:tenantKey(installationId,'history',conversationId),sk:`id#${requestId}`,expected:null,value:{fixture:runId}},
  ]),Conflict);
  assert.equal(await store.get(rollbackKey),undefined,'partial_transaction_committed');
  const outbox=await store.query<Delivery>(tenantKey(installationId,'outbox',beta.id),'',10);
  assert.equal(outbox.items.length,3,'outbox_count');
  assert.ok(outbox.items.every(row=>!('text' in row.value.message)),'outbox_contains_message_body');
  return {conversationId,messageIds:[requestId,responseId,...extraIds],correlationId:requestId,
    principalIds:[alpha.id,beta.id,reader.id],outboxKeys:outbox.items.map(({pk,sk})=>({pk,sk})),historyCount:history.length};
}

/** Requeue only an exact, run-owned bootstrap fixture; this produces MODIFY. */
export async function requeueFixture(store:Store,key:Key,evidence:OperatorEvidence,now=Date.now()):Promise<number> {
  if(!evidence.outboxKeys.some(owned=>owned.pk===key.pk&&owned.sk===key.sk))throw new Error('foreign_smoke_key');
  const row=await store.get<Delivery>(key);
  if(!row||row.value.status!=='dead'||row.value.lastError!=='integration_not_configured'||row.value.attempts!==0)throw new Error('fixture_not_bootstrap_terminal');
  if(row.value.message.conversationId!==evidence.conversationId||!evidence.messageIds.includes(row.value.message.id))throw new Error('fixture_identity_mismatch');
  await store.commit([{...key,expected:row.version,value:{...row.value,status:'pending',lastError:undefined,attempts:0,leaseUntil:0,fence:row.value.fence+1},dueAt:now}]);
  return row.version+1;
}

interface LambdaConfiguration { FunctionArn?:string; State?:string; LastUpdateStatus?:string; Environment?:{Variables?:Record<string,string>} }
interface Mapping { UUID?:string; State?:string; EventSourceArn?:string }
async function cliJson(region:string,args:string[]):Promise<Record<string,unknown>> {
  try {
    const {stdout}=await executeFile('aws',[...args,'--region',region,'--output','json','--no-cli-pager'],{
      timeout:45000,maxBuffer:2*1024*1024,env:{...process.env,AWS_PAGER:''},
    });
    return JSON.parse(stdout) as Record<string,unknown>;
  } catch {throw new Error('aws_cli_operation_failed');}
}
async function ready(options:SmokeOptions,client:DynamoDBClient) {
  const identity=await cliJson(options.region,['sts','get-caller-identity']);
  if(identity.Account!==options.accountId)throw new Error('operator_account_mismatch');
  const table=(await client.send(new DescribeTableCommand({TableName:options.tableName}))).Table;
  if(!table||table.TableStatus!=='ACTIVE'||table.StreamSpecification?.StreamViewType!=='KEYS_ONLY'||!table.LatestStreamArn)throw new Error('table_not_ready_or_wrong_schema');
  assertTargetArn(table.TableArn,'dynamodb',options,`table/${options.tableName}`);
  if(!table.LatestStreamArn.startsWith(`${table.TableArn}/stream/`))throw new Error('stream_target_mismatch');
  if(table.KeySchema?.length!==2||!table.KeySchema.some(key=>key.AttributeName==='pk'&&key.KeyType==='HASH')||!table.KeySchema.some(key=>key.AttributeName==='sk'&&key.KeyType==='RANGE'))throw new Error('table_not_ready_or_wrong_schema');
  const index=table.GlobalSecondaryIndexes?.find(item=>item.IndexName==='due-index');
  if(index?.IndexStatus!=='ACTIVE'||index.Projection?.ProjectionType!=='KEYS_ONLY'||!index.KeySchema?.some(key=>key.AttributeName==='duePk'&&key.KeyType==='HASH')||!index.KeySchema.some(key=>key.AttributeName==='dueAt'&&key.KeyType==='RANGE'))throw new Error('due_index_not_ready_or_wrong_schema');
  for(const [name,kind] of [[options.streamFunction,'stream'],[options.deliveryFunction,'delivery'],[options.sweepFunction,'sweep']] as const){
    const configuration=await cliJson(options.region,['lambda','get-function-configuration','--function-name',name]) as LambdaConfiguration;
    assertTargetArn(configuration.FunctionArn,'lambda',options,`function:${name}`);
    if(configuration.State!=='Active'||configuration.LastUpdateStatus!=='Successful')throw new Error('function_not_ready');
    const env=configuration.Environment?.Variables;
    if(env?.TABLE_NAME!==options.tableName||env?.INSTALLATION_ID!==options.installationId)throw new Error('function_target_mismatch');
    if(kind==='delivery'&&env.BOOTSTRAP_MODE!=='true')throw new Error('bootstrap_delivery_required');
  }
  const streamConfig=await cliJson(options.region,['lambda','get-function-configuration','--function-name',options.streamFunction]) as LambdaConfiguration;
  const queueUrl=streamConfig.Environment?.Variables?.OUTBOX_QUEUE_URL;
  if(!queueUrl)throw new Error('outbox_queue_missing');
  const queue=(await new SQSClient({region:options.region}).send(new GetQueueAttributesCommand({QueueUrl:queueUrl,AttributeNames:['QueueArn']}))).Attributes?.QueueArn;
  if(!queue)throw new Error('outbox_queue_missing');
  assertTargetArn(queue,'sqs',options);
  const stream=(await cliJson(options.region,['lambda','list-event-source-mappings','--function-name',options.streamFunction])).EventSourceMappings as Mapping[]|undefined;
  const delivery=(await cliJson(options.region,['lambda','list-event-source-mappings','--function-name',options.deliveryFunction])).EventSourceMappings as Mapping[]|undefined;
  const streamMapping=stream?.find(item=>item.State==='Enabled'&&item.EventSourceArn===table.LatestStreamArn);
  const deliveryMapping=delivery?.find(item=>item.State==='Enabled'&&item.EventSourceArn===queue);
  if(!streamMapping||!deliveryMapping)throw new Error('deployed_event_mapping_not_ready');
  return {tableArn:table.TableArn,streamArn:table.LatestStreamArn,queueArn:queue,
    streamMappingId:streamMapping.UUID,deliveryMappingId:deliveryMapping.UUID};
}
/** Reject same-named resources in a different account/region before any write. */
export function assertTargetArn(arn:string|undefined,service:string,options:Pick<SmokeOptions,'accountId'|'region'>,resource?:string):void {
  const parts=arn?.split(':');
  if(!parts||parts.length<6||parts[0]!=='arn'||!/^aws(?:-[a-z-]+)?$/.test(parts[1]!)||parts[2]!==service||parts[3]!==options.region||parts[4]!==options.accountId||!parts.slice(5).join(':')||(resource!==undefined&&parts.slice(5).join(':')!==resource))throw new Error('resource_account_or_region_mismatch');
}
async function until(check:()=>Promise<boolean>,waitMs:number,phase:string):Promise<void> {
  const deadline=Date.now()+waitMs;
  while(Date.now()<deadline){if(await check())return;await new Promise(resolve=>setTimeout(resolve,1000));}
  throw new Error(`${phase}_timeout`);
}
async function terminal(store:Store,key:Key,waitMs:number,minimumVersion=0) {
  await until(async()=>{
    const row=await store.get<Delivery>(key);
    if(!row)return false;
    if(row.value.attempts!==0)throw new Error('unexpected_outbound_attempt');
    if(row.value.status==='dead'){
      if(row.value.lastError!=='integration_not_configured')throw new Error('unexpected_terminal_delivery');
      return row.version>minimumVersion;
    }
    if(row.value.status!=='pending')throw new Error('unexpected_delivery_status');
    return false;
  },waitMs,'bootstrap_delivery');
}
/** Active dispatchers can finish the fixture before the eventual GSI exposes it. */
export async function observeRequeuedFixture(store:Store,key:Key,minimumVersion:number,waitMs:number):Promise<'due_index'|'already_terminal'> {
  let observation:'due_index'|'already_terminal'|undefined;
  await until(async()=>{
    const row=await store.get<Delivery>(key);
    if(row&&row.value.attempts!==0)throw new Error('unexpected_outbound_attempt');
    if(row?.value.status==='dead'&&row.version>minimumVersion){
      if(row.value.lastError!=='integration_not_configured')throw new Error('unexpected_terminal_delivery');
      observation='already_terminal';return true;
    }
    if((await store.due(Date.now(),100)).some(item=>item.pk===key.pk&&item.sk===key.sk)){
      observation='due_index';return true;
    }
    return false;
  },waitMs,'due_index_or_terminal_visibility');
  return observation!;
}

interface EvidenceRecord {
  runId:string; status:'started'|'passed'|'failed'; targets:SmokeOptions;
  recordKeys:Key[]; confirmedRecordKeys:Key[]; readiness?:Awaited<ReturnType<typeof ready>>;
  operator?:OperatorEvidence; checks:string[]; recoveryObservation?:'due_index'|'already_terminal'; sweepEnqueued?:number; errorCode?:string;
  limitations:string[];
}
/** Keeps only exact record keys locally, even after a timeout/uncertain transaction. */
function tracked(store:Store,report:EvidenceRecord,save:()=>Promise<void>):Store {
  const attempted=new Map<string,Key>(),confirmed=new Map<string,Key>();
  const identity=(key:Key)=>JSON.stringify([key.pk,key.sk]);
  return {
    get:store.get.bind(store),query:store.query.bind(store),due:store.due.bind(store),
    async commit(writes:Write[]){
      for(const {pk,sk} of writes)attempted.set(identity({pk,sk}),{pk,sk});
      report.recordKeys=[...attempted.values()];await save();
      await store.commit(writes);
      for(const {pk,sk} of writes)confirmed.set(identity({pk,sk}),{pk,sk});
      report.confirmedRecordKeys=[...confirmed.values()];await save();
    },
  };
}
export async function main(args=process.argv.slice(2),environment=process.env):Promise<void> {
  const options=smokeOptions(args,environment);
  const runId=`smoke_${Date.now()}_${randomUUID().replaceAll('-','').slice(0,12)}`;
  const folder=resolve('.private','aws-smoke',runId);
  await mkdir(folder,{recursive:true,mode:0o700});
  const output=resolve(folder,'evidence.json');
  const report:EvidenceRecord={runId,status:'started',targets:options,recordKeys:[],confirmedRecordKeys:[],checks:[],limitations:[
    'Domain transactions/claims/history run through the existing operator identity, not deployed HTTP authentication or MCP roles.',
    'No OAuth clients, principal grants, configuration secrets or external agent callbacks are created.',
    'INSERT plus terminal delivery demonstrates the configured dispatch system; an active recovery schedule or duplicate queue wake can also process the record.',
    'The explicit sweep invocation and subsequent terminal record do not prove exclusive causal attribution when other triggers are active.',
    'The existing sweep is installation-wide and may enqueue other due records; bootstrap delivery prevents outbound calls.',
    'Synthetic records are preserved. No cleanup or unrelated-table scan is performed.',
  ]};
  let saving=Promise.resolve();
  const save=()=>{
    saving=saving.then(async()=>{await writeFile(`${output}.tmp`,JSON.stringify(report,null,2)+'\n',{mode:0o600});await rename(`${output}.tmp`,output);});
    return saving;
  };
  await save();
  try {
    const client=new DynamoDBClient({region:options.region});
    report.readiness=await ready(options,client);report.checks.push('bootstrap_targets_and_event_mappings_verified');await save();
    const store=tracked(new DynamoStore(options.tableName,DynamoDBDocumentClient.from(client)),report,save);
    report.operator=await operatorChecks(store,options.installationId,runId);
    report.checks.push('operator_transactions_dedup_claim_concurrency_fencing_history_and_rollback');await save();
    for(const key of report.operator.outboxKeys)await terminal(store,key,options.waitMs);
    report.checks.push('inserted_outbox_processed_by_deployed_bootstrap_delivery');await save();
    const key=report.operator.outboxKeys[0]!;
    const pendingVersion=await requeueFixture(store,key,report.operator);
    // The GSI is eventually consistent and a scheduled sweep can win this race.
    report.recoveryObservation=await observeRequeuedFixture(store,key,pendingVersion,options.waitMs);
    await save();
    const invokeFile=resolve(folder,'sweep-response.tmp.json');
    try {
      const invoked=await cliJson(options.region,['lambda','invoke','--function-name',options.sweepFunction,'--invocation-type','RequestResponse',
        '--cli-binary-format','raw-in-base64-out','--payload','{}',invokeFile]);
      if(invoked.StatusCode!==200||invoked.FunctionError)throw new Error('sweep_invocation_failed');
      const result=JSON.parse(await readFile(invokeFile,'utf8')) as {enqueued?:number};
      if(!Number.isSafeInteger(result.enqueued)||result.enqueued!<0)throw new Error('invalid_sweep_response');
      report.sweepEnqueued=result.enqueued;
    } finally {
      // Never retain arbitrary Lambda response/error bodies in the evidence folder.
      await unlink(invokeFile).catch(()=>{});
    }
    await terminal(store,key,options.waitMs,pendingVersion);
    report.checks.push('existing_outbox_modify_explicit_sweep_and_terminal_delivery');
    report.status='passed';await save();
    console.log(JSON.stringify({status:report.status,evidence:relative(process.cwd(),output),runId}));
  } catch(error) {
    report.status='failed';report.errorCode=error instanceof Error?/^[a-z_]+$/.test(error.message)?error.message:error.name:'unknown_error';
    await save();console.error(JSON.stringify({status:report.status,errorCode:report.errorCode,evidence:relative(process.cwd(),output),runId}));
    throw new Error('aws_smoke_failed_see_private_evidence');
  }
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  main().catch(()=>{process.exitCode=1;});
}

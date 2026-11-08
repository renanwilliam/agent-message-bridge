import assert from 'node:assert/strict';
import test from 'node:test';
import { assertTargetArn, observeRequeuedFixture, operatorChecks, requeueFixture, smokeOptions } from '../scripts/aws-smoke.js';
import { MemoryStore } from '../src/memory-store.js';
import type { Write } from '../src/store.js';
import type { Delivery } from '../src/types.js';
import { Worker } from '../src/worker.js';

const target={AWS_ACCOUNT_ID:'000000000000',TABLE_NAME:'fixture-bridge-table',INSTALLATION_ID:'fixture',AWS_REGION:'us-east-1',
  LAMBDA_STREAM_NAME:'fixture-stream',LAMBDA_DELIVERY_NAME:'fixture-delivery',LAMBDA_SWEEP_NAME:'fixture-sweep'};

test('AWS smoke requires explicit execution and concrete valid target names without doing any AWS work',()=>{
  assert.throws(()=>smokeOptions([],target),/explicit_execute_required/);
  assert.throws(()=>smokeOptions(['--execute','--cleanup'],target),/explicit_execute_required/);
  assert.throws(()=>smokeOptions(['--execute'],{}),/missing_smoke_target/);
  assert.throws(()=>smokeOptions(['--execute'],{...target,AWS_ACCOUNT_ID:'*'}),/invalid_smoke_target/);
  assert.throws(()=>smokeOptions(['--execute'],{...target,INSTALLATION_ID:'fixture*'}),/invalid_smoke_target/);
  assert.throws(()=>smokeOptions(['--execute'],{...target,AWS_REGION:'prefix us-east-1'}),/invalid_smoke_target/);
  assert.throws(()=>smokeOptions(['--execute'],{...target,LAMBDA_STREAM_NAME:'--other-argument value'}),/invalid_smoke_function_name/);
  assert.throws(()=>smokeOptions(['--execute'],{...target,LAMBDA_SWEEP_NAME:target.LAMBDA_DELIVERY_NAME}),/distinct_smoke_functions_required/);
  assert.throws(()=>smokeOptions(['--execute'],{...target,AWS_SMOKE_WAIT_MS:'99999999'}),/invalid_smoke_wait/);
  const parsed=smokeOptions(['--execute'],target);
  assert.equal(parsed.installationId,'fixture');
  assert.equal(parsed.waitMs,45000);
});

test('smoke resource identity rejects different accounts, regions and names before writes',()=>{
  const options={accountId:target.AWS_ACCOUNT_ID,region:target.AWS_REGION};
  assert.doesNotThrow(()=>assertTargetArn('arn:aws:lambda:us-east-1:000000000000:function:fixture-delivery','lambda',options,'function:fixture-delivery'));
  for(const arn of [undefined,'arn:aws:lambda:us-east-1:111111111111:function:fixture-delivery','arn:aws:lambda:eu-west-1:000000000000:function:fixture-delivery','arn:aws:lambda:us-east-1:000000000000:function:other','arn:aws:sqs:us-east-1:000000000000:function:fixture-delivery']){
    assert.throws(()=>assertTargetArn(arn,'lambda',options,'function:fixture-delivery'),/resource_account_or_region_mismatch/);
  }
});

test('smoke domain checks and exact-key recovery run locally without persisting authentication grants',async()=>{
  class RecordedStore extends MemoryStore {
    readonly writes:Write[]=[];
    override async commit(writes:Write[]){await super.commit(writes);this.writes.push(...structuredClone(writes));}
  }
  const store=new RecordedStore();
  const proof=await operatorChecks(store,'fixture','smoke_local');
  assert.equal(proof.historyCount,4);
  assert.equal(proof.messageIds.length,4);
  assert.equal(proof.outboxKeys.length,3);
  const kinds=new Set(store.writes.map(write=>write.pk.split('#')[1]));
  assert.deepEqual([...kinds].sort(),['claims','dedup','history','meta','outbox','rate']);
  assert.ok(!JSON.stringify(proof).includes('Synthetic infrastructure smoke'));
  assert.ok(!JSON.stringify(proof).includes('scopes'));
  let outboundCalls=0;
  const worker=new Worker(store,{deliveryEnabled:false,routes:{},leaseMs:30000,retryMs:1000,maxAttempts:3,responseWaitMs:60000},async()=>{
    outboundCalls++;throw new Error('An inactive delivery must not access the network');
  });
  for(const key of proof.outboxKeys)assert.equal(await worker.deliver(key),'dead');
  assert.equal(outboundCalls,0);
  for(const key of proof.outboxKeys){
    const row=await store.get<Delivery>(key);
    assert.equal(row?.value.lastError,'integration_not_configured');
    assert.equal(row?.value.attempts,0);
  }
  const key=proof.outboxKeys[0]!;
  const before=(await store.get<Delivery>(key))!;
  const pendingVersion=await requeueFixture(store,key,proof,Date.now()-1);
  const pending=(await store.get<Delivery>(key))!;
  assert.equal(pendingVersion,before.version+1);
  assert.equal(pending.value.status,'pending');
  assert.ok((await store.due(Date.now(),100)).some(item=>item.pk===key.pk&&item.sk===key.sk));
  assert.equal(await observeRequeuedFixture(store,key,pendingVersion,1000),'due_index');
  assert.equal(await worker.deliver(key),'dead');
  const after=(await store.get<Delivery>(key))!;
  assert.ok(after.version>pendingVersion);
  assert.equal(after.value.lastError,'integration_not_configured');
  assert.equal(await observeRequeuedFixture(store,key,pendingVersion,1000),'already_terminal','A scheduled dispatcher may win before GSI observation');
  assert.equal(outboundCalls,0);
  await assert.rejects(requeueFixture(store,{pk:'fixture#outbox#unrelated',sk:'foreign'},proof),/foreign_smoke_key/);
  await store.commit([{...key,expected:after.version,value:{...after.value,lastError:'route_missing'}}]);
  await assert.rejects(requeueFixture(store,key,proof),/fixture_not_bootstrap_terminal/);
});

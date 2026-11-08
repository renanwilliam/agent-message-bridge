import test from 'node:test';
import assert from 'node:assert/strict';
import {createStreamWake,type StreamRecord} from '../src/dispatch.js';
const hash='a'.repeat(64);
function record(pk:string,eventName='INSERT'):StreamRecord {return {eventID:'event_a',eventName,dynamodb:{SequenceNumber:'101',Keys:{pk:{S:pk},sk:{S:hash}}}};}
test('KEYS_ONLY dispatcher sends only same-installation outbox pointers, never record values',async()=>{
 const sent:unknown[]=[];const dispatch=createStreamWake(async key=>{sent.push(key);},'sample');
 const allowed={...record('sample#outbox#beta'),dynamodb:{...record('sample#outbox#beta').dynamodb,NewImage:{value:{S:'secret and message canary'}}}};
 const result=await dispatch({Records:[allowed,record('sample#history#conversation_a'),record('sample#subscription-secrets#alpha'),record('other#outbox#beta'),record('sample#outbox#beta','MODIFY'),record('sample#outbox#beta','REMOVE')]});
 assert.deepEqual(sent,[{pk:'sample#outbox#beta',sk:hash}]);assert.deepEqual(result,{batchItemFailures:[]});assert.ok(!JSON.stringify(sent).includes('canary'));
});
test('dispatcher retries failed pointers by stream sequence and ignores malformed identifiers',async()=>{
 const dispatch=createStreamWake(async()=>{throw new Error('synthetic queue failure');},'sample');
 const bad=record('sample#outbox#beta');bad.dynamodb!.Keys!.sk={S:'not-an-event-id'};
 const result=await dispatch({Records:[record('sample#outbox#beta'),bad,record('sample#outbox#beta#extra'),{eventID:'empty',eventName:'INSERT'}]});
 assert.deepEqual(result,{batchItemFailures:[{itemIdentifier:'101'}]});
 assert.throws(()=>createStreamWake(async()=>{},'sample*'));
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { setEventAuthorization, eventAuthorizationKey } from '../src/event-authorization.js';
import { Events, activeSubscriptions } from '../src/events.js';
import { MemoryStore } from '../src/memory-store.js';
import { tenantKey, type Principal, type EventAuthorization } from '../src/types.js';

const principal:Principal={tenant:'sample',id:'recipient',scopes:['events:subscribe'],peers:[],eventAuthorizationEpoch:'1'};
const identity={tenant:principal.tenant,owner:principal.id};
const secret=`whsec_${Buffer.alloc(32,37).toString('base64')}`;
const params={name:'message.received',delivery:{mode:'webhook',url:'https://callback.example.test/events',secret}};
const callback=async(_url:string,body:string)=>({status:200,body:JSON.stringify({challenge:JSON.parse(body).challenge})});

test('event grants require an exact previous epoch and strictly increase across revocation and regrant',async()=>{
  const store=new MemoryStore();
  await setEventAuthorization(store,identity,{epoch:'1',active:true},null);
  await assert.rejects(setEventAuthorization(store,identity,{epoch:'2',active:false},null),/event_authorization_conflict/);
  await setEventAuthorization(store,identity,{epoch:'2',active:false},'1');
  for(const epoch of ['1','2'])await assert.rejects(setEventAuthorization(store,identity,{epoch,active:true},'2'),/event_authorization_epoch_reuse/);
  await setEventAuthorization(store,identity,{epoch:'3',active:true},'2');
  const events=new Events(store,callback);
  await assert.rejects(events.subscribe(principal,params),/event_access_revoked/);
  await events.subscribe({...principal,eventAuthorizationEpoch:'3'},params);
  assert.equal((await activeSubscriptions(store,principal.tenant,principal.id))[0]!.authorizationEpoch,'3');
  await assert.rejects(setEventAuthorization(store,identity,{epoch:'4',active:false},'2'),/event_authorization_conflict/);
  assert.deepEqual((await store.get<EventAuthorization>(eventAuthorizationKey(principal.tenant,principal.id)))!.value,{epoch:'3',active:true});
});

test('concurrent grant updates cannot overwrite each other or resurrect the losing epoch',async()=>{
  const store=new MemoryStore();
  await setEventAuthorization(store,identity,{epoch:'1',active:true},null);
  const results=await Promise.allSettled([
    setEventAuthorization(store,identity,{epoch:'2',active:false},'1'),
    setEventAuthorization(store,identity,{epoch:'3',active:false},'1'),
  ]);
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
  const rejected=results.find(result=>result.status==='rejected');
  assert.match(String(rejected?.reason),/event_authorization_conflict/);
  const row=(await store.get<EventAuthorization>(eventAuthorizationKey(principal.tenant,principal.id)))!;
  assert.equal(row.value.active,false);
  await assert.rejects(setEventAuthorization(store,identity,{epoch:'1',active:true},row.value.epoch),/event_authorization_epoch_reuse/);
});

test('missing, revoked and mismatched authorization fail before callback verification',async()=>{
  for(const state of ['missing','revoked','mismatch','principal_missing'] as const){
    const store=new MemoryStore();
    if(state!=='missing')await setEventAuthorization(store,identity,{epoch:state==='mismatch'?'2':'1',active:state!=='revoked'},null);
    const events=new Events(store,async()=>{assert.fail('No callback before a current explicit grant');});
    await assert.rejects(events.subscribe({...principal,eventAuthorizationEpoch:state==='principal_missing'?undefined:'1'},params),/event_access_revoked/);
    assert.deepEqual(await activeSubscriptions(store,principal.tenant,principal.id),[]);
  }
});

test('revocation during callback verification atomically prevents subscription resurrection',async()=>{
  const store=new MemoryStore();
  await setEventAuthorization(store,identity,{epoch:'1',active:true},null);
  let entered!:()=>void;let release!:()=>void;
  const started=new Promise<void>(resolve=>{entered=resolve;});
  const continueVerification=new Promise<void>(resolve=>{release=resolve;});
  const events=new Events(store,async(url,body)=>{entered();await continueVerification;return callback(url,body);});
  const subscribing=events.subscribe(principal,params);
  await started;
  await setEventAuthorization(store,identity,{epoch:'2',active:false},'1');
  release();
  await assert.rejects(subscribing,/event_access_revoked/);
  assert.equal((await store.query(tenantKey(principal.tenant,'subscriptions',principal.id),'sub_',100)).items.length,0);
  assert.equal((await store.query(tenantKey(principal.tenant,'subscription-secrets',principal.id),'',100)).items.length,0);
  assert.deepEqual((await store.get<EventAuthorization>(eventAuthorizationKey(principal.tenant,principal.id)))!.value,{epoch:'2',active:false});
});

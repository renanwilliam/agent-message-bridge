import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from 'yaml';
import { createApp } from '../src/app.js';
import { Bridge } from '../src/bridge.js';
import { Events } from '../src/events.js';
import { setEventAuthorization } from '../src/event-authorization.js';
import { MemoryStore } from '../src/memory-store.js';
import type { Key, Store, Write } from '../src/store.js';
import { signWebhook, verifyWebhook } from '../src/transport.js';
import { BridgeError, tenantKey, type Principal } from '../src/types.js';
import { Worker } from '../src/worker.js';

// Exercise actual application calls against the source allowlists. This focused
// regression checker is not an AWS IAM simulator or proof of deployed permissions.
interface Statement {
  Effect: string;
  Action: string | string[];
  Resource: unknown;
  Condition?: Record<string, Record<string, string | string[]>>;
}
interface Manifest {
  resources: { Resources: Record<string, { Properties: {
    Policies?: { PolicyDocument: { Statement: Statement[] } }[];
  } }> };
}
const manifest=parse(readFileSync(new URL('../serverless.yml',import.meta.url),'utf8')) as Manifest;
const installation='sample';
const actions=['GetItem','Query','PutItem','DeleteItem'] as const;
type Action=typeof actions[number];

function grants(role:string,action:Action,key:Key,operation?:string):boolean {
  const statements=manifest.resources.Resources[role]?.Properties.Policies?.flatMap(policy=>policy.PolicyDocument.Statement)??[];
  return statements.some(statement=>{
    if(statement.Effect!=='Allow'||![statement.Action].flat().includes(`dynamodb:${action}`))return false;
    if(JSON.stringify(statement.Resource)!==JSON.stringify({'Fn::GetAtt':['BridgeTable','Arn']}))return false;
    const patterns=statement.Condition?.['ForAllValues:StringLike']?.['dynamodb:LeadingKeys'];
    if(!Array.isArray(patterns)||statement.Condition?.Null?.['dynamodb:LeadingKeys']!=='false')return false;
    const requiredOperation=statement.Condition?.['ForAnyValue:StringEquals']?.['dynamodb:EnclosingOperation'];
    if(requiredOperation&&(!operation||![requiredOperation].flat().includes(operation)))return false;
    return patterns.some(pattern=>{
      const expanded=pattern.replaceAll('${param:installationId}',installation);
      const expression=expanded.split('*').map(part=>part.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('.*');
      return new RegExp(`^${expression}$`).test(key.pk);
    });
  });
}
function scoped(store:Store,role:string,calls:Set<string>):Store {
  function check(action:Action,key:Key,operation?:string) {
    assert.ok(grants(role,action,key,operation),`${role} lacks ${action} for ${key.pk}`);
    calls.add(`${role}:${action}:${key.pk.split('#')[1]}`);
  }
  return {
    async get<T=Record<string,unknown>>(key:Key){check('GetItem',key);return store.get<T>(key);},
    async query<T=Record<string,unknown>>(pk:string,prefix:string,limit:number,cursor?:string){check('Query',{pk,sk:prefix});return store.query<T>(pk,prefix,limit,cursor);},
    async commit(writes:Write[]){
      for(const write of writes)check(write.value===undefined?'DeleteItem':'PutItem',write,'TransactWriteItems');
      return store.commit(writes);
    },
    async due(){throw new Error('These roles do not read the due index');},
  };
}

const agentScopes=['messages:send','messages:read','messages:claim','events:subscribe'];
const alpha:Principal={eventAuthorizationEpoch:'1',id:'alpha',tenant:installation,scopes:agentScopes,peers:['beta']};
const beta:Principal={id:'beta',tenant:installation,scopes:agentScopes,peers:['alpha']};
const reader:Principal={id:'reader',tenant:installation,scopes:['history:read'],peers:[],readParticipants:['alpha']};
const config={maxTurns:20,messagesPerMinute:30,claimMs:60_000,webhookRecipients:[`${installation}:beta`]};
const secret=`whsec_${Buffer.alloc(32,17).toString('base64')}`;
const resource='https://bridge.example.test/bridge/mcp';

test('actual subscribe, signed ingress, fenced response, human history and delivery fit role action/partition allowlists',async()=>{
  const store=new MemoryStore(),calls=new Set<string>();
  await setEventAuthorization(store,{tenant:alpha.tenant,owner:alpha.id},{epoch:alpha.eventAuthorizationEpoch!,active:true},null);
  const mcpStore=scoped(store,'McpRole',calls),ingressStore=scoped(store,'IngressRole',calls);
  const historyStore=scoped(store,'HistoryRole',calls),deliveryStore=scoped(store,'DeliveryRole',calls);
  const events=new Events(mcpStore,async(_url,body,headers)=>{
    verifyWebhook(secret,body,headers);
    return {status:200,body:JSON.stringify({challenge:JSON.parse(body).challenge})};
  });
  await events.subscribe(alpha,{name:'message.received',delivery:{mode:'webhook',url:'https://callback.example.test/event',secret}});
  const ingress=new Bridge(ingressStore,config),mcp=new Bridge(mcpStore,config);
  const forbiddenPost=async()=>{throw new Error('Unexpected callback verification');};
  const peerApp=createApp(ingress,new Events(ingressStore,forbiddenPost),{
    resourceUrl:resource,issuer:'https://issuer.example.test',origins:[],
    authenticate:async()=>{throw new BridgeError('unauthorized',401);},
    callbacks:{peer_beta:{secret,principal:beta}},
  });
  const raw=JSON.stringify({action:'send',arguments:{id:'request',conversationId:'conversation',recipient:'alpha',text:'Synthetic request'}});
  const response=await peerApp.fetch(new Request('https://bridge.example.test/peer',{
    method:'POST',body:raw,headers:{...signWebhook(secret,'delivery',raw),'x-bridge-key-id':'peer_beta'},
  }));
  assert.equal(response.status,200,await response.clone().text());
  const claim=await mcp.claim(alpha,'conversation','request');
  assert.equal(claim.status,'claimed');
  if(claim.status!=='claimed')throw new Error('Expected a claim');
  await mcp.complete(alpha,{id:'response',conversationId:'conversation',recipient:'beta',text:'Synthetic response',replyTo:'request',fence:claim.fence});
  const historyApp=createApp(new Bridge(historyStore,config),new Events(historyStore,forbiddenPost),{
    resourceUrl:resource,issuer:'https://issuer.example.test',origins:[],callbacks:{},authenticate:async()=>reader,
  });
  const historyResponse=await historyApp.fetch(new Request('https://bridge.example.test/history?conversationId=conversation'));
  assert.equal(historyResponse.status,200,await historyResponse.clone().text());
  assert.equal((await historyResponse.json()).messages.length,2);
  let delivered=0;
  const worker=new Worker(deliveryStore,{
    routes:{[`${installation}:beta`]:{url:'https://peer.example.test/wake',bearer:'synthetic-peer-bearer'}},
    leaseMs:30_000,retryMs:1000,maxAttempts:3,responseWaitMs:60_000,
  },async(_url,body)=>{
    delivered++;
    assert.ok(!body.includes('Synthetic request')&&!body.includes('Synthetic response'));
    assert.ok(!body.includes(secret));
    return {status:204,body:''};
  });
  // These pointers represent the dispatch/sweep boundary, outside delivery IAM.
  for(const key of await store.due(Date.now(),100))await worker.deliver(key);
  assert.equal(delivered,2);
  assert.deepEqual([...calls].filter(value=>value.startsWith('HistoryRole:')).sort(),[
    'HistoryRole:GetItem:meta','HistoryRole:Query:history',
  ]);
  assert.ok(calls.has('IngressRole:PutItem:callback'));
  assert.ok(calls.has('DeliveryRole:GetItem:subscription-secrets'));
  assert.ok(![...calls].some(value=>value.startsWith('IngressRole:')&&value.endsWith(':subscription-secrets')));
});

test('role allowlists deny history access to claims/secrets, ingress signing secrets and delivery message bodies',()=>{
  const key=(kind:string):Key=>({pk:tenantKey(installation,kind,'fixture'),sk:'fixture'});
  for(const role of ['HistoryRole','IngressRole'])assert.equal(grants(role,'GetItem',key('subscription-secrets')),false);
  assert.equal(grants('HistoryRole','GetItem',key('claims')),false);
  assert.equal(grants('HistoryRole','Query',key('claims')),false);
  assert.equal(grants('HistoryRole','PutItem',key('history'),'TransactWriteItems'),false);
  assert.equal(grants('IngressRole','PutItem',key('subscription-secrets'),'TransactWriteItems'),false);
  assert.equal(grants('DeliveryRole','GetItem',key('history')),false);
  assert.equal(grants('DeliveryRole','Query',key('history')),false);
  assert.equal(grants('DeliveryRole','PutItem',key('claims'),'TransactWriteItems'),false);
  for(const role of ['McpRole','IngressRole','HistoryRole','DeliveryRole']){
    for(const kind of ['meta','history','claims','dedup','rate','outbox','subscriptions','subscription-secrets','callback']){
      const foreign={pk:tenantKey('foreign_installation',kind,'fixture'),sk:'fixture'};
      for(const action of actions)assert.equal(grants(role,action,foreign,'TransactWriteItems'),false,`${role}:${action}:${kind}`);
    }
  }
  for(const role of ['McpRole','IngressRole','DeliveryRole']){
    assert.equal(grants(role,'PutItem',key('outbox')),false,'Writes require transactional context');
    assert.equal(grants(role,'DeleteItem',key('outbox'),'TransactWriteItems'),false,'Runtime roles cannot delete records');
  }
});

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../src/sqlite-store.js';
import { Bridge } from '../src/bridge.js';
import { Events } from '../src/events.js';
import { setEventAuthorization } from '../src/event-authorization.js';
import { Worker } from '../src/worker.js';
import { createApp } from '../src/app.js';
import { verifyWebhook } from '../src/transport.js';
import { httpServer,listen,close } from '../src/http.js';
import { BridgeError,type Principal,type OutboundPost } from '../src/types.js';

const dir=await mkdtemp(join(tmpdir(),'bridge-demo-'));const database=join(dir,'history.sqlite');
const store=new SqliteStore(database);
const scopes=['messages:send','messages:read','messages:claim','events:subscribe'];
const alpha:Principal={eventAuthorizationEpoch:'1',id:'agent_alpha',tenant:'demo',scopes,peers:['agent_beta']};
const beta:Principal={id:'agent_beta',tenant:'demo',scopes,peers:['agent_alpha']};
const human:Principal={id:'reader',tenant:'demo',scopes:['history:read'],peers:[],readParticipants:['agent_alpha']};
const tokens=new Map<string,Principal>();for(const p of [alpha,beta,human])tokens.set(randomBytes(24).toString('base64url'),p);
const tokenFor=(p:Principal)=>[...tokens].find(([,v])=>v===p)![0];
const eventSecret=`whsec_${randomBytes(32).toString('base64')}`,wakeToken=randomBytes(24).toString('base64url');
let bridgeUrl='';let callbackUrl='';let completed=0;let receivedEvents=0;let wakeCount=0;
let resolveWork!:()=>void,rejectWork!:(e:unknown)=>void;const work=new Promise<void>((resolve,reject)=>{resolveWork=resolve;rejectWork=reject;});
async function rpc(p:Principal,method:string,params:unknown) {
  const response=await fetch(`${bridgeUrl}/bridge/mcp`,{method:'POST',headers:{authorization:`Bearer ${tokenFor(p)}`,'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
  const raw=await response.text();assert.equal(response.status,200,raw);
  const data=JSON.parse(raw.startsWith('event:')?raw.split('\n').find(line=>line.startsWith('data: '))!.slice(6):raw);
  if(data.error)throw new Error(JSON.stringify(data.error));return data.result;
}
async function tool(p:Principal,name:string,args:unknown) {const r=await rpc(p,'tools/call',{name,arguments:args});assert.ok(!r.isError,JSON.stringify(r));return r.structuredContent??JSON.parse(r.content[0].text);}
const sink=httpServer({async fetch(request){
  const raw=await request.text();const data=JSON.parse(raw);
  if(new URL(request.url).pathname==='/events') {
    verifyWebhook(eventSecret,raw,Object.fromEntries(request.headers));
    if(data.type==='verification')return Response.json({challenge:data.challenge});
    assert.equal(data.name,'message.received');assert.equal(data.data.recipient,'agent_alpha');assert.ok(request.headers.get('x-mcp-subscription-id'));receivedEvents++;return new Response(null,{status:204});
  }
  assert.equal(request.headers.get('authorization'),`Bearer ${wakeToken}`);wakeCount++;
  void(async()=>{
    const claim=await tool(beta,'bridge_claim_message',{conversationId:data.conversationId,messageId:data.messageId});
    if(claim.status!=='claimed')return;
    const history=await tool(beta,'bridge_read_history',{conversationId:data.conversationId});assert.equal(history.messages[0].text,'Please confirm receipt.');
    await tool(beta,'bridge_complete_message',{id:'reply_1',conversationId:data.conversationId,recipient:'agent_alpha',text:'Receipt confirmed.',replyTo:data.messageId,fence:claim.fence});completed++;resolveWork();
  })().catch(rejectWork);
  return Response.json({accepted:true});
}});
// The fixture maps one reserved test hostname to loopback; production uses the SSRF-protected HTTPS adapter.
const post:OutboundPost=async(url,body,headers)=>{const target=new URL(url);assert.equal(target.hostname,'sink.example');const response=await fetch(callbackUrl+target.pathname,{method:'POST',headers:{'content-type':'application/json',...headers},body});return {status:response.status,body:await response.text()};};
const bridge=new Bridge(store,{maxTurns:8,messagesPerMinute:20,claimMs:10000,webhookRecipients:['demo:agent_beta']});
const events=new Events(store,post);
const app=createApp(bridge,events,{resourceUrl:'https://bridge.example/bridge/mcp',issuer:'https://issuer.example',origins:[],callbacks:{},authenticate:async request=>{const p=tokens.get(request.headers.get('authorization')?.slice(7)??'');if(!p)throw new BridgeError('unauthorized',401);return p;}});
const server=httpServer(app);
const worker=new Worker(store,{routes:{'demo:agent_beta':{url:'https://sink.example/wake',bearer:wakeToken}},leaseMs:30000,retryMs:100,maxAttempts:3,responseWaitMs:10000},post);
try {
  await setEventAuthorization(store,{tenant:alpha.tenant,owner:alpha.id},{epoch:alpha.eventAuthorizationEpoch!,active:true},null);
  callbackUrl=await listen(sink);bridgeUrl=await listen(server);
  const init=await rpc(alpha,'initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'demo',version:'1'}});assert.deepEqual(init.capabilities.events,{});
  await rpc(alpha,'events/subscribe',{name:'message.received',arguments:{conversationId:'demo_conversation'},delivery:{mode:'webhook',url:'https://sink.example/events',secret:eventSecret}});
  const message={id:'question_1',conversationId:'demo_conversation',recipient:'agent_beta',text:'Please confirm receipt.'};
  await tool(alpha,'bridge_send_message',message);assert.equal((await tool(alpha,'bridge_send_message',message)).duplicate,true);
  await worker.drain();await Promise.race([work,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error('Demo timed out')),15000);timer.unref();})]);
  await worker.drain();
  const response=await fetch(`${bridgeUrl}/history?conversationId=demo_conversation`,{headers:{authorization:`Bearer ${tokenFor(human)}`}});const history=await response.json();assert.equal(history.messages.length,2);assert.equal(completed,1);assert.equal(receivedEvents,1);
  store.close();const restarted=new SqliteStore(database);const rows=await restarted.query('demo#history#demo_conversation','message#',10);assert.equal(rows.items.length,2);restarted.close();
  const report={scope:'Local HTTP fixture; no live platform or AWS proof',messages:2,duplicateSendDeduplicated:true,webhookWakes:wakeCount,completedResponses:completed,signedEventsReceived:receivedEvents,historySurvivesRestart:true,secretsPrinted:false};
  await mkdir('.private',{recursive:true});await writeFile('.private/local-demo.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
} finally {await close(server);await close(sink);await rm(dir,{recursive:true,force:true});}

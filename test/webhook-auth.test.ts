import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import type { request as httpsRequest, RequestOptions } from 'node:https';
import { privateConfigSchema } from '../src/config.js';
import { MemoryStore } from '../src/memory-store.js';
import { createOutboundPost } from '../src/transport.js';
import { Worker } from '../src/worker.js';
import type { Delivery } from '../src/types.js';

test('real local HTTP receiver captures configured raw credential header and default omission',async t=>{
  const received:{method?:string;headers:IncomingHttpHeaders;body:string}[]=[];
  const server=createServer(async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk;
    received.push({method:req.method,headers:req.headers,body});
    res.writeHead(200,{'content-type':'application/json'});res.end('{}');
  });
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  t.after(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});
  const address=server.address();assert.ok(address && typeof address!=='string');
  // Test-only adapter directs the real wire request to a local fixture. Production
  // HTTPS validation, public-address checks and transport code stay unchanged.
  const request=((_url:URL,options:RequestOptions,callback:(response:IncomingMessage)=>void)=>
    httpRequest({hostname:'127.0.0.1',port:address.port,path:'/wake',method:options.method,
      headers:options.headers,signal:options.signal,agent:false},callback)) as typeof httpsRequest;
  const post=createOutboundPost({request,resolve:async()=>[{address:'8.8.8.8',family:4}]});
  const bearer='fictional-wire-credential';
  for(const additionalAuthHeader of [undefined,'X-Webhook-Key']){
    const parsed=privateConfigSchema.parse({routes:{'sample:receiver':{
      url:'https://receiver.example.test/wake',bearer,...(additionalAuthHeader?{additionalAuthHeader}:{}),
    }}});
    const store=new MemoryStore();const at=1_700_000_000_000;
    const key={pk:'sample#outbox#receiver',sk:'delivery_wire'};
    const value:Delivery={id:key.sk,kind:'webhook',tenant:'sample',owner:'receiver',attempts:0,fence:0,leaseUntil:0,status:'pending',
      message:{id:'message_wire',conversationId:'conversation_wire',correlationId:'message_wire',sender:'sender',recipient:'receiver',timestamp:new Date(at).toISOString()}};
    await store.commit([{...key,expected:null,value,dueAt:at}]);
    const worker=new Worker(store,{routes:parsed.routes,leaseMs:30_000,retryMs:1000,maxAttempts:3,responseWaitMs:60_000},post,()=>at);
    assert.equal(await worker.deliver(key),'pending');
    const captured=received.at(-1)!;
    assert.equal(captured.method,'POST');
    assert.equal(captured.headers.authorization,`Bearer ${bearer}`);
    assert.equal(captured.headers['content-type'],'application/json');
    assert.equal(captured.headers['idempotency-key'],key.sk);
    assert.equal(captured.headers['content-length'],String(Buffer.byteLength(captured.body)));
    assert.equal(captured.headers['x-webhook-key'],additionalAuthHeader?bearer:undefined);
    assert.deepEqual(Object.keys(captured.headers).filter(name=>name.startsWith('x-')),additionalAuthHeader?['x-webhook-key']:[]);
    assert.deepEqual(JSON.parse(captured.body),{type:'message.available',deliveryId:key.sk,messageId:'message_wire',conversationId:'conversation_wire',correlationId:'message_wire'});
    assert.ok(!captured.body.includes(bearer));
    assert.ok(!JSON.stringify(await store.get(key)).includes(bearer));
  }
  assert.equal(received.length,2);
});

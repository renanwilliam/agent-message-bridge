import test from 'node:test';
import assert from 'node:assert/strict';
import { probe, mcpCaller, main } from '../scripts/post-deploy-probe.js';
import { Bridge } from '../src/bridge.js';
import { MemoryStore } from '../src/memory-store.js';
import { type Principal } from '../src/types.js';
const config={resourceUrl:'https://bridge.example.test/bridge/mcp',conversationId:'probe_conversation',recipient:'beta',sender:'alpha',exclusiveSender:true as const,waitMs:1000};
const commit='a'.repeat(40);
function fixture() {
  const store=new MemoryStore();let clock=Date.UTC(2026,0,1),effects=0;
  const bridge=new Bridge(store,{inboxEnabled:true,messagesPerMinute:100,claimMs:1000,webhookRecipients:[]},()=>clock);
  const alpha:Principal={tenant:'sample',id:'alpha',scopes:['messages:send','messages:read','messages:claim'],peers:['beta']};
  const beta:Principal={...alpha,id:'beta',peers:['alpha']};
  const receiver=async()=>{
    for(const notice of (await bridge.pending(beta)).messages) {
      const c=await bridge.claim(beta,notice.conversationId,notice.id);if(c.status!=='claimed')continue;
      effects++;
      await bridge.complete(beta,{id:'synthetic_probe_response',conversationId:notice.conversationId,recipient:'alpha',text:'Synthetic response',replyTo:notice.id,fence:c.fence});
    }
  };
  const call=async(name:string,args:Record<string,unknown>)=>{
    switch(name) {
      case 'bridge_probe_preflight':return bridge.probePreflight(alpha);
      case 'bridge_send_message':return bridge.send(alpha,args as any);
      case 'bridge_read_history':return bridge.history(alpha,args.conversationId as string,args.limit as number,args.cursor as string|undefined);
      case 'bridge_claim_message':return bridge.claim(alpha,args.conversationId as string,args.messageId as string);
      case 'bridge_acknowledge_message':return bridge.acknowledge(alpha,args as any);
      default:throw new Error('unexpected_tool');
    }
  };
  const pause=async(ms:number)=>{clock+=ms;await receiver();};
  return {bridge,store,call,receiver,pause,now:()=>clock,effects:()=>effects};
}
test('functional probe requires actual fenced response and ledger evidence; resume creates no duplicate effects',async()=>{
  const f=fixture();
  const run=()=>probe(config,commit,f.call,async()=>f.effects()===1,f.now,f.pause);
  const report=await run();assert.equal(report.status,'passed');assert.equal(report.processingConfirmed,true);assert.equal(f.effects(),1);
  const resumed=await run();assert.equal(resumed.status,'passed');assert.equal(f.effects(),1);
  const history=await f.bridge.history({tenant:'sample',id:'alpha',scopes:['messages:read'],peers:['beta']},config.conversationId);
  assert.equal(history.messages.length,2);
});
test('HTTP acceptance without recipient processing times out rather than passing',async()=>{
  const f=fixture();let now=f.now();
  await assert.rejects(probe(config,commit,f.call,undefined,()=>now,async ms=>{now+=ms;}),/processing_not_confirmed/);
});
test('processing without an independent effect ledger is explicitly partial',async()=>{
  const f=fixture();const report=await probe(config,commit,f.call,undefined,f.now,f.pause);
  assert.equal(report.status,'partial');assert.equal(report.duplicateEffectsVerified,false);
});
test('receiver response without matching effect evidence never passes',async()=>{
  const f=fixture();await assert.rejects(probe({...config,waitMs:2000},commit,f.call,async()=>false,f.now,f.pause),/effect_not_confirmed/);
});
for(const raw of ['{"jsonrpc":"2.0","id":1,"error":{"code":-32603,"message":"private"}}','{"jsonrpc":"2.0","id":1,"result":{"isError":true,"content":[]}}']) {
  test('probe rejects MCP failure hidden behind HTTP 200 without reflecting response text',async()=>{
    const call=mcpCaller(config.resourceUrl,'synthetic-token',async()=>new Response(raw,{status:200}) as any);
    await assert.rejects(call('bridge_send_message',{}),/probe_mcp_error/);
  });
}
test('CI without approved probe credentials reports partial, without creating credentials or calling a receiver',async()=>{
  const lines:string[]=[];const log=console.log;
  try {console.log=(value:string)=>{lines.push(value);};await main({CI:'true'});}finally{console.log=log;}
  assert.deepEqual(JSON.parse(lines[0]!),{status:'partial',reason:'authorized_probe_configuration_missing',processingConfirmed:false});
});
for(const newline of ['\n','\r\n']) {
  test(`MCP SSE parses multiline data, comments, notifications and split chunks (${JSON.stringify(newline)})`,async()=>{
    const raw=[': keepalive','','event: message','data: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}','','event: message','data: {"jsonrpc":"2.0","id":1,','data: "result":{"structuredContent":{"ok":true}}}','',''].join(newline);
    const bytes=new TextEncoder().encode(raw);
    const stream=new ReadableStream({start(controller){for(let offset=0;offset<bytes.length;offset+=7)controller.enqueue(bytes.slice(offset,offset+7));controller.close();}});
    const call=mcpCaller(config.resourceUrl,'synthetic-token',async()=>new Response(stream,{headers:{'content-type':'text/event-stream'}}));
    assert.deepEqual(await call('bridge_list_pending',{}),{ok:true});
  });
}
test('MCP JSON response requires the matching ID and SSE rejects duplicate responses',async()=>{
  const response={jsonrpc:'2.0',id:1,result:{structuredContent:{ok:true}}};
  const call=mcpCaller(config.resourceUrl,'synthetic-token',async()=>new Response(JSON.stringify(response)));
  assert.deepEqual(await call('bridge_list_pending',{}),{ok:true});
  const wrong=mcpCaller(config.resourceUrl,'synthetic-token',async()=>new Response(JSON.stringify({...response,id:2})));
  await assert.rejects(wrong('bridge_list_pending',{}),/response_id_mismatch/);
  const duplicate=mcpCaller(config.resourceUrl,'synthetic-token',async()=>new Response(`data: ${JSON.stringify(response)}\n\ndata: ${JSON.stringify(response)}\n\n`,{headers:{'content-type':'text/event-stream'}}));
  await assert.rejects(duplicate('bridge_list_pending',{}),/invalid_response/);
});
for(const [raw,error] of [
  ['data: {"jsonrpc":"2.0","id":1,"error":{"code":-32603,"message":"private"}}\n\n','probe_mcp_error'],
  ['data: {"jsonrpc":"2.0","id":1,"result":{"isError":true}}\n\n','probe_mcp_error'],
  ['data: {"jsonrpc":"2.0","id":2,"result":{"structuredContent":{"ok":true}}}\n\n','probe_response_id_mismatch'],
  ['data: broken\n\n','probe_invalid_response'],
  [': heartbeat\n\n','probe_invalid_response'],
  ['data: {"jsonrpc":"2.0","id":1,"result":{}}\n\n','probe_result_missing'],
] as const) {
  test(`MCP SSE fails closed for ${error}`,async()=>{
    const call=mcpCaller(config.resourceUrl,'synthetic-token',async()=>new Response(raw,{headers:{'content-type':'text/event-stream'}}));
    await assert.rejects(call('bridge_list_pending',{}),new RegExp(error));
  });
}
test('probe rejects a shared webhook sender before sending any message',async()=>{
  const f=fixture();f.bridge.config.webhookRecipients.push('sample:alpha');let sent=false;
  await assert.rejects(probe(config,commit,async(name,args)=>{if(name==='bridge_send_message')sent=true;return f.call(name,args);},undefined,f.now,f.pause),/probe_sender_not_isolated/);
  assert.equal(sent,false);assert.equal(f.effects(),0);
});
test('probe rejects active subscriptions or a mismatched sender before sending',async()=>{
  for(const preflight of [{sender:'alpha',webhookConfigured:false,activeSubscriptions:1},{sender:'other',webhookConfigured:false,activeSubscriptions:0}]) {
    let sent=false;
    await assert.rejects(probe(config,commit,async(name)=>{if(name==='bridge_probe_preflight')return preflight;sent=true;throw new Error('unexpected_send');},undefined),/probe_sender_not_isolated/);
    assert.equal(sent,false);
  }
});
test('probe requires explicit exclusive consumer reservation before making calls',async()=>{
  let calls=0;
  await assert.rejects(probe({...config,exclusiveSender:undefined} as any,commit,async()=>{calls++;return {};},undefined));
  assert.equal(calls,0);
});
test('unexpected polling contention fails without stealing or reopening the terminal claim',async()=>{
  const f=fixture();let claims=0;
  const call=async(name:string,args:Record<string,unknown>)=>{
    if(name==='bridge_claim_message'){claims++;return {status:'busy',retryAfter:f.now()+1000};}
    return f.call(name,args);
  };
  await assert.rejects(probe(config,commit,call,undefined,f.now,f.pause),/probe_terminal_claim_uncertain/);
  assert.equal(claims,1);assert.equal(f.effects(),1);
});

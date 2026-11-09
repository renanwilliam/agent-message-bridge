import test from 'node:test';
import assert from 'node:assert/strict';
import { probe, mcpCaller, main } from '../scripts/post-deploy-probe.js';
import { Bridge } from '../src/bridge.js';
import { MemoryStore } from '../src/memory-store.js';
import { type Principal } from '../src/types.js';
const config={resourceUrl:'https://bridge.example.test/bridge/mcp',conversationId:'probe_conversation',recipient:'beta',waitMs:1000};
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
for(const raw of ['{"jsonrpc":"2.0","error":{"code":-32603,"message":"private"}}','{"result":{"isError":true,"content":[]}}']) {
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

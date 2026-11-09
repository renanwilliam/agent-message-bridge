/** Functional probe using existing, separately authorized credentials and destinations.
 * No credential provisioning, permission changes, raw HTTP output or message logging.
 */
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { z } from 'zod';
import { validateCallbackUrl } from '../src/transport.js';
import { mcpResponseFailed } from '../src/delivery-response.js';

const identifier=z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const configSchema=z.object({resourceUrl:z.string(),conversationId:identifier,recipient:identifier,effectUrl:z.string().optional(),waitMs:z.number().int().min(1000).max(180000).default(60000)}).strict();
export type ProbeConfig=z.input<typeof configSchema>;
type Result=Record<string,any>;
export type ToolCall=(name:string,args:Record<string,unknown>)=>Promise<Result>;

export async function probe(config:ProbeConfig,commit:string,call:ToolCall,verifyEffect:((runId:string)=>Promise<boolean>)|undefined,
  now=Date.now,pause:(ms:number)=>Promise<void>=ms=>new Promise(resolve=>setTimeout(resolve,ms))) {
  const c=configSchema.parse(config);
  if(!/^[a-f0-9]{40}$/.test(commit))throw new Error('invalid_release_commit');
  // One logical probe per release and approved conversation, including resumed jobs.
  const runId=`probe_${createHash('sha256').update(JSON.stringify([commit,c.resourceUrl,c.conversationId,c.recipient])).digest('hex').slice(0,32)}`;
  const requestId=`${runId}_request`;
  const sent=await call('bridge_send_message',{id:requestId,conversationId:c.conversationId,recipient:c.recipient,
    text:JSON.stringify({type:'synthetic_bridge_probe',runId,request:'Process once using claim and complete. Record one synthetic effect in the authorized probe ledger. No other external action.'})});
  if(sent.message?.id!==requestId||sent.message?.conversationId!==c.conversationId||sent.message?.recipient!==c.recipient)throw new Error('probe_persistence_mismatch');
  const deadline=now()+c.waitMs;
  let response:Result|undefined;
  let evidence=false;
  do {
    const responses:Result[]=[];let cursor:string|undefined;let pages=0;
    do {
      const history=await call('bridge_read_history',{conversationId:c.conversationId,limit:100,...(cursor?{cursor}:{})});
      if(!Array.isArray(history.messages))throw new Error('probe_invalid_history');
      responses.push(...history.messages.filter((m:Result)=>m.replyTo===requestId));
      if(history.cursor!==undefined && typeof history.cursor!=='string')throw new Error('probe_invalid_cursor');
      cursor=history.cursor;
      if(++pages>100)throw new Error('probe_history_budget_exhausted');
    } while(cursor);
    if(responses.length>1)throw new Error('probe_duplicate_response');
    response=responses[0];
    if(response && (response.sender!==c.recipient||response.recipient!==sent.message.sender))throw new Error('probe_response_identity_mismatch');
    if(response && verifyEffect)evidence=await verifyEffect(runId);
    if(response && (!verifyEffect||evidence))break;
    await pause(1000);
  } while(now()<=deadline);
  if(!response)throw new Error('probe_processing_not_confirmed');
  if(verifyEffect&&!evidence)throw new Error('probe_effect_not_confirmed');
  // Claim done/acknowledged is durable evidence on resume; do not publish an ACK message.
  const claim=await call('bridge_claim_message',{conversationId:c.conversationId,messageId:response.id});
  if(claim.status==='claimed') {
    const ack=await call('bridge_acknowledge_message',{conversationId:c.conversationId,messageId:response.id,fence:claim.fence});
    if(ack.status!=='done'||ack.outcome!=='acknowledged')throw new Error('probe_terminal_ack_missing');
  } else if(claim.status!=='done'||claim.outcome!=='acknowledged')throw new Error('probe_terminal_claim_uncertain');
  return {status:verifyEffect?'passed':'partial',commit,persisted:true,processingConfirmed:true,terminalAcknowledged:true,
    duplicateEffectsVerified:!!verifyEffect,limitation:verifyEffect?'Finite observation of the authorized receiver ledger; not exactly-once.':'No independent receiver effect ledger configured.'};
}

export function mcpCaller(resourceUrl:string,token:string,request:typeof fetch=fetch):ToolCall {
  validateCallbackUrl(resourceUrl);
  return async(name,args)=>{
    const response=await request(resourceUrl,{method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),
      headers:{authorization:`Bearer ${token}`,'content-type':'application/json',accept:'application/json, text/event-stream','mcp-protocol-version':'2025-03-26'},
      body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})});
    const raw=await boundedResponse(response);
    if(!response.ok)throw new Error('probe_http_error');
    const data=response.headers.get('content-type')?.includes('text/event-stream')?raw.split('\n').filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trim()).filter(Boolean).at(-1):raw;
    if(!data||mcpResponseFailed(data))throw new Error('probe_mcp_error');
    let body:Result;try {body=JSON.parse(data);}catch{throw new Error('probe_invalid_response');}
    if(!body.result?.structuredContent)throw new Error('probe_result_missing');
    return body.result.structuredContent;
  };
}
async function boundedResponse(response:Response) {
  const reader=response.body?.getReader();if(!reader)throw new Error('probe_empty_response');
  let size=0;const chunks:Uint8Array[]=[];
  try {while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>262144)throw new Error('probe_response_too_large');chunks.push(value);}}
  finally {await reader.cancel();}
  return Buffer.concat(chunks).toString('utf8');
}
export async function main(environment=process.env) {
  if(!environment.BRIDGE_PROBE_CONFIG||!environment.BRIDGE_PROBE_TOKEN) {
    if(environment.CI==='true') {console.log(JSON.stringify({status:'partial',reason:'authorized_probe_configuration_missing',processingConfirmed:false}));return;}
    throw new Error('authorized_probe_configuration_required');
  }
  const config=configSchema.parse(JSON.parse(environment.BRIDGE_PROBE_CONFIG));
  const token=environment.BRIDGE_PROBE_TOKEN;
  const effectToken=environment.BRIDGE_PROBE_EFFECT_TOKEN;
  if(config.effectUrl && !effectToken)throw new Error('authorized_effect_credential_required');
  if(config.effectUrl)validateCallbackUrl(config.effectUrl);
  const verify=config.effectUrl?async(runId:string)=>{
    const url=new URL(config.effectUrl!);url.searchParams.set('runId',runId);
    const response=await fetch(url,{headers:{authorization:`Bearer ${effectToken}`},redirect:'error',signal:AbortSignal.timeout(10000)});
    if(!response.ok)throw new Error('probe_effect_http_error');
    const receipt=JSON.parse(await boundedResponse(response));
    if(receipt.runId!==runId||!Number.isSafeInteger(receipt.effects)||receipt.effects>1)throw new Error('probe_effect_mismatch_or_duplicate');
    return receipt.effects===1&&receipt.processingConfirmed===true;
  }:undefined;
  console.log(JSON.stringify(await probe(config,environment.TARGET_SHA??'',mcpCaller(config.resourceUrl,token),verify)));
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)main().catch(()=>{console.error(JSON.stringify({status:'failed',reason:'functional_probe_failed_inspect_private_state_before_retry'}));process.exitCode=1;});

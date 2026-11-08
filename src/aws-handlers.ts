import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { DynamoStore } from './dynamo-store.js';
import { env } from './config.js';
import { runtime } from './runtime.js';
import type { Key } from './store.js';
import { createStreamWake, type StreamRecord } from './dispatch.js';
const sqs=new SQSClient({});
async function enqueue(key:Key) {await sqs.send(new SendMessageCommand({QueueUrl:env('OUTBOX_QUEUE_URL'),MessageBody:JSON.stringify({pk:key.pk,sk:key.sk})}));}
export async function sweep() {const rows=await new DynamoStore(env('TABLE_NAME')).due(Date.now(),100);await Promise.all(rows.map(enqueue));return {enqueued:rows.length};}
export async function streamWake(event:{Records:StreamRecord[]}) {
  return createStreamWake(enqueue,env('INSTALLATION_ID'))(event);
}
export async function delivery(event:{Records:{messageId:string;body:string}[]}) {
  const {worker}=await runtime();const batchItemFailures:{itemIdentifier:string}[]=[];
  for(const record of event.Records) {try{const key=JSON.parse(record.body);if(typeof key.pk!=='string'||typeof key.sk!=='string')throw new Error('invalid key');await worker.deliver(key);}catch{batchItemFailures.push({itemIdentifier:record.messageId});}}
  return {batchItemFailures};
}
interface ApiEvent {path?:string;rawPath?:string;httpMethod?:string;requestContext?:{http?:{method?:string}};headers?:Record<string,string>;queryStringParameters?:Record<string,string>;body?:string;isBase64Encoded?:boolean}
export async function ingress(event:ApiEvent) {
  const method=event.httpMethod??event.requestContext?.http?.method??'POST';const headers=event.headers??{};
  const path=event.rawPath??event.path??'/peer';const query=new URLSearchParams(event.queryStringParameters??{});
  const body=event.body?Buffer.from(event.body,event.isBase64Encoded?'base64':'utf8'):undefined;
  const request=new Request(`https://bridge.invalid${path}?${query}`,{method,headers,...(body&&method!=='GET'&&method!=='HEAD'?{body}:{} )});
  const response=await(await runtime()).app.fetch(request);return {statusCode:response.status,headers:Object.fromEntries(response.headers),body:await response.text()};
}
export const history=ingress;

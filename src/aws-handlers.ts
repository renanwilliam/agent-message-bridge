import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { DynamoStore } from './dynamo-store.js';
import { env } from './config.js';
import { runtime } from './runtime.js';
import type { Key } from './store.js';
import { createStreamWake, type StreamRecord } from './dispatch.js';
import { createDeliveryHandler } from './delivery-handler.js';
import { mapBounded } from './concurrency.js';
const sqs=new SQSClient({});
async function enqueue(key:Key) {await sqs.send(new SendMessageCommand({QueueUrl:env('OUTBOX_QUEUE_URL'),MessageBody:JSON.stringify({pk:key.pk,sk:key.sk})}));}
export async function sweep() {const rows=await new DynamoStore(env('TABLE_NAME')).due(Date.now(),100);await mapBounded(rows,4,enqueue);return {enqueued:rows.length};}
export async function streamWake(event:{Records:StreamRecord[]}) {
  return createStreamWake(enqueue,env('INSTALLATION_ID'))(event);
}
export async function delivery(event:{Records:{messageId:string;body:string}[]}) {
  const {worker,store}=await runtime();
  return createDeliveryHandler(store,worker,env('INSTALLATION_ID'))(event);
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

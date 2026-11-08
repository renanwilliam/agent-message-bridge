import { DynamoStore } from '../src/dynamo-store.js';
import { env } from '../src/config.js';
import type { Delivery } from '../src/types.js';
// Operator-only CLI using the caller's existing AWS identity. Never prints message bodies or secrets.
const [pk,sk,mode]=process.argv.slice(2);
if(!pk||!sk||mode&&mode!=='--apply')throw new Error('Usage: requeue.ts <partition-key> <delivery-id> [--apply]');
const store=new DynamoStore(env('TABLE_NAME'));const row=await store.get<Delivery>({pk,sk});
if(!row||row.value.status!=='dead')throw new Error('Only a dead outbox delivery can be requeued');
if(!pk.includes('#outbox#'))throw new Error('Not an outbox record');
if(mode==='--apply')await store.commit([{pk,sk,expected:row.version,value:{...row.value,status:'pending',attempts:0,leaseUntil:0,fence:row.value.fence+1,lastError:undefined},dueAt:Date.now()}]);
console.log(JSON.stringify({applied:mode==='--apply',previousAttempts:row.value.attempts,previousStatus:row.value.status}));

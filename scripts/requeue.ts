import { DynamoStore } from '../src/dynamo-store.js';
import { env } from '../src/config.js';
import { recoverDelivery } from '../src/recovery.js';
// Operator-only CLI using the caller's existing AWS identity. Never prints message bodies or secrets.
const [pk,sk,mode,version]=process.argv.slice(2);
if(!pk||!sk||mode&&mode!=='--apply'||process.argv.length>6||mode==='--apply'&&!/^[1-9][0-9]*$/.test(version??''))throw new Error('Usage: requeue.ts <partition-key> <delivery-id> [--apply <reviewed-version>]');
console.log(JSON.stringify(await recoverDelivery(new DynamoStore(env('TABLE_NAME')),{pk,sk},{apply:mode==='--apply',expectedVersion:version===undefined?undefined:Number(version)})));

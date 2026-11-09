import type { Store } from './store.js';
import type { Worker } from './worker.js';
import { tenantKey, type Delivery } from './types.js';
import { deliveryMetric } from './observability.js';
type Records={Records:{messageId:string;body:string}[]};
export function createDeliveryHandler(store:Store,worker:Pick<Worker,'deliver'>,installation:string,emit:(value:ReturnType<typeof deliveryMetric>)=>void=value=>console.log(JSON.stringify(value))) {
  return async(event:Records)=>{
    const batchItemFailures:{itemIdentifier:string}[]=[];
    for(const record of event.Records) {
      try {
        const key=JSON.parse(record.body);
        if(typeof key.pk!=='string'||typeof key.sk!=='string'||key.pk.split('#').length!==3||!key.pk.startsWith(`${installation}#outbox#`)||!/^[a-f0-9]{64}$/.test(key.sk))throw new Error('invalid key');
        const canonical={pk:key.pk,sk:key.sk};
        const before=await store.get<Delivery>(canonical);
        if(before && (before.pk!==tenantKey(installation,'outbox',before.value.owner)||before.value.tenant!==installation||before.value.id!==key.sk||before.value.message.recipient!==before.value.owner))throw new Error('invalid delivery');
        const result=await worker.deliver(canonical);
        const row=await store.get<Delivery>(canonical);
        emit(deliveryMetric(result,row?.value));
      } catch {
        emit(deliveryMetric('failed',undefined));
        batchItemFailures.push({itemIdentifier:record.messageId});
      }
    }
    return {batchItemFailures};
  };
}

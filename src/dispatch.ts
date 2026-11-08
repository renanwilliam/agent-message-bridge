import type { Key } from './store.js';
export interface StreamRecord {
  eventID: string;
  eventName?: string;
  dynamodb?: { SequenceNumber?: string; Keys?: {pk?:{S?:string};sk?:{S?:string}} };
}
/** The KEYS_ONLY stream carries no values. Filter by key rather than inspecting an image. */
export function createStreamWake(enqueue:(key:Key)=>Promise<void>,installationId:string) {
  if(!/^[A-Za-z0-9_-]{1,100}$/.test(installationId))throw new Error('Invalid installation identifier');
  return async(event:{Records:StreamRecord[]})=>{
    const batchItemFailures:{itemIdentifier:string}[]=[];
    for(const record of event.Records) {
      if(record.eventName!=='INSERT')continue;
      const key=record.dynamodb?.Keys;const pk=key?.pk?.S;const sk=key?.sk?.S;
      if(!pk||!sk)continue;
      const segments=pk.split('#');
      if(segments.length!==3||segments[0]!==installationId||segments[1]!=='outbox'||
        !/^[A-Za-z0-9_-]{1,100}$/.test(segments[2]!)||!/^[a-f0-9]{64}$/.test(sk))continue;
      try{await enqueue({pk,sk});}catch{batchItemFailures.push({itemIdentifier:record.dynamodb?.SequenceNumber??record.eventID});}
    }
    return {batchItemFailures};
  };
}

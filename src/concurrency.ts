/** Bounded work; wait for all started operations before reporting a failure. */
export async function mapBounded<T,R>(items:readonly T[],concurrency:number,operation:(item:T)=>Promise<R>):Promise<R[]> {
  if(!Number.isSafeInteger(concurrency)||concurrency<1||concurrency>100)throw new Error('invalid_concurrency');
  const results:R[]=new Array(items.length);let next=0;let failure:unknown;let failed=false;
  await Promise.all(Array.from({length:Math.min(items.length,concurrency)},async()=>{
    while(!failed) {
      const index=next++;if(index>=items.length)return;
      try {results[index]=await operation(items[index]!);} catch(error) {failed=true;failure=error;}
    }
  }));
  if(failed)throw failure;
  return results;
}

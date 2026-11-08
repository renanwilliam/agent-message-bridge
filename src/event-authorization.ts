import { Conflict, type Store } from './store.js';
import { BridgeError, tenantKey, type EventAuthorization } from './types.js';

const identifier=/^[A-Za-z0-9_-]{1,100}$/;
// Decimal strings avoid JSON number precision loss while remaining monotonic.
const epochPattern=/^[1-9][0-9]{0,15}$/;
export function eventAuthorizationKey(tenant:string,owner:string) {
  if(typeof tenant!=='string'||typeof owner!=='string'||!identifier.test(tenant)||!identifier.test(owner))throw new BridgeError('invalid_event_authorization_identity');
  return {pk:tenantKey(tenant,'subscriptions',owner),sk:'_authorization'};
}
export function eventAuthorizationAllows(value:EventAuthorization|undefined,epoch:string|undefined):boolean {
  return typeof epoch==='string'&&epochPattern.test(epoch)&&value?.active===true&&value.epoch===epoch;
}

/** Operator-only provisioning/revocation primitive, never a client-facing MCP tool.
 * Every change needs a fresh epoch and the exact prior epoch. A stale grant can
 * therefore neither overwrite a revocation nor reactivate old subscriptions.
 */
export async function setEventAuthorization(
  store:Store, identity:{tenant:string;owner:string},
  next:EventAuthorization, expectedEpoch:string|null,
):Promise<EventAuthorization> {
  const key=eventAuthorizationKey(identity.tenant,identity.owner);
  if(!next||!epochPattern.test(next.epoch)||typeof next.active!=='boolean'||
      (expectedEpoch!==null&&(typeof expectedEpoch!=='string'||!epochPattern.test(expectedEpoch)))) {
    throw new BridgeError('invalid_event_authorization');
  }
  const existing=await store.get<EventAuthorization>(key);
  if((existing?.value.epoch??null)!==expectedEpoch)throw new BridgeError('event_authorization_conflict',409);
  if(existing&&(!epochPattern.test(existing.value.epoch)||BigInt(next.epoch)<=BigInt(existing.value.epoch)))throw new BridgeError('event_authorization_epoch_reuse',409);
  try {await store.commit([{...key,expected:existing?.version??null,value:{epoch:next.epoch,active:next.active}}]);}
  catch(error){if(error instanceof Conflict)throw new BridgeError('event_authorization_conflict',409);throw error;}
  return {epoch:next.epoch,active:next.active};
}

import type { Key, Store } from './store.js';
import { tenantKey, type Delivery, type Subscription, type EventAuthorization } from './types.js';
import { messageExpired, claimSortKey } from './retention.js';
import { eventAuthorizationAllows, eventAuthorizationKey } from './event-authorization.js';

/** Operator-only, default dry-run. A fresh successful delivery is not proof of processing.
 * Historical records without acceptance evidence require recipient reconciliation first.
 */
export async function recoverDelivery(store:Store,key:Key,options:{apply?:boolean;expectedVersion?:number;maxRecoveries?:number}={},now=Date.now()) {
  const row=await store.get<Delivery>(key);
  if(!row || row.value.status!=='dead')throw new Error('only_dead_delivery');
  const value=row.value;
  if(key.pk!==tenantKey(value.tenant,'outbox',value.owner)||key.sk!==value.id)throw new Error('delivery_identity_mismatch');
  if(messageExpired(value.message,now))throw new Error('message_expired');
  if(value.acceptedAt!==undefined || value.acceptanceUncertain===true || (value.attempts>0||(value.recoveredAttempts??0)>0) && value.acceptanceUncertain!==false)throw new Error('acceptance_uncertain_reconcile_recipient');
  const max=options.maxRecoveries??1;
  if(!Number.isSafeInteger(max)||max<1||max>10||(value.recoveryCount??0)>=max)throw new Error('recovery_budget_exhausted');
  const claimKey={pk:tenantKey(value.tenant,'claims',value.message.conversationId),sk:claimSortKey(value.message)};
  const claim=await store.get<{status:string;leaseUntil:number}>(claimKey);
  if(claim?.value.status==='done'||claim&&claim.value.leaseUntil>now)throw new Error('processing_completed_or_reserved');
  if(value.kind==='event') {
    const sub=await store.get<Subscription>({pk:tenantKey(value.tenant,'subscriptions',value.owner),sk:value.subscriptionId!});
    const auth=await store.get<EventAuthorization>(eventAuthorizationKey(value.tenant,value.owner));
    if(!sub?.value.active||sub.value.expiresAt<=now||sub.value.generation!==value.subscriptionGeneration||
      sub.value.owner!==value.owner||sub.value.tenant!==value.tenant||
      !eventAuthorizationAllows(auth?.value,value.subscriptionAuthorizationEpoch)||sub.value.authorizationEpoch!==value.subscriptionAuthorizationEpoch)throw new Error('subscription_not_authorized');
  }
  if(options.apply) {
    if(options.expectedVersion!==row.version)throw new Error('reviewed_version_required');
    await store.commit([
      {...key,expected:row.version,retentionExpiresAt:row.retentionExpiresAt,value:{...value,status:'pending',attempts:0,
        recoveredAttempts:(value.recoveredAttempts??0)+value.attempts,recoveryCount:(value.recoveryCount??0)+1,
        leaseUntil:0,fence:value.fence+1,lastError:undefined},dueAt:now},
      // CAS also fences a claim acquired/completed between inspection and mutation.
      {...claimKey,expected:claim?.version??null,retentionExpiresAt:claim?.retentionExpiresAt,...(claim?{value:claim.value}:{})},
    ]);
  }
  return {applied:options.apply===true,version:row.version,previousAttempts:value.attempts,recoveryCount:value.recoveryCount??0};
}

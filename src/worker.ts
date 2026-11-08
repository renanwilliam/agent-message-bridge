import { Conflict, type Store, type Key, type Row } from './store.js';
import { tenantKey, validSubscriptionGeneration, type Delivery, type Subscription, type SubscriptionSecret, type OutboundPost, type EventAuthorization } from './types.js';
import { signWebhook } from './transport.js';
import { eventAuthorizationAllows, eventAuthorizationKey } from './event-authorization.js';
import { isAdditionalAuthHeader } from './webhook-auth.js';
import type { PrivateConfig } from './config.js';
export type WebhookRoute = PrivateConfig['routes'][string];
export interface WorkerConfig { deliveryEnabled?: boolean; routes: Record<string,WebhookRoute>; leaseMs: number; retryMs: number; maxAttempts: number; responseWaitMs: number }
export class Worker {
  constructor(readonly store:Store, readonly config:WorkerConfig, readonly post:OutboundPost, readonly now:()=>number=Date.now) {}
  async deliver(key:Key):Promise<string> {
    const row=await this.store.get<Delivery>(key); const at=this.now();
    if(!row || row.value.status!=='pending' || row.dueAt===undefined || row.dueAt>at || row.value.leaseUntil>at) return 'skipped';
    const value={...row.value,fence:row.value.fence+1,leaseUntil:at+this.config.leaseMs};
    try { await this.store.commit([{...key,expected:row.version,value,dueAt:value.leaseUntil}]); } catch(e) { if(e instanceof Conflict) return 'contended'; throw e; }
    let leaseVersion=row.version+1;
    const finish=async(status:Delivery['status'],error?:string,dueAt?:number,attempts=value.attempts)=> {
      try {
        await this.store.commit([{...key,expected:leaseVersion,value:{...value,status,lastError:error,leaseUntil:0,attempts},dueAt}]);
        return status;
      } catch(e) { if(e instanceof Conflict) return 'fenced'; throw e; }
    };
    if(this.config.deliveryEnabled===false) return finish('dead','integration_not_configured');
    let url:string; let body:string; let headers:Record<string,string>;
    let eventSub:Row<Subscription>|undefined;
    const subscriptionActive=(sub:Subscription|undefined,now:number):sub is Subscription=>!!sub&&sub.active&&sub.expiresAt>now&&sub.id===value.subscriptionId&&sub.tenant===value.tenant&&sub.owner===value.owner&&sub.event==='message.received'&&(!sub.params.conversationId||sub.params.conversationId===value.message.conversationId)&&value.message.recipient===value.owner;
    if(value.kind==='event') {
      const sub=await this.store.get<Subscription>({pk:tenantKey(value.tenant,'subscriptions',value.owner),sk:value.subscriptionId!});
      if(!subscriptionActive(sub?.value,this.now())) return finish('done','subscription_inactive');
      if(!validSubscriptionGeneration(sub!.value.generation)||value.subscriptionGeneration!==sub!.value.generation)return finish('done','subscription_generation_changed');
      const authorization=await this.store.get<EventAuthorization>(eventAuthorizationKey(value.tenant,value.owner));
      if(!eventAuthorizationAllows(authorization?.value,sub!.value.authorizationEpoch)||value.subscriptionAuthorizationEpoch!==sub!.value.authorizationEpoch)return finish('done','event_access_revoked');
      const signing=await this.store.get<SubscriptionSecret>({pk:tenantKey(value.tenant,'subscription-secrets',value.owner),sk:sub.value.id});
      if(!signing?.value.secret || !signing.value.url) return finish('dead','subscription_secret_missing');
      eventSub=sub;
      url=signing.value.url;
      body=JSON.stringify({eventId:value.id,name:'message.received',timestamp:value.message.timestamp,data:{messageId:value.message.id,conversationId:value.message.conversationId,sender:value.message.sender,recipient:value.message.recipient,correlationId:value.message.correlationId,timestamp:value.message.timestamp},cursor:null});
      headers={}; // Sign after the final authorization/rotation reads, immediately before POST.
    } else {
      // O aceite do aviso não conclui o trabalho; a claim termina por resposta ou ACK terminal com fence.
      const claim=await this.store.get<{status:string;leaseUntil:number}>({pk:tenantKey(value.tenant,'claims',value.message.conversationId),sk:`claim#${value.message.id}`});
      if(claim?.value.status==='done') return finish('done');
      if(claim && claim.value.leaseUntil>at) return finish('pending',undefined,claim.value.leaseUntil+1);
      const route=this.config.routes[`${value.tenant}:${value.owner}`];
      if(!route) return finish('dead','route_missing');
      if(route.additionalAuthHeader!==undefined && !isAdditionalAuthHeader(route.additionalAuthHeader))return finish('dead','route_invalid');
      url=route.url;
      body=JSON.stringify({type:'message.available',deliveryId:value.id,messageId:value.message.id,conversationId:value.message.conversationId,correlationId:value.message.correlationId});
      headers={'content-type':'application/json',authorization:`Bearer ${route.bearer}`,'idempotency-key':value.id};
      if(route.additionalAuthHeader!==undefined)headers[route.additionalAuthHeader.toLowerCase()]=route.bearer;
    }
    if(value.attempts>=this.config.maxAttempts) return finish('dead','attempts_exhausted');
    const attempts=value.attempts+1;
    // Charge the attempt durably before crossing the network boundary. A crash
    // after a successful POST must not reset the bounded retry budget.
    const attempted={...value,attempts,leaseUntil:this.now()+this.config.leaseMs};
    try {
      await this.store.commit([{...key,expected:leaseVersion,value:attempted,dueAt:attempted.leaseUntil}]);
    } catch(e) { if(e instanceof Conflict) return 'fenced'; throw e; }
    leaseVersion++;
    Object.assign(value,attempted);
    if(eventSub){
      const signing=await this.store.get<SubscriptionSecret>({pk:tenantKey(value.tenant,'subscription-secrets',value.owner),sk:eventSub.value.id});
      const current=await this.store.get<Subscription>({pk:eventSub.pk,sk:eventSub.sk});
      const authorization=await this.store.get<EventAuthorization>(eventAuthorizationKey(value.tenant,value.owner));
      const signedAt=this.now();
      if(!subscriptionActive(current?.value,signedAt))return finish('done','subscription_inactive');
      if(!validSubscriptionGeneration(current!.value.generation)||value.subscriptionGeneration!==current!.value.generation)return finish('done','subscription_generation_changed');
      if(!eventAuthorizationAllows(authorization?.value,current!.value.authorizationEpoch)||value.subscriptionAuthorizationEpoch!==current!.value.authorizationEpoch)return finish('done','event_access_revoked');
      if(current!.version!==eventSub.version)return finish('pending','subscription_changed',signedAt);
      if(!signing?.value.secret||!signing.value.url)return finish('dead','subscription_secret_missing');
      if(value.leaseUntil<=signedAt)return finish('pending','lease_expired',signedAt);
      const keys=[signing.value.secret];
      if(signing.value.previousSecret&&typeof signing.value.previousSecretExpiresAt==='number'&&Number.isFinite(signing.value.previousSecretExpiresAt)&&signing.value.previousSecretExpiresAt>signedAt)keys.push(signing.value.previousSecret);
      try {headers={...signWebhook(keys,value.id,body,signedAt),'x-mcp-subscription-id':current!.value.id};}
      catch {return finish('dead','subscription_secret_invalid');}
      url=signing.value.url;
    }
    try {
      const response=await this.post(url,body,headers);
      if(response.status>=200 && response.status<300) {
        return value.kind==='event'?finish('done',undefined,undefined,attempts):finish('pending',undefined,at+this.config.responseWaitMs,attempts);
      }
      const permanent=response.status>=400 && response.status<500 && ![408,425,429].includes(response.status);
      return finish(permanent || attempts>=this.config.maxAttempts?'dead':'pending',`http_${response.status}`,permanent || attempts>=this.config.maxAttempts?undefined:at+this.backoff(attempts),attempts);
    } catch {
      return finish(attempts>=this.config.maxAttempts?'dead':'pending','network_error',attempts>=this.config.maxAttempts?undefined:at+this.backoff(attempts),attempts);
    }
  }
  private backoff(attempt:number) { return Math.min(this.config.retryMs*2**(attempt-1),3600000); }
  async drain(limit=100) { const rows=await this.store.due(this.now(),limit); return Promise.all(rows.map(row=>this.deliver(row))); }
}

import { EMIT_MESSAGE_GENERATION } from './release-protocol.js';
import { claimSortKey, HISTORY_RETENTION_MS, messageExpired, retentionDeadline, retentionTTL } from './retention.js';
import { createHash, randomUUID } from 'node:crypto';
import { activeSubscriptions } from './events.js';
import { Conflict, type Store, type Write } from './store.js';
import { BridgeError, requireScope, tenantKey, type Principal, type Message, type MessageInput, type Delivery } from './types.js';

const identifier = /^[a-zA-Z0-9_-]{1,100}$/;
export function id(value: unknown): string { if (typeof value !== 'string' || !identifier.test(value)) throw new BridgeError('invalid_id'); return value; }
export interface BridgeConfig { /** @deprecated Accepted for old configurations, ignored. */ maxTurns?: number; messagesPerMinute: number; claimMs: number; webhookRecipients: string[] }
interface Conversation { participants: string[]; count: number; correlationId: string; claimFence?: number }
interface Claim { owner: string; fence: number; leaseUntil: number; status: 'running'|'done'; responseId?: string; outcome?: 'acknowledged' }
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export class Bridge {
  constructor(readonly store: Store, readonly config: BridgeConfig, readonly now: () => number = Date.now, private readonly emitMessageGeneration = EMIT_MESSAGE_GENERATION) {}
  private async retry<T>(operation: () => Promise<T>): Promise<T> {
    for (let n=0; n<12; n++) { try { return await operation(); } catch (e) { if (!(e instanceof Conflict)) throw e; } }
    throw new BridgeError('busy_retry', 409);
  }
  private async conversation(p: Principal, conversationId: string) {
    const row = await this.store.get<Conversation>({pk:tenantKey(p.tenant,'meta',id(conversationId)),sk:'meta'});
    if (!row || !(row.value.participants.includes(p.id) || (p.scopes.includes('history:read') && p.readParticipants?.some(member=>row.value.participants.includes(member))))) throw new BridgeError('conversation_not_found',404);
    return row;
  }
  async send(p: Principal, input: MessageInput): Promise<{message: Message; duplicate: boolean}> {
    if (input.replyTo) throw new BridgeError('responses_require_claim_and_complete');
    return this.publish(p,input);
  }
  private async publish(p: Principal, input: MessageInput, reservation?: {messageId:string; fence:number}) {
    requireScope(p,'messages:send');
    id(input.id); id(input.conversationId); id(input.recipient); id(p.id); id(p.tenant);
    if (!p.peers.includes(input.recipient) || p.id===input.recipient) throw new BridgeError('recipient_forbidden',403);
    if (typeof input.text!=='string' || !input.text.trim() || Buffer.byteLength(input.text)>16384) throw new BridgeError('invalid_text');
    const canonical = {id:input.id,conversationId:input.conversationId,recipient:input.recipient,text:input.text,replyTo:input.replyTo ?? null};
    const fingerprint = digest(canonical);
    return this.retry(async()=> {
      const pk=tenantKey(p.tenant,'meta',input.conversationId);
      const historyPk=tenantKey(p.tenant,'history',input.conversationId);
      const claimsPk=tenantKey(p.tenant,'claims',input.conversationId);
      const dedupKey={pk:tenantKey(p.tenant,'dedup',p.id),sk:input.id};
      const previous = await this.store.get<{fingerprint:string;conversationId:string;messageId:string}>(dedupKey);
      if (previous) {
        if (previous.retentionExpiresAt !== undefined && previous.retentionExpiresAt * 1000 <= this.now()) throw new BridgeError('message_expired',410);
        if (previous.value.fingerprint!==fingerprint) throw new BridgeError('idempotency_conflict',409);
        const persisted=await this.store.get<Message>({pk:tenantKey(p.tenant,'history',previous.value.conversationId),sk:`id#${previous.value.messageId}`});
        if(!persisted || messageExpired(persisted.value,this.now())) throw new BridgeError('message_expired',410);
        if(persisted.value.sender!==p.id) throw new BridgeError('message_unavailable',503);
        return {message:persisted.value,duplicate:true};
      }
      const existingMessage=await this.store.get<Message>({pk:historyPk,sk:`id#${input.id}`});
      if(existingMessage) {
        if(messageExpired(existingMessage.value,this.now())) throw new BridgeError('message_expired',410);
        // Another publication may have committed after the empty dedup read.
        // Re-read its fingerprint to distinguish an identical retry from changed input.
        if(existingMessage.value.sender===p.id) throw new Conflict();
        throw new BridgeError('message_id_conflict',409);
      }
      const at=this.now();
      const conv = await this.store.get<Conversation>({pk,sk:'meta'});
      if (conv && (!conv.value.participants.includes(p.id) || !conv.value.participants.includes(input.recipient))) throw new BridgeError('conversation_forbidden',403);
      const rateKey={pk:tenantKey(p.tenant,'rate',p.id),sk:String(Math.floor(at/60000))};
      const rate=await this.store.get<{count:number}>(rateKey);
      if ((rate?.value.count??0)>=this.config.messagesPerMinute) throw new BridgeError('rate_limit',429);
      const writes: Write[]=[];
      let claimDeadline: number | undefined;
      if (reservation) {
        const parent=await this.getMessage(p,input.conversationId,reservation.messageId);
        if(parent.recipient!==p.id || parent.sender!==input.recipient) throw new BridgeError('claim_forbidden',403);
        const claimKey={pk:claimsPk,sk:claimSortKey(parent)};
        const claim=await this.store.get<Claim>(claimKey);
        if(!claim || claim.value.owner!==p.id || claim.value.fence!==reservation.fence || claim.value.leaseUntil<=at || claim.value.status!=='running') throw new BridgeError('stale_claim',409);
        claimDeadline=Math.min(claim.value.leaseUntil,retentionDeadline(parent));
        writes.push({...claimKey,expected:claim.version,retentionExpiresAt:claim.retentionExpiresAt ?? retentionTTL(parent),value:{...claim.value,status:'done',responseId:input.id}});
      }
      if(!Number.isSafeInteger((conv?.value.count??0)+1)) throw new BridgeError('sequence_exhausted',409);
      const message: Message={...(this.emitMessageGeneration?{generation:randomUUID()}:{}),id:input.id,conversationId:input.conversationId,correlationId:conv?.value.correlationId??input.id,sender:p.id,recipient:input.recipient,text:input.text,timestamp:new Date(at).toISOString(),turn:(conv?.value.count??0)+1,...(input.replyTo?{replyTo:input.replyTo}:{})};
      writes.push({pk,sk:'meta',expected:conv?.version??null,value:{...(conv?conv.value:{claimFence:0}),participants:conv?.value.participants??[p.id,input.recipient],count:message.turn,correlationId:message.correlationId}},
        {pk:historyPk,sk:`message#${message.turn<10_000_000_000?String(message.turn).padStart(10,'0'):'~'+String(message.turn).padStart(16,'0')}#${message.id}`,expected:null,retentionExpiresAt:retentionTTL(message),value:message},
        {pk:historyPk,sk:`id#${message.id}`,expected:null,retentionExpiresAt:retentionTTL(message),value:message},
        {...dedupKey,expected:null,retentionExpiresAt:retentionTTL(message),value:{fingerprint,conversationId:message.conversationId,messageId:message.id}},
        {...rateKey,expected:rate?.version??null,retentionExpiresAt:Math.ceil((Math.floor(at/60000)*60000+60000+HISTORY_RETENTION_MS)/1000),value:{count:(rate?.value.count??0)+1,expiresAt:Math.floor(at/1000)+86400}});
      // All event outbox rows are committed atomically with the history; no network in this transaction.
      const subscriptions=await activeSubscriptions(this.store,p.tenant,input.recipient,at);
      for(const sub of subscriptions) {
        if(!sub.params.conversationId || sub.params.conversationId===input.conversationId) {
          writes.push(this.outbox(p.tenant,message,'event',at,sub.id,sub.authorizationEpoch,sub.generation));
        }
      }
      if(this.config.webhookRecipients.includes(`${p.tenant}:${input.recipient}`)) writes.push(this.outbox(p.tenant,message,'webhook',at));
      if(claimDeadline!==undefined && claimDeadline<=this.now()) throw new BridgeError('stale_claim',409);
      await this.store.commit(writes);
      return {message,duplicate:false};
    });
  }
  private outbox(tenant:string,message:Message,kind:Delivery['kind'],at:number,subscriptionId?:string,subscriptionAuthorizationEpoch?:string,subscriptionGeneration?:string): Write {
    const eventId=digest([tenant,message.sender,message.id,kind,subscriptionId??null,...(message.generation?[message.generation]:[])]);
    const notice={id:message.id,conversationId:message.conversationId,correlationId:message.correlationId,sender:message.sender,recipient:message.recipient,timestamp:message.timestamp,generation:message.generation};
    const delivery:Delivery={id:eventId,kind,tenant,owner:message.recipient,message:notice,subscriptionId,subscriptionAuthorizationEpoch,subscriptionGeneration,attempts:0,fence:0,leaseUntil:0,status:'pending'};
    return {pk:tenantKey(tenant,'outbox',message.recipient),sk:eventId,expected:null,retentionExpiresAt:retentionTTL(message),value:delivery,dueAt:at};
  }
  async history(p:Principal,conversationId:string,limit=30,cursor?:string) {
    if(!p.scopes.includes('history:read')) requireScope(p,'messages:read'); await this.conversation(p,conversationId);
    const page=await this.store.query<Message>(tenantKey(p.tenant,'history',conversationId),'message#',limit,cursor);
    return {messages:page.items.filter(row=>!messageExpired(row.value,this.now())).map(row=>row.value),...(page.cursor?{cursor:page.cursor}:{})};
  }
  async getMessage(p:Principal,conversationId:string,messageId:string) {
    if(!p.scopes.includes('history:read')) requireScope(p,'messages:read'); await this.conversation(p,conversationId);
    const row=await this.store.get<Message>({pk:tenantKey(p.tenant,'history',conversationId),sk:`id#${id(messageId)}`});
    if(!row || messageExpired(row.value,this.now())) throw new BridgeError('message_not_found',404); return row.value;
  }
  async claim(p:Principal,conversationId:string,messageId:string) {
    requireScope(p,'messages:claim');
    const message=await this.getMessage(p,conversationId,messageId);
    if(message.recipient!==p.id) throw new BridgeError('claim_forbidden',403);
    return this.retry(async()=> {
      const key={pk:tenantKey(p.tenant,'claims',conversationId),sk:claimSortKey(message)};
      const row=await this.store.get<Claim>(key); const at=this.now();
      if(messageExpired(message,at)) throw new BridgeError('message_not_found',404);
      if(row?.value.status==='done') return row.value.outcome==='acknowledged'
        ? {status:'done' as const,outcome:'acknowledged' as const}
        : {status:'done' as const,responseId:row.value.responseId};
      if(row && row.value.leaseUntil>at) return {status:'busy' as const,retryAfter:row.value.leaseUntil};
      // The permanent conversation counter prevents ABA after TTL removes a claim.
      // Bootstrap from all legacy claim rows before any of those rows may be backfilled.
      const meta=await this.conversation(p,conversationId);
      let fence=meta.value.claimFence;
      if(fence===undefined) {
        fence=0; let cursor:string|undefined;
        do {
          const page=await this.store.query<Message>(tenantKey(p.tenant,'history',conversationId),'message#',100,cursor);
          for(const old of page.items) {
            const claim=await this.store.get<Claim>({pk:key.pk,sk:claimSortKey(old.value)});
            if(claim) fence=Math.max(fence,claim.value.fence);
          }
          cursor=page.cursor;
        } while(cursor);
      }
      fence=Math.max(fence,row?.value.fence??0)+1;
      if(!Number.isSafeInteger(fence)) throw new BridgeError('sequence_exhausted',409);
      const value:Claim={owner:p.id,fence,leaseUntil:Math.min(at+this.config.claimMs,retentionDeadline(message)),status:'running'};
      if(messageExpired(message,this.now())) throw new BridgeError('message_not_found',404);
      await this.store.commit([{pk:meta.pk,sk:meta.sk,expected:meta.version,value:{...meta.value,claimFence:fence}}, {...key,expected:row?.version??null,retentionExpiresAt:row?.retentionExpiresAt ?? retentionTTL(message),value}]);
      return {status:'claimed' as const,fence:value.fence,leaseUntil:value.leaseUntil,message};
    });
  }
  async complete(p:Principal,input: MessageInput & {replyTo:string;fence:number}) {
    requireScope(p,'messages:claim');
    if(!Number.isSafeInteger(input.fence) || input.fence<1) throw new BridgeError('invalid_fence');
    return this.publish(p,input,{messageId:id(input.replyTo),fence:input.fence});
  }
  async acknowledge(p:Principal,input:{conversationId:string;messageId:string;fence:number}) {
    requireScope(p,'messages:claim');
    if(!Number.isSafeInteger(input.fence) || input.fence<1) throw new BridgeError('invalid_fence');
    const message=await this.getMessage(p,input.conversationId,input.messageId);
    if(message.recipient!==p.id) throw new BridgeError('claim_forbidden',403);
    if(!message.replyTo) throw new BridgeError('acknowledgement_requires_reply');
    const key={pk:tenantKey(p.tenant,'claims',input.conversationId),sk:claimSortKey(message)};
    return this.retry(async()=> {
      const row=await this.store.get<Claim>(key);
      if(messageExpired(message,this.now())) throw new BridgeError('message_not_found',404);
      if(!row || row.value.owner!==p.id || row.value.fence!==input.fence) throw new BridgeError('stale_claim',409);
      const result={status:'done' as const,outcome:'acknowledged' as const,messageId:input.messageId};
      if(row.value.status==='done') {
        // Um retry consulta a conclusão existente mesmo após o lease original expirar.
        if(row.value.outcome==='acknowledged') return {...result,duplicate:true};
        throw new BridgeError('already_completed_with_response',409);
      }
      if(row.value.status!=='running' || row.value.leaseUntil<=this.now()) throw new BridgeError('stale_claim',409);
      const value:Claim={owner:p.id,fence:input.fence,leaseUntil:0,status:'done',outcome:'acknowledged'};
      await this.store.commit([{...key,expected:row.version,retentionExpiresAt:row?.retentionExpiresAt ?? retentionTTL(message),value}]);
      return {...result,duplicate:false};
    });
  }
}

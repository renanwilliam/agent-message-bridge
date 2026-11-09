import type { Delivery } from './types.js';
/** Deliberately excludes identifiers, exception messages, bodies and destinations. */
export function deliveryMetric(result:string,delivery:Delivery|undefined,now=Date.now(),functionName=process.env.AWS_LAMBDA_FUNCTION_NAME??'local') {
  const outcomes=['skipped','expired','contended','fenced','done','dead','pending','failed'];
  const outcome=outcomes.includes(result)?result:'failed';
  const kind=delivery?.kind==='event'?'event':delivery?.kind==='webhook'?'webhook':'unknown';
  const reason=delivery?.lastError;
  const safeReason=reason && /^(?:http_[1-5][0-9]{2}|mcp_error|network_error|attempts_exhausted|message_expired|integration_not_configured|route_missing|route_invalid|subscription_(?:inactive|generation_changed|secret_missing|secret_invalid|changed)|event_access_revoked|lease_expired)$/.test(reason)?reason:undefined;
  const published=Date.parse(delivery?.message.timestamp??'');
  const age=Number.isFinite(published)?Math.max(0,now-published):0;
  return {_aws:{Timestamp:now,CloudWatchMetrics:[{Namespace:'AgentMessageBridge',Dimensions:[['FunctionName'],['FunctionName','Kind','Outcome']],Metrics:[{Name:'DeliveryResult',Unit:'Count'},{Name:'MessageAge',Unit:'Milliseconds'},{Name:'DeadDelivery',Unit:'Count'},{Name:'UnconfirmedAcceptance',Unit:'Count'}]}]},
    FunctionName:functionName,Kind:kind,Outcome:outcome,DeliveryResult:1,MessageAge:age,DeadDelivery:outcome==='dead'||delivery?.status==='dead'&&delivery.lastError!=='message_expired'?1:0,
    UnconfirmedAcceptance:delivery?.acceptedAt!==undefined && delivery.processing!=='confirmed'?1:0,
    attempts:delivery?.attempts??0,...(safeReason?{reason:safeReason}:{})};
}

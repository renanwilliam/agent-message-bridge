import test from 'node:test';
import assert from 'node:assert/strict';
import { processingSnapshot } from '../scripts/processing-monitor.js';

test('processing monitor follows empty pages and exposes durable dead and accepted-unconfirmed state without identifiers',async()=>{
  const now=Date.UTC(2026,0,1);
  const result=await processingSnapshot(async(name,args)=>{
    if(name==='bridge_list_pending')return args.cursor?{messages:[{timestamp:new Date(now-600000).toISOString(),processing:'available',id:'private-id'},{timestamp:new Date(now-1000).toISOString(),processing:'running'}]}:{messages:[],cursor:'next'};
    if(name==='bridge_delivery_status')return {deliveries:[{status:'dead',processing:'unconfirmed',acceptanceEvidence:'recorded',expiredClaim:true,id:'private-id'},{status:'done',processing:'confirmed',acceptanceEvidence:'unknown'}]};
    return {authorizationActive:true,subscriptions:[{active:true,expired:true,authorized:true,generationValid:true}]};
  },{subscriptionHealth:true},now);
  assert.equal(result.AvailableMessages,1);assert.equal(result.RunningMessages,1);assert.equal(result.OldestPendingAge,600000);
  assert.equal(result.DeadDeliveries,1);assert.equal(result.AcceptedUnconfirmed,1);assert.equal(result.UnknownAcceptance,0);assert.equal(result.ExpiredLeases,1);assert.equal(result.UnhealthySubscriptions,1);
  assert.equal(JSON.stringify(result).includes('private-id'),false);
});
test('incomplete monitor pagination and protocol failures fail closed instead of reporting a healthy zero',async()=>{
  await assert.rejects(processingSnapshot(async()=>({messages:[],cursor:'more'}),{maxPages:1}),/page_budget/);
  await assert.rejects(processingSnapshot(async()=>({messages:[],cursor:'same'})),/invalid_monitor_cursor/);
  await assert.rejects(processingSnapshot(async()=>{throw new Error('failed');}),/failed/);
});

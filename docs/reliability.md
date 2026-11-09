# Delivery evidence and controlled recovery

## Evidence, not exactly-once

The canonical message transaction proves persistence. `attemptedAt` proves that an
attempt was durably charged before networking, not that it left the process.
`acceptedAt` records a successful transport receipt after checking for JSON-RPC
`error` and MCP `isError` envelopes. An empty 2xx callback remains compatible.
Neither result proves that the receiver processed anything.

Existing `pending`/`done`/`dead` delivery values remain compatible with older code.
In particular, **event `done` is transport-terminal, not processing-confirmed**.
`processing: unconfirmed` explicitly records that distinction for new receipts.
The authenticated claim is the processing source of truth: only `complete` or
terminal `acknowledge` proves completion within the bridge. A legacy delivery with
no acceptance timestamp has **unknown acceptance evidence**, not a fabricated
receipt. Status tools re-read claims, including for deliveries already dead.

The worker suppresses both kinds of notification when a claim is done and defers
while a claim is live. Network retries preserve event identity and signing rules.
Production retry delay uses bounded exponential backoff with equal jitter. Local
draining and sweep enqueueing use at most four concurrent operations. SQS still
uses the existing four-worker concurrency ceiling. The sweep selects up to 100
due rows per minute: this is a throughput bound, **not a delivery SLA**.

An accepted MCP event is not blindly replayed. A receiver can deduplicate it
without executing again, so changing `eventId` would be an unsafe workaround.
Remote effects need a receiver-owned idempotency ledger; bridge fencing protects
only bridge writes. A crash after a successful remote call remains uncertain.

## Inbox and authorization

`limits.inboxEnabled` is absent/false by default for safe code-only rollout.
When enabled on every writer, publication atomically creates one metadata-only
`inbox` pointer for its recipient, even with no active subscription or route.
It has the original message TTL and contains no text, callback URL or credential.

`bridge_list_pending` discovers incoming work across conversations for the
authenticated tenant and recipient. It requires both `messages:read` and
`messages:claim`, rechecks the conversation ACL and filters logical expiry and
completed claims. It returns `available` or `running`; an expired claim becomes
available again. Claim before acting. A successful list is not a reservation.

Consumers must run a reconciliation cycle through **all pages**, including empty
pages with a cursor, and start again without a cursor on the next cycle. Do not
permanently checkpoint past busy work. Never process `running` messages or bypass
fencing. Consumer scheduling, bounded concurrency and stopping terminal replies
remain necessary. The bridge does not itself run another agent or install a
receiver schedule.

`bridge_delivery_status` returns a bounded page of the recipient's delivery
metadata, dead states, attempts, acceptance evidence and current claim evidence.
It uses the same access checks and does not return signing values or message
text. Its discovery is also gated by inbox activation until Query IAM is ready.
`bridge_subscription_status` requires `events:subscribe` and returns only the
caller's bounded current registry, expiry and grant/generation health. It does
not renew a grant or prove continued external subscription renewal.

New inbox coverage starts only after activation. **Legacy history is not
automatically backfilled**, and publications by old/disabled writers have no
pointer. Before claiming complete recovery coverage, inventory legacy canonical
messages under operator access, review a resumable backfill of unexpired pointers
with original timestamps/generations/TTL, preserve ACLs, and verify every writer
has converged. No backfill, scan permission or data mutation is granted by the
runtime. Do not scan unrelated tables. Status queries can still diagnose existing
outbox rows once the reviewed Query grants are installed.

## Dead recovery

The operator CLI uses the existing AWS identity:

```sh
node --import tsx scripts/requeue.ts "$OUTBOX_PK" "$DELIVERY_ID"
node --import tsx scripts/requeue.ts "$OUTBOX_PK" "$DELIVERY_ID" --apply "$REVIEWED_VERSION"
```

The first invocation is read-only. Apply requires that exact reviewed version,
preserves the logical ID and TTL, retains accumulated prior attempts, increments
a recovery counter and uses a CAS guard on both delivery and claim. The default
manual recovery budget is one. The library allows an explicitly reviewed bound
up to ten; the CLI does not silently increase it. An in-flight claim or completion
after inspection causes a conflict instead of reopening work. A later claim can
still race a POST; the receiver must honor its own claim/idempotency contract.

Expired messages, confirmed work, live claims, recorded acceptance, legacy
attempts with unknown evidence and network/MCP/5xx uncertainty are refused.
Attempted recovery is allowed only for recorded 401/403/410/413 rejections, or
records that never charged an outbound attempt. Event recovery also rechecks
subscription activation generation, owner and authorization epoch. Delivery
rechecks these again. A recovered 410/413 is an explicit operator decision after
repair; those responses are never automatically retried.

Do not reset IDs, automatically reset budgets, recover every dead item, or treat
an uncertain mutation as failure and repeat it. Inspect canonical state first.
This CLI now needs operator claim condition-write/delete permission in addition
to outbox write permission; application workers do not gain that permission.

## Metrics and notification configuration

The delivery handler emits CloudWatch EMF to its existing private log group.
Dimensions are `FunctionName` and optionally bounded `Kind`/`Outcome`; there are
no per-message, conversation, subscriber or URL dimensions. Logs exclude arbitrary
exception/response text and message bodies. Signals include result, observed
message age, attempts, categorized failure, dead delivery and unconfirmed receipt.
A dead row observed on an SQS retry also emits the signal even if the prior
invocation died after committing its state.

These are **observations/counters, not a durable backlog gauge**. `MessageAge` is
age at an invocation, not age of every pending message. `UnconfirmedAcceptance`
does not prove that a receiver failed. Historical dead/accepted rows with no new
invocation require paginated status investigation; long-lived backlog and
subscription-health alarms require a scheduled, authorized state monitor.
Do not use DLQ emptiness or absence of EMF events as proof of health.

`scripts/processing-monitor.ts` provides that read-only snapshot collector through
the authenticated MCP tools, across all conversations of its recipient. It follows
empty pages, fails closed on incomplete pagination/protocol errors and emits gauges
for available/running work, oldest pending age, dead deliveries, recorded acceptance
without confirmation, unknown legacy acceptance and expired leases. Optional
subscription health flags missing, expired or unauthorized current registry entries.
Its EMF dimension is one configured `Monitor` name per monitored identity, never a
message/conversation/subscription ID. Snapshot pages are not a transaction and
counts can change during collection; missed monitor data is not a healthy zero.

Supply existing `BRIDGE_MONITOR_RESOURCE_URL`, `BRIDGE_MONITOR_TOKEN` and a
low-cardinality `BRIDGE_MONITOR_NAME`; set `BRIDGE_MONITOR_SUBSCRIPTIONS=true`
only when that principal already has the Events scope. An existing authorized
runner must schedule it and send stdout to its private CloudWatch log group. No
runner, credential, log permission or subscription is silently created. Coverage
remains inbox-only until reviewed legacy backfill.

Set the private infrastructure parameter `processingMonitorName` to that same
monitor name only after reviewing the runner. The optional gauge alarms cover
oldest pending age (`pendingAgeThresholdMs`, default 300000), accepted-unconfirmed
count (`unconfirmedCountThreshold`, default 1), durable dead backlog, subscription
health and missing heartbeat. `processingMonitorPeriodSeconds` defaults to 60;
choose a valid CloudWatch period matching the approved runner interval. The missing
heartbeat alarm treats three absent periods as breaching; other gauges use Maximum
and do not treat missing data as healthy evidence. If subscription monitoring is
disabled, its gauge is absent, not a verified healthy subscription. Review these
thresholds and alert destination before activation; the defaults are not an SLA.

The source template adds `DeadDeliveryAlarm` and optional `alarmTopicArn` actions
to it and the two existing DLQ alarms. The topic must already be authorized;
this change does not create a topic, subscription, credential or topic policy.
Without the parameter, alarms have **no notification destination**. Verify the
live AlarmActions, ActionsEnabled, SNS topic policy, confirmed subscriptions,
encryption permissions and a separately approved notification test. Alarm state
OK alone proves none of those. The dead alarm threshold is one observation per
minute, not a count of distinct dead deliveries.

## Rollout and rollback

1. Review code, tests, public diff and dependency audit on a branch. No merge is
   inert: `master` triggers production CD.
2. Ship compatible code with inbox disabled. Existing authentication, credentials,
   subscriptions, queues and TTL must be preserved. Verify all six function hashes.
3. Separately review the **live-template** infrastructure change: add inbox PutItem
   to MCP/ingress transaction allowlists and Query inbox/outbox to those roles;
   add/attach alarms to the approved topic. History, delivery, stream and sweep
   gain no extra data privileges. This is persistent access expansion and requires
   specific approval. Do not deploy the generic source template over a configured
   installation or accidentally disable its TTL.
4. Infrastructure changes must be reconciled into the private CD baseline and
   manifest before resuming code-only releases. Do not weaken the existing guards.
5. After IAM verification, enable `limits.inboxEnabled: true` in the existing
   role-specific writer configurations. Confirm every writer after cache expiry
   and natural invocation drain. Configure authorized receiver reconciliation and
   review legacy backfill before claiming all-history coverage.
6. Run the post-deploy test below. Missing receiver evidence is partial, not success.

Rollback first stops inbox activation and reconciles any in-flight publication.
Before returning to a parser that predates this feature, remove the optional
`inboxEnabled` field from private configurations entirely: the old strict parser
rejects even an explicit false value. Verify all writers after cache expiry.
Old code ignores additive pointers but cannot maintain recovery coverage. Do not
remove inbox/TTL/data or revoke IAM while a writer using them is still running.
Keep code that understands message generations, fencing and logical retention;
pre-retention code is not a safe rollback. Use the existing verified immutable
artifact procedure, never a blind retry or a blanket infrastructure replacement.

## Functional post-deploy probe

The workflow keeps existing deployment verification and then calls
`scripts/post-deploy-probe.ts`. The verified **actual deployed commit**, rather
than a stale queued target, comes from the CD hash/template checks. Release state
still records deployment independently: a failed probe does not pretend the code
was rolled back. It stops the job; inspect state before any remediation.

Configure existing authorized credentials via protected secrets, with separate
review of their scope and lifetime:

- `BRIDGE_PROBE_CONFIG`: private JSON with `resourceUrl`, authorized
  `conversationId`, `recipient`, optional `effectUrl`, and `waitMs` (1–180 seconds).
- `BRIDGE_PROBE_TOKEN`: existing sender MCP credential, never sent to the effect URL.
- `BRIDGE_PROBE_EFFECT_TOKEN`: separate existing ledger-reader credential if the
  independent effect verifier is used.

No secrets are created by this change. Do not add credentials or broaden access
merely to make the test pass. Without configuration CI emits `partial` with
`processingConfirmed: false`. With processing but no independent verifier it
still emits `partial`. Only an authorized controlled receiver with a durable
synthetic effect ledger can support the full check. Its verifier returns
`{runId, effects: 1, processingConfirmed: true}` for the exact run, never message
text or credentials. Duplicate effects fail the test. The receiver must honor
claim/complete and deduplicate its synthetic ledger by run ID.

The probe uses stable synthetic request IDs per deployed release and approved
target, reads paginated history, requires one authenticated fenced response and
terminal ACK, and checks the independent ledger when configured. Resuming uses
the same identity; a lost completion/ACK response is not a reason to generate new
messages. It does not alter an existing subscription or create an agent loop.
Its result logs no private target, identifiers, token or message text. Local
tests cover a real domain/store receiver and resume idempotence, not a live host.

A ledger read is a finite observation, not an exactly-once proof. The probe does
not establish a provider SLA or continuous renewal. Verify another observation
after the configured retry horizon and subscription renewal when those are the
acceptance goals. Polling or health/2xx alone is not processing evidence.

## First retention expiry checklist

Keep the actual first cutoff, exact keys and inventory private. Before that date,
verify enabled TTL attribute `retentionExpiresAt`, original deadlines on both
history copies, claims, dedup, pending/done/dead outbox, inbox and rate counters;
record a bounded manifest and expected namespace counts without message text.
Preserve metadata ACL/fence counters and the separate security lifecycle.

At the cutoff, use an existing authorized reader to verify logical invisibility
and inability to claim/complete/ACK expired messages. Do not resend, delete,
backdate or rewrite real data to exercise this. Check that no new outbound attempt
starts after the deadline. Unit tests exercise exact boundaries with an injected
clock; a network call begun before expiry may finish after it.

Afterward, read the exact manifest keys and observe physical disappearance of
both text copies and auxiliaries, including asynchronous out-of-order deletion.
Track DynamoDB `TimeToLiveDeletedItemCount`; it is aggregate evidence and does
not prove every manifest key disappeared. Physical deletion may take days;
report remaining eligible rows, not an invented exact deletion deadline.
Record continued ACL/fence safety and unaffected subscriptions. PITR snapshots,
on-demand backups, exports, queues and receiver copies require their own retention
inventory; primary-table TTL does not erase them. A future expiry observation
cannot be claimed from tests run before that date.

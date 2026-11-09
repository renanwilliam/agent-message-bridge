# Delivery evidence and controlled recovery

## Evidence, not exactly-once

The canonical message transaction proves persistence. `attemptedAt` proves that an
attempt was durably charged before networking, not that it left the process.
`acceptedAt` records the first successful transport receipt after checking for JSON-RPC
`error` objects and MCP `result.isError === true` in `jsonrpc: "2.0"` envelopes.
Generic webhook receipts such as `{ok:true,error:false}` or `error:""` are not
protocol errors. Empty, non-JSON and other 2xx receipts remain compatible.
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
`complete` and terminal `acknowledge` remove the original inbox pointer in the same
transaction as the confirmed claim. History, dedup, claims and outbox keep their
original TTL/evidence. This avoids rereading 14 days of already completed work.
Deletion is conditional on the pointer version; a failed transaction leaves both
the pointer and claim unchanged. Legacy messages without a pointer still complete.
Older completed pointers are filtered but not silently cleaned up; include them in
the separately reviewed migration if an earlier inbox version was ever activated.

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
text. Both its discovery and execution (including signed `/peer`) are gated by
inbox activation until IAM is ready. `/peer` explicitly accepts only `send`,
`history`, `claim`, `complete`, `acknowledge`, `pending` and `deliveries`; adding an
MCP tool never implicitly adds a signed ingress action.
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
`acceptanceUncertain` is persisted as true with the charged attempt, before POST.
Only a recorded 401/403/410/413 can clear that attempt's uncertainty, and only if
there was no prior uncertainty. A timeout, lost lease, process crash, MCP error or
5xx remains uncertain even after a later rejection. Attempted legacy records with
no cumulative evidence are refused, including those with `attemptedAt` and a safe
last error. Recovery does not reset this evidence or accumulated prior attempts.
Attempted recovery is allowed only with cumulative safe-rejection evidence, or
records that never charged an outbound attempt. Event recovery also rechecks
subscription activation generation, owner and authorization epoch. Delivery
rechecks these again. A recovered 410/413 is an explicit operator decision after
repair; those responses are never automatically retried.
Legacy dead records with zero current and prior attempts can still qualify. Do not
weaken this evidence check to restore the old CLI's blind requeue behavior.

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
Logical retention expiry is reported as `expired` and never contributes to
`DeadDelivery`, whether detected at entry, immediately before POST, or on redelivery.

These are **observations/counters, not a durable backlog gauge**. `MessageAge` is
age at an invocation, not age of every pending message. `UnconfirmedAcceptance`
does not prove that a receiver failed. Historical dead/accepted rows with no new
invocation require paginated status investigation; long-lived backlog and
subscription-health alarms require a scheduled, authorized state monitor.
Do not use DLQ emptiness or absence of EMF events as proof of health.

`scripts/processing-monitor.ts` provides that read-only snapshot collector through
the authenticated MCP tools, across all conversations of its recipient. It follows
empty pages, fails closed on incomplete pagination/protocol errors and emits gauges
for available/running work, oldest pending age, dead deliveries **without confirmed
processing**, unknown legacy acceptance and expired leases. A late inbox completion
clears the actionable dead gauge without erasing the historical transport failure.
Optional
subscription health flags missing, expired or unauthorized current registry entries.
Its EMF dimension is one configured `Monitor` name per monitored identity, never a
message/conversation/subscription ID. Snapshot pages are not a transaction and
counts can change during collection; missed monitor data is not a healthy zero.

Confirmation alerting is opt-in: set `BRIDGE_MONITOR_CLAIMS_EXPECTED=true` only for
a recipient whose controlled receiver implements claim/complete or terminal ACK.
`AcceptedUnconfirmed` then counts only accepted work with **no current live claim**
and first-acceptance age at least `BRIDGE_MONITOR_CONFIRMATION_GRACE_MS` (default
300000, range 1000–86400000). Repeated receipts preserve `acceptedAt`, so retries
cannot renew the grace period.
Fresh acceptances, running claims and completed work do not count. Without this
opt-in, the metric is absent, not a fabricated healthy zero. There is no inference
of processing for a receiver that provides no confirmation contract.

Supply existing `BRIDGE_MONITOR_RESOURCE_URL`, `BRIDGE_MONITOR_TOKEN` and a
low-cardinality `BRIDGE_MONITOR_NAME`; set `BRIDGE_MONITOR_SUBSCRIPTIONS=true`
only when that principal already has the Events scope. An existing authorized
runner must schedule it and send stdout to its private CloudWatch log group. No
runner, credential, log permission or subscription is silently created. Coverage
remains inbox-only until reviewed legacy backfill.

The collector bounds each invocation to `BRIDGE_MONITOR_MAX_PAGES` pages (default
100, range 1–1000), across inbox and retained outbox. Set
`BRIDGE_MONITOR_CHECKPOINT` to a persistent private path outside Git, in an existing
operator-owned directory, to resume larger cycles on subsequent invocations. It
stores only counters and the opaque continuation cursor, mode 0600, atomically;
the cursor can contain private identity metadata and must not be logged/shared.
State is bound to the target, credential and options. Rotation or configuration
changes automatically discard the old cursor and counters and start a fresh cycle;
partial state is never reused across credentials. A `.lock`
prevents concurrent writers; after a crash, inspect the runner before removing a
stale lock. No database grants or runner credentials are created.

Partial cycles emit only an explicit partial status, **no heartbeat or backlog
gauges**. Only a completed cycle emits a snapshot, timestamped at cycle start, and
the next cycle starts from the beginning. Checkpoints older than 15 minutes (or
ahead of the clock) are reset before collection. If a cycle expires during collection,
its result is discarded without gauges/heartbeat and its checkpoint is reset for
the next invocation. Repeated expiry still requires inspecting capacity/interval. Choose
page budget and scheduling so a full cycle completes within that bound and within
the heartbeat evaluation window. This bounds per-invocation cost, not total read
cost: retained outbox history is still revisited each complete cycle. Sustained
high-volume installations must size their runner/cadence accordingly; do not
silently raise budgets or claim real-time consistency.

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
The unconfirmed alarm additionally requires `processingClaimsExpected: 'true'`,
matching the collector opt-in. It is not created by default. A continuously
breaching gauge keeps its alarm in ALARM; SNS actions normally occur on state
transitions, not on every collection.

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
   Even before inbox activation, this release suppresses/defers **event** callbacks
   for completed/live claims (previously webhook-only), applies protocol error
   detection to ordinary webhook receipts too, and advertises
   `bridge_subscription_status` to `events:subscribe` callers. The read-only
   `bridge_probe_preflight` is visible to send/read/claim identities as well. These
   tool/worker changes are immediate on code deployment, not inbox-gated.
3. Separately review the **live-template** infrastructure change: add inbox PutItem
   to MCP/ingress transaction allowlists and Query inbox/outbox to those roles;
   also add inbox GetItem and **transaction-only DeleteItem** for atomic completion;
   add/attach alarms to the approved topic. History, delivery, stream and sweep
   gain no extra data privileges. This is persistent access expansion and requires
   specific approval. Do not deploy the generic source template over a configured
   installation or accidentally disable its TTL.
   The previously prepared PutItem/Query-only ChangeSet is insufficient for this
   revision. The additional inbox read/delete grants require specific approval and
   a newly reviewed ChangeSet; this PR does not execute or broaden live permissions.
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
Do not apply manual requeue while workers predating cumulative uncertainty tracking
are active, including during rollback; their attempts cannot maintain that evidence.

## Functional post-deploy probe

The workflow keeps existing deployment verification and then calls
`scripts/post-deploy-probe.ts`. The verified **actual deployed commit**, rather
than a stale queued target, comes from the CD hash/template checks. Release state
still records deployment independently: a failed probe does not pretend the code
was rolled back. It stops the job; inspect state before any remediation.

Configure existing authorized credentials via protected secrets, with separate
review of their scope and lifetime:

- `BRIDGE_PROBE_CONFIG`: private JSON with `resourceUrl`, authorized
  `conversationId`, `recipient`, **`sender`** and **`exclusiveSender: true`**, optional
  `effectUrl`, and `waitMs` (1–180 seconds).
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

Use an existing explicitly authorized **dedicated sender identity**, not a normal
agent connection. It must have no configured webhook, active event subscription,
or external polling/reconciliation consumer sharing its messages. The existing
receiver under test still needs its normal approved delivery/reconciliation path.
Before sending, `bridge_probe_preflight` checks the authenticated sender, configured
webhook in the current MCP writer configuration and active subscriptions using
existing MCP reads; the probe refuses a
mismatch or competing callback. `exclusiveSender: true` is the operator's explicit
attestation about external consumers, not a claim that the bridge can inspect
another agent's scheduler. Keep the identity reserved for the entire probe run;
preflight is a point-in-time check, not a lock against later configuration changes.
Operators must also verify the other writers' recipient configuration and drain
any pre-existing callbacks for that identity before reserving it for the probe.
Absent an already authorized suitable identity, leave the probe unconfigured and
report partial rather than minting credentials or reusing a live agent.

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

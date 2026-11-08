# Deferred bootstrap smoke test

`scripts/aws-smoke.ts` is an operator-only proof for an already deployed, explicitly approved bootstrap installation. Creating the script and passing its local tests does not run AWS or establish a real integration. Run it only after the concrete deployment and use of the operator's existing credentials are approved.

The script creates synthetic DynamoDB records and invokes the existing recovery Lambda. It creates no OAuth client, API credential, principal grant or configuration secret. The fixture principals exist only in the local process. It refuses to write until the operator account, resource account/region, table/index schema, active function target settings, enabled event mappings and delivery `BOOTSTRAP_MODE=true` have been checked. Both the AWS CLI identity and SDK resource ARNs must match the explicitly supplied account. AWS CLI v2 must already be available for read-only identity/Lambda checks and the explicit sweep invocation.

Supply these values privately from the approved deployed stack:

- `AWS_ACCOUNT_ID`, `TABLE_NAME`, `INSTALLATION_ID`, `AWS_REGION`.
- `LAMBDA_STREAM_NAME`, `LAMBDA_DELIVERY_NAME`, `LAMBDA_SWEEP_NAME` (unqualified function names).
- Optional `AWS_SMOKE_WAIT_MS` controls the bounded observation window; it is not a latency commitment.

Then, only when approved:

```sh
node --import tsx scripts/aws-smoke.ts --execute
```

The test directly exercises real DynamoDB transactions, identical-request deduplication, concurrent claims and publications, valid fenced completion, rejection of an incorrect fence, ordered history and transaction rollback **using the operator identity**. These checks do not prove the deployed MCP, ingress or history roles, JWT configuration or a live client connection. Lease-expiration recovery and stale-owner publication have separate local tests; this smoke does not claim to prove them against AWS.

Synthetic outbox INSERTs enter the deployed dispatch system. The test observes the delivery worker close them as `dead / integration_not_configured` with zero outbound attempts. It then requeues one exact existing fixture record using MODIFY. It records whether the key became visible in the due index or an active dispatcher already completed it, explicitly invokes the sweep function and observes terminal delivery again. This avoids treating a scheduled dispatcher winning the race as a failure. The existing sweep can enqueue up to 100 due records across the installation, including records outside this fixture; bootstrap delivery prevents outbound calls. With recovery scheduling and at-least-once queues active, these observations do not establish exclusive causal attribution to one dispatcher. The report preserves that limitation rather than claiming an exactly-once or connected-agent proof.

Only target identifiers, record keys, check outcomes and counts are retained in `.private/aws-smoke/<run-id>/evidence.json`. Arbitrary Lambda response/error bodies are discarded. Keep this directory private. Synthetic rows remain for review; the script never deletes records, scans table data, directly modifies unrelated keys or creates persistent access. The due-index query and invoked sweep are installation-wide operations. A failed/uncertain run records attempted and confirmed keys separately for investigation.

The real proof remains pending until deployment is approved and completed. End-to-end agent wake-up, OAuth registration and callback authorization remain a separate activation proof.

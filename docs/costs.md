# Cost model

This is a generic planning model, not an inventory or invoice for a particular installation. Keep the verified stack inventory, real resource identifiers and post-deployment estimate in the separate private deployment records. Packaging and CloudFormation validation do not establish which resources exist.

The following scenario is a planning estimate for **US East (N. Virginia)**, checked on 2026-11-06. It is not measured usage, an invoice, a traffic limit or a latency commitment. It assumes no free-tier credits are available, because credits can be consumed by other workloads in the account.

## Idle infrastructure illustration

Four configuration containers cost US$1.60/month even while their JSON is empty. Two standard one-metric alarms add US$0.20/month. These are the main fixed charges: **US$1.80/month before usage and credits**. [Secrets Manager pricing](https://aws.amazon.com/secrets-manager/pricing/), [CloudWatch pricing](https://aws.amazon.com/cloudwatch/pricing/)

For a 30-day idle bootstrap, assume 43,200 one-minute sweeps at 256 MiB and 250 ms average billed duration, 21,600 DynamoDB read units for empty eventual queries, 400,000 SQS operations, 0.05 GB of logs ingested and 0.025 GB stored, negligible table size and 2.3 MB of artifacts. This gives about US$0.045 Lambda, US$0.003 DynamoDB reads, US$0.043 Scheduler, US$0.16 SQS and US$0.026 logs. Allow another US$0.03 for 10,000 billable symmetric KMS operations. The resulting **illustration is approximately US$2.11/month**, excluding free-tier discounts. Duration, polls, log bytes and KMS use are assumptions to replace with measurements, not fixed charges or upper bounds. Bootstrap skips configuration-secret reads and blocks external delivery.

## Illustrative light-use installation

Assume 10,000 accepted messages per 30-day month, about 1 KiB of text per message, 30,000 API requests, and one delivery target per message. Assume 93,200 Lambda invocations including 43,200 recovery sweeps, all at 256 MiB with 250 ms average billed duration. Actual webhook waits, cold starts, retries, subscription fanout and conversation reads change these quantities.

For storage, assume **1 GiB of table data already retained**, a conservative 0.1 GiB storage budget for the keys-only GSI, and 200,000 billed write units plus 221,600 read units. These unit budgets include transaction overhead, outbox/claim updates, GSI writes and sweep reads; they are assumptions, not one DynamoDB operation per message. Transactional reads/writes consume additional capacity units. DynamoDB Standard on-demand prices are US$0.625 per million write units and US$0.125 per million read units; storage is about US$0.25/GB-month and PITR about US$0.20/GB-month of table data. [DynamoDB pricing](https://aws.amazon.com/dynamodb/pricing/)

| Component | Illustrative monthly cost, USD | Assumption |
| --- | ---: | --- |
| Four private configuration secrets | 1.65 | US$0.40 each plus 10,000 combined API calls |
| Two standard CloudWatch alarms | 0.20 | One standard metric per alarm |
| Lambda requests and ARM execution | 0.10 | 93,200 calls at 256 MiB and 250 ms average |
| API Gateway REST requests | 0.11 | 30,000 small requests at US$3.50/million |
| DynamoDB reads, writes, table/GSI storage and PITR | 0.63 | Unit and retained-storage assumptions above |
| SQS | 0.16 | 400,000 total operations, including an explicit allowance for empty receives |
| CloudWatch logs | 0.05 | 0.1 GB ingested; 0.05 GB stored |
| Scheduler | 0.04 | 43,200 invocations without applying its free tier |
| KMS request allowance | 0.03 | 10,000 billable symmetric operations; no customer-managed key rental |
| S3 artifact storage | <0.01 | About 2.3 MB in Standard storage |
| **Approximate subtotal** | **2.97** | Before taxes and the exclusions below |

Treat this as roughly **US$3/month under these assumptions**, with additional room for unmeasured traffic and operational usage. It is not measured usage from a deployed installation.

The four secrets separate MCP identity mappings, inbound peer verification, human history access, and outbound webhook credentials. Their references must be distinct. IAM policies grant each runtime only its own configuration reference; stream and sweep receive none. Subscription signing secrets stay in their separate DynamoDB namespace and do not create one Secrets Manager secret per subscription. Secret storage costs US$0.40 per secret-month and API calls US$0.05 per 10,000. [Secrets Manager pricing](https://aws.amazon.com/secrets-manager/pricing/)

The ARM compute rate used is US$0.0000133334/GB-second plus US$0.20 per million invocations. Reserved concurrency does not provision warm execution capacity; this template does not enable Provisioned Concurrency or provisioned event pollers. [AWS Lambda pricing](https://aws.amazon.com/lambda/pricing/), [official regional ARM price list](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AWSLambda/current/us-east-1/index.json)

SQS standard requests cost US$0.40 per million at the first paid tier in this region. Sends, receives, deletes and visibility operations count; empty receives can create idle costs. The three queues have no fixed queue rental. Lambda's SQS polling pattern must be measured; the 400,000 figure above is an allowance, not a documented guarantee or maximum. This template configures maximum concurrency, which disables Lambda's low-traffic optimization to two concurrent invokes. Do not estimate an exact idle poll count from concurrency alone. [SQS scaling behavior](https://docs.aws.amazon.com/lambda/latest/dg/services-sqs-scaling.html) [SQS pricing](https://aws.amazon.com/sqs/pricing/), [official regional SQS price list](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AWSQueueService/current/us-east-1/index.json)

The DynamoDB stream and due index project only keys, so neither duplicates message bodies or subscription secrets. The 0.1 GiB index allowance is deliberately conservative and must be replaced with the observed index size. The stream consumer adds Lambda execution/request costs. DynamoDB Streams reads made by Lambda triggers are not charged as standalone stream reads; this design does not use Kinesis capture or a provisioned polling service. GSI queries and writes still incur ordinary DynamoDB charges. [DynamoDB pricing](https://aws.amazon.com/dynamodb/pricing/)

Native MCP uses API Gateway REST response streaming. Small responses use the standard REST request price; larger streamed responses are metered in request-size increments, and network transfer can add charges. Lambda also charges streamed bytes beyond the first 6 MB per response (US$0.008/GB at the cited regional rate). This bridge's bounded message/history responses should be sized and measured. [API Gateway pricing](https://aws.amazon.com/api-gateway/pricing/), [Lambda response stream pricing](https://aws.amazon.com/lambda/pricing/)

CloudWatch standard alarms cost US$0.10 per metric-month; the example uses US$0.50/GB log ingestion and US$0.03/GB log storage. Detailed per-method API metrics are disabled to avoid extra custom-metric charges. [CloudWatch pricing](https://aws.amazon.com/cloudwatch/pricing/)

Scheduler's published free tier is 14 million invocations/month, shared across eligible usage. If available, it would eliminate the approximately four-cent Scheduler line here; do not automatically subtract it from an account-level forecast. [EventBridge pricing](https://aws.amazon.com/eventbridge/pricing/)

S3 Standard storage is US$0.023/GB-month at the first regional tier; PUT/COPY/POST/LIST costs US$0.005 per 1,000 and GET/other requests US$0.004 per 10,000. A 2.3 MB package set costs roughly US$0.00005/month in storage, plus about US$0.00003 for six uploads. Each retained release adds storage; versioned rollback artifacts remain billable. [S3 pricing](https://aws.amazon.com/s3/pricing/), [official regional S3 price list](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonS3/current/us-east-1/index.json)

The template uses AWS-managed encryption paths and creates no customer-managed KMS key. AWS-managed key storage has no monthly rental, but eligible KMS API requests can still be billed. The allowance above uses US$0.03 per 10,000 symmetric operations before credits; actual request counts depend on the services and their key caching. S3 AES256 and SQS-managed encryption do not introduce a customer key rental. [KMS pricing](https://aws.amazon.com/kms/pricing/)

## Exclusions and growth

- Authentication resources are still a separate proposal. Cognito/OAuth provider charges, connector subscriptions, agent execution and model tokens are excluded.
- Domain registration, any additional DNS/domain infrastructure, external notification destinations, taxes and currency conversion are excluded.
- Additional artifact versions, operator/CI API calls, data transfer and occasional restore operations depend on real usage. The tiny package-storage illustration does not include an unlimited release history.
- The table currently has no automatic history deletion. Storage and PITR grow with retained history, fingerprint/pointer deduplication records and operational state; they do not reset each month. Queue retention does not define history retention.
- Callback retries, broad history queries, multiple subscriptions per message and large payloads can materially increase the variable portion. Measure billed duration, request counts, table/index size, DLQ depth and secret fetches after the real proof.

The compiled template currently plans six Lambda functions/log groups, one REST API, one DynamoDB table with one GSI, three SQS queues, one recovery schedule and its dedicated schedule group, seven IAM roles and two alarms. The isolation redesign adds namespaces and narrower policies within those resources, not another database or queue. Four configuration secrets are supplied separately or created as empty containers by an explicitly reviewed bootstrap plan. Identity-provider resources remain separate. Use CloudFormation's actual resource inventory to reconcile this list before presenting a post-deployment estimate.

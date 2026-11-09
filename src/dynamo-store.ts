import { randomUUID } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { Conflict, type DueKey, type Key, type Page, type Row, type Store, type Write } from './store.js';
import { cursorFor, nextRow, readCursor, validateDue, validateKey, validateLimit, validateQuery, validateWrites } from './store-utils.js';

function decode<T>(item: Record<string, unknown>): Row<T> {
  return { pk: item.pk as string, sk: item.sk as string, version: item.version as number, value: item.value as T,
    ...(item.dueAt === undefined ? {} : { dueAt: item.dueAt as number }),
    ...(item.retentionExpiresAt === undefined ? {} : { retentionExpiresAt: item.retentionExpiresAt as number }) };
}
/** Base PK/SK queries are strongly consistent. The due-index is eventually consistent;
 * workers must re-read and conditionally reserve each candidate before sending it. */
export class DynamoStore implements Store {
  constructor(
    private readonly tableName: string,
    private readonly client: Pick<DynamoDBDocumentClient, 'send'> = DynamoDBDocumentClient.from(new DynamoDBClient({})),
    private readonly dueIndex = 'due-index',
  ) {
    if (!tableName || !dueIndex) throw new Error('DynamoDB table and index names are required');
  }
  async get<T = Record<string, unknown>>(key: Key): Promise<Row<T> | undefined> {
    validateKey(key);
    const result = await this.client.send(new GetCommand({ TableName: this.tableName, Key: key, ConsistentRead: true }));
    return result.Item ? decode<T>(result.Item) : undefined;
  }
  async query<T = Record<string, unknown>>(pk: string, prefix: string, limit: number, cursor?: string): Promise<Page<T>> {
    validateQuery(pk, prefix, limit);
    const after = readCursor(cursor, pk, prefix);
    const result = await this.client.send(new QueryCommand({
      TableName: this.tableName, ConsistentRead: true, Limit: limit, ScanIndexForward: true,
      KeyConditionExpression: '#pk = :pk' + (prefix ? ' AND begins_with(#sk, :prefix)' : ''),
      ExpressionAttributeNames: { '#pk': 'pk', ...(prefix ? { '#sk': 'sk' } : {}) },
      ExpressionAttributeValues: { ':pk': pk, ...(prefix ? { ':prefix': prefix } : {}) },
      ...(after === undefined ? {} : { ExclusiveStartKey: { pk, sk: after } }),
    }));
    return { items: (result.Items ?? []).map(item => decode<T>(item)),
      ...(result.LastEvaluatedKey ? { cursor: cursorFor(pk, prefix, result.LastEvaluatedKey.sk as string) } : {}) };
  }
  async due(now: number, limit: number): Promise<DueKey[]> {
    validateDue(now); validateLimit(limit);
    const result = await this.client.send(new QueryCommand({
      TableName: this.tableName, IndexName: this.dueIndex, Limit: limit, ScanIndexForward: true,
      KeyConditionExpression: '#duePk = :duePk AND #dueAt <= :now',
      Select: 'SPECIFIC_ATTRIBUTES',
      ProjectionExpression: '#pk, #sk, #dueAt',
      ExpressionAttributeNames: { '#duePk': 'duePk', '#dueAt': 'dueAt', '#pk': 'pk', '#sk': 'sk' },
      ExpressionAttributeValues: { ':duePk': 'DUE', ':now': now },
    }));
    return (result.Items ?? []).map(item => ({ pk: item.pk as string, sk: item.sk as string, dueAt: item.dueAt as number }));
  }
  async commit(writes: Write[]): Promise<void> {
    const valid = validateWrites(writes);
    if (!valid.length) return;
    try {
      await this.client.send(new TransactWriteCommand({
        ClientRequestToken: randomUUID(),
        TransactItems: valid.map(write => {
          const condition = {
            TableName: this.tableName,
            ConditionExpression: write.expected === null ? 'attribute_not_exists(#pk)' : '#version = :expected',
            ExpressionAttributeNames: (write.expected === null ? { '#pk': 'pk' } : { '#version': 'version' }) as Record<string, string>,
            ...(write.expected === null ? {} : { ExpressionAttributeValues: { ':expected': write.expected } }),
          };
          return write.value === undefined ? { Delete: { ...condition, Key: { pk: write.pk, sk: write.sk } } } : {
            Put: { ...condition, Item: { ...nextRow(write), ...(write.dueAt === undefined ? {} : { duePk: 'DUE' }) } },
          };
        }),
      }));
    } catch (error) {
      const details = error as { name?: string; CancellationReasons?: { Code?: string }[] };
      if (details.name === 'ConditionalCheckFailedException' || details.name === 'TransactionConflictException' ||
          (details.name === 'TransactionCanceledException' && details.CancellationReasons?.some(reason =>
            reason.Code === 'ConditionalCheckFailed' || reason.Code === 'TransactionConflict') &&
            details.CancellationReasons.every(reason => !reason.Code || ['None', 'ConditionalCheckFailed', 'TransactionConflict'].includes(reason.Code)))) {
        throw new Conflict();
      }
      throw error;
    }
  }
}

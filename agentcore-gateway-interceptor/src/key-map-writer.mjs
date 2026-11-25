import { DEFAULT_ROLE_PREFIX, createKeyMapWriter } from './key-map.mjs';

const tableName = process.env.LANGGUARD_KEY_MAP_TABLE;
let client;

async function putItem(item) {
  if (!tableName) throw new Error('LANGGUARD_KEY_MAP_TABLE is not set');
  // The Lambda Node.js runtime includes the AWS SDK v3; a dynamic import keeps it out of the tests.
  const { DynamoDBClient, PutItemCommand } = await import('@aws-sdk/client-dynamodb');
  // The writer in us-east-1 writes to the table in the Region of the interceptor.
  client ??= new DynamoDBClient({ region: process.env.LANGGUARD_KEY_MAP_REGION || undefined });
  await client.send(new PutItemCommand({ TableName: tableName, Item: item }));
}

export const handler = createKeyMapWriter({
  putItem,
  rolePrefix: process.env.LANGGUARD_STS_ROLE_PREFIX || DEFAULT_ROLE_PREFIX,
});

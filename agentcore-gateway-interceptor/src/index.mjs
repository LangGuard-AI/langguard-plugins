import { createHandler } from './interceptor.mjs';
import { createKeyCache } from './key-cache.mjs';
import { DEFAULT_LOOKUP_TIMEOUT_MS, createCallerLookup } from './key-map.mjs';

const KEY_TTL_MS = 5 * 60 * 1000;

let client;

async function readSecret() {
  const secretId = process.env.LANGGUARD_API_KEY_SECRET_ARN;
  if (!secretId) throw new Error('LANGGUARD_API_KEY_SECRET_ARN is not set');
  // The Lambda Node.js runtime includes the AWS SDK v3; a dynamic import keeps it out of the tests.
  const { SecretsManagerClient, GetSecretValueCommand } = await import('@aws-sdk/client-secrets-manager');
  client ??= new SecretsManagerClient({});
  const out = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
  const key = out.SecretString?.trim();
  if (!key) throw new Error('the secret has no SecretString');
  return key;
}

const keys = createKeyCache({ read: readSecret, ttlMs: KEY_TTL_MS });

function keyMapLookup(tableName) {
  if (!tableName) return undefined;
  // Loaded during the Lambda init phase, so that the first lookup does not wait for the SDK.
  // No retries and short socket limits: without a network path to DynamoDB (a VPC with no endpoint), a read
  // that hangs would otherwise hold each call to the lookup deadline.
  const dynamo = import('@aws-sdk/client-dynamodb').then((sdk) => ({
    sdk,
    db: new sdk.DynamoDBClient({ maxAttempts: 1, requestHandler: { connectionTimeout: 300, requestTimeout: 1000 } }),
  }));
  dynamo.catch(() => {});
  const timeout = Number(process.env.LANGGUARD_KEY_MAP_TIMEOUT_MS);
  return createCallerLookup({
    timeoutMs: Number.isInteger(timeout) && timeout >= 1 && timeout <= 5000 ? timeout : DEFAULT_LOOKUP_TIMEOUT_MS,
    getItem: async (accessKeyId) => {
      const { sdk, db } = await dynamo;
      const out = await db.send(new sdk.GetItemCommand({ TableName: tableName, Key: { accessKeyId: { S: accessKeyId } } }));
      return out.Item;
    },
  });
}

export const handler = createHandler({
  fetch: globalThis.fetch,
  getApiKey: keys.get,
  env: process.env,
  onAuthRejected: keys.drop,
  lookupCaller: keyMapLookup(process.env.LANGGUARD_KEY_MAP_TABLE),
});

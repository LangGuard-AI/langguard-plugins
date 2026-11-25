/**
 * The STS key map: one record for each temporary access key ID that an IAM Identity Center sign-in made.
 * The writer makes the records from CloudTrail `AssumeRoleWithSAML` events. The interceptor reads them to find
 * the person behind a SigV4-signed gateway call.
 *
 * @typedef {{ accessKeyId: string, userName: string, expiresAt: number }} KeyRecord expiresAt is epoch seconds
 * @typedef {{ accessKeyId: { S: string }, userName: { S: string }, expiresAt: { N: string } }} KeyItem
 * @typedef {(
 *   | { outcome: 'hit', userName: string }
 *   | { outcome: 'miss' | 'timeout' | 'error' }
 * )} Lookup
 */

export const DEFAULT_ROLE_PREFIX = 'AWSReservedSSO_';
export const DEFAULT_LOOKUP_TIMEOUT_MS = 400;
// A sign-in event can reach the key map some seconds after the first signed call.
const MISS_TTL_MS = 10_000;
const MAX_ENTRIES = 1000;

export const ACCESS_KEY_ID = /^[A-Z0-9]{16,128}$/;
const ASSUMED_ROLE_ARN = /^arn:([a-z-]+):sts::(\d{12}):assumed-role\/([\w+=,.@-]{1,64})\/([\w+=,.@-]{2,64})$/;
// IAM Identity Center makes its roles under this path, with a Region segment unless its home Region is us-east-1.
const SSO_ROLE_ARN = /^arn:([a-z-]+):iam::(\d{12}):role\/aws-reserved\/sso\.amazonaws\.com\/(?:[a-z0-9-]+\/)?([\w+=,.@-]{1,64})$/;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// CloudTrail writes the expiration of STS credentials as `Aug 28, 2023, 7:00:58 PM`, in UTC.
// Newer Java locale data puts a narrow no-break space (U+202F) before AM or PM.
const CLOUDTRAIL_TIME = /^([A-Z][a-z]{2}) (\d{1,2}), (\d{4}),? (\d{1,2}):(\d{2}):(\d{2})[  ]([AP]M)$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** @returns {number | undefined} epoch seconds */
export function parseExpiration(value) {
  if (typeof value !== 'string') return undefined;
  if (ISO_TIME.test(value)) {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined;
  }
  const m = CLOUDTRAIL_TIME.exec(value);
  if (!m) return undefined;
  const month = MONTHS.indexOf(m[1]);
  const hour12 = Number(m[4]);
  if (month < 0 || hour12 < 1 || hour12 > 12) return undefined;
  const hour = (hour12 % 12) + (m[7] === 'PM' ? 12 : 0);
  const ms = Date.UTC(Number(m[3]), month, Number(m[2]), hour, Number(m[5]), Number(m[6]));
  return Number.isNaN(ms) ? undefined : ms / 1000;
}

/**
 * Reads a sign-in from an EventBridge "AWS API Call via CloudTrail" event.
 * @param {unknown} event
 * @param {{ rolePrefix: string, nowSeconds: number }} options
 * @returns {{ kind: 'write', record: KeyRecord } | { kind: 'ignore', reason: string }}
 */
export function parseSignIn(event, { rolePrefix, nowSeconds }) {
  const detail = isObject(event) && isObject(event.detail) ? event.detail : undefined;
  if (!detail) return { kind: 'ignore', reason: 'no detail' };
  if (detail.eventSource !== 'sts.amazonaws.com' || detail.eventName !== 'AssumeRoleWithSAML') {
    return { kind: 'ignore', reason: 'not AssumeRoleWithSAML' };
  }
  if (detail.errorCode !== undefined) return { kind: 'ignore', reason: 'call failed' };
  const request = isObject(detail.requestParameters) ? detail.requestParameters : {};
  const response = isObject(detail.responseElements) ? detail.responseElements : {};
  const credentials = isObject(response.credentials) ? response.credentials : {};
  const roleUser = isObject(response.assumedRoleUser) ? response.assumedRoleUser : {};

  const arn = typeof roleUser.arn === 'string' ? ASSUMED_ROLE_ARN.exec(roleUser.arn) : null;
  if (!arn) return { kind: 'ignore', reason: 'no assumed-role ARN' };
  const [, partition, account, roleName, userName] = arn;
  if (!roleName.startsWith(rolePrefix)) return { kind: 'ignore', reason: 'role name has another prefix' };
  const role = typeof request.roleArn === 'string' ? SSO_ROLE_ARN.exec(request.roleArn) : null;
  if (!role || role[1] !== partition || role[2] !== account || role[3] !== roleName) {
    return { kind: 'ignore', reason: 'not an IAM Identity Center role' };
  }

  const { accessKeyId } = credentials;
  if (typeof accessKeyId !== 'string' || !ACCESS_KEY_ID.test(accessKeyId)) {
    return { kind: 'ignore', reason: 'no access key ID' };
  }
  const expiresAt = parseExpiration(credentials.expiration);
  if (expiresAt === undefined) return { kind: 'ignore', reason: 'no expiration' };
  if (expiresAt <= nowSeconds) return { kind: 'ignore', reason: 'credentials expired' };
  return { kind: 'write', record: { accessKeyId, userName, expiresAt } };
}

/** @param {KeyRecord} record @returns {KeyItem} */
export const toItem = ({ accessKeyId, userName, expiresAt }) => ({
  accessKeyId: { S: accessKeyId },
  userName: { S: userName },
  expiresAt: { N: String(expiresAt) },
});

/** @returns {KeyRecord | undefined} */
export function fromItem(item) {
  if (!isObject(item)) return undefined;
  const accessKeyId = item.accessKeyId?.S;
  const userName = item.userName?.S;
  const expiresAt = Number(item.expiresAt?.N);
  if (typeof accessKeyId !== 'string' || typeof userName !== 'string' || !userName || !Number.isFinite(expiresAt)) {
    return undefined;
  }
  return { accessKeyId, userName, expiresAt };
}

/** The first 4 characters only: a log line must not name a whole access key ID. */
export const maskKey = (accessKeyId) => `${String(accessKeyId).slice(0, 4)}...`;

/**
 * Finds the user for an access key ID with a hard deadline. It never throws.
 * A hit stays in memory until the credentials expire. A miss or an error stays for 10 seconds, with its outcome.
 * A lookup that passes the deadline continues, and its result goes into memory for the next call.
 * @param {{ getItem: (accessKeyId: string) => Promise<unknown>, timeoutMs?: number, now?: () => number }} options
 * @returns {(accessKeyId: string) => Promise<Lookup>}
 */
export function createCallerLookup({ getItem, timeoutMs = DEFAULT_LOOKUP_TIMEOUT_MS, now = Date.now }) {
  /** @type {Map<string, { userName?: string, failed?: boolean, until: number }>} */
  const known = new Map();
  /** @type {Map<string, Promise<Lookup>>} */
  const inFlight = new Map();

  const remember = (accessKeyId, entry) => {
    known.delete(accessKeyId);
    known.set(accessKeyId, entry);
    if (known.size > MAX_ENTRIES) known.delete(known.keys().next().value);
  };

  /** @returns {Promise<Lookup>} */
  const load = async (accessKeyId) => {
    try {
      const record = fromItem(await getItem(accessKeyId));
      if (record && record.accessKeyId === accessKeyId && record.expiresAt * 1000 > now()) {
        remember(accessKeyId, { userName: record.userName, until: record.expiresAt * 1000 });
        return { outcome: 'hit', userName: record.userName };
      }
      remember(accessKeyId, { until: now() + MISS_TTL_MS });
      return { outcome: 'miss' };
    } catch {
      remember(accessKeyId, { failed: true, until: now() + MISS_TTL_MS });
      return { outcome: 'error' };
    } finally {
      inFlight.delete(accessKeyId);
    }
  };

  return async function lookup(accessKeyId) {
    const entry = known.get(accessKeyId);
    if (entry && entry.until > now()) {
      if (entry.userName !== undefined) return { outcome: 'hit', userName: entry.userName };
      return { outcome: entry.failed ? 'error' : 'miss' };
    }
    let pending = inFlight.get(accessKeyId);
    if (!pending) {
      pending = load(accessKeyId);
      inFlight.set(accessKeyId, pending);
    }
    let timer;
    const deadline = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ outcome: 'timeout' }), timeoutMs);
    });
    try {
      return await Promise.race([pending, deadline]);
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * The key map writer: one DynamoDB item for each sign-in. A repeated event writes the same item again.
 * A failed write throws, so that Lambda retries the event.
 * @param {{ putItem: (item: KeyItem) => Promise<unknown>, rolePrefix?: string, now?: () => number, log?: (line: string) => void }} deps
 */
export function createKeyMapWriter({ putItem, rolePrefix = DEFAULT_ROLE_PREFIX, now = Date.now, log = console.log }) {
  return async function handler(event) {
    const parsed = parseSignIn(event, { rolePrefix, nowSeconds: Math.floor(now() / 1000) });
    if (parsed.kind === 'ignore') {
      log(JSON.stringify({ outcome: 'ignore', reason: parsed.reason }));
      return;
    }
    const key = maskKey(parsed.record.accessKeyId);
    try {
      await putItem(toItem(parsed.record));
    } catch (err) {
      log(JSON.stringify({ outcome: 'error', reason: err?.name ?? 'write failed', key }));
      throw err;
    }
    log(JSON.stringify({ outcome: 'write', key, expiresAt: parsed.record.expiresAt }));
  };
}

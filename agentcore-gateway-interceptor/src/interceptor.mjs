import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

export const INTERCEPTOR_NAME = 'policy-langguard.ai';
export const BLOCK_MARKER_KEY = 'langguard.ai/blocked';
const DEFAULT_TIMEOUT_MS = 5000;
const KEY_READ_TIMEOUT_MS = 3000;
const IDENTITY_CLAIMS = ['user_id', 'ai_app_id', 'department', 'environment'];
const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/;
const ALL_ZERO = /^0+$/;
const XRAY_ROOT = /(?:^|;)Root=1-([0-9a-f]{8})-([0-9a-f]{24})(?:;|$)/;

/** Client-facing text for each block cause other than a policy verdict. */
const BLOCK_TEXT = {
  unavailable: 'Blocked by LangGuard: the policy check is unavailable, so this tool call is not allowed.',
  invalid: 'Blocked by LangGuard: this is not a valid tool call or tool result, so it was not sent for a policy check.',
  too_large:
    'Blocked by LangGuard: the tool call or its result is larger than 1 MB, the size limit of the policy check, so it is not allowed.',
};
const DEFAULT_BLOCK_REASON = 'The tool call does not comply with a LangGuard policy.';

/**
 * @typedef {'request' | 'response'} Phase
 * @typedef {{ id: unknown, name: string, arguments: Record<string, unknown> | undefined, result?: unknown }} ToolCall
 * @typedef {(
 *   | { kind: 'http' }
 *   | { kind: 'passthrough', phase: Phase, reason: string }
 *   | { kind: 'unsupported', phase: Phase, reason: string, shape?: { bodyShape: Shape, fieldNames: string[] } }
 *   | { kind: 'evaluate', phase: Phase, call: ToolCall, marker?: unknown }
 * )} Classification
 * @typedef {(
 *   | { kind: 'allow' }
 *   | { kind: 'block', message: string }
 *   | { kind: 'unavailable', reason: string, cause: 'unavailable' | 'too_large' }
 * )} Decision
 * @typedef {{ kind: 'policy', message: string } | { kind: keyof typeof BLOCK_TEXT }} BlockCause
 * @typedef {{ kind: 'pass' } | { kind: 'block', text: string, marker?: string }} Outcome
 * @typedef {{
 *   fetch: typeof globalThis.fetch,
 *   getApiKey: () => Promise<string>,
 *   env: Record<string, string | undefined>,
 *   now?: () => number,
 *   log?: (line: string) => void,
 *   onAuthRejected?: () => void,
 *   keyReadTimeoutMs?: number,
 *   lookupCaller?: (accessKeyId: string) => Promise<import('./key-map.mjs').Lookup>,
 * }} Deps
 */

/** @typedef {{ type: string, length?: number, framing?: string, first?: Shape, keys?: string[], otherKeys?: number, encoded?: string }} Shape */

const MAX_SHAPE_KEYS = 20;
const MAX_KEY_LENGTH = 40;
const cutKeys = (o) => Object.keys(o).sort().slice(0, MAX_SHAPE_KEYS).map((k) => k.slice(0, MAX_KEY_LENGTH));

const PROTOCOL_KEYS = new Set([
  'jsonrpc', 'id', 'result', 'error', 'method', 'params', 'content', 'isError',
  'structuredContent', '_meta', 'code', 'message', 'data', 'name', 'arguments',
]);

/**
 * Describes a value without its content, so that a log line can say what the gateway sent.
 * The client or the target chooses the key names of a body, so only JSON-RPC and MCP protocol words
 * appear and the other names are counted. Values never appear.
 * @returns {Shape}
 */
export function describeShape(value, nested = false) {
  if (value === null) return { type: 'null' };
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) return { type: 'buffer', length: value.byteLength };
  if (Array.isArray(value)) {
    return { type: 'array', length: value.length, ...(value.length > 0 && !nested ? { first: describeShape(value[0], true) } : {}) };
  }
  if (typeof value === 'string') {
    const framing = ['data:', 'event:', '{', '['].find((p) => value.startsWith(p));
    return { type: 'string', length: value.length, ...(framing ? { framing } : {}) };
  }
  if (typeof value === 'object') {
    const names = Object.keys(value);
    const keys = names.filter((k) => PROTOCOL_KEYS.has(k)).sort();
    const otherKeys = names.length - keys.length;
    return { type: 'object', keys, ...(otherKeys > 0 ? { otherKeys } : {}) };
  }
  return { type: typeof value };
}

const unsupportedBody = (phase, reason, parent, body) => ({
  kind: 'unsupported',
  phase,
  reason,
  shape: { bodyShape: describeShape(body), fieldNames: cutKeys(parent) },
});

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const asString = (v) => (typeof v === 'string' ? v : undefined);

/** @returns {Classification} */
export function classify(event) {
  if (!isObject(event)) return { kind: 'unsupported', phase: 'request', reason: 'event is not an object' };
  if (!isObject(event.mcp)) {
    if (isObject(event.http)) return { kind: 'http' };
    return { kind: 'unsupported', phase: 'request', reason: 'event has no mcp or http payload' };
  }
  const { gatewayRequest, gatewayResponse } = event.mcp;
  const request = isObject(gatewayRequest) ? gatewayRequest.body : undefined;
  // The event names no phase. A real gateway sends the `gatewayResponse` key in a REQUEST event too, without a value
  // (live test, 2026-11-24). So a missing or null value marks a REQUEST. Each other value marks a RESPONSE, so that a
  // bad value cannot make a result pass as a request.
  return gatewayResponse == null
    ? classifyRequest(request, gatewayRequest)
    : classifyResponse(request, gatewayResponse, gatewayRequest);
}

const NOT_SINGLE_REQUEST = 'request body is not a single JSON-RPC object';
// The client chooses the method name, so the log gets it only when it has the form of an MCP method:
// segments that start with a lower-case letter, as in `notifications/roots/list_changed`.
const LOGGABLE_METHOD = /^[a-z][A-Za-z_]*(?:\/[a-z][A-Za-z_]*)*$/;
const methodReason = (m) => `method ${typeof m === 'string' && m.length <= 64 && LOGGABLE_METHOD.test(m) ? m : 'other'}`;

// The client chooses the tool name: the gateway runs the function also for a name that no target has.
// 256 holds a gateway tool name `<target>___<tool>` with a 100-character target name and a 128-character tool name.
const MAX_LOGGED_TOOL_NAME = 256;
const CONTROL_CHARS = /\p{Cc}/gu;
const loggedToolName = (name) => {
  const clean = name.replace(CONTROL_CHARS, '');
  return clean.length <= MAX_LOGGED_TOOL_NAME
    ? { tool: clean }
    : { tool: clean.slice(0, MAX_LOGGED_TOOL_NAME), toolNameLength: name.length };
};

function classifyRequest(body, parent) {
  const phase = 'request';
  if (!isObject(body)) return unsupportedBody(phase, NOT_SINGLE_REQUEST, isObject(parent) ? parent : {}, body);
  if (body.method !== 'tools/call') return { kind: 'passthrough', phase, reason: methodReason(body.method) };
  const call = toolCall(body);
  if (!call) return { kind: 'unsupported', phase, reason: 'tools/call has no tool name' };
  if (isObject(body.params) && body.params.arguments != null && !isObject(body.params.arguments)) {
    return { kind: 'unsupported', phase, reason: 'tools/call arguments is not an object' };
  }
  return { kind: 'evaluate', phase, call };
}

function classifyResponse(request, gatewayResponse, gatewayRequest) {
  const phase = 'response';
  if (!isObject(gatewayResponse)) {
    const type = Array.isArray(gatewayResponse) ? 'array' : typeof gatewayResponse;
    return { kind: 'unsupported', phase, reason: `gatewayResponse is not an object (${type})` };
  }
  const response = gatewayResponse.body;
  if (!isObject(request)) {
    return unsupportedBody(phase, NOT_SINGLE_REQUEST, isObject(gatewayRequest) ? gatewayRequest : {}, request);
  }
  if (request.method !== 'tools/call') return { kind: 'passthrough', phase, reason: 'request is not a tools/call' };
  const call = toolCall(request);
  if (!call) return { kind: 'unsupported', phase, reason: 'tools/call has no tool name' };
  if (!isObject(response)) {
    return unsupportedBody(phase, 'response body is not a single JSON-RPC object', gatewayResponse, response);
  }
  if (!('result' in response)) return { kind: 'passthrough', phase, reason: 'response event has no result' };
  const marker = isObject(response.result) && isObject(response.result._meta)
    ? response.result._meta[BLOCK_MARKER_KEY]
    : undefined;
  return {
    kind: 'evaluate',
    phase,
    call: { ...call, id: response.id, result: response.result },
    ...(marker !== undefined ? { marker } : {}),
  };
}

function toolCall(body) {
  const params = isObject(body.params) ? body.params : {};
  const name = asString(params.name);
  if (!name) return undefined;
  return { id: body.id, name, arguments: isObject(params.arguments) ? params.arguments : undefined };
}

function header(headers, name) {
  if (!isObject(headers)) return undefined;
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return asString(value);
  }
  return undefined;
}

function parseTraceparent(value) {
  const match = value ? TRACEPARENT.exec(value) : null;
  if (!match || ALL_ZERO.test(match[1]) || ALL_ZERO.test(match[2])) return undefined;
  return { traceId: match[1], spanId: match[2] };
}

/** The W3C form of the trace ID in Lambda's X-Ray header (`Root=1-<8 hex>-<24 hex>`). */
function parseXRayTraceId(value) {
  const match = typeof value === 'string' ? XRAY_ROOT.exec(value) : null;
  if (!match) return undefined;
  const traceId = match[1] + match[2];
  return ALL_ZERO.test(traceId) ? undefined : traceId;
}

/**
 * The gateway continues the caller's `traceparent`. Without one it makes a trace ID,
 * which reaches the function only as the X-Ray header.
 */
function traceContext(headers, env) {
  const caller = parseTraceparent(header(headers, 'traceparent'));
  if (caller) return caller;
  const traceId = parseXRayTraceId(env._X_AMZN_TRACE_ID);
  return traceId === undefined ? undefined : { traceId };
}

/** Decodes the JWT payload without verification: the gateway authorizer has verified the token. */
function decodeJwtClaims(authorization) {
  if (!authorization) return undefined;
  const token = authorization.replace(/^Bearer\s+/i, '');
  const parts = token.split('.');
  if (parts.length !== 3) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return isObject(claims) ? claims : undefined;
  } catch {
    return undefined;
  }
}

const SIGV4 =
  /^AWS4-HMAC-SHA256 Credential=([A-Z0-9]{16,128})\/\d{8}\/[a-z0-9-]+\/[a-z0-9-]+\/aws4_request, ?SignedHeaders=[a-z0-9-]+(?:;[a-z0-9-]+)*, ?Signature=[0-9a-f]{64}$/;

/** The access key ID of a SigV4 `Authorization` header. The gateway `AWS_IAM` authorizer has verified the signature. */
export function sigV4AccessKeyId(authorization) {
  const match = typeof authorization === 'string' ? SIGV4.exec(authorization) : null;
  return match ? match[1] : undefined;
}

/** @returns {Promise<import('./key-map.mjs').Lookup | { outcome: 'none' | 'off' }>} */
async function callerOf(deps, headers) {
  const accessKeyId = sigV4AccessKeyId(header(headers, 'authorization'));
  if (accessKeyId === undefined) return { outcome: 'none' };
  if (!deps.lookupCaller) return { outcome: 'off' };
  try {
    return await deps.lookupCaller(accessKeyId);
  } catch {
    return { outcome: 'error' };
  }
}

function principalOf(claims) {
  if (!claims) return undefined;
  const id = asString(claims.sub);
  const identity = Object.fromEntries(
    IDENTITY_CLAIMS.filter((k) => typeof claims[k] === 'string').map((k) => [k, claims[k]]),
  );
  const hasIdentity = Object.keys(identity).length > 0;
  if (id === undefined && !hasIdentity) return undefined;
  return { ...(id !== undefined ? { id } : {}), ...(hasIdentity ? { claims: identity } : {}) };
}

/**
 * Builds the `interceptor/invoke` params for one tool call.
 * `callerUser` is the user that the STS key map gives for a SigV4 call. A JWT claim user wins over it.
 * @param {{ phase: Phase, call: ToolCall, headers?: Record<string, unknown>, env?: Record<string, string | undefined>, callerUser?: string }} input
 */
export function buildInvokeParams({ phase, call, headers, env = {}, callerUser }) {
  const trace = traceContext(headers, env);
  const sessionId = header(headers, 'mcp-session-id');
  // Only a CUSTOM_JWT authorizer verifies a bearer token. With AWS_IAM or no authorizer, a token is unverified.
  const verifiesJwt = (env.LANGGUARD_AUTHORIZER ?? 'CUSTOM_JWT') === 'CUSTOM_JWT';
  const claims = verifiesJwt ? decodeJwtClaims(header(headers, 'authorization')) : undefined;
  const principal = principalOf(claims);
  const userClaim = env.LANGGUARD_USER_CLAIM;
  const userId = (userClaim && claims ? asString(claims[userClaim]) : undefined) ?? callerUser;

  const args = phase === 'response' ? { ...call.arguments, result: call.result } : call.arguments;
  const context = {
    ...(trace ?? {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(principal !== undefined ? { principal } : {}),
  };
  return {
    name: INTERCEPTOR_NAME,
    event: 'tools/call',
    phase,
    payload: {
      method: 'tools/call',
      params: { name: call.name, ...(args !== undefined ? { arguments: args } : {}) },
    },
    config: { langguard: { agent_type: 'agentcore', ...(userId !== undefined ? { user_id: userId } : {}) } },
    ...(Object.keys(context).length > 0 ? { context } : {}),
  };
}

// AbortSignal.timeout throws for a delay that is not an unsigned 32-bit integer.
const MAX_TIMEOUT_MS = 2 ** 32 - 1;

/** @returns {number | undefined} undefined when the setting is not a valid delay */
function timeoutMs(env) {
  const value = env.LANGGUARD_TIMEOUT_MS;
  if (value === undefined || value === '') return DEFAULT_TIMEOUT_MS;
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= MAX_TIMEOUT_MS ? n : undefined;
}

/** @returns {Decision} */
const unavailable = (reason, cause = 'unavailable') => ({ kind: 'unavailable', reason, cause });

/** @returns {Promise<Decision>} */
async function decide(deps, params, key) {
  const baseUrl = deps.env.LANGGUARD_URL;
  if (!baseUrl) return unavailable('LANGGUARD_URL is not set');
  if (!URL.canParse(baseUrl) || new URL(baseUrl).protocol !== 'https:') {
    return unavailable('LANGGUARD_URL is not an https URL');
  }
  const timeout = timeoutMs(deps.env);
  if (timeout === undefined) return unavailable(`LANGGUARD_TIMEOUT_MS is not a whole number of milliseconds from 1 to ${MAX_TIMEOUT_MS}`);
  if (!key.ok) return unavailable(key.reason);

  let response;
  try {
    response = await deps.fetch(`${baseUrl.replace(/\/$/, '')}/api/interceptor`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method: 'interceptor/invoke', params }),
      signal: AbortSignal.timeout(timeout),
      // A followed redirect would take the decision from another location.
      redirect: 'error',
    });
  } catch (err) {
    return unavailable(err?.name === 'TimeoutError' ? 'timeout' : 'network error');
  }
  if (response.status === 401 || response.status === 403) deps.onAuthRejected?.();
  if (response.status === 413) return unavailable('HTTP 413', 'too_large');
  if (response.status !== 200) return unavailable(`HTTP ${response.status}`);

  let body;
  try {
    body = await response.json();
  } catch {
    return unavailable('response is not JSON');
  }
  return interpretInvokeResponse(body);
}

/**
 * Maps an `interceptor/invoke` JSON-RPC response body to a decision. Only severity `error` blocks: the server
 * sends `valid: false` with severity `warn` for a notify result, which is what Shadow mode returns.
 * @returns {Decision}
 */
export function interpretInvokeResponse(body) {
  if (isObject(body) && body.error !== undefined) {
    return unavailable(`JSON-RPC error ${String(isObject(body.error) ? body.error.code : body.error)}`);
  }
  const result = isObject(body) && isObject(body.result) ? body.result : undefined;
  const validation = result && isObject(result.validation) ? result.validation : undefined;
  if (typeof validation?.valid !== 'boolean') return unavailable('result has no validation.valid');
  if (validation.valid || validation.severity === 'warn') return { kind: 'allow' };
  return { kind: 'block', message: blockMessage(validation, result.langguard) };
}

function blockMessage(validation, langguard) {
  const errors = Array.isArray(validation.messages)
    ? validation.messages.filter((m) => isObject(m) && m.severity === 'error' && typeof m.message === 'string' && m.message)
    : [];
  if (errors.length > 0) return errors.map((m) => m.message).join('; ');
  return asString(isObject(langguard) ? langguard.reason : undefined) || DEFAULT_BLOCK_REASON;
}

/** @param {BlockCause} cause */
function blockText(cause) {
  return cause.kind === 'policy' ? `Blocked by LangGuard policy: ${cause.message}` : BLOCK_TEXT[cause.kind];
}

/** An absent id and a null id sign the same: neither names a request the block could be replayed against. */
function sign(key, id, text) {
  return createHmac('sha256', key).update(`langguard-block\n${JSON.stringify(id ?? null)}\n${text}`).digest('hex');
}

/** @returns {string | undefined} the block text when `marker` is this function's signature over the id and text */
function ownBlockText(key, call, marker) {
  if (!key.ok || typeof marker !== 'string') return undefined;
  const content = isObject(call.result) && Array.isArray(call.result.content) ? call.result.content[0] : undefined;
  const text = isObject(content) && content.type === 'text' ? asString(content.text) : undefined;
  if (text === undefined) return undefined;
  const expected = Buffer.from(sign(key.key, call.id, text));
  const actual = Buffer.from(marker);
  return expected.length === actual.length && timingSafeEqual(expected, actual) ? text : undefined;
}

/**
 * The id to put in a block body. `undefined` means the request has no id member, and the block then has none:
 * the gateway rejects an interceptor response with `id: null` for such a request. `null` is for a request body
 * that cannot be read, as JSON-RPC requires.
 */
function blockId(event, classification) {
  if (classification.kind === 'evaluate') return classification.call.id;
  const body = event?.mcp?.gatewayRequest?.body;
  return isObject(body) ? body.id : null;
}

/**
 * The one place that builds the AgentCore interceptor output.
 * @param {any} event
 * @param {Phase} phase
 * @param {Outcome} outcome
 * @param {unknown} id `undefined` leaves the id member out of the body
 */
function render(event, phase, outcome, id) {
  const response = isObject(event?.mcp?.gatewayResponse) ? event.mcp.gatewayResponse : undefined;
  const statusCode = response && 'statusCode' in response ? { statusCode: response.statusCode } : {};

  if (outcome.kind === 'pass') {
    const mcp = phase === 'request'
      ? { transformedGatewayRequest: { body: event.mcp.gatewayRequest.body } }
      : { transformedGatewayResponse: { ...statusCode, body: response.body } };
    return { interceptorOutputVersion: '1.0', mcp };
  }

  const result = {
    isError: true,
    content: [{ type: 'text', text: outcome.text }],
    ...(outcome.marker !== undefined ? { _meta: { [BLOCK_MARKER_KEY]: outcome.marker } } : {}),
  };
  return {
    interceptorOutputVersion: '1.0',
    mcp: {
      transformedGatewayResponse: {
        ...(response ? statusCode : { statusCode: 200 }),
        body: { jsonrpc: '2.0', ...(id !== undefined ? { id } : {}), result },
      },
    },
  };
}

const TIMED_OUT = Symbol('timed out');

async function loadKey(getApiKey, deadlineMs) {
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), deadlineMs);
  });
  try {
    const key = await Promise.race([getApiKey(), deadline]);
    if (key === TIMED_OUT) return { ok: false, reason: 'API key read timed out' };
    return typeof key === 'string' && key ? { ok: true, key } : { ok: false, reason: 'API key is empty' };
  } catch {
    return { ok: false, reason: 'API key read failed' };
  } finally {
    clearTimeout(timer);
  }
}

const once = (fn) => {
  let p;
  return () => (p ??= fn());
};

// The handler threw, so the event is not trusted for an id.
const FALLBACK_OUTPUT = {
  interceptorOutputVersion: '1.0',
  mcp: {
    transformedGatewayResponse: {
      statusCode: 200,
      body: { jsonrpc: '2.0', id: null, result: { isError: true, content: [{ type: 'text', text: BLOCK_TEXT.unavailable }] } },
    },
  },
};

/** @param {Deps} deps */
export function createHandler(deps) {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((line) => console.log(line));

  return async function handler(event) {
    const started = now();
    const entry = { phase: undefined, tool: undefined, outcome: 'unavailable', reason: undefined, traceId: undefined };
    try {
      const classification = classify(event);
      if (classification.kind === 'http') {
        Object.assign(entry, { outcome: 'passthrough', reason: 'http target' });
        return { interceptorOutputVersion: '1.0', http: {} };
      }
      entry.phase = classification.phase;
      const key = once(() => loadKey(deps.getApiKey, deps.keyReadTimeoutMs ?? KEY_READ_TIMEOUT_MS));
      /** @param {BlockCause} cause */
      const blockWith = async (cause) => {
        const text = blockText(cause);
        const k = await key();
        const id = blockId(event, classification);
        return render(event, classification.phase, { kind: 'block', text, ...(k.ok ? { marker: sign(k.key, id, text) } : {}) }, id);
      };

      if (classification.kind === 'passthrough') {
        Object.assign(entry, { outcome: 'passthrough', reason: classification.reason });
        return render(event, classification.phase, { kind: 'pass' });
      }
      if (classification.kind === 'unsupported') {
        Object.assign(entry, { outcome: 'unsupported', reason: classification.reason, ...classification.shape });
        return await blockWith({ kind: 'invalid' });
      }

      const { call, phase, marker } = classification;
      Object.assign(entry, loggedToolName(call.name));
      const ownText = marker === undefined ? undefined : ownBlockText(await key(), call, marker);
      if (ownText !== undefined) {
        // Only the signed id and text are trusted: the rest of the body comes from the target.
        Object.assign(entry, { outcome: 'block', reason: 'own block' });
        return render(event, phase, { kind: 'block', text: ownText, marker }, call.id);
      }

      const { headers } = event.mcp.gatewayRequest;
      // The key read and the caller lookup run at the same time.
      key();
      const caller = await callerOf(deps, headers);
      entry.caller = caller.outcome;
      const callerUser = caller.outcome === 'hit' ? caller.userName : undefined;
      const params = buildInvokeParams({ phase, call, headers, env: deps.env, callerUser });
      entry.traceId = params.context?.traceId;
      const decision = await decide(deps, params, await key());
      entry.outcome = decision.kind;
      if (decision.kind === 'allow') return render(event, phase, { kind: 'pass' });
      if (decision.kind === 'block') {
        entry.reason = 'policy';
        return await blockWith({ kind: 'policy', message: decision.message });
      }
      entry.reason = decision.reason;
      return await blockWith({ kind: decision.cause });
    } catch {
      Object.assign(entry, { outcome: 'unavailable', reason: 'internal error' });
      return FALLBACK_OUTPUT;
    } finally {
      try {
        log(JSON.stringify({ ...entry, durationMs: now() - started }));
      } catch {
        // A logging failure must not change the gateway result.
      }
    }
  };
}

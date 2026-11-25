import { readFileSync } from 'node:fs';

export const fixture = (name) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));

export const TRACE_ID = '0af7651916cd43dd8448eb211c80319c';
export const SPAN_ID = 'b7ad6b7169203331';
export const TRACEPARENT = `00-${TRACE_ID}-${SPAN_ID}-01`;
export const SESSION_ID = 'mcp-session-7f3a';
export const JWT_CLAIMS = {
  sub: 'user-123',
  user_id: 'u-42',
  department: 'finance',
  environment: 7,
  email: 'person@example.com',
  'custom:employee': 'E-9',
};
const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
export const JWT = `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url(JWT_CLAIMS)}.signature`;

export const TOOL_CALL_BODY = {
  jsonrpc: '2.0',
  id: 7,
  method: 'tools/call',
  params: { name: 'issue_refund', arguments: { order_id: 'ORD-10024', amount: 429 } },
};
export const TOOL_RESULT = { content: [{ type: 'text', text: 'Refund issued for ORD-10024' }] };

export const HEADERS = {
  Accept: 'application/json',
  Authorization: `Bearer ${JWT}`,
  'Mcp-Session-Id': SESSION_ID,
  traceparent: TRACEPARENT,
};

/** The AWS documented REQUEST payload, with a tools/call body and real header values. */
export function requestEvent({ body = TOOL_CALL_BODY, headers = HEADERS } = {}) {
  const event = fixture('request-interceptor-input');
  event.mcp.gatewayRequest.body = structuredClone(body);
  if (headers === null) delete event.mcp.gatewayRequest.headers;
  else event.mcp.gatewayRequest.headers = structuredClone(headers);
  return event;
}

/** The AWS documented RESPONSE payload, with a tools/call request and the given response body. */
export function responseEvent({ responseBody, body = TOOL_CALL_BODY, headers = HEADERS } = {}) {
  const event = fixture('response-interceptor-input');
  event.mcp.gatewayRequest.body = structuredClone(body);
  event.mcp.gatewayRequest.headers = structuredClone(headers);
  event.mcp.gatewayResponse.body = structuredClone(
    responseBody ?? { jsonrpc: '2.0', id: body.id, result: TOOL_RESULT },
  );
  return event;
}

/** The server's `interceptor/invoke` body. Severity follows `sepSeverity`: success is info, block is error. */
export function invokeResult({ valid, severity = valid ? 'info' : 'error', messages = [], langguard = {} }) {
  return {
    jsonrpc: '2.0',
    id: 'x',
    result: {
      interceptor: 'policy-langguard.ai',
      type: 'validation',
      phase: 'request',
      durationMs: 3,
      validation: { valid, severity, messages },
      langguard,
    },
  };
}

/** A fake fetch that records each call and answers with `respond(call)`. */
export function fakeFetch(respond) {
  const calls = [];
  const fetch = async (url, init) => {
    const call = { url, init, headers: init.headers, body: JSON.parse(init.body) };
    calls.push(call);
    return respond(call);
  };
  return { fetch, calls };
}

export const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export const API_KEY = 'lgr_test_key';
export const ENV = {
  LANGGUARD_URL: 'https://langguard.internal.test/',
  LANGGUARD_API_KEY_SECRET_ARN: 'arn:aws:secretsmanager:us-east-1:111122223333:secret:lg',
  LANGGUARD_USER_CLAIM: 'custom:employee',
};

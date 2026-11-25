import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createHandler, sigV4AccessKeyId } from '../src/interceptor.mjs';
import { createCallerLookup } from '../src/key-map.mjs';
import { API_KEY, ENV, HEADERS, fakeFetch, invokeResult, json, requestEvent, responseEvent } from './helpers.mjs';

const KEY_ID = 'ASIAIOSFODNN7EXAMPLE';
const USER = 'jane@corp.example';
const SIGNATURE = 'fe5f80f77d5fa3beca038a248ff027d0445342fe2855ddc963176630326f1024';
const SIGV4 =
  `AWS4-HMAC-SHA256 Credential=${KEY_ID}/20261124/us-east-1/bedrock-agentcore/aws4_request, ` +
  `SignedHeaders=accept;content-type;host;x-amz-date;x-amz-security-token, Signature=${SIGNATURE}`;
const IAM_HEADERS = { ...HEADERS, Authorization: SIGV4 };

describe('sigV4AccessKeyId', () => {
  it('reads the access key ID of a SigV4 header', () => {
    assert.equal(sigV4AccessKeyId(SIGV4), KEY_ID);
  });

  it('reads a header without spaces after the commas', () => {
    assert.equal(sigV4AccessKeyId(SIGV4.replaceAll(', ', ',')), KEY_ID);
  });

  for (const [name, value] of [
    ['a Bearer token', HEADERS.Authorization],
    ['no header', undefined],
    ['an empty header', ''],
    ['a SigV4a header', SIGV4.replace('AWS4-HMAC-SHA256', 'AWS4-ECDSA-P256-SHA256')],
    ['a lower-case key ID', SIGV4.replace(KEY_ID, KEY_ID.toLowerCase())],
    ['a key ID that is too short', SIGV4.replace(KEY_ID, 'ASIA123')],
    ['a key ID with a path', SIGV4.replace(KEY_ID, `${KEY_ID}/..`)],
    ['no signature', SIGV4.replace(/, Signature=.*$/, '')],
    ['a short signature', SIGV4.replace(SIGNATURE, SIGNATURE.slice(2))],
    ['text after the signature', `${SIGV4}, Credential=ASIAOTHERKEY00000000/20261124/us-east-1/x/aws4_request`],
    ['query string parameters', `X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=${KEY_ID}%2F20261124%2Fus-east-1%2Fbedrock-agentcore%2Faws4_request`],
    ['a second header line', `${SIGV4}\nX-Injected: 1`],
    ['a number', 42],
  ]) {
    it(`rejects ${name}`, () => {
      assert.equal(sigV4AccessKeyId(value), undefined);
    });
  }
});

function setup({ lookupCaller, env = { ...ENV, LANGGUARD_USER_CLAIM: undefined } } = {}) {
  const { fetch, calls } = fakeFetch(() => json(invokeResult({ valid: true })));
  const lines = [];
  const asked = [];
  const handler = createHandler({
    fetch,
    getApiKey: async () => API_KEY,
    env,
    log: (l) => lines.push(l),
    ...(lookupCaller
      ? { lookupCaller: async (id) => { asked.push(id); return lookupCaller(id); } }
      : {}),
  });
  const sentUser = () => calls[0].body.params.config.langguard.user_id;
  const logged = () => JSON.parse(lines[0]);
  return { handler, calls, asked, sentUser, logged };
}

const hit = async () => ({ outcome: 'hit', userName: USER });

describe('caller from the STS key map', () => {
  it('sends the user of the access key ID as config.langguard.user_id in the request phase', async () => {
    const { handler, calls, sentUser, logged } = setup({ lookupCaller: hit });
    await handler(requestEvent({ headers: IAM_HEADERS }));
    assert.equal(calls.length, 1);
    assert.equal(sentUser(), USER);
    assert.deepEqual(calls[0].body.params.config, { langguard: { agent_type: 'agentcore', user_id: USER } });
    assert.equal(logged().caller, 'hit');
  });

  it('sends the user in the response phase', async () => {
    const { handler, sentUser } = setup({ lookupCaller: hit });
    await handler(responseEvent({ headers: IAM_HEADERS }));
    assert.equal(sentUser(), USER);
  });

  it('looks up the key ID of the header, with any header-name case', async () => {
    const { handler, asked } = setup({ lookupCaller: hit });
    await handler(requestEvent({ headers: { traceparent: HEADERS.traceparent, AUTHORIZATION: SIGV4 } }));
    assert.deepEqual(asked, [KEY_ID]);
  });

  it('does not log the user name or the key ID', async () => {
    const lines = [];
    const handler = createHandler({
      fetch: fakeFetch(() => json(invokeResult({ valid: true }))).fetch,
      getApiKey: async () => API_KEY,
      env: ENV,
      log: (l) => lines.push(l),
      lookupCaller: hit,
    });
    await handler(requestEvent({ headers: IAM_HEADERS }));
    assert.ok(!lines[0].includes(USER));
    assert.ok(!lines[0].includes(KEY_ID));
  });

  for (const outcome of ['miss', 'timeout', 'error']) {
    it(`sends no user and lets the call through to LangGuard on a ${outcome}`, async () => {
      const { handler, calls, sentUser, logged } = setup({ lookupCaller: async () => ({ outcome }) });
      const output = await handler(requestEvent({ headers: IAM_HEADERS }));
      assert.equal(calls.length, 1);
      assert.equal(sentUser(), undefined);
      assert.ok(output.mcp.transformedGatewayRequest);
      assert.equal(logged().caller, outcome);
    });
  }

  it('sends no user and lets the call through when the lookup throws', async () => {
    const { handler, calls, sentUser, logged } = setup({
      lookupCaller: async () => { throw new Error('boom'); },
    });
    const output = await handler(requestEvent({ headers: IAM_HEADERS }));
    assert.equal(calls.length, 1);
    assert.equal(sentUser(), undefined);
    assert.ok(output.mcp.transformedGatewayRequest);
    assert.equal(logged().caller, 'error');
  });

  it('sends no user within the deadline when the table never answers', async () => {
    const lookupCaller = createCallerLookup({ getItem: () => new Promise(() => {}), timeoutMs: 20 });
    const { handler, calls, sentUser, logged } = setup({ lookupCaller });
    const started = performance.now();
    await handler(requestEvent({ headers: IAM_HEADERS }));
    assert.ok(performance.now() - started < 500);
    assert.equal(calls.length, 1);
    assert.equal(sentUser(), undefined);
    assert.equal(logged().caller, 'timeout');
  });

  it('logs off and sends no user when the key map is not configured', async () => {
    const { handler, sentUser, logged } = setup();
    await handler(requestEvent({ headers: IAM_HEADERS }));
    assert.equal(sentUser(), undefined);
    assert.equal(logged().caller, 'off');
  });

  it('does not look up a Bearer token, and the JWT claim gives the user', async () => {
    const { handler, asked, sentUser, logged } = setup({ lookupCaller: hit, env: ENV });
    await handler(requestEvent());
    assert.deepEqual(asked, []);
    assert.equal(sentUser(), 'E-9');
    assert.equal(logged().caller, 'none');
  });

  it('does not use the key map for a Bearer token without the configured claim', async () => {
    const { handler, asked, sentUser } = setup({ lookupCaller: hit });
    await handler(requestEvent());
    assert.deepEqual(asked, []);
    assert.equal(sentUser(), undefined);
  });

  it('does not look up a call without an Authorization header', async () => {
    const { handler, asked, logged } = setup({ lookupCaller: hit });
    await handler(requestEvent({ headers: { traceparent: HEADERS.traceparent } }));
    assert.deepEqual(asked, []);
    assert.equal(logged().caller, 'none');
  });

  it('does not look up a tools/list', async () => {
    const { handler, asked } = setup({ lookupCaller: hit });
    await handler(requestEvent({ body: { jsonrpc: '2.0', id: 1, method: 'tools/list' }, headers: IAM_HEADERS }));
    assert.deepEqual(asked, []);
  });
});

describe('bearer token and the gateway authorizer', () => {
  const forged = (claims) =>
    `Bearer x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.y`;
  const FORGED = { sub: 'victim', 'custom:employee': 'victim@corp.example', user_id: 'victim' };

  for (const authorizer of ['AWS_IAM', 'NONE']) {
    it(`ignores a bearer token when the authorizer is ${authorizer}`, async () => {
      const { handler, calls, sentUser } = setup({
        lookupCaller: hit,
        env: { ...ENV, LANGGUARD_AUTHORIZER: authorizer },
      });
      await handler(requestEvent({ headers: { ...HEADERS, Authorization: forged(FORGED) } }));
      assert.equal(sentUser(), undefined);
      assert.equal(calls[0].body.params.context.principal, undefined);
    });
  }

  it('sends the key map user and not a token user when the authorizer is AWS_IAM', async () => {
    const { handler, sentUser } = setup({ lookupCaller: hit, env: { ...ENV, LANGGUARD_AUTHORIZER: 'AWS_IAM' } });
    await handler(requestEvent({ headers: IAM_HEADERS }));
    assert.equal(sentUser(), USER);
  });

  it('reads the token claims when the authorizer is CUSTOM_JWT or not set', async () => {
    for (const env of [{ ...ENV, LANGGUARD_AUTHORIZER: 'CUSTOM_JWT' }, ENV]) {
      const { handler, calls, sentUser } = setup({ env });
      await handler(requestEvent({ headers: { ...HEADERS, Authorization: forged(FORGED) } }));
      assert.equal(sentUser(), 'victim@corp.example');
      assert.equal(calls[0].body.params.context.principal.id, 'victim');
    }
  });
});

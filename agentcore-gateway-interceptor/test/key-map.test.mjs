import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createCallerLookup, createKeyMapWriter } from '../src/key-map.mjs';

const KEY_ID = 'ASIAIOSFODNN7EXAMPLE';
const USER = 'jane@corp.example';
// 2023-08-28T19:00:58Z, the expiration of the AWS example event.
const EXPIRES_AT = 1693249258;
const SIGN_IN_TIME = (EXPIRES_AT - 3600) * 1000;
const ROLE = 'AWSReservedSSO_Developer_0123456789abcdef';

/** An EventBridge event around the AWS documented CloudTrail record for AssumeRoleWithSAML. */
function signInEvent(edit = (d) => d) {
  const detail = {
    eventVersion: '1.08',
    userIdentity: { type: 'SAMLUser', userName: USER },
    eventTime: '2023-08-28T18:00:58Z',
    eventSource: 'sts.amazonaws.com',
    eventName: 'AssumeRoleWithSAML',
    awsRegion: 'us-east-1',
    sourceIPAddress: 'AWS Internal',
    requestParameters: {
      roleArn: `arn:aws:iam::444455556666:role/aws-reserved/sso.amazonaws.com/${ROLE}`,
      principalArn: 'arn:aws:iam::444455556666:saml-provider/AWSSSO_0123456789abcdef_DO_NOT_DELETE',
      roleSessionName: USER,
    },
    responseElements: {
      credentials: { accessKeyId: KEY_ID, sessionToken: 'token-blob', expiration: 'Aug 28, 2023, 7:00:58 PM' },
      assumedRoleUser: {
        assumedRoleId: `AROAD35QRSTUVWEXAMPLE:${USER}`,
        arn: `arn:aws:sts::444455556666:assumed-role/${ROLE}/${USER}`,
      },
    },
    readOnly: true,
    eventType: 'AwsApiCall',
    managementEvent: true,
  };
  return { version: '0', 'detail-type': 'AWS API Call via CloudTrail', source: 'aws.sts', detail: edit(detail) };
}

function writer({ putItem, rolePrefix } = {}) {
  const items = [];
  const lines = [];
  const handler = createKeyMapWriter({
    putItem: putItem ?? (async (item) => items.push(item)),
    ...(rolePrefix ? { rolePrefix } : {}),
    now: () => SIGN_IN_TIME,
    log: (l) => lines.push(l),
  });
  return { handler, items, lines };
}

const EXPECTED_ITEM = {
  accessKeyId: { S: KEY_ID },
  userName: { S: USER },
  expiresAt: { N: String(EXPIRES_AT) },
};

describe('key map writer', () => {
  it('writes a role under the Region path of IAM Identity Center', async () => {
    const { handler, items } = writer();
    await handler(
      signInEvent((d) => {
        d.requestParameters.roleArn = `arn:aws:iam::444455556666:role/aws-reserved/sso.amazonaws.com/eu-west-1/${ROLE}`;
        return d;
      }),
    );
    assert.deepEqual(items, [EXPECTED_ITEM]);
  });

  for (const [name, roleArn] of [
    ['a role outside the aws-reserved path', `arn:aws:iam::444455556666:role/${ROLE}`],
    ['a role under another path', `arn:aws:iam::444455556666:role/sso.amazonaws.com/${ROLE}`],
    ['a role of another account', `arn:aws:iam::111122223333:role/aws-reserved/sso.amazonaws.com/${ROLE}`],
    ['a role with another name', 'arn:aws:iam::444455556666:role/aws-reserved/sso.amazonaws.com/AWSReservedSSO_Admin_0123456789abcdef'],
    ['no role ARN', undefined],
  ]) {
    it(`ignores ${name}`, async () => {
      const { handler, items, lines } = writer();
      await handler(
        signInEvent((d) => {
          d.requestParameters.roleArn = roleArn;
          return d;
        }),
      );
      assert.deepEqual(items, []);
      assert.equal(JSON.parse(lines[0]).reason, 'not an IAM Identity Center role');
    });
  }

  it('writes the key ID, the session name and the expiration in epoch seconds', async () => {
    const { handler, items } = writer();
    await handler(signInEvent());
    assert.deepEqual(items, [EXPECTED_ITEM]);
  });

  it('reads an expiration with a narrow no-break space before PM', async () => {
    const { handler, items } = writer();
    await handler(
      signInEvent((d) => {
        d.responseElements.credentials.expiration = 'Aug 28, 2023, 7:00:58 PM';
        return d;
      }),
    );
    assert.deepEqual(items, [EXPECTED_ITEM]);
  });

  it('ignores an ISO expiration that is not a real date', async () => {
    const { handler, items, lines } = writer();
    await handler(
      signInEvent((d) => {
        d.responseElements.credentials.expiration = '2025-13-45T00:00:00Z';
        return d;
      }),
    );
    assert.deepEqual(items, []);
    assert.deepEqual(JSON.parse(lines[0]), { outcome: 'ignore', reason: 'no expiration' });
  });

  it('writes the same item for a repeated event', async () => {
    const { handler, items } = writer();
    await handler(signInEvent());
    await handler(signInEvent());
    assert.deepEqual(items, [EXPECTED_ITEM, EXPECTED_ITEM]);
  });

  it('reads an ISO 8601 expiration', async () => {
    const { handler, items } = writer();
    await handler(signInEvent((d) => {
      d.responseElements.credentials.expiration = '2023-08-28T19:00:58Z';
      return d;
    }));
    assert.deepEqual(items, [EXPECTED_ITEM]);
  });

  it('reads a morning and a noon expiration in UTC', async () => {
    const at = async (expiration) => {
      const { handler, items } = writer();
      await handler(signInEvent((d) => {
        d.responseElements.credentials.expiration = expiration;
        return d;
      }));
      return Number(items[0].expiresAt.N);
    };
    assert.equal(await at('Aug 29, 2023, 12:30:00 PM'), Date.UTC(2023, 7, 29, 12, 30) / 1000);
    assert.equal(await at('Aug 29, 2023, 12:30:00 AM'), Date.UTC(2023, 7, 29, 0, 30) / 1000);
    assert.equal(await at('Aug 29, 2023 1:05:09 AM'), Date.UTC(2023, 7, 29, 1, 5, 9) / 1000);
  });

  const ignored = [
    ['another STS call', (d) => ({ ...d, eventName: 'AssumeRole' }), 'not AssumeRoleWithSAML'],
    ['another event source', (d) => ({ ...d, eventSource: 'signin.amazonaws.com' }), 'not AssumeRoleWithSAML'],
    ['a failed call', (d) => ({ ...d, errorCode: 'AccessDenied', responseElements: null }), 'call failed'],
    ['a role without the prefix', (d) => {
      d.responseElements.assumedRoleUser.arn = `arn:aws:sts::444455556666:assumed-role/Admin/${USER}`;
      return d;
    }, 'role name has another prefix'],
    ['no access key ID', (d) => {
      delete d.responseElements.credentials.accessKeyId;
      return d;
    }, 'no access key ID'],
    ['an access key ID that is not a key ID', (d) => {
      d.responseElements.credentials.accessKeyId = 'ASIA/../../x';
      return d;
    }, 'no access key ID'],
    ['an IAM role ARN in place of the assumed-role ARN', (d) => {
      d.responseElements.assumedRoleUser.arn = 'arn:aws:iam::444455556666:role/AWSReservedSSO_Developer_0123';
      return d;
    }, 'no assumed-role ARN'],
    ['an expiration in another format', (d) => {
      d.responseElements.credentials.expiration = 'tomorrow';
      return d;
    }, 'no expiration'],
    ['expired credentials', (d) => {
      d.responseElements.credentials.expiration = 'Aug 28, 2023, 5:00:58 PM';
      return d;
    }, 'credentials expired'],
  ];
  for (const [name, edit, reason] of ignored) {
    it(`ignores ${name}`, async () => {
      const { handler, items, lines } = writer();
      await handler(signInEvent(edit));
      assert.deepEqual(items, []);
      assert.deepEqual(lines.map((l) => JSON.parse(l)), [{ outcome: 'ignore', reason }]);
    });
  }

  it('ignores an event without detail', async () => {
    const { handler, items } = writer();
    await handler({ source: 'aws.sts' });
    await handler(null);
    assert.deepEqual(items, []);
  });

  it('uses the configured role prefix', async () => {
    const { handler, items } = writer({ rolePrefix: 'AWSReservedSSO_Admin' });
    await handler(signInEvent((d) => {
      d.responseElements.assumedRoleUser.arn = `arn:aws:sts::444455556666:assumed-role/AWSReservedSSO_AdminRole/${USER}`;
      d.requestParameters.roleArn = 'arn:aws:iam::444455556666:role/aws-reserved/sso.amazonaws.com/AWSReservedSSO_AdminRole';
      return d;
    }));
    assert.equal(items.length, 1);
    const { handler: other, items: none } = writer({ rolePrefix: 'AWSReservedSSO_Admin' });
    await other(signInEvent());
    assert.deepEqual(none, []);
  });

  it('logs one line with a masked key ID and without the user name', async () => {
    const { handler, lines } = writer();
    await handler(signInEvent());
    assert.equal(lines.length, 1);
    assert.deepEqual(JSON.parse(lines[0]), { outcome: 'write', key: 'ASIA...', expiresAt: EXPIRES_AT });
    assert.ok(!lines[0].includes(KEY_ID));
    assert.ok(!lines[0].includes(USER));
  });

  it('throws when the write fails, so that Lambda retries the event', async () => {
    const failure = Object.assign(new Error(`no access to ${KEY_ID}`), { name: 'AccessDeniedException' });
    const { handler, lines } = writer({ putItem: async () => { throw failure; } });
    await assert.rejects(handler(signInEvent()), failure);
    assert.deepEqual(JSON.parse(lines[0]), { outcome: 'error', reason: 'AccessDeniedException', key: 'ASIA...' });
  });
});

function lookupWith(answer, { timeoutMs } = {}) {
  let t = SIGN_IN_TIME;
  const reads = [];
  const lookup = createCallerLookup({
    getItem: async (id) => {
      reads.push(id);
      return answer(id);
    },
    now: () => t,
    ...(timeoutMs ? { timeoutMs } : {}),
  });
  return { lookup, reads, advance: (ms) => { t += ms; } };
}

describe('caller lookup', () => {
  it('returns the user of a stored key and keeps it until the credentials expire', async () => {
    const { lookup, reads, advance } = lookupWith(() => EXPECTED_ITEM);
    assert.deepEqual(await lookup(KEY_ID), { outcome: 'hit', userName: USER });
    advance(3599_000);
    assert.deepEqual(await lookup(KEY_ID), { outcome: 'hit', userName: USER });
    assert.equal(reads.length, 1);
  });

  it('reads the table again after the credentials expire', async () => {
    const { lookup, reads, advance } = lookupWith(() => EXPECTED_ITEM);
    await lookup(KEY_ID);
    advance(3600_000);
    assert.deepEqual(await lookup(KEY_ID), { outcome: 'miss' });
    assert.equal(reads.length, 2);
  });

  it('returns no user for an expired item that the table has not deleted yet', async () => {
    const { lookup } = lookupWith(() => ({ ...EXPECTED_ITEM, expiresAt: { N: String(SIGN_IN_TIME / 1000 - 1) } }));
    assert.deepEqual(await lookup(KEY_ID), { outcome: 'miss' });
  });

  it('returns no user for an item that has no user name', async () => {
    const { lookup } = lookupWith(() => ({ ...EXPECTED_ITEM, userName: { S: '' } }));
    assert.deepEqual(await lookup(KEY_ID), { outcome: 'miss' });
  });

  it('keeps a miss for 10 seconds, then finds a sign-in that arrived later', async () => {
    let stored;
    const { lookup, reads, advance } = lookupWith(() => stored);
    assert.deepEqual(await lookup(KEY_ID), { outcome: 'miss' });
    stored = EXPECTED_ITEM;
    advance(9_000);
    assert.deepEqual(await lookup(KEY_ID), { outcome: 'miss' });
    assert.equal(reads.length, 1);
    advance(1_000);
    assert.deepEqual(await lookup(KEY_ID), { outcome: 'hit', userName: USER });
    assert.equal(reads.length, 2);
  });

  it('returns an error outcome and does not throw when the read fails', async () => {
    const { lookup } = lookupWith(() => {
      throw new Error('throttled');
    });
    assert.deepEqual(await lookup(KEY_ID), { outcome: 'error' });
  });

  it('reports a remembered failed read as an error, not a miss', async () => {
    const { lookup, reads } = lookupWith(() => {
      throw new Error('throttled');
    });
    await lookup(KEY_ID);
    assert.deepEqual(await lookup(KEY_ID), { outcome: 'error' });
    assert.equal(reads.length, 1);
  });

  it('returns a timeout outcome at the deadline and keeps the late result for the next call', async () => {
    let release;
    const late = new Promise((resolve) => { release = resolve; });
    const { lookup, reads } = lookupWith(() => late, { timeoutMs: 20 });
    const started = performance.now();
    assert.deepEqual(await lookup(KEY_ID), { outcome: 'timeout' });
    assert.ok(performance.now() - started < 500);
    release(EXPECTED_ITEM);
    await late;
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(await lookup(KEY_ID), { outcome: 'hit', userName: USER });
    assert.equal(reads.length, 1);
  });

  it('returns a timeout outcome for a read that never ends', async () => {
    const { lookup } = lookupWith(() => new Promise(() => {}), { timeoutMs: 20 });
    assert.deepEqual(await lookup(KEY_ID), { outcome: 'timeout' });
    assert.deepEqual(await lookup(KEY_ID), { outcome: 'timeout' });
  });

  it('keeps at most 1000 keys', async () => {
    const id = (n) => `ASIA${String(n).padStart(16, '0')}`;
    const { lookup, reads } = lookupWith((k) => ({ ...EXPECTED_ITEM, accessKeyId: { S: k } }));
    for (let n = 0; n <= 1000; n += 1) await lookup(id(n));
    assert.equal(reads.length, 1001);
    await lookup(id(1000));
    assert.equal(reads.length, 1001);
    await lookup(id(0));
    assert.equal(reads.length, 1002);
  });

  it('does not take the user of an item for another key', async () => {
    const { lookup } = lookupWith(() => ({ ...EXPECTED_ITEM, accessKeyId: { S: 'ASIAOTHERKEY00000000' } }));
    assert.deepEqual(await lookup(KEY_ID), { outcome: 'miss' });
  });
});

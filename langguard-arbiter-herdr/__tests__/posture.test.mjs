import assert from 'node:assert/strict';
import { test } from 'node:test';
import { POSTURE_SUMMARY, POSTURE_TOKEN, derivePosture } from '../lib/posture.mjs';

const supported = { kind: 'supported', label: 'claude' };
const healthy = { kind: 'healthy', pid: 4242, bundleRevision: 7 };

const CASES = [
  ['no agent in the pane', { daemon: healthy, agent: { kind: 'none' } }, 'unmonitored'],
  [
    'an unsupported agent beats a healthy daemon',
    { daemon: healthy, agent: { kind: 'unsupported', label: 'gemini' }, probe: 'proven', probeProvenUnderPid: 4242 },
    'unsupported',
  ],
  [
    'healthy daemon with proof from the same pid',
    { daemon: healthy, agent: supported, probe: 'proven', probeProvenUnderPid: 4242 },
    'enforcing',
  ],
  [
    'proof from a different pid is void',
    { daemon: healthy, agent: supported, probe: 'proven', probeProvenUnderPid: 999 },
    'unproven',
  ],
  [
    'proof without a recorded pid is void',
    { daemon: healthy, agent: supported, probe: 'proven', probeProvenUnderPid: null },
    'unproven',
  ],
  [
    'a healthy daemon with no pid cannot hold proof',
    { daemon: { kind: 'healthy' }, agent: supported, probe: 'proven', probeProvenUnderPid: 4242 },
    'unproven',
  ],
  [
    'a silent probe is not proof',
    { daemon: healthy, agent: supported, probe: 'silent', probeProvenUnderPid: null },
    'unproven',
  ],
  [
    'no probe yet',
    { daemon: healthy, agent: supported, probe: null, probeProvenUnderPid: null },
    'unproven',
  ],
  [
    'proof does not survive the daemon leaving healthy',
    { daemon: { kind: 'wedged', pid: 4242 }, agent: supported, probe: 'proven', probeProvenUnderPid: 4242 },
    'wedged',
  ],
  [
    'a transient daemon is warming',
    { daemon: { kind: 'transient' }, agent: supported, probe: null, probeProvenUnderPid: null },
    'warming',
  ],
  [
    'absent under the first contact boundary',
    { daemon: { kind: 'absent', firstContactAgeMs: 19_999 }, agent: supported },
    'warming',
  ],
  [
    'absent at the first contact boundary',
    { daemon: { kind: 'absent', firstContactAgeMs: 20_000 }, agent: supported },
    'exposed',
  ],
  [
    'absent over the first contact boundary',
    { daemon: { kind: 'absent', firstContactAgeMs: 20_001 }, agent: supported },
    'exposed',
  ],
  [
    'absent without a first contact age',
    { daemon: { kind: 'absent' }, agent: supported },
    'unknown',
  ],
  [
    'absent with a non numeric first contact age',
    { daemon: { kind: 'absent', firstContactAgeMs: 'soon' }, agent: supported },
    'unknown',
  ],
  [
    'absent with an infinite first contact age',
    { daemon: { kind: 'absent', firstContactAgeMs: Number.POSITIVE_INFINITY }, agent: supported },
    'unknown',
  ],
  ['no daemon at all', { daemon: { kind: 'no-daemon' }, agent: supported }, 'exposed'],
  ['an unknown daemon kind', { daemon: { kind: 'sideways' }, agent: supported }, 'unknown'],
  ['a prototype key as the daemon kind', { daemon: { kind: 'constructor' }, agent: supported }, 'unknown'],
  ['the proto key as the daemon kind', { daemon: { kind: '__proto__' }, agent: supported }, 'unknown'],
  ['toString as the daemon kind', { daemon: { kind: 'toString' }, agent: supported }, 'unknown'],
  ['a missing daemon', { daemon: null, agent: supported }, 'unknown'],
  ['a daemon that is not an object', { daemon: 'healthy', agent: supported }, 'unknown'],
  ['a missing agent', { daemon: healthy }, 'unknown'],
  ['an agent that is not an object', { daemon: healthy, agent: 'claude' }, 'unknown'],
  ['an unknown agent kind', { daemon: healthy, agent: { kind: 'maybe' } }, 'unknown'],
];

for (const [name, input, expected] of CASES) {
  test(`derivePosture: ${name}`, () => {
    assert.equal(derivePosture(input), expected);
  });
}

test('derivePosture never throws on garbage input', () => {
  assert.equal(derivePosture(undefined), 'unknown');
  assert.equal(derivePosture(null), 'unknown');
  assert.equal(derivePosture(42), 'unknown');
  assert.equal(derivePosture('healthy'), 'unknown');
  assert.equal(derivePosture([]), 'unknown');
  assert.equal(derivePosture({}), 'unknown');
});

test('every posture is reached by the case table', () => {
  const reached = new Set(CASES.map(([, input]) => derivePosture(input)));
  assert.deepEqual(
    [...reached].sort(),
    ['enforcing', 'exposed', 'unknown', 'unmonitored', 'unproven', 'unsupported', 'warming', 'wedged'],
  );
});

test('POSTURE_TOKEN maps every posture to its badge value', () => {
  assert.deepEqual(POSTURE_TOKEN, {
    enforcing: 'ENFORCING',
    unproven: 'UNPROVEN',
    warming: 'WARMING',
    exposed: 'EXPOSED',
    wedged: 'WEDGED',
    unsupported: 'UNCOVERED',
    unmonitored: null,
    unknown: null,
  });
});

test('POSTURE_SUMMARY holds the exact user facing text', () => {
  assert.deepEqual(POSTURE_SUMMARY, {
    enforcing: 'Arbiter is live and this agent sent a decision through it.',
    unproven: 'Arbiter is live but this agent has not sent a decision yet.',
    warming: 'Arbiter is starting. Coverage is not confirmed yet.',
    exposed: 'Arbiter does not run. This agent has no policy control.',
    wedged: 'Arbiter runs but does not answer. Coverage is broken.',
    unsupported: 'Arbiter has no plugin for this agent. It has no policy control.',
    unmonitored: 'No agent runs in this pane.',
    unknown: 'Coverage is not known.',
  });
});

test('every summary fits the pane token limit', () => {
  for (const [posture, summary] of Object.entries(POSTURE_SUMMARY)) {
    assert.equal(typeof summary, 'string');
    assert.ok(summary.length <= 80, `${posture} is ${summary.length} characters`);
  }
});

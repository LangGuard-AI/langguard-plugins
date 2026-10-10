import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ARBITER_HARNESSES, coverageFor } from '../lib/coverage.mjs';

test('claude resolves to the claude harness with its install lines', () => {
  assert.deepEqual(coverageFor('claude'), {
    supported: true,
    harness: 'claude',
    install: [
      'claude plugin marketplace add LangGuard-AI/langguard-plugins',
      'claude plugin install langguard-arbiter@langguard-plugins',
    ],
  });
});

test('codex resolves to the codex harness with its install lines', () => {
  assert.deepEqual(coverageFor('codex'), {
    supported: true,
    harness: 'codex',
    install: [
      'codex plugin marketplace add LangGuard-AI/langguard-plugins',
      'codex plugin install langguard-arbiter',
    ],
  });
});

test('cursor resolves to the cursor harness with a manual install line', () => {
  const result = coverageFor('cursor');
  assert.equal(result.supported, true);
  assert.equal(result.harness, 'cursor');
  assert.equal(result.install.length, 1);
  assert.equal(
    result.install[0],
    'Open the Cursor plugin marketplace and install the LangGuard Arbiter plugin. Cursor has no command line installer.',
  );
});

test('agy and antigravity both resolve to the antigravity harness', () => {
  const expected = {
    supported: true,
    harness: 'antigravity',
    install: ['agy plugin install LangGuard-AI/langguard-plugins/langguard-arbiter-antigravity'],
  };
  assert.deepEqual(coverageFor('agy'), expected);
  assert.deepEqual(coverageFor('antigravity'), expected);
});

test('every supported label carries a harness and a non empty install list', () => {
  const labels = Object.keys(ARBITER_HARNESSES);
  assert.deepEqual(labels.sort(), ['agy', 'antigravity', 'claude', 'codex', 'cursor']);
  for (const label of labels) {
    const result = coverageFor(label);
    assert.equal(result.supported, true);
    assert.equal(typeof result.harness, 'string');
    assert.ok(result.harness.length > 0);
    assert.ok(Array.isArray(result.install));
    assert.ok(result.install.length > 0);
    for (const line of result.install) {
      assert.equal(typeof line, 'string');
      assert.ok(line.length > 0);
    }
  }
});

test('an agent Arbiter does not cover is unsupported', () => {
  assert.deepEqual(coverageFor('droid'), { supported: false });
  assert.deepEqual(coverageFor('opencode'), { supported: false });
  assert.deepEqual(coverageFor('gemini'), { supported: false });
  assert.deepEqual(coverageFor('a-label-nobody-ships'), { supported: false });
});

test('a prototype key is not a supported agent', () => {
  assert.deepEqual(coverageFor('__proto__'), { supported: false });
  assert.deepEqual(coverageFor('constructor'), { supported: false });
  assert.deepEqual(coverageFor('toString'), { supported: false });
  assert.deepEqual(coverageFor('hasOwnProperty'), { supported: false });
});

test('a value that is not a string is not a supported agent', () => {
  assert.deepEqual(coverageFor(null), { supported: false });
  assert.deepEqual(coverageFor(undefined), { supported: false });
  assert.deepEqual(coverageFor(42), { supported: false });
  assert.deepEqual(coverageFor({}), { supported: false });
});

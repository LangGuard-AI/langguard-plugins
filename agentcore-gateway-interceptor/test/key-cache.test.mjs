import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as tick } from 'node:timers/promises';

import { createKeyCache } from '../src/key-cache.mjs';

/** Each entry is a key, an Error to throw, or a function that returns the read's promise. */
function setup(results) {
  let t = 0;
  let reads = 0;
  const cache = createKeyCache({
    read: async () => {
      const next = results[reads++];
      if (typeof next === 'function') return next();
      if (next instanceof Error) throw next;
      return next;
    },
    ttlMs: 100,
    now: () => t,
  });
  return { cache, advance: (ms) => { t += ms; }, reads: () => reads };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function within(promise, ms = 200) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`still pending after ${ms} ms`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

describe('createKeyCache', () => {
  it('reads once within the TTL, then returns the new key once the refresh after the TTL finishes', async () => {
    const { cache, advance, reads } = setup(['k1', 'k2']);
    assert.equal(await cache.get(), 'k1');
    advance(99);
    assert.equal(await cache.get(), 'k1');
    assert.equal(reads(), 1);
    advance(1);
    assert.equal(await cache.get(), 'k1');
    assert.equal(reads(), 2);
    await tick();
    assert.equal(await cache.get(), 'k2');
    assert.equal(reads(), 2);
  });

  it('returns the cached key at once when the refresh after the TTL never finishes', async () => {
    const { cache, advance } = setup(['k1', () => new Promise(() => {})]);
    await cache.get();
    advance(100);
    assert.equal(await within(cache.get()), 'k1');
  });

  it('starts one refresh for several calls while it is in flight', async () => {
    const refresh = deferred();
    const { cache, advance, reads } = setup(['k1', () => refresh.promise, 'k3']);
    await cache.get();
    advance(100);
    assert.deepEqual(await Promise.all([cache.get(), cache.get(), cache.get()]), ['k1', 'k1', 'k1']);
    assert.equal(reads(), 2);
    refresh.resolve('k2');
    await tick();
    assert.equal(await cache.get(), 'k2');
    assert.equal(reads(), 2);
  });

  it('keeps the cached key when the refresh fails, and tries again on the next call', async () => {
    const { cache, advance, reads } = setup(['k1', new Error('throttled'), 'k2']);
    await cache.get();
    advance(100);
    assert.equal(await cache.get(), 'k1');
    await tick();
    assert.equal(await cache.get(), 'k1');
    assert.equal(reads(), 3);
    await tick();
    assert.equal(await cache.get(), 'k2');
  });

  it('causes no unhandled rejection when the refresh fails', async () => {
    const unhandled = [];
    const onUnhandled = (reason) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const { cache, advance } = setup(['k1', new Error('throttled')]);
      await cache.get();
      advance(100);
      await cache.get();
      await tick();
      await tick();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    assert.deepEqual(unhandled, []);
  });

  it('does not keep the key from a refresh that started before drop', async () => {
    const refresh = deferred();
    const { cache, advance, reads } = setup(['k1', () => refresh.promise, 'k3']);
    await cache.get();
    advance(100);
    await cache.get();
    cache.drop();
    refresh.resolve('k2');
    await tick();
    assert.equal(await cache.get(), 'k3');
    assert.equal(reads(), 3);
  });

  it('throws when the first read fails', async () => {
    const { cache } = setup([new Error('AccessDenied')]);
    await assert.rejects(cache.get(), /AccessDenied/);
  });

  it('reads again after drop, and does not return the dropped key when that read fails', async () => {
    const { cache, reads } = setup(['k1', 'k2', new Error('AccessDenied')]);
    await cache.get();
    cache.drop();
    assert.equal(await cache.get(), 'k2');
    assert.equal(reads(), 2);
    cache.drop();
    await assert.rejects(cache.get(), /AccessDenied/);
  });
});

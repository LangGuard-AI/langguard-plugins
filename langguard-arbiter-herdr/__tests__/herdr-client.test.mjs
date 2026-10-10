// Herdr serves one request per connection and then closes it. A client that keeps one socket
// and writes a second request to it fails with EPIPE, which made the supervisor exit on its
// second call. These tests pin the one-shot behaviour against a server that behaves the same way.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect, subscribe } from '../lib/herdr-client.mjs';

function oneShotServer(onRequest) {
  const dir = mkdtempSync(join(tmpdir(), 'arbiter-herdr-sock-'));
  const path = join(dir, 's.sock');
  let connections = 0;
  const server = createServer((socket) => {
    connections += 1;
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const index = buffer.indexOf('\n');
      if (index === -1) return;
      const request = JSON.parse(buffer.slice(0, index));
      socket.write(`${JSON.stringify(onRequest(request))}\n`);
      socket.end();
    });
  });
  return {
    path,
    connections: () => connections,
    listen: () => new Promise((resolve) => server.listen(path, resolve)),
    close: () => {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('a second call succeeds even though the server closed the first connection', async () => {
  const server = oneShotServer((req) => ({ id: req.id, result: { echoed: req.method } }));
  await server.listen();
  const client = connect(server.path);
  try {
    const first = await client.call('pane.list', {}, 2000);
    const second = await client.call('agent.list', {}, 2000);
    assert.deepEqual(first, { echoed: 'pane.list' });
    assert.deepEqual(second, { echoed: 'agent.list' });
    assert.equal(server.connections(), 2, 'each call opens its own connection');
  } finally {
    client.close();
    server.close();
  }
});

test('an error frame rejects with the server message', async () => {
  const server = oneShotServer((req) => ({
    id: req.id,
    error: { code: 'invalid_request', message: 'missing field `pane_id`' },
  }));
  await server.listen();
  const client = connect(server.path);
  try {
    await assert.rejects(
      () => client.call('events.subscribe', {}, 2000),
      /missing field `pane_id`/,
    );
  } finally {
    client.close();
    server.close();
  }
});

test('a call on a closed client rejects instead of opening a socket', async () => {
  const server = oneShotServer((req) => ({ id: req.id, result: {} }));
  await server.listen();
  const client = connect(server.path);
  client.close();
  try {
    await assert.rejects(() => client.call('pane.list', {}, 2000), /closed/);
    assert.equal(server.connections(), 0, 'a closed client opens no connection');
  } finally {
    server.close();
  }
});

test('subscribe reads snake_case frames and reports the close', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'arbiter-herdr-sub-'));
  const path = join(dir, 's.sock');
  const server = createServer((socket) => {
    socket.on('data', () => {
      socket.write(`${JSON.stringify({ id: 'subscribe', result: { type: 'subscription_started' } })}\n`);
      socket.write(`${JSON.stringify({ event: 'pane_agent_detected', data: { pane_id: 'w1:p1' } })}\n`);
      socket.end();
    });
  });
  await new Promise((resolve) => server.listen(path, resolve));

  const frames = [];
  let closed = false;
  const stream = subscribe(path, ['pane.agent_detected'], (kind, data) => frames.push([kind, data]));
  stream.onClose(() => {
    closed = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  stream.close();
  server.close();
  rmSync(dir, { recursive: true, force: true });

  assert.deepEqual(frames, [['pane_agent_detected', { pane_id: 'w1:p1' }]]);
  assert.equal(closed, true, 'the supervisor is told when the stream ends');
});

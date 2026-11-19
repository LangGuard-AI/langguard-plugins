import { connect as connectSocket } from 'node:net';

const DEFAULT_CALL_TIMEOUT_MS = 5000;

function readLines(socket, onLine) {
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    buffer += chunk;
    let index = buffer.indexOf('\n');
    while (index !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line.length > 0) onLine(line);
      index = buffer.indexOf('\n');
    }
  });
}

function parseFrame(line) {
  try {
    const frame = JSON.parse(line);
    return frame && typeof frame === 'object' ? frame : null;
  } catch {
    return null;
  }
}

// herdr serves ONE request per connection and then closes it, so a second write on the same
// socket fails with EPIPE. Only a subscription connection stays open. Every call therefore
// opens its own short-lived socket.
export function connect(socketPath) {
  let closed = false;

  function call(method, params, timeoutMs = DEFAULT_CALL_TIMEOUT_MS) {
    if (closed) return Promise.reject(new Error('The herdr client is closed.'));
    return new Promise((resolve, reject) => {
      const socket = connectSocket(socketPath);
      let settled = false;

      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        fn(value);
      };

      const timer = setTimeout(
        () => finish(reject, new Error(`The herdr call ${method} timed out.`)),
        timeoutMs,
      );
      timer.unref?.();

      readLines(socket, (line) => {
        const frame = parseFrame(line);
        if (!frame || frame.id !== 'c1') return;
        if (frame.error) {
          finish(reject, new Error(String(frame.error.message ?? 'The herdr call failed.')));
          return;
        }
        finish(resolve, frame.result ?? {});
      });

      socket.on('error', (error) => finish(reject, error));
      socket.on('close', () => finish(reject, new Error('The herdr socket closed.')));
      socket.on('connect', () => {
        socket.write(`${JSON.stringify({ id: 'c1', method, params: params ?? {} })}\n`);
      });
    });
  }

  return {
    call,
    close() {
      closed = true;
    },
  };
}

export function subscribe(socketPath, types, onFrame) {
  const socket = connectSocket(socketPath);
  const handlers = { close: null, error: null };

  socket.on('connect', () => {
    const request = {
      id: 'subscribe',
      method: 'events.subscribe',
      // The subscription type uses dots. The streamed frame kind uses underscores.
      params: { subscriptions: types.map((type) => ({ type })) },
    };
    socket.write(`${JSON.stringify(request)}\n`);
  });

  readLines(socket, (line) => {
    const frame = parseFrame(line);
    if (!frame || typeof frame.event !== 'string') return;
    try {
      onFrame(frame.event, frame.data ?? {});
    } catch (error) {
      process.stderr.write(`event handler failed: ${String(error?.message ?? error)}\n`);
    }
  });

  socket.on('error', (error) => handlers.error?.(error));
  socket.on('close', () => handlers.close?.());

  return {
    onClose(handler) {
      handlers.close = handler;
    },
    onError(handler) {
      handlers.error = handler;
    },
    close() {
      socket.destroy();
    },
  };
}

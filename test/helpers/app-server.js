'use strict';

const { EventEmitter } = require('events');

// JSONL transport double. The production client still performs initialization,
// serialization, decoding, request matching, turn handling and session queuing.
function createAppServerHarness(onRequest) {
  const requests = [];
  const responses = [];
  const children = [];
  const events = new EventEmitter();
  let threadCount = 0;
  let turnCount = 0;

  function send(child, message, bytewise = false) {
    const bytes = Buffer.from(`${JSON.stringify(message)}\n`);
    if (bytewise) {
      for (const byte of bytes) child.stdout.emit('data', Buffer.from([byte]));
    } else child.stdout.emit('data', bytes);
  }

  const spawnImpl = jest.fn(() => {
    const child = new EventEmitter();
    child.pid = 1234 + children.length;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = {
      write: jest.fn(line => {
        const message = JSON.parse(line);
        if (!message.method) {
          responses.push(message);
          events.emit('response', message);
          return true;
        }
        requests.push(message);
        events.emit('request', message);
        if (message.id == null) return true;
        setImmediate(() => {
          const transport = {
            child,
            reply: result => send(child, { id: message.id, result }),
            error: text => send(child, { id: message.id, error: { code: -32000, message: text } }),
            notify: (method, params, bytewise) => send(child, { method, params }, bytewise),
            send: (value, bytewise) => send(child, value, bytewise)
          };
          if (onRequest && onRequest(message, transport) === true) return;
          if (message.method === 'initialize') transport.reply({ serverInfo: { name: 'test-server' } });
          else if (message.method === 'thread/start') transport.reply({ thread: { id: `thread-${++threadCount}` } });
          else if (message.method === 'turn/start') {
            const id = `turn-${++turnCount}`;
            transport.reply({ turn: { id } });
            setImmediate(() => transport.notify('turn/completed', {
              threadId: message.params.threadId,
              turn: { id, status: 'completed', items: [{ type: 'agentMessage', text: 'Fertig.' }] }
            }));
          } else transport.reply({ ok: true });
        });
        return true;
      })
    };
    children.push(child);
    return child;
  });

  function waitFor(kind, predicate, existing) {
    const found = existing.find(predicate);
    if (found) return Promise.resolve(found);
    return new Promise(resolve => {
      const handler = message => {
        if (!predicate(message)) return;
        events.removeListener(kind, handler);
        resolve(message);
      };
      events.on(kind, handler);
    });
  }

  return {
    spawnImpl, children, requests, responses, send,
    waitForRequest: method => waitFor('request', message => message.method === method, requests),
    waitForResponse: id => waitFor('response', message => message.id === id, responses),
    close() {
      for (const child of children) child.emit('close', 0);
      events.removeAllListeners();
    }
  };
}

module.exports = { createAppServerHarness };

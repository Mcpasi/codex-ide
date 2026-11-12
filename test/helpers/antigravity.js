'use strict';

const { EventEmitter } = require('events');

// Only process I/O is simulated. Production NDJSON decoding, session queues,
// cancellation and the gateway/editor pipeline remain in use.
function createAntigravityHarness(onPrompt) {
  const children = [], prompts = [];
  const events = new EventEmitter();
  function send(child, event, bytewise = false) {
    const bytes = Buffer.from(JSON.stringify(event) + '\n');
    if (bytewise) for (const byte of bytes) child.stdout.emit('data', Buffer.from([byte]));
    else child.stdout.emit('data', bytes);
  }
  const spawnImpl = jest.fn(() => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.stdin = new EventEmitter();
    child.kill = jest.fn(() => { setImmediate(() => child.emit('close', null)); return true; });
    const threadId = 'agy-conversation-' + (children.length + 1);
    let index = 0;
    child.stdin.write = jest.fn(line => {
      const prompt = JSON.parse(line);
      prompts.push(prompt);
      events.emit('prompt', prompt);
      setImmediate(() => {
        if (index === 0) send(child, { event: 'init', conversation_id: threadId, init: {} });
        const transport = { child, send: (event, bytewise) => send(child, event, bytewise),
          token: (text, bytewise) => send(child, { event: 'step_update', step_update: {
            conversation_id: threadId, step_index: index, step_type: 'agent_response', state: 'ACTIVE', text_delta: text
          } }, bytewise),
          result: (text, extra = {}) => send(child, { event: 'result', result: {
            conversation_id: threadId, status: 'SUCCESS', response: text, num_turns: index + 1, ...extra
          } }) };
        index++;
        if (onPrompt && onPrompt(prompt, transport) === true) return;
        transport.token('Grüße 👋'); transport.result('Grüße 👋');
      });
      return true;
    });
    children.push(child);
    return child;
  });
  return { children, prompts, spawnImpl, send,
    waitForPrompt(count = 1) {
      if (prompts.length >= count) return Promise.resolve(prompts[count - 1]);
      return new Promise(resolve => {
        const handler = () => {
          if (prompts.length < count) return;
          events.removeListener('prompt', handler); resolve(prompts[count - 1]);
        };
        events.on('prompt', handler);
      });
    }
  };
}

module.exports = { createAntigravityHarness };

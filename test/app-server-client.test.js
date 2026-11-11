'use strict';

const { CodexAppServerClient, extractAgentTextFromTurn } = require('../scripts/codex-app-server-client');
const { createAppServerHarness } = require('./helpers/app-server');

describe('persistent App Server JSONL client', () => {
  let harness;
  let client;

  function setup(handler, options = {}) {
    harness = createAppServerHarness(handler);
    client = new CodexAppServerClient({
      spawnImpl: harness.spawnImpl, codexBin: 'test-codex', cwd: __dirname,
      persistSessions: true, requestTimeoutMs: 500, ...options
    });
  }

  afterEach(() => { if (harness) harness.close(); });

  test('initializes once when requests arrive concurrently', async () => {
    setup();
    await Promise.all([client.request('model/list', {}), client.request('account/read', {})]);
    expect(harness.spawnImpl).toHaveBeenCalledTimes(1);
    expect(harness.spawnImpl.mock.calls[0][0]).toBe('test-codex');
    expect(harness.spawnImpl.mock.calls[0][1]).toEqual(expect.arrayContaining(['app-server', '--stdio', 'default_permissions=\"codex-ide-live-editor\"']));
    expect(harness.spawnImpl.mock.calls[0][2].cwd).toBe(__dirname);
    expect(harness.requests.filter(message => message.method === 'initialize')).toHaveLength(1);
    expect(harness.requests.filter(message => message.method === 'initialized')).toHaveLength(1);
    expect(client.getStatus()).toMatchObject({ running: true, initialized: true, pid: 1234 });
  });

  test('matches out-of-order responses to their original request IDs', async () => {
    const waiting = [];
    setup((message, transport) => {
      if (!message.method.startsWith('test/')) return false;
      waiting.push({ message, transport });
      if (waiting.length === 2) {
        waiting[1].transport.reply({ name: 'second' });
        waiting[0].transport.reply({ name: 'first' });
      }
      return true;
    });
    await expect(Promise.all([client.request('test/first'), client.request('test/second')]))
      .resolves.toEqual([{ name: 'first' }, { name: 'second' }]);
  });

  test('surfaces JSON-RPC errors and continues to accept requests', async () => {
    setup((message, transport) => {
      if (message.method !== 'test/fail') return false;
      transport.error('request rejected');
      return true;
    });
    await expect(client.request('test/fail')).rejects.toThrow('request rejected');
    await expect(client.request('model/list')).resolves.toEqual({ ok: true });
  });

  test('times out unanswered requests and removes their pending state', async () => {
    setup(message => message.method === 'test/never', { requestTimeoutMs: 30 });
    await expect(client.request('test/never')).rejects.toThrow(/Timeout/);
    expect(client.pending.size).toBe(0);
  });

  test('keeps requests pending without a default timeout until the server answers', async () => {
    let response;
    setup((message, transport) => {
      if (message.method !== 'test/slow') return false;
      response = transport;
      return true;
    }, { requestTimeoutMs: undefined });
    await client.initialize();
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    try {
      const request = client.request('test/slow');
      await harness.waitForRequest('test/slow');
      await new Promise(resolve => setImmediate(resolve));
      await jest.advanceTimersByTimeAsync(86400000);
      expect(client.pending.size).toBe(1);
      response.reply({ finished: true });
      await expect(request).resolves.toEqual({ finished: true });
    } finally {
      jest.useRealTimers();
    }
  });

  test('sandboxes verification writes to the copy and streams full UTF-8 output without limits', async () => {
    setup((message, transport) => {
      if (message.method !== 'command/exec') return false;
      for (const byte of Buffer.from('Grüße 👋')) {
        transport.notify('command/exec/outputDelta', { processId: message.params.processId,
          stream: 'stdout', deltaBase64: Buffer.from([byte]).toString('base64'), capReached: false });
      }
      transport.reply({ exitCode: 0, stdout: '', stderr: '' });
      return true;
    });
    const onOutput = jest.fn();
    await expect(client.runVerificationCommand(['node', '--check', 'main.ts'], {
      cwd: '/tmp/verification/model-home', temporaryRoot: '/tmp/verification', onOutput
    })).resolves.toEqual({ code: 0 });
    expect(onOutput.mock.calls.map(([delta]) => delta).join('')).toBe('Grüße 👋');
    const request = harness.requests.find(message => message.method === 'command/exec');
    expect(request.params).toMatchObject({ disableTimeout: true, disableOutputCap: true,
      sandboxPolicy: { type: 'workspaceWrite', writableRoots: ['/tmp/verification'], networkAccess: false,
        excludeTmpdirEnvVar: true, excludeSlashTmp: true } });
    expect(client.notificationHandlers.size).toBe(0);
  });

  test('keeps native writes read-only and requests visible editing for starts, turns and resumed sessions', async () => {
    setup();
    const options = { sessionId: 'workspace', workdir: __dirname, prompt: 'Edit .git/config',
      workspaceAccess: true, terminalAccess: true, readOnly: true, disableWebSearch: true };
    await client.runTurn(options);
    harness.children[0].emit('close', 0);
    await client.runTurn(options);
    for (const message of harness.requests.filter(request => /^(?:thread\/(?:start|resume)|turn\/start)$/.test(request.method))) {
      expect(message.params.permissions).toBe('codex-ide-live-editor');
      expect(message.params.runtimeWorkspaceRoots).toEqual([__dirname]);
      expect(message.params).not.toHaveProperty('sandbox');
      expect(message.params).not.toHaveProperty('sandboxPolicy');
    }
    const instructions = harness.requests.find(request => request.method === 'thread/start').params.developerInstructions;
    expect(instructions).toContain('entire model-home');
    expect(instructions).toContain('All project changes must go through the visible live-editor');
    expect(instructions).toContain('Native tools are read-only');
  });

  test.each([0, 1, 2, 3])('refreshes stale persisted tool schemas without blocking: version=%s', async workspaceToolVersion => {
    setup();
    const onSessionMetadata = jest.fn();
    await client.runTurn({ sessionId: 'restored', threadId: 'stored-thread', workspaceToolVersion,
      prompt: 'Full conversation and current task', followupPrompt: 'Current task',
      workspaceAccess: true, terminalAccess: true, onSessionMetadata });
    expect(harness.requests.filter(request => request.method === 'thread/resume')).toHaveLength(workspaceToolVersion === 3 ? 1 : 0);
    expect(harness.requests.filter(request => request.method === 'thread/start')).toHaveLength(workspaceToolVersion === 3 ? 0 : 1);
    expect(harness.requests.some(request => request.method === 'thread/delete')).toBe(false);
    expect(onSessionMetadata).toHaveBeenCalledWith(expect.objectContaining({ workspaceToolVersion: 3 }));
    if (workspaceToolVersion !== 3) {
      expect(harness.requests.find(request => request.method === 'turn/start').params.input[0].text).toBe('Full conversation and current task');
    }
  });

  test('reports completed native file changes to the workspace observer', async () => {
    setup((message, transport) => {
      if (message.method !== 'turn/start') return false;
      transport.reply({ turn: { id: 'file-turn' } });
      setImmediate(() => {
        transport.notify('item/completed', { threadId: 'thread-1', item: {
          type: 'fileChange', changes: [{ path: 'src/main.ts' }], status: 'completed'
        } });
        transport.notify('turn/completed', { threadId: 'thread-1', turn: { id: 'file-turn', status: 'completed' } });
      });
      return true;
    });
    const onWorkspaceChange = jest.fn();
    await client.runTurn({ prompt: 'Edit', onWorkspaceChange });
    expect(onWorkspaceChange).toHaveBeenCalledWith(expect.objectContaining({ changes: [{ path: 'src/main.ts' }] }));
  });

  test('streams split UTF-8 bytes without corrupting Unicode or duplicating completed text', async () => {
    setup((message, transport) => {
      if (message.method !== 'turn/start') return false;
      transport.reply({ turn: { id: 'unicode-turn' } });
      setImmediate(() => {
        transport.notify('item/agentMessage/delta', { threadId: 'other-thread', delta: 'ignore me' });
        transport.notify('item/agentMessage/delta', { threadId: 'thread-1', turnId: 'other-turn', delta: 'ignore me too' });
        transport.notify('item/agentMessage/delta', { threadId: 'thread-1', turnId: 'unicode-turn', delta: 'Grüße 👋' }, true);
        transport.notify('item/completed', { threadId: 'thread-1', item: { type: 'agentMessage', text: 'Grüße 👋' } }, true);
        transport.notify('turn/completed', { threadId: 'thread-1', turn: { id: 'unicode-turn', status: 'completed' } }, true);
      });
      return true;
    });
    const onToken = jest.fn();
    await expect(client.runTurn({ prompt: 'Hallo', onToken })).resolves.toMatchObject({ content: 'Grüße 👋' });
    expect(onToken.mock.calls.map(call => call[0]).join('')).toBe('Grüße 👋');
  });

  test('falls back to completed agent messages when no deltas were emitted', async () => {
    setup();
    await expect(client.runTurn({ prompt: 'Hallo' })).resolves.toMatchObject({ content: 'Fertig.', threadId: 'thread-1', turnId: 'turn-1' });
  });

  test('reconciles each native summary part, retaining unstreamed parts and missing final text', async () => {
    const item = { id: 'reasoning-1', type: 'reasoning', summary: [
      { text: 'Ich prüfe die Einfügung.' }, { text: 'Die Löschung passt 👋.' }, 'Abgeschlossen.'
    ] };
    setup((message, transport) => {
      if (message.method !== 'turn/start') return false;
      transport.reply({ turn: { id: 'summary-turn' } });
      setImmediate(() => {
        const scope = { threadId: 'thread-1', turnId: 'summary-turn', itemId: item.id };
        transport.notify('item/reasoning/summaryTextDelta', { ...scope, summaryIndex: 0, delta: 'Ich prüfe ' }, true);
        transport.notify('item/reasoning/summaryTextDelta', { ...scope, summaryIndex: 0, delta: 'die Einfügung.' });
        transport.notify('item/reasoning/summaryTextDelta', { ...scope, summaryIndex: 1, delta: 'Die Löschung ' });
        transport.notify('item/completed', { ...scope, item });
        transport.notify('turn/completed', { ...scope, turn: { id: 'summary-turn', status: 'completed', items: [item] } });
      });
      return true;
    });
    const onReasoningSummary = jest.fn();
    await client.runTurn({ prompt: 'Prüfen', onReasoningSummary });
    expect(onReasoningSummary.mock.calls.map(([delta, detail]) => [delta, detail.summaryIndex])).toEqual([
      ['Ich prüfe ', 0], ['die Einfügung.', 0], ['Die Löschung ', 1], ['', 0], ['passt 👋.', 1], ['Abgeschlossen.', 2]
    ]);
    expect(onReasoningSummary.mock.calls.every(([, detail]) => detail.threadId === 'thread-1' && detail.turnId === 'summary-turn' && detail.itemId === 'reasoning-1')).toBe(true);
    expect(onReasoningSummary.mock.calls.filter(([, detail]) => detail.completed).map(([, detail]) => detail.summaryIndex)).toEqual([0, 1, 2]);
  });

  test('uses summaries from the completed turn even when item notifications are missing', async () => {
    setup((message, transport) => {
      if (message.method !== 'turn/start') return false;
      transport.reply({ turn: { id: 'fallback-turn' } });
      setImmediate(() => transport.notify('turn/completed', { threadId: 'thread-1', turn: {
        id: 'fallback-turn', status: 'completed', items: [
          { type: 'reasoning', id: 'fallback-reasoning', summary: [{ text: 'Ergebnis geprüft.' }] },
          { type: 'agentMessage', text: 'Fertig.' }
        ]
      } }));
      return true;
    });
    const onReasoningSummary = jest.fn();
    await client.runTurn({ prompt: 'Prüfen', onReasoningSummary });
    expect(onReasoningSummary).toHaveBeenCalledWith('Ergebnis geprüft.', {
      threadId: 'thread-1', turnId: 'fallback-turn', itemId: 'fallback-reasoning', summaryIndex: 0, completed: true
    });
  });

  test('marks completed corrections as replacements instead of appending duplicate text', async () => {
    setup((message, transport) => {
      if (message.method !== 'turn/start') return false;
      // Notifications can already be delivered before the turn/start response.
      const scope = { threadId: 'thread-1', turnId: 'correction-turn', itemId: 'reasoning-1' };
      transport.notify('item/reasoning/summaryTextDelta', { ...scope, summaryIndex: 0, delta: 'Vorläufig.' });
      transport.reply({ turn: { id: 'correction-turn' } });
      setImmediate(() => {
        transport.notify('item/completed', { ...scope, item: { id: scope.itemId, type: 'reasoning', summary: ['Bestätigt.'] } });
        transport.notify('turn/completed', { ...scope, turn: { id: 'correction-turn', status: 'completed' } });
      });
      return true;
    });
    const onReasoningSummary = jest.fn();
    await client.runTurn({ prompt: 'Prüfen', onReasoningSummary });
    expect(onReasoningSummary.mock.calls).toEqual([
      ['Vorläufig.', { threadId: 'thread-1', turnId: 'correction-turn', itemId: 'reasoning-1', summaryIndex: 0 }],
      ['Bestätigt.', { threadId: 'thread-1', turnId: 'correction-turn', itemId: 'reasoning-1', summaryIndex: 0, replace: true, completed: true }]
    ]);
  });

  test('forwards scoped native tool events without duplicating IDE tools or changing write permissions', async () => {
    setup((message, transport) => {
      if (message.method !== 'turn/start') return false;
      transport.reply({ turn: { id: 'tools-turn' } });
      setImmediate(() => {
        const scope = { threadId: 'thread-1', turnId: 'tools-turn' };
        transport.notify('item/started', { ...scope, threadId: 'other', item: { id: 'ignored', type: 'mcpToolCall', tool: 'lookup' } });
        transport.notify('item/started', { ...scope, item: { id: 'workspace', type: 'dynamicToolCall', tool: 'codex_ide_workspace' } });
        transport.notify('item/started', { ...scope, item: { id: 'mcp', type: 'mcpToolCall', tool: 'lookup', server: 'docs' } });
        transport.notify('item/completed', { ...scope, item: { id: 'mcp', type: 'mcpToolCall', tool: 'lookup', server: 'docs', result: { text: 'Gefunden 👋' } } });
        transport.notify('item/completed', { ...scope, item: { id: 'dynamic', type: 'dynamicToolCall', tool: 'check', success: false, error: 'Offline' } });
        transport.notify('item/reasoning/textDelta', { ...scope, delta: 'private reasoning must never become a visible summary' });
        transport.notify('turn/completed', { ...scope, turn: { id: scope.turnId, status: 'completed', items: [{ type: 'agentMessage', text: 'Fertig.' }] } });
      });
      return true;
    });
    const onToolEvent = jest.fn();
    const onReasoningSummary = jest.fn();
    await client.runTurn({ prompt: 'Prüfen', onToolEvent, onReasoningSummary, workspaceAccess: true, terminalAccess: true });
    expect(onToolEvent.mock.calls.map(([event]) => [event.itemId, event.status])).toEqual([
      ['mcp', 'running'], ['mcp', 'completed'], ['dynamic', 'failed']
    ]);
    expect(onToolEvent.mock.calls[1][0]).toMatchObject({ threadId: 'thread-1', turnId: 'tools-turn', source: 'app-server',
      target: 'docs', name: 'lookup', output: JSON.stringify({ text: 'Gefunden 👋' }) });
    expect(onReasoningSummary).not.toHaveBeenCalled();
    const turn = harness.requests.find(request => request.method === 'turn/start');
    expect(turn.params).toMatchObject({ permissions: 'codex-ide-live-editor', approvalPolicy: 'never' });
  });

  test('queues turns in a session and uses the follow-up prompt for later turns', async () => {
    setup();
    await Promise.all([
      client.runTurn({ sessionId: 'same', prompt: 'First full prompt' }),
      client.runTurn({ sessionId: 'same', prompt: 'Second full prompt', followupPrompt: 'Second follow-up' })
    ]);
    expect(harness.requests.filter(message => message.method === 'thread/start')).toHaveLength(1);
    expect(harness.requests.filter(message => message.method === 'turn/start').map(message => message.params.input[0].text))
      .toEqual(['First full prompt', 'Second follow-up']);
    expect(client.getStatus().sessions[0]).toMatchObject({ sessionId: 'same', turnCount: 2, activeTurnId: '', lastStatus: 'completed' });
  });

  test('resumes a persistent thread after a process restart and discards partial old bytes', async () => {
    setup();
    await client.runTurn({ sessionId: 'persistent', prompt: 'First' });
    harness.children[0].stdout.emit('data', Buffer.from('{"stale":"'));
    harness.children[0].stdout.emit('data', Buffer.from([0xf0, 0x9f]));
    harness.children[0].emit('close', 1);
    await expect(client.runTurn({ sessionId: 'persistent', prompt: 'Second' })).resolves.toMatchObject({ content: 'Fertig.', threadId: 'thread-1' });
    expect(harness.spawnImpl).toHaveBeenCalledTimes(2);
    expect(harness.requests.filter(message => message.method === 'thread/resume')).toHaveLength(1);
    expect(harness.requests.filter(message => message.method === 'thread/start')).toHaveLength(1);
    expect(client.stdoutBuffer).toBe('');
  });

  test.each(['close', 'exit', 'error'])('ignores a retired process %s event while the replacement has a pending request', async event => {
    setup(message => message.method === 'test/restarted');
    await client.runTurn({ sessionId: 'persistent', prompt: 'First' });
    const retired = harness.children[0];
    retired.emit('exit', 17);

    const response = client.request('test/restarted').then(
      value => ({ value }), error => ({ error: error.message })
    );
    const request = await harness.waitForRequest('test/restarted');
    const replacement = harness.children[1];
    retired.emit(event, event === 'error' ? new Error('retired process error') : 17);
    harness.send(replacement, { id: request.id, result: { recovered: true } });

    await expect(response).resolves.toEqual({ value: { recovered: true } });
    expect(client.getStatus()).toMatchObject({ running: true, initialized: true, pid: replacement.pid });
    expect(client.getStatus().sessions[0].needsResume).toBe(true);
    await expect(client.runTurn({ sessionId: 'persistent', prompt: 'Second' }))
      .resolves.toMatchObject({ content: 'Fertig.', threadId: 'thread-1' });
    expect(harness.spawnImpl).toHaveBeenCalledTimes(2);
  });

  test('ignores late pipe data from a retired process after restarting', async () => {
    setup();
    await client.initialize();
    const retired = harness.children[0];
    retired.emit('exit', 17);
    await client.initialize();
    const replacement = harness.children[1];
    const onNotification = jest.fn();
    client.notificationHandlers.add(onNotification);

    harness.send(retired, { method: 'account/updated', params: { source: 'retired' } });
    retired.stdout.emit('data', Buffer.from('{"stale":"'));
    retired.stdout.emit('data', Buffer.from([0xf0, 0x9f]));
    retired.stderr.emit('data', Buffer.from('retired process stderr'));
    harness.send(replacement, { method: 'account/updated', params: { source: 'replacement' } }, true);

    expect(onNotification.mock.calls).toEqual([[{ method: 'account/updated', params: { source: 'replacement' } }]]);
    expect(client.stdoutBuffer).toBe('');
    expect(client.getStatus().stderrTail).toBe('');
    await expect(client.request('model/list')).resolves.toEqual({ ok: true });
  });

  test('restarts with an ephemeral thread when persistence is disabled', async () => {
    setup(undefined, { persistSessions: false });
    await client.runTurn({ sessionId: 'temporary', prompt: 'First' });
    harness.children[0].emit('close', 0);
    expect(client.getStatus().sessions).toEqual([]);
    await client.runTurn({ sessionId: 'temporary', prompt: 'Second' });
    expect(harness.requests.filter(message => message.method === 'thread/start').map(message => message.params.ephemeral)).toEqual([true, true]);
  });

  test('deletes a persistent session on reset', async () => {
    setup();
    await client.runTurn({ sessionId: 'reset-me', prompt: 'First' });
    await expect(client.resetSession('reset-me')).resolves.toBe(true);
    expect(client.getStatus().sessions).toEqual([]);
    expect(harness.requests.find(message => message.method === 'thread/delete').params).toEqual({ threadId: 'thread-1' });
    await expect(client.resetSession('missing')).resolves.toBe(false);
  });

  test('rejects a pre-aborted turn before starting a process', async () => {
    setup();
    const controller = new AbortController();
    controller.abort();
    await expect(client.runTurn({ prompt: 'ignored', signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(harness.spawnImpl).not.toHaveBeenCalled();
  });

  test('interrupts an active turn when the caller aborts', async () => {
    setup((message, transport) => {
      if (message.method === 'turn/start') {
        transport.reply({ turn: { id: 'active-turn' } });
        return true;
      }
      if (message.method === 'turn/interrupt') {
        transport.reply({});
        transport.notify('turn/completed', { threadId: 'thread-1', turn: { id: 'active-turn', status: 'interrupted' } });
        return true;
      }
      return false;
    });
    const controller = new AbortController();
    const result = expect(client.runTurn({ prompt: 'Wait', signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    await harness.waitForRequest('turn/start');
    controller.abort();
    await result;
    expect(harness.requests.some(message => message.method === 'turn/interrupt')).toBe(true);
    expect(client.getStatus().activeTurns).toBe(0);
  });

  test('rejects pending requests when the process exits and preserves split stderr characters', async () => {
    setup((message, transport) => {
      if (message.method !== 'test/exit') return false;
      for (const byte of Buffer.from('Fehler: Grüße 👋')) transport.child.stderr.emit('data', Buffer.from([byte]));
      transport.child.emit('close', 17);
      return true;
    });
    await expect(client.request('test/exit')).rejects.toThrow('Fehler: Grüße 👋');
    expect(client.getStatus()).toMatchObject({ running: false, initialized: false });
    expect(client.pending.size).toBe(0);
  });

  test.each([
    ['item/commandExecution/requestApproval', 'cancel'],
    ['item/fileChange/requestApproval', 'decline'],
    ['applyPatchApproval', 'denied'], ['execCommandApproval', 'denied']
  ])('declines native approval requests: %s', (method, decision) => {
    setup();
    const child = client.start();
    harness.send(child, { id: 'approval', method, params: {} });
    expect(harness.responses).toContainEqual({ id: 'approval', result: { decision } });
  });

  test('blocks native patch and shell writes without interrupting the active editor turn', async () => {
    let transport;
    setup((message, stream) => {
      if (message.method !== 'turn/start') return false;
      transport = stream;
      stream.reply({ turn: { id: 'editor-turn' } });
      setImmediate(() => {
        stream.send({ id: 'hidden-patch', method: 'item/fileChange/requestApproval', params: {
          threadId: 'thread-1', turnId: 'editor-turn', reason: 'Apply changes directly'
        } });
        stream.send({ id: 'hidden-shell', method: 'item/commandExecution/requestApproval', params: {
          threadId: 'thread-1', turnId: 'editor-turn', command: "printf hidden > app.js"
        } });
      });
      return true;
    });
    const pending = client.runTurn({ prompt: 'Edit app.js', workspaceAccess: true });
    expect((await harness.waitForResponse('hidden-patch')).result).toEqual({ decision: 'decline' });
    expect((await harness.waitForResponse('hidden-shell')).result).toEqual({ decision: 'cancel' });
    const text = '<codex_ide_editor_request>{"operation":"edit","path":"app.js","oldText":"old","newText":"new"}</codex_ide_editor_request>';
    transport.notify('turn/completed', { threadId: 'thread-1', turn: {
      id: 'editor-turn', status: 'completed', items: [{ type: 'agentMessage', text }]
    } });
    await expect(pending).resolves.toMatchObject({ content: text });
    expect(harness.requests.some(request => request.method === 'turn/interrupt')).toBe(false);
    expect(harness.requests.filter(request => request.method === 'turn/start')).toHaveLength(1);
  });

  test('returns a protocol error for unsupported server requests', () => {
    setup();
    harness.send(client.start(), { id: 'unsupported', method: 'unknown/request' });
    expect(harness.responses).toContainEqual({ id: 'unsupported', error: { code: -32601, message: expect.stringContaining('unknown/request') } });
  });

  test.each([true, false])('gates the workspace tool by the active turn: enabled=%s', async enabled => {
    let transport;
    setup((message, stream) => {
      if (message.method !== 'turn/start') return false;
      transport = stream;
      stream.reply({ turn: { id: 'tool-turn' } });
      setImmediate(() => stream.send({ id: 'workspace-call', method: 'item/tool/call', params: {
        threadId: 'thread-1', tool: 'codex_ide_workspace', arguments: { operation: 'list' }
      } }));
      return true;
    });
    const onWorkspaceToolCall = jest.fn(() => ({ success: true, text: '{"files":[]}' }));
    const turn = client.runTurn({ prompt: 'List', workspaceAccess: enabled, onWorkspaceToolCall, readOnly: true });
    const response = await harness.waitForResponse('workspace-call');
    transport.notify('turn/completed', { threadId: 'thread-1', turn: { id: 'tool-turn', status: 'completed' } });
    await turn;
    expect(response.result.success).toBe(enabled);
    expect(onWorkspaceToolCall).toHaveBeenCalledTimes(enabled ? 1 : 0);
    const start = harness.requests.find(message => message.method === 'turn/start');
    expect(start.params.permissions).toBe('codex-ide-live-editor');
    expect(start.params).not.toHaveProperty('sandboxPolicy');
  });

  test('extracts only completed agent text from a turn', () => {
    expect(extractAgentTextFromTurn({ items: [
      { type: 'reasoning', text: 'internal' }, { type: 'agentMessage', text: 'First' },
      null, { type: 'agentMessage', text: 'Second' }
    ] })).toBe('First\nSecond');
    expect(extractAgentTextFromTurn(null)).toBe('');
  });
});

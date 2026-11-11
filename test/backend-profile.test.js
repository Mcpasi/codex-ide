'use strict';

const { createBrowser } = require('./helpers/browser');

function jsonResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300, status,
    headers: { get: () => 'application/json' },
    json: async () => data, text: async () => JSON.stringify(data)
  };
}

function streamResponse(events, chunkSize = 1) {
  const text = events.map(event => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\r\n\r\n`).join('');
  const bytes = Buffer.from(text);
  let index = 0;
  return {
    ok: true, headers: { get: () => 'text/event-stream' },
    body: { getReader: () => ({
      read: async () => {
        if (index >= bytes.length) return { done: true };
        const start = index;
        index += chunkSize;
        return { done: false, value: bytes.subarray(start, index) };
      }
    }) }
  };
}

describe('browser backend profiles', () => {
  let browser;
  let profile;
  let fetch;

  beforeEach(() => {
    browser = createBrowser();
    browser.load('backendProfile.js');
    profile = browser.window.codexIdeProfile;
    fetch = browser.context.fetch;
  });

  test.each(['local', 'api', 'codex'])('persists the %s profile and updates its capabilities', value => {
    profile.set(value);
    expect(profile.get()).toBe(value);
    expect(profile.needsTransformers()).toBe(value === 'local');
    expect(profile.needsLLM()).toBe(value === 'local');
    expect(profile.usesApi()).toBe(value === 'api');
    expect(profile.usesCodex()).toBe(value === 'codex');
    expect(browser.values.get('codexIdeBackendProfile')).toBe(value);
    expect(browser.document.dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'codex-ide-profile-change', detail: { profile: value } }));
  });

  test('falls back from an invalid saved profile and ignores unsupported selections', () => {
    const restored = createBrowser({ codexIdeBackendProfile: 'unknown' });
    restored.load('backendProfile.js');
    expect(restored.window.codexIdeProfile.get()).toBe('codex');
    profile.set('unsupported');
    expect(profile.get()).toBe('codex');
  });

  test('normalizes saved configuration and preserves supported reasoning levels', () => {
    profile.setApiConfig(' https://api.example.test/v1 ', ' test-key ', ' test-model ');
    expect(profile.getApiConfig()).toEqual({ url: 'https://api.example.test/v1', key: 'test-key', model: 'test-model' });
    profile.setCodexConfig(' http://localhost:9000/v1 ', ' test-codex ');
    profile.setCodexReasoningEffort(' ULTRA ');
    expect(profile.getCodexConfig()).toEqual({ url: 'http://localhost:9000/v1', model: 'test-codex', reasoningEffort: 'ultra' });
    profile.setCodexReasoningEffort('unsupported');
    expect(profile.getCodexConfig().reasoningEffort).toBe('');
  });

  test('bounds saved API and Codex reply budgets', () => {
    profile.setApiMaxTokens(10000);
    profile.setCodexMaxTokens(0);
    expect(profile.getApiMaxTokens()).toBe(1000);
    expect(profile.getCodexMaxTokens()).toBe(700);
  });

  test('delegates local calls without making a network request', async () => {
    profile.set('local');
    browser.window.CodexIdeLocalModel = { chatCompletion: jest.fn().mockResolvedValue('local answer') };
    await expect(profile.apiChatCompletion([{ role: 'user', content: 'Hallo' }], 100)).resolves.toBe('local answer');
    expect(browser.window.CodexIdeLocalModel.chatCompletion).toHaveBeenCalledWith([{ role: 'user', content: 'Hallo' }], 100, {});
    expect(fetch).not.toHaveBeenCalled();
  });

  test.each([
    ['https://api.example.test', 'https://api.example.test/v1/chat/completions'],
    ['https://api.example.test/v1/', 'https://api.example.test/v1/chat/completions'],
    ['https://openrouter.ai', 'https://openrouter.ai/api/v1/chat/completions']
  ])('normalizes the compatible API endpoint %s', async (url, expected) => {
    profile.set('api');
    profile.setApiConfig(url, 'test-key', 'test-model');
    fetch.mockResolvedValue(jsonResponse({ choices: [{ message: { content: ['Grüße ', { text: '👋' }] } }] }));
    await expect(profile.apiChatCompletion([{ role: 'user', content: 'Hallo' }], 123, { skipModelHomeContext: true })).resolves.toBe('Grüße 👋');
    const [endpoint, request] = fetch.mock.calls[0];
    expect(endpoint).toBe(expected);
    expect(request.headers.Authorization).toBe('Bearer test-key');
    expect(JSON.parse(request.body)).toMatchObject({ model: 'test-model', max_tokens: 123 });
  });

  test('surfaces the provider error message on an unsuccessful API request', async () => {
    profile.set('api');
    profile.setApiConfig('https://api.example.test');
    fetch.mockResolvedValue(jsonResponse({ error: { message: 'invalid test credential' } }, 401));
    await expect(profile.apiChatCompletion([{ role: 'user', content: 'Hallo' }], 100, { skipModelHomeContext: true }))
      .rejects.toThrow('API 401: invalid test credential');
  });

  test('propagates editor policy, session IDs, reasoning and locale to the gateway', async () => {
    profile.setCodexReasoningEffort('max');
    fetch.mockResolvedValue(jsonResponse({ choices: [{ message: { content: 'Done' } }], codexIde: { sessionId: 'chat', threadId: 'thread-1' } }));
    const onSessionMetadata = jest.fn();
    await expect(profile.codexChatCompletion([{ role: 'user', content: 'Build' }], 32000, {
      editorWriteMode: true, editorWorkspaceMode: true, sessionId: 'chat', threadId: 'thread-1',
      responseLanguage: 'en', onSessionMetadata, stream: false
    })).resolves.toBe('Done');
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({
      max_tokens: 32000, reasoning_effort: 'max', stream: false,
      codexIde: { editorMode: true, editorWorkspaceMode: true, sessionId: 'chat', threadId: 'thread-1', responseLanguage: 'en' }
    });
    expect(onSessionMetadata).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'chat', threadId: 'thread-1' }));
  });

  test('decodes SSE events even when every Unicode character is split across network chunks', async () => {
    const onToken = jest.fn();
    const onTerminalOutput = jest.fn();
    const onReasoningSummary = jest.fn();
    fetch.mockResolvedValue(streamResponse([
      { choices: [{ delta: { content: 'Grüße ' } }] },
      { codexIde: { terminal_event: { phase: 'output', item_id: 'console-1', delta: 'Prüfung 👋' } } },
      { codexIde: { reasoning_summary: { delta: 'Geprüft.', item_id: 'summary-1', summary_index: 0, thread_id: 'thread-1', turn_id: 'turn-1', replace: true } } },
      { choices: [{ delta: { content: '👋' } }] }, '[DONE]'
    ]));
    await expect(profile.codexChatCompletion([{ role: 'user', content: 'Hallo' }], 100, { onToken, onTerminalOutput, onReasoningSummary }))
      .resolves.toBe('Grüße 👋');
    expect(onToken.mock.calls.map(call => call[0])).toEqual(['Grüße ', '👋']);
    expect(onTerminalOutput).toHaveBeenCalledWith('Prüfung 👋', expect.objectContaining({ item_id: 'console-1' }));
    expect(onReasoningSummary).toHaveBeenCalledWith('Geprüft.', { itemId: 'summary-1', summaryIndex: 0, threadId: 'thread-1', turnId: 'turn-1', replace: true });
  });

  test.each([
    ['codex', 1], ['codex', 7], ['codex', 4096],
    ['api', 1], ['api', 7], ['api', 4096]
  ])('decodes multiline SSE data in the %s backend with %s-byte reads', async (backend, chunkSize) => {
    profile.set(backend);
    profile.setApiConfig('https://api.example.test');
    const onToken = jest.fn();
    fetch.mockResolvedValue(streamResponse([
      '{"choices": [\r\n' +
        ': heartbeat inside the event\r\n' +
        'event: message\r\n' +
        'data: {"delta": {"content": "Grüße 👋"}}\r\n' +
        'data: ]}',
      { choices: [{ delta: { content: ' Fertig.' } }] },
      '[DONE]'
    ], chunkSize));

    await expect(profile.apiChatCompletion([{ role: 'user', content: 'Hallo' }], 100, {
      stream: true, skipModelHomeContext: true, onToken
    })).resolves.toBe('Grüße 👋 Fertig.');
    expect(onToken.mock.calls).toEqual([
      ['Grüße 👋', 'Grüße 👋'], [' Fertig.', 'Grüße 👋 Fertig.']
    ]);
  });

  test('surfaces stream errors instead of displaying a successful empty reply', async () => {
    fetch.mockResolvedValue(streamResponse([{ error: { message: 'stream interrupted' } }, '[DONE]']));
    await expect(profile.codexChatCompletion([{ role: 'user', content: 'Hallo' }], 100)).rejects.toThrow('stream interrupted');
  });

  test.each(['codex', 'api'])('finishes a %s stream at DONE while the HTTP body remains open', async backend => {
    profile.set(backend);
    profile.setApiConfig('https://api.example.test');
    let controller;
    const cancel = jest.fn();
    const body = new ReadableStream({
      start(value) {
        controller = value;
        controller.enqueue(Buffer.from('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Grüße 👋' } }] }) + '\n\ndata: [DONE]\n\n'));
      },
      cancel
    });
    fetch.mockResolvedValue({ ok: true, headers: { get: () => 'text/event-stream' }, body });
    let outcome = { pending: true };
    const completion = profile.apiChatCompletion([{ role: 'user', content: 'Hallo' }], 100, {
      stream: true, skipModelHomeContext: true
    }).then(value => { outcome = { value }; }, error => { outcome = { error: error.message }; });

    // Let queued reads and promise callbacks settle without closing the body.
    await new Promise(resolve => setImmediate(resolve));
    try {
      expect(outcome).toEqual({ value: 'Grüße 👋' });
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(body.locked).toBe(false);
    } finally {
      if (outcome.pending) controller.close();
      await completion;
    }
  });

  test.each([1, 7, 4096])('ignores events after DONE in %s-byte stream reads', async chunkSize => {
    const onToken = jest.fn();
    const onToolEvent = jest.fn();
    const text = 'data: ' + JSON.stringify({ choices: [{ delta: { content: 'Fertig.' } }] }) + '\n\n' +
      'data: [DONE]\n\n' +
      'data: ' + JSON.stringify({ choices: [{ delta: { content: 'late text' } }], codexIde: { tool_event: { name: 'late tool' } } }) + '\n\n';
    const bytes = Buffer.from(text);
    let offset = 0;
    fetch.mockResolvedValue({ ok: true, headers: { get: () => 'text/event-stream' }, body: { getReader: () => ({
      read: async () => {
        if (offset >= bytes.length) return { done: true };
        const start = offset;
        offset += chunkSize;
        return { done: false, value: bytes.subarray(start, offset) };
      }
    }) } });

    await expect(profile.codexChatCompletion([{ role: 'user', content: 'Hallo' }], 100, { onToken, onToolEvent }))
      .resolves.toBe('Fertig.');
    expect(onToken.mock.calls).toEqual([['Fertig.', 'Fertig.']]);
    expect(onToolEvent).not.toHaveBeenCalled();
  });

  test('streams card completion, tool identities, paths and diagnostics without mixing them into the reply', async () => {
    const onReasoningSummary = jest.fn();
    const onToolEvent = jest.fn();
    const onSkillStart = jest.fn();
    const onSkillError = jest.fn();
    const scope = { item_id: 'read-1', thread_id: 'thread', turn_id: 'turn', operation: 'read', path: 'src/app.js', app_server_tool: true };
    const tool = { itemId: 'mcp', threadId: 'thread', turnId: 'turn', name: 'lookup', status: 'completed', output: 'Treffer 👋' };
    fetch.mockResolvedValue(streamResponse([
      { codexIde: { reasoning_summary: { delta: '', item_id: 'reasoning', completed: true } } },
      { codexIde: { skill_event: { ...scope, id: 'workspace.extended-files', status: 'running' } } },
      { codexIde: { tool_event: tool } },
      { codexIde: { skill_event: { ...scope, id: 'workspace.extended-files', status: 'failed', error: 'Datei fehlt.' } } },
      { choices: [{ delta: { content: 'Antwort' } }] }, '[DONE]'
    ]));
    await expect(profile.codexChatCompletion([{ role: 'user', content: 'Prüfen' }], 100, {
      onReasoningSummary, onToolEvent, onSkillStart, onSkillError
    })).resolves.toBe('Antwort');
    expect(onReasoningSummary).toHaveBeenCalledWith('', expect.objectContaining({ completed: true, itemId: 'reasoning' }));
    expect(onToolEvent).toHaveBeenCalledWith(tool);
    expect(onSkillStart).toHaveBeenCalledWith('workspace.extended-files', expect.objectContaining({
      itemId: 'read-1', threadId: 'thread', turnId: 'turn', path: 'src/app.js', operation: 'read', appServerTool: true
    }));
    expect(onSkillError).toHaveBeenCalledWith('workspace.extended-files', expect.objectContaining({ itemId: 'read-1', error: 'Datei fehlt.' }));
  });

  test.each([1, 2, 3, 4, 7, 4096])('preserves SSE boundaries and an unterminated final event in %s-byte reads', async chunkSize => {
    const text = ': heartbeat\r\n\r\n' +
      'data: ' + JSON.stringify({ choices: [{ delta: { content: 'Grüße ' } }] }) + '\n\n' +
      'data: ' + JSON.stringify({ choices: [{ delta: { content: '👋' } }] });
    const bytes = Buffer.from(text);
    let offset = 0;
    const onToken = jest.fn();
    fetch.mockResolvedValue({ ok: true, headers: { get: () => 'text/event-stream' }, body: { getReader: () => ({ read: async () => {
      if (offset >= bytes.length) return { done: true };
      const start = offset;
      offset += chunkSize;
      return { done: false, value: bytes.subarray(start, offset) };
    } }) } });
    await expect(profile.codexChatCompletion([{ role: 'user', content: 'Hallo' }], 100, { onToken })).resolves.toBe('Grüße 👋');
    expect(onToken.mock.calls).toEqual([['Grüße ', 'Grüße '], ['👋', 'Grüße 👋']]);
  });

  test('rejects aborted requests before contacting the gateway', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(profile.codexChatCompletion([{ role: 'user', content: 'Hallo' }], 100, { signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(fetch).not.toHaveBeenCalled();
  });

  test('saves an empty editor buffer through the workspace contract with explicit operation', async () => {
    fetch.mockResolvedValue(jsonResponse({ ok: true, persistence: 'saved' }));
    await profile.writeModelHomeWorkspaceFile('src\\app.js', '', { editorWorkspaceMode: true, operation: 'edit' });
    const [endpoint, request] = fetch.mock.calls[0];
    expect(endpoint).toBe('http://localhost:8787/codex-ide/ide-files');
    expect(request.headers['X-Codex-IDE-Workspace']).toBe('model-home');
    expect(JSON.parse(request.body)).toEqual({ path: 'src/app.js', content: '', overwrite: true, operation: 'edit' });
  });

  test.each(['../app.js', '/tmp/app.js', 'src/../../app.js', 'bad\0name.js'])
    ('rejects unsafe browser file requests before fetching: %s', async file => {
      await expect(profile.readModelHomeWorkspaceFile(file, { editorWorkspaceMode: true })).rejects.toThrow();
      await expect(profile.writeModelHomeWorkspaceFile(file, 'replace', { editorWorkspaceMode: true })).rejects.toThrow();
      expect(fetch).not.toHaveBeenCalled();
    });

  test.each(['src/main.ts', 'package.json', '.env', '.git/config', 'node_modules/lib/index.cjs', 'memory.md', 'Makefile'])
    ('sends workspace reads and writes for %s without a skill grant', async file => {
      fetch.mockResolvedValue(jsonResponse({ ok: true, file: { path: file, content: 'source' } }));
      await profile.readModelHomeWorkspaceFile(file, { editorWorkspaceMode: true });
      await profile.writeModelHomeWorkspaceFile(file, 'updated', { editorWorkspaceMode: true });
      expect(fetch.mock.calls[0][0]).toContain('/codex-ide/ide-files?path=');
      expect(JSON.parse(fetch.mock.calls[1][1].body)).toMatchObject({ path: file, content: 'updated' });
    });

  test('continues an IDE turn without a gateway policy preflight or skill permission', async () => {
    const requests = [];
    fetch.mockImplementation(async (url, request) => {
      requests.push(url);
      if (!url.endsWith('/v1/chat/completions')) throw new Error('status endpoint unavailable');
      const body = JSON.parse(request.body);
      if (body.response_format) return jsonResponse({ choices: [{ message: { content: '{"complete":true}' } }] });
      return jsonResponse({ choices: [{ message: { content: requests.length === 1
        ? '<codex_ide_workspace_complete>{"complete":true}</codex_ide_workspace_complete>'
        : '<codex_ide_final>Erledigt.</codex_ide_final>' } }] });
    });
    await expect(profile.apiGenerateReply('Prüfe die Konfiguration', { editorWriteMode: true, editorWorkspaceMode: true }))
      .resolves.toContain('Erledigt.');
    expect(requests.every(url => url.endsWith('/v1/chat/completions'))).toBe(true);
    const prompt = JSON.parse(fetch.mock.calls[0][1].body).messages[0].content;
    expect(prompt).toContain('gesamte Modell-Home');
    expect(prompt).toContain('Jede Projektaenderung muss sichtbar im Live-Editor stattfinden');
    expect(prompt).toContain('einzige Schreibkanal');
  });
});

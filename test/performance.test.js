'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { performance } = require('perf_hooks');
const { createBrowser } = require('./helpers/browser');
const { createEditor } = require('./helpers/editor');
const { createAppServerHarness } = require('./helpers/app-server');
const { CodexAppServerClient } = require('../scripts/codex-app-server-client');

const samples = [];
function report(name, metrics) { samples.push({ name, ...metrics }); }

function loadStreamingBackend(browser) {
  const filename = path.resolve(__dirname, '../backendProfile.js');
  const source = fs.readFileSync(filename, 'utf8');
  vm.runInContext(source.replace(/\}\)\(\);\s*$/, `
    window.streamingUnderTest = { extract: extractStreamingEditorWrite, read: readCodexStreamResponse };
  })();`), browser.context, { filename });
  return browser.window.streamingUnderTest;
}

function chunkedResponse(text, chunkSize) {
  const bytes = Buffer.from(text);
  let offset = 0;
  return { body: { getReader: () => ({ read: async () => {
    if (offset === bytes.length) return { done: true };
    const start = offset;
    offset = Math.min(bytes.length, offset + chunkSize);
    return { done: false, value: bytes.subarray(start, offset) };
  } }) } };
}

afterAll(() => {
  if (process.env.CODEX_IDE_PERF_REPORT === '1' || process.env.npm_lifecycle_event === 'test:performance') {
    console.log(JSON.stringify({ performance: samples }, null, 2));
  }
});

describe('streaming performance budgets', () => {
  test('decodes growing editor requests without repeatedly decoding their full content', () => {
    const browser = createBrowser();
    const { extract } = loadStreamingBackend(browser);
    function replay(size) {
      const content = 'const greeting = "Grüße 👋";\n'.repeat(Math.ceil(size / 29)).slice(0, size);
      const text = '<codex_ide_editor_request>' + JSON.stringify({ operation: 'write', path: 'src/new.js', content }) + '</codex_ide_editor_request>';
      const cache = {};
      let draft;
      const start = performance.now();
      for (let end = 64; end < text.length; end += 64) draft = extract(text.slice(0, end), '', true, cache);
      draft = extract(text, '', true, cache);
      const ms = performance.now() - start;
      expect(draft).toMatchObject({ path: 'src/new.js', content, complete: true });
      return ms;
    }
    replay(4096); // Warm the VM before measuring the same workload at two sizes.
    const small = Math.min(replay(32768), replay(32768));
    const large = Math.min(replay(131072), replay(131072));
    report('editor-request-decoding', { smallChars: 32768, largeChars: 131072, smallMs: small, largeMs: large, growth: large / small });
    // 4x input must stay well below quadratic (16x) work. The absolute budget
    // leaves headroom for shared CI machines; neither budget uses network time.
    expect(large).toBeLessThan(750);
    expect(large).toBeLessThan(small * 8 + 20);
  });

  test('keeps fragmented SSE events responsive and preserves every Unicode token', async () => {
    const browser = createBrowser();
    const { read } = loadStreamingBackend(browser);
    const token = 'Grüße 👋\n'.repeat(30000);
    const event = 'data: ' + JSON.stringify({ choices: [{ delta: { content: token } }] }) + '\r\n\r\ndata: [DONE]\r\n\r\n';
    let calls = 0;
    const start = performance.now();
    const result = await read(chunkedResponse(event, 31), (delta, aggregate) => {
      calls += 1;
      expect(delta === token && aggregate === token).toBe(true);
    });
    const ms = performance.now() - start;
    report('fragmented-sse', { bytes: Buffer.byteLength(event), chunkBytes: 31, ms });
    expect(result === token).toBe(true);
    expect(calls).toBe(1);
    expect(ms).toBeLessThan(750);
  });

  test('keeps the production planner responsive across token events and editor handoff', async () => {
    const browser = createBrowser();
    loadStreamingBackend(browser);
    const profile = browser.window.codexIdeProfile;
    const content = 'const greeting = "Grüße 👋";\n'.repeat(3000);
    const request = '<codex_ide_editor_request>' + JSON.stringify({ operation: 'write', path: 'src/new.js', content }) + '</codex_ide_editor_request>';
    const events = [];
    for (let offset = 0; offset < request.length; offset += 64) {
      events.push('data: ' + JSON.stringify({ choices: [{ delta: { content: request.slice(offset, offset + 64) } }] }) + '\n\n');
    }
    const response = { ...chunkedResponse(events.join('') + 'data: [DONE]\n\n', 4096), ok: true, headers: { get: () => 'text/event-stream' } };
    let calls = 0;
    let drafts = 0;
    let firstDraft;
    const start = performance.now();
    browser.context.fetch.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) return response;
      return { ok: true, headers: { get: () => 'application/json' }, json: async () => ({ choices: [{ message: {
        content: calls === 2 ? '{"complete":true}' : '<codex_ide_final>Erledigt.</codex_ide_final>'
      } }] }) };
    });
    const result = await profile.apiGenerateReply('Erstelle die Datei', {
      editorWriteMode: true, editorWorkspaceMode: true,
      onEditorDraft: () => { drafts += 1; if (firstDraft === undefined) firstDraft = performance.now() - start; },
      onEditorWrite: async change => {
        expect(change.content === content).toBe(true);
        return { ok: true, saved: true, file: { path: 'src/new.js', content } };
      }
    });
    const ms = performance.now() - start;
    report('planner-stream-to-editor', { contentChars: content.length, tokenEvents: events.length, drafts, firstDraftMs: firstDraft, ms });
    expect(result).toContain('Erledigt.');
    expect(drafts).toBeGreaterThan(100);
    expect(calls).toBe(3);
    expect(firstDraft).toBeLessThan(250);
    expect(ms).toBeLessThan(1000);
  });

  test('delivers tokens while a turn is open and reuses its sandboxed App Server', async () => {
    let release;
    const harness = createAppServerHarness((message, transport) => {
      if (message.method !== 'turn/start') return false;
      const id = 'perf-turn-' + harness.requests.filter(request => request.method === 'turn/start').length;
      transport.reply({ turn: { id } });
      setImmediate(() => {
        transport.notify('item/agentMessage/delta', { threadId: message.params.threadId, turnId: id, delta: 'Grüße 👋' });
        release = () => transport.notify('turn/completed', { threadId: message.params.threadId, turn: { id, status: 'completed' } });
      });
      return true;
    });
    const client = new CodexAppServerClient({ spawnImpl: harness.spawnImpl, cwd: __dirname });
    const start = performance.now();
    try {
      for (let index = 0; index < 10; index += 1) {
        let firstToken;
        const received = new Promise(resolve => { firstToken = resolve; });
        let completed = false;
        const turn = client.runTurn({ sessionId: 'performance', workdir: __dirname, prompt: 'Edit through the live editor',
          workspaceAccess: true, terminalAccess: true, readOnly: true,
          onToken: firstToken }).then(result => { completed = true; return result; });
        expect(await received).toBe('Grüße 👋');
        expect(completed).toBe(false);
        release();
        await turn;
      }
      report('persistent-turns', { turns: 10, ms: performance.now() - start, processes: harness.spawnImpl.mock.calls.length });
      expect(harness.spawnImpl).toHaveBeenCalledTimes(1);
      expect(harness.requests.filter(request => request.method === 'initialize')).toHaveLength(1);
      expect(harness.requests.filter(request => request.method === 'thread/start')).toHaveLength(1);
      expect(harness.requests.filter(request => request.method === 'thread/resume')).toHaveLength(0);
      for (const request of harness.requests.filter(request => ['thread/start', 'turn/start'].includes(request.method))) {
        expect(request.params.permissions).toBe('codex-ide-live-editor');
      }
    } finally { harness.close(); }
  });
});

describe('Codex and editor latency budgets', () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

  test('streams into the visible editor promptly and saves only after its final paint', async () => {
    const editor = createEditor();
    const { extract } = loadStreamingBackend(editor.browser);
    editor.browser.window.codexIdeProfile = editor.profile;
    const content = 'const greeting = "Grüße 👋";\n';
    const request = '<codex_ide_editor_request>' + JSON.stringify({ operation: 'write', path: 'src/new.js', content }) + '</codex_ide_editor_request>';
    const cache = {};
    const started = Date.now();
    let firstPaint;
    for (let end = 16; end < request.length + 16; end += 16) {
      const draft = extract(request.slice(0, end), '', true, cache);
      if (draft) editor.applyModelEditorDraft(draft, 1);
      await jest.advanceTimersByTimeAsync(17);
      if (firstPaint === undefined && editor.node('ideHighlightCode').textContent) firstPaint = Date.now();
      expect(editor.profile.writeModelHomeWorkspaceFile).not.toHaveBeenCalled();
    }
    const pending = editor.applyModelEditorWrite({ operation: 'write', path: 'src/new.js', content }, 1, { persist: true });
    editor.profile.writeModelHomeWorkspaceFile.mockImplementation(async () => {
      expect(editor.node('ideHighlightCode').textContent).toBe(content);
      return { ok: true };
    });
    await jest.runAllTimersAsync();
    await expect(pending).resolves.toMatchObject({ saved: true });
    report('visible-stream-to-save', { firstPaintMs: firstPaint - started, savedMs: Date.now() - started });
    expect(firstPaint - started).toBeLessThanOrEqual(119);
    expect(Date.now() - started).toBeLessThan(650);
    expect(editor.profile.writeModelHomeWorkspaceFile).toHaveBeenCalledTimes(1);
  });

  test('continues after confirmed saves without a full workspace round trip per edit', async () => {
    const editor = createEditor();
    editor.state.files = [{ path: 'keep.txt', size: 5 }];
    editor.state.directories = ['existing'];
    editor.profile.listModelHomeWorkspaceFiles.mockImplementation(() => new Promise(resolve => setTimeout(() => resolve({ files: [], directories: [] }), 250)));
    const started = Date.now();
    for (let index = 0; index < 5; index += 1) {
      const content = 'const value = ' + index + ';\n';
      const pending = editor.applyModelEditorWrite({ operation: 'write', path: 'src/nested/file' + index + '.js', content }, 1, { persist: true });
      await jest.runAllTimersAsync();
      await expect(pending).resolves.toMatchObject({ saved: true });
    }
    report('five-editor-saves', { ms: Date.now() - started, fullWorkspaceReads: editor.profile.listModelHomeWorkspaceFiles.mock.calls.length });
    expect(editor.profile.listModelHomeWorkspaceFiles).not.toHaveBeenCalled();
    expect(editor.state.files.map(file => file.path)).toEqual(expect.arrayContaining(['keep.txt', ...Array.from({ length: 5 }, (_, index) => 'src/nested/file' + index + '.js')]));
    expect(editor.state.directories).toEqual(expect.arrayContaining(['existing', 'src', 'src/nested']));
    expect(Date.now() - started).toBeLessThan(1800);
  });
});

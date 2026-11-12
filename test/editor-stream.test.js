'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createEditor } = require('./helpers/editor');
const { createFixture } = require('./helpers/fixture');
const bridge = require('../scripts/codex-bridge');

describe.each(['codex', 'antigravity'])('editor requests streamed from the %s backend', provider => {
  let editor;
  let extract;

  beforeEach(() => {
    jest.useFakeTimers();
    editor = createEditor();
    const filename = path.resolve(__dirname, '../backendProfile.js');
    const source = fs.readFileSync(filename, 'utf8');
    vm.runInContext(source.replace(/\}\)\(\);\s*$/, `
      window.editorStreamUnderTest = extractStreamingEditorWrite;
      window.editorDispatchUnderTest = runEditorRequest;
      window.editorBackendUnderTest = window.codexIdeProfile;
    })();`), editor.browser.context, { filename });
    editor.browser.window.editorBackendUnderTest.set(provider);
    editor.browser.window.codexIdeProfile = editor.profile;
    extract = text => editor.browser.window.editorStreamUnderTest(text, '', true);
  });

  afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

  test('waits for replaceAll after newText and applies both replacements without a rollback', async () => {
    const content = '// Keep this context\nconst first = old;\nconst second = old;\n';
    editor.activateBuffer('app.js', content, content, false);
    const partial = '<codex_ide_editor_request>{"operation":"edit","path":"app.js","oldText":"old","newText":"updated"';
    expect(extract(partial)).toBeNull();
    const full = partial + ',"replaceAll":true}</codex_ide_editor_request>';
    const frames = [];
    const textarea = editor.node('ideEditor');
    const update = textarea.setRangeText.getMockImplementation();
    textarea.setRangeText.mockImplementation(function (...args) { update.apply(this, args); frames.push(this.value); });
    for (let length = partial.length; length <= full.length; length += 1) {
      const draft = extract(full.slice(0, length));
      if (draft) editor.applyModelEditorDraft(draft, 1);
      await jest.advanceTimersByTimeAsync(16);
    }
    await jest.runAllTimersAsync();
    expect(textarea.value).toBe(content.replaceAll('old', 'updated'));
    // The first completed location must never revert when more fields/tags arrive.
    let firstFinished = false;
    for (const frame of frames) {
      if (frame.includes('first = updated;')) firstFinished = true;
      if (firstFinished) expect(frame).toContain('first = updated;');
      expect(frame).toContain('// Keep this context\n');
    }
  });

  test('uses line hints even when they follow the replacement string', async () => {
    const content = '// Keep\nlet value = old;\n// Keep middle\nlet value = old;\n';
    editor.activateBuffer('app.js', content, content, false);
    const request = extract('<codex_ide_editor_request>{"operation":"edit","path":"app.js","oldText":"old","newText":"updated","startLine":4,"endLine":4}</codex_ide_editor_request>');
    editor.applyModelEditorDraft(request, 1);
    await jest.runAllTimersAsync();
    expect(editor.node('ideEditor').value).toBe('// Keep\nlet value = old;\n// Keep middle\nlet value = updated;\n');
  });

  test('continues to stream new files without showing split surrogate pairs', async () => {
    const stream = '<codex_ide_editor_request>{"operation":"write","path":"new.js","content":"const icon = \\"\\ud83d\\ude03\\";\\n"}</codex_ide_editor_request>';
    const frames = [];
    for (let length = 1; length <= stream.length; length += 1) {
      const draft = extract(stream.slice(0, length));
      if (draft) editor.applyModelEditorDraft(draft, 1);
      await jest.advanceTimersByTimeAsync(16);
      frames.push(editor.node('ideEditor').value);
    }
    await jest.runAllTimersAsync();
    expect(frames.some(frame => frame && !frame.includes('😃'))).toBe(true);
    expect(editor.node('ideEditor').value).toBe('const icon = "😃";\n');
    for (const frame of frames) expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(frame)).toBe(false);
  });

  test.each([
    { operation: 'write', path: 'src/neu.js', content: 'Grüße 👋\n"quoted"\\path\t\b\f\r' },
    { operation: 'edit', path: 'app.js', oldText: 'old', newText: 'Grüße 👋', replaceAll: true, startLine: 4, endLine: 8 }
  ])('cached decoding matches independent decoding at every character boundary: $operation', request => {
    const text = '<codex_ide_editor_request>' + JSON.stringify(request).replace('👋', '\\ud83d\\udc4b') + '</codex_ide_editor_request>';
    const cache = {};
    for (let end = 1; end <= text.length; end += 1) {
      const prefix = text.slice(0, end);
      const cached = editor.browser.window.editorStreamUnderTest(prefix, '', true, cache);
      expect(cached).toEqual(extract(prefix));
    }
  });

  test('an incomplete or invalid escape cannot appear in a cached preview', () => {
    const prefix = '<codex_ide_editor_request>{"operation":"write","path":"new.js","content":"hello ';
    for (const tail of ['\\ud83d\\udc4b', '\\n', '\\"', '\\\\']) {
      const cache = {};
      for (let end = prefix.length; end <= prefix.length + tail.length; end += 1) {
        const text = (prefix + tail).slice(0, end);
        expect(editor.browser.window.editorStreamUnderTest(text, '', true, cache)).toEqual(extract(text));
      }
    }
    const cache = {};
    expect(editor.browser.window.editorStreamUnderTest(prefix, '', true, cache).content).toBe('hello ');
    expect(editor.browser.window.editorStreamUnderTest(prefix + '\\q', '', true, cache)).toBeNull();
  });

  test('cached decoding keeps the first request until a fresh response starts', () => {
    const first = '<codex_ide_editor_request>' + JSON.stringify({ operation: 'write', path: 'one.js', content: 'one' }) + '</codex_ide_editor_request>';
    const second = '<codex_ide_editor_request>' + JSON.stringify({ operation: 'write', path: 'two.js', content: 'two' }) + '</codex_ide_editor_request>';
    const cache = {};
    for (let end = 1; end <= first.length + second.length; end += 1) {
      const text = (first + second).slice(0, end);
      expect(editor.browser.window.editorStreamUnderTest(text, '', true, cache)).toEqual(extract(text));
    }
    expect(editor.browser.window.editorStreamUnderTest(first + second, '', true, cache)).toMatchObject({ path: 'one.js', content: 'one' });
    expect(editor.browser.window.editorStreamUnderTest(second, '', true, {})).toMatchObject({ path: 'two.js', content: 'two' });
  });

  test.each(['write', 'edit'])('dispatches a model %s through the visible editor before touching the real file', async operation => {
    const fixture = createFixture();
    try {
      const original = 'const value = "WXYZ";\nkeep();\n';
      const expected = original.replace('WXYZ', 'abcd');
      const file = operation === 'write' ? 'new.js' : 'app.js';
      if (operation === 'edit') {
        fixture.write(file, original);
        editor.activateBuffer(file, original, original, false);
      }
      const textarea = editor.node('ideEditor');
      const frames = [];
      const update = textarea.setRangeText.getMockImplementation();
      textarea.setRangeText.mockImplementation(function (...args) { update.apply(this, args); frames.push(this.value); });
      editor.profile.writeModelHomeWorkspaceFile.mockImplementation(async (name, content, options) => {
        expect(textarea.value).toBe(expected);
        expect(editor.node('ideHighlightCode').textContent).toBe(expected);
        expect(frames.length).toBeGreaterThan(2);
        const saved = bridge.writeIdeEditorFile(fixture.home, name, content, options);
        return { ok: true, file: saved };
      });
      const request = operation === 'write'
        ? { operation, path: file, content: expected }
        : { operation, path: file, oldText: 'WXYZ', newText: 'abcd' };
      const onPersistenceStart = jest.fn();
      const pending = editor.browser.window.editorDispatchUnderTest(request, {
        editorWorkspaceMode: true,
        onEditorWrite: (change, options) => editor.applyModelEditorWrite(change, 1, { ...options, onPersistenceStart })
      });
      await jest.advanceTimersByTimeAsync(17);
      expect(editor.profile.writeModelHomeWorkspaceFile).not.toHaveBeenCalled();
      expect(onPersistenceStart).not.toHaveBeenCalled();
      if (operation === 'edit') expect(fixture.read(file)).toBe(original);
      else expect(fs.existsSync(path.join(fixture.home, file))).toBe(false);
      await jest.runAllTimersAsync();
      await expect(pending).resolves.toMatchObject({ status: 'completed', persistence: 'saved', editorChanged: true });
      expect(fixture.read(file)).toBe(expected);
      expect(editor.profile.writeModelHomeWorkspaceFile).toHaveBeenCalledTimes(1);
      expect(onPersistenceStart).toHaveBeenCalledTimes(1);
    } finally {
      fixture.dispose();
    }
  });

  test('a missing visible editor cannot fall back to a direct file write', async () => {
    await expect(editor.browser.window.editorDispatchUnderTest({ operation: 'write', path: 'new.js', content: 'hidden' }, {
      editorWorkspaceMode: true
    })).resolves.toMatchObject({ status: 'failed', failureKind: 'editor-channel-unavailable' });
    expect(editor.profile.writeModelHomeWorkspaceFile).not.toHaveBeenCalled();
  });

  test.each(['new.js', 'other.js'])
  ('saves the first streamed request once without closing or retyping it when later blocks target %s', async laterPath => {
    const fixture = createFixture();
    const backend = editor.browser.window.editorBackendUnderTest;
    editor.browser.window.codexIdeProfile = backend;
    backend.set(provider);
    const first = { operation: 'write', path: 'new.js', content: 'const value = "first 👋";\n' };
    const later = [
      { operation: 'write', path: laterPath, content: 'const value = "second";\n' },
      { operation: 'write', path: laterPath, content: 'const value = "third";\n' }
    ];
    const followUp = { operation: 'edit', path: first.path, oldText: 'first', newText: 'next' };
    const updatedContent = first.content.replace('first', 'next');
    const changes = [];
    const textarea = editor.node('ideEditor');
    const update = textarea.setRangeText.getMockImplementation();
    textarea.setRangeText.mockImplementation(function (text, start, end, mode) {
      const removed = this.value.slice(start, end);
      update.call(this, text, start, end, mode);
      changes.push({ path: editor.state.path, content: this.value, text, removed });
    });
    let turnId = 1;
    const onEditorDraftDiscard = jest.fn(() => editor.discardModelEditorDraft(turnId));
    const onEditorWrite = jest.fn((request, options) => editor.applyModelEditorWrite(request, turnId, options));
    let modelCalls = 0;
    let saves = 0;
    function json(data) { return { ok: true, headers: { get: () => 'application/json' }, json: async () => data }; }
    function stream(parts) {
      const chunks = parts.map(content => Buffer.from('data: ' + JSON.stringify({ choices: [{ delta: { content } }] }) + '\n\n'));
      chunks.push(Buffer.from('data: [DONE]\n\n'));
      return { ok: true, headers: { get: () => 'text/event-stream' }, body: { getReader: () => ({ read: async () => {
        // Leave time to paint each block: an undelayed mock hides the repeated
        // closing/retyping that occurs while a real model is still streaming.
        await new Promise(resolve => setTimeout(resolve, 1000));
        return chunks.length ? { done: false, value: chunks.shift() } : { done: true };
      } }) } };
    }
    editor.browser.context.fetch.mockImplementation(async (url, request) => {
      const body = JSON.parse(request.body);
      if (url.endsWith('/codex-ide/ide-files')) {
        const content = saves ? updatedContent : first.content;
        expect(body).toMatchObject({ path: first.path, operation: saves ? 'edit' : 'write', content });
        expect(textarea.value).toBe(content);
        expect(editor.node('ideHighlightCode').textContent).toBe(content);
        if (saves) expect(fixture.read(first.path)).toBe(first.content);
        else expect(fs.existsSync(path.join(fixture.home, first.path))).toBe(false);
        saves += 1;
        return json({ ok: true, file: bridge.writeIdeEditorFile(fixture.home, body.path, body.content, body) });
      }
      if (!url.endsWith('/v1/chat/completions')) throw new Error('Unexpected request: ' + url);
      if (body.response_format) return json({ choices: [{ message: { content: '{"complete":true}' } }] });
      modelCalls += 1;
      if (modelCalls === 1) return stream([first, ...later].map(change =>
        '<codex_ide_editor_request>' + JSON.stringify(change) + '</codex_ide_editor_request>'));
      if (modelCalls === 3) return stream([followUp, { ...followUp, newText: 'ignored' }].map(change =>
        '<codex_ide_editor_request>' + JSON.stringify(change) + '</codex_ide_editor_request>'));
      if (modelCalls === 2 || modelCalls === 4) return stream(['<codex_ide_final>Gespeichert.</codex_ide_final>']);
      throw new Error('Unexpected model retry');
    });
    try {
      const options = {
        editorWriteMode: true, editorWorkspaceMode: true,
        onEditorDraft: request => editor.applyModelEditorDraft(request, turnId),
        onEditorDraftDiscard, onEditorWrite
      };
      const pending = backend.apiGenerateReply('Erstelle die neue Datei', options);
      await jest.runAllTimersAsync();
      await expect(pending).resolves.toContain('Gespeichert.');
      expect(fixture.read(first.path)).toBe(first.content);
      expect(saves).toBe(1);
      expect(onEditorWrite).toHaveBeenCalledTimes(1);
      expect(onEditorDraftDiscard).not.toHaveBeenCalled();
      expect(changes.length).toBeGreaterThan(2);
      expect(changes.every(change => change.path === first.path && !change.removed && first.content.startsWith(change.content))).toBe(true);
      expect(changes.map(change => change.text).join('')).toBe(first.content);
      expect(editor.state.dirty).toBe(false);
      expect(Object.keys(editor.state.buffers)).toEqual([first.path]);

      // A later user turn edits the saved file with a fresh stream cache and
      // must retain the visible context instead of replaying the first write.
      changes.length = 0;
      editor.state.turnId = ++turnId;
      const next = backend.apiGenerateReply('Ändere first zu next', {
        ...options,
        conversationHistory: [{ user: 'Erstelle die neue Datei', reply: 'Gespeichert.' }]
      });
      await jest.runAllTimersAsync();
      await expect(next).resolves.toContain('Gespeichert.');
      expect(fixture.read(first.path)).toBe(updatedContent);
      expect(saves).toBe(2);
      expect(onEditorWrite).toHaveBeenCalledTimes(2);
      expect(onEditorDraftDiscard).not.toHaveBeenCalled();
      expect(changes.length).toBeGreaterThan(2);
      expect(changes.every(change => change.path === first.path && change.content.startsWith('const value = "') && change.content.endsWith(' 👋";\n'))).toBe(true);
      expect(editor.state.dirty).toBe(false);
    } finally { fixture.dispose(); }
  });

  test('runs multiple streamed model responses through painting, persistence and the completeness audit', async () => {
    const fixture = createFixture();
    const backend = editor.browser.window.editorBackendUnderTest;
    editor.browser.window.codexIdeProfile = backend;
    const changes = [
      { operation: 'write', path: 'src/one.js', content: 'const text = "Grüße 👋";\n' },
      { operation: 'write', path: 'src/two.js', content: 'const next = "zweite Datei";\n' }
    ];
    let actions = 0;
    let audits = 0;
    let saves = 0;
    function json(data) { return { ok: true, headers: { get: () => 'application/json' }, json: async () => data }; }
    function stream(text) {
      const bytes = Buffer.from(Array.from(text).map(token => 'data: ' + JSON.stringify({ choices: [{ delta: { content: token } }] }) + '\r\n\r\n').join('') + 'data: [DONE]\r\n\r\n');
      let offset = 0;
      return { ok: true, headers: { get: () => 'text/event-stream' }, body: { getReader: () => ({ read: async () => {
        if (offset >= bytes.length) return { done: true };
        const start = offset;
        offset += 7;
        return { done: false, value: bytes.subarray(start, offset) };
      } }) } };
    }
    editor.browser.context.fetch.mockImplementation(async (url, request) => {
      const body = JSON.parse(request.body);
      if (url.endsWith('/codex-ide/ide-files')) {
        expect(editor.node('ideEditor').value).toBe(body.content);
        expect(editor.node('ideHighlightCode').textContent).toBe(body.content);
        expect(fs.existsSync(path.join(fixture.home, body.path))).toBe(false);
        saves += 1;
        return json({ ok: true, file: bridge.writeIdeEditorFile(fixture.home, body.path, body.content, body), persistence: 'saved' });
      }
      if (!url.endsWith('/v1/chat/completions')) throw new Error('Unexpected workspace scan or preflight: ' + url);
      if (body.response_format) {
        audits += 1;
        expect(saves).toBe(actions);
        return json({ choices: [{ message: { content: JSON.stringify({ complete: saves === changes.length }) } }] });
      }
      if (actions < changes.length) return stream('<codex_ide_editor_request>' + JSON.stringify(changes[actions++]) + '</codex_ide_editor_request>');
      return stream('<codex_ide_final>Beide Dateien erstellt.</codex_ide_final>');
    });
    try {
      const pending = backend.apiGenerateReply('Erstelle beide Dateien', {
        editorWriteMode: true, editorWorkspaceMode: true,
        onEditorDraft: request => editor.applyModelEditorDraft(request, 1),
        onEditorWrite: (request, options) => editor.applyModelEditorWrite(request, 1, options)
      });
      await jest.runAllTimersAsync();
      await expect(pending).resolves.toContain('Beide Dateien erstellt.');
      expect(actions).toBe(2);
      expect(audits).toBe(2);
      expect(saves).toBe(2);
      for (const change of changes) expect(fixture.read(change.path)).toBe(change.content);
      expect(editor.state.files.map(file => file.path)).toEqual(['src/one.js', 'src/two.js']);
    } finally { fixture.dispose(); }
  });
});

'use strict';

const { createEditor } = require('./helpers/editor');

describe('live editor actions', () => {
  let editor;

  beforeEach(() => {
    jest.useFakeTimers();
    editor = createEditor();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  test.each(['package.json', 'src/main.ts', '.env', '.git/config', 'memory.md'])
    ('shows the complete live edit before persisting %s', async file => {
      const content = 'sichtbare Aenderung 👋\nzweite Zeile\n';
      const frames = [];
      const textarea = editor.node('ideEditor');
      const update = textarea.setRangeText.getMockImplementation();
      textarea.setRangeText.mockImplementation(function (...args) {
        update.apply(this, args);
        frames.push(this.value);
      });
      editor.profile.writeModelHomeWorkspaceFile.mockImplementation(async (name, saved) => {
        expect(name).toBe(file);
        expect(saved).toBe(content);
        expect(textarea.value).toBe(content);
        expect(frames.some(frame => frame.length > 0 && frame.length < content.length)).toBe(true);
        return { ok: true, persistence: 'saved' };
      });
      const pending = editor.applyModelEditorWrite({ operation: 'write', path: file, content }, 1, { persist: true });
      expect(editor.profile.writeModelHomeWorkspaceFile).not.toHaveBeenCalled();
      await jest.runAllTimersAsync();
      await pending;
      expect(editor.profile.writeModelHomeWorkspaceFile).toHaveBeenCalledTimes(1);
    });

  test.each([
    ['completed', true], ['completed', false], ['streamed', true], ['streamed', false]
  ])('%s edit with replaceAll=%s animates only pending replacements', async (mode, replaceAll) => {
    const content = '// Keep both declarations\nconst first = "foobar";\nconst second = "foo";\n';
    const expected = content.replace('"foo"', '"foobar"');
    editor.activateBuffer('app.js', content, content, false);

    const request = {
      operation: 'edit', path: 'app.js', oldText: 'foo', newText: 'foobar',
      replaceAll, complete: true
    };
    if (mode === 'streamed') {
      for (const newText of ['', 'fo', 'foob']) {
        editor.applyModelEditorDraft({ ...request, newText, complete: false }, 1);
        await jest.advanceTimersByTimeAsync(16);
      }
    }
    editor.applyModelEditorDraft(request, 1);
    await jest.runAllTimersAsync();

    expect(editor.node('ideEditor').value).toBe(expected);
    await expect(editor.applyModelEditorWrite(request, 1, { persist: false }))
      .resolves.toMatchObject({ file: { content: expected } });
    expect(editor.node('ideEditor').value).toBe(expected);
  });

  test.each(['abort rejection', 'late success', 'late failure'])
  ('Stop during persistence handles %s without changing the restored buffer', async completion => {
    const content = '// Existing file\nconst untouched = true;\n';
    editor.activateBuffer('original.js', content, content, false);
    editor.node('ideEditor').setSelectionRange(5, 12);
    const controller = new AbortController();
    editor.state.controller = controller;
    let resolveWrite;
    let rejectWrite;
    editor.profile.writeModelHomeWorkspaceFile.mockImplementation((_path, _content, { signal }) =>
      new Promise((resolve, reject) => {
        resolveWrite = resolve;
        rejectWrite = reject;
        if (completion === 'abort rejection') {
          signal.addEventListener('abort', () => {
            reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }));
          }, { once: true });
        }
      }));

    const pending = editor.applyModelEditorWrite({
      operation: 'write', path: 'new.js', content: 'const created = true;\n'
    }, 1, { persist: true, signal: controller.signal });
    const outcome = pending.then(result => ({ result }), error => ({ error }));
    await jest.runAllTimersAsync();
    expect(editor.profile.writeModelHomeWorkspaceFile).toHaveBeenCalledTimes(1);

    editor.node('ideStop').dispatchEvent({ type: 'click' });
    if (completion === 'late success') resolveWrite({ ok: true });
    if (completion === 'late failure') rejectWrite(new Error('Connection closed after Stop'));
    const settled = await outcome;

    expect({
      errorName: settled.error && settled.error.name,
      path: editor.state.path,
      content: editor.node('ideEditor').value,
      dirty: editor.state.dirty,
      bufferDirty: editor.state.buffers['original.js'].dirty,
      newBuffer: editor.state.buffers['new.js'],
      selection: [editor.node('ideEditor').selectionStart, editor.node('ideEditor').selectionEnd]
    }).toEqual({
      errorName: 'AbortError', path: 'original.js', content,
      dirty: false, bufferDirty: false, newBuffer: undefined, selection: [5, 12]
    });
  });

  test.each(['app.js', 'style.css', 'index.html', 'main.py', 'README.md'])
  ('full-context edits of %s preserve every unchanged region in every frame', async path => {
    const content = 'HEADER keep\nfirst = old\nMIDDLE keep\nsecond = before\nFOOTER keep\n';
    const expected = content.replace('old', 'new').replace('before', 'after');
    editor.activateBuffer(path, content, content, false);
    const textarea = editor.node('ideEditor');
    const frames = [];
    const changes = [];
    const setRangeText = textarea.setRangeText.getMockImplementation();
    textarea.setRangeText.mockImplementation(function (text, start, end, mode) {
      changes.push({ removed: this.value.slice(start, end), text });
      setRangeText.call(this, text, start, end, mode);
      frames.push(this.value);
    });
    const pending = editor.applyModelEditorWrite({ operation: 'edit', path, oldText: content, newText: expected }, 1, { persist: true });
    await jest.runAllTimersAsync();
    await expect(pending).resolves.toMatchObject({ saved: true, file: { content: expected } });
    expect(frames.length).toBeGreaterThan(2);
    for (const frame of frames) {
      for (const context of ['HEADER keep\n', '\nMIDDLE keep\n', '\nFOOTER keep\n']) expect(frame).toContain(context);
    }
    expect(changes.every(change => !change.removed.includes('keep') && !change.text.includes('keep'))).toBe(true);
    expect(textarea.value).toBe(expected);
    expect(textarea.selectionStart).toBe(expected.indexOf('after') + 'after'.length);
    expect(textarea.selectionEnd).toBe(textarea.selectionStart);
  });

  test.each([
    ['insertion', 'const value = 1;\n', 'const value = 10;\n'],
    ['deletion', 'const value = 10;\n', 'const value = 1;\n'],
    ['empty file', 'remove everything\n', ''],
    ['Unicode', 'const icon = "😀";\r\n', 'const icon = "😃";\r\n']
  ])('%s animates the actual difference even for a one-line file', async (_kind, content, expected) => {
    editor.activateBuffer('app.js', content, content, false);
    const frames = [];
    const textarea = editor.node('ideEditor');
    const update = textarea.setRangeText.getMockImplementation();
    textarea.setRangeText.mockImplementation(function (...args) { update.apply(this, args); frames.push(this.value); });
    const pending = editor.applyModelEditorWrite({ operation: 'edit', path: 'app.js', oldText: content, newText: expected }, 1, { persist: false });
    await jest.runAllTimersAsync();
    await expect(pending).resolves.toMatchObject({ file: { content: expected } });
    if (expected) expect(frames.every(frame => frame.startsWith('const ') && frame.endsWith(content.endsWith('\r\n') ? '\r\n' : '\n'))).toBe(true);
    for (const frame of frames) expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(frame)).toBe(false);
  });

  test('incomplete replacement text never erases context that has not arrived yet', async () => {
    const content = 'const first = 1;\nkeep();\nconst last = 2;\n';
    editor.activateBuffer('app.js', content, content, false);
    editor.node('ideEditor').setRangeText.mockClear();
    for (const newText of ['', 'const first', 'const first = 3;\nkeep();\n']) {
      editor.applyModelEditorDraft({ operation: 'edit', path: 'app.js', oldText: content, newText, complete: false }, 1);
      await jest.runAllTimersAsync();
      expect(editor.node('ideEditor').value).toBe(content);
      expect(editor.state.liveEditorDraft).toBeNull();
    }
    expect(editor.node('ideEditor').setRangeText).not.toHaveBeenCalled();
  });

  test('Stop during a localized animation restores content, dirty state, selection and viewport', async () => {
    const content = 'keep\nconst value = "' + 'old'.repeat(100) + '";\nkeep end\n';
    const saved = 'previous saved content';
    editor.activateBuffer('app.js', content, saved, true);
    const textarea = editor.node('ideEditor');
    textarea.setSelectionRange(4, 8);
    textarea.scrollTop = 70;
    textarea.scrollLeft = 14;
    editor.applyModelEditorDraft({ operation: 'edit', path: 'app.js', oldText: content, newText: content.replace('old'.repeat(100), 'new'.repeat(100)), complete: true }, 1);
    await jest.advanceTimersByTimeAsync(32);
    expect(textarea.value).not.toBe(content);
    editor.node('ideStop').dispatchEvent({ type: 'click' });
    await jest.runAllTimersAsync();
    expect(textarea.value).toBe(content);
    expect(editor.state.savedContent).toBe(saved);
    expect(editor.state.dirty).toBe(true);
    expect([textarea.selectionStart, textarea.selectionEnd, textarea.scrollTop, textarea.scrollLeft]).toEqual([4, 8, 70, 14]);
    expect(editor.state.buffers['app.js'].content).toBe(content);
  });

  test('a superseded turn releases its animation waiters without rescheduling forever', async () => {
    const content = 'keep\nconst value = "' + 'old'.repeat(100) + '";\nkeep end\n';
    editor.activateBuffer('app.js', content, content, false);
    const pending = editor.applyModelEditorWrite({ operation: 'edit', path: 'app.js', oldText: content, newText: content.replace('old'.repeat(100), 'new'.repeat(100)) }, 1, { persist: false });
    const outcome = pending.catch(error => error);
    editor.state.turnId = 2;
    await jest.runAllTimersAsync();
    expect((await outcome).message).toContain('nicht mehr aktiv');
    expect(jest.getTimerCount()).toBe(0);
  });
});

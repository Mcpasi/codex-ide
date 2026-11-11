'use strict';

const { createEditor } = require('./helpers/editor');
const { advanceLiveEditorText, advanceLiveEditorTextBatch } = require('../codex_ide/codex-ide');

describe('keyboard-like live editing', () => {
  let editor;
  let textarea;

  beforeEach(() => {
    jest.useFakeTimers();
    editor = createEditor();
    textarea = editor.node('ideEditor');
  });

  afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

  function recordChanges() {
    const changes = [];
    const update = textarea.setRangeText.getMockImplementation();
    textarea.setRangeText.mockImplementation(function (text, start, end, mode) {
      const removed = this.value.slice(start, end);
      update.call(this, text, start, end, mode);
      changes.push({ content: this.value, inserted: text, removed, time: Date.now() });
    });
    return changes;
  }

  test.each(['write', 'edit'])('Tab during a live %s preserves the read-only buffer and lets it save', async operation => {
    editor.browser.context.Event = Event;
    editor.activateBuffer('app.js', 'b', 'b', false);
    editor.setBusy(true);
    const request = operation === 'write'
      ? { operation, path: 'new.js', content: 'a' }
      : { operation, path: 'app.js', oldText: 'b', newText: 'a' };
    const pending = editor.applyModelEditorWrite(request, 1, { persist: true });
    const outcome = pending.then(result => ({ result }), error => ({ error }));

    // Press Tab after the final syntax paint, before the save starts.
    await jest.advanceTimersByTimeAsync(operation === 'write' ? 17 : 34);
    expect(textarea.readOnly).toBe(true);
    expect(textarea.value).toBe('a');
    expect(editor.node('ideHighlightCode').textContent).toBe('a');
    expect(editor.profile.writeModelHomeWorkspaceFile).not.toHaveBeenCalled();
    textarea.dispatchEvent({ type: 'keydown', key: 'Tab', preventDefault: jest.fn() });
    const contentAfterTab = textarea.value;

    await jest.runAllTimersAsync();
    const settled = await outcome;
    expect(contentAfterTab).toBe('a');
    expect(settled.error).toBeUndefined();
    expect(settled.result).toMatchObject({ saved: true, file: { content: 'a' } });
    expect(editor.profile.writeModelHomeWorkspaceFile).toHaveBeenCalledTimes(1);
    expect(textarea.value).toBe('a');
  });

  test('Tab still indents selected text when the editor is editable', () => {
    editor.browser.context.Event = Event;
    editor.activateBuffer('app.js', 'selected();', 'selected();', false);
    editor.setBusy(false);
    textarea.setSelectionRange(0, 'selected'.length);
    const event = { type: 'keydown', key: 'Tab', preventDefault: jest.fn() };

    textarea.dispatchEvent(event);

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(textarea.value).toBe('  ();');
    expect(editor.state.buffers['app.js']).toMatchObject({ content: '  ();', dirty: true });
  });

  test('types short code one visible Unicode character at a time before saving', async () => {
    const content = 'const icon = "👋";\n';
    const changes = recordChanges();
    const pending = editor.applyModelEditorWrite({ operation: 'write', path: 'new.js', content }, 1, { persist: true });
    expect(textarea.value).toBe('');
    await jest.advanceTimersByTimeAsync(17);
    expect(textarea.value).toBe('c');
    expect(editor.node('ideHighlightCode').textContent).toBe('c');
    expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([1, 1]);
    expect(editor.node('ideEditorSurface').dataset.liveEdit).toBe('write');
    expect(editor.profile.writeModelHomeWorkspaceFile).not.toHaveBeenCalled();
    await jest.runAllTimersAsync();
    await expect(pending).resolves.toMatchObject({ saved: true });
    const characters = Array.from(content);
    expect(changes.map(change => change.content)).toEqual(characters.map((_, index) => characters.slice(0, index + 1).join('')));
    expect(changes.every(change => !change.removed)).toBe(true);
    expect(changes.at(-1).time - changes[0].time).toBeLessThan(500);
  });

  test('backspaces an old range before typing its replacement, with a collapsed caret in both phases', async () => {
    const content = 'const value = "WXYZ";\nkeep();\n';
    const wrap = replacement => content.replace('WXYZ', replacement);
    editor.activateBuffer('app.js', content, content, false);
    const changes = recordChanges();
    const pending = editor.applyModelEditorWrite({ operation: 'edit', path: 'app.js', oldText: 'WXYZ', newText: 'abcd' }, 1, { persist: true });
    for (const [index, replacement] of ['WXY', 'WX', 'W', '', 'a', 'ab', 'abc', 'abcd'].entries()) {
      await jest.advanceTimersByTimeAsync(17);
      expect(textarea.value).toBe(wrap(replacement));
      expect(editor.node('ideHighlightCode').textContent).toBe(textarea.value);
      expect(editor.node('ideEditorSurface').dataset.liveEdit).toBe(index < 4 ? 'edit-delete' : 'edit-insert');
      expect(textarea.selectionStart).toBe(content.indexOf('WXYZ') + replacement.length);
      expect(textarea.selectionEnd).toBe(textarea.selectionStart);
      expect(editor.profile.writeModelHomeWorkspaceFile).not.toHaveBeenCalled();
    }
    await jest.runAllTimersAsync();
    await pending;
    expect(changes.slice(0, 4).map(change => change.removed)).toEqual(['Z', 'Y', 'X', 'W']);
    expect(changes.slice(0, 4).every(change => change.inserted === '')).toBe(true);
    expect(changes.slice(4).map(change => change.inserted)).toEqual(['a', 'b', 'c', 'd']);
    expect(changes.slice(4).every(change => change.removed === '')).toBe(true);
  });

  test.each([
    ['write', 'x'.repeat(1000), 1800],
    ['write', 'x'.repeat(12000), 3600],
    ['write', '\n'.repeat(5000), 1800],
    ['edit', 'x'.repeat(1000), 1300],
    ['edit', 'x'.repeat(12000), 3600]
  ])('animates a large %s at a bounded, steady rate', async (operation, text, maxDuration) => {
    const content = '// keep\n' + text + '\n// keep end\n';
    if (operation === 'edit') editor.activateBuffer('app.js', content, content, false);
    const changes = recordChanges();
    const started = Date.now();
    const request = operation === 'write'
      ? { operation, path: 'new.js', content: text }
      : { operation, path: 'app.js', oldText: text, newText: '' };
    const pending = editor.applyModelEditorWrite(request, 1, { persist: true });
    await jest.runAllTimersAsync();
    await expect(pending).resolves.toMatchObject({ saved: true });
    const units = changes.map(change => Array.from(operation === 'write' ? change.inserted : change.removed).length);
    expect(units.length).toBeGreaterThan(10);
    expect(units.every(count => count > 0 && count <= 64)).toBe(true);
    expect(units.slice(0, -1).every(count => count === units[0])).toBe(true);
    expect(Date.now() - started).toBeLessThanOrEqual(maxDuration);
    expect(textarea.value).toBe(operation === 'write' ? text : content.replace(text, ''));
  });

  test('catches up with streamed bursts without restarting characters already typed', async () => {
    const changes = recordChanges();
    editor.applyModelEditorDraft({ operation: 'write', path: 'new.js', content: 'const ' }, 1);
    await jest.runAllTimersAsync();
    expect(textarea.value).toBe('const ');
    const content = 'const value = "' + 'x'.repeat(1500) + '";\n';
    editor.applyModelEditorDraft({ operation: 'write', path: 'new.js', content }, 1);
    const pending = editor.applyModelEditorWrite({ operation: 'write', path: 'new.js', content }, 1, { persist: true });
    await jest.runAllTimersAsync();
    await pending;
    expect(changes.every(change => !change.removed && content.startsWith(change.content))).toBe(true);
    expect(changes.map(change => change.inserted).join('')).toBe(content);
    expect(editor.profile.writeModelHomeWorkspaceFile).toHaveBeenCalledTimes(1);
  });

  test('waits for every visible syntax paint and a final presentation frame before persisting', async () => {
    const paints = [];
    editor.browser.window.requestAnimationFrame = callback => { paints.push(callback); return paints.length; };
    const pending = editor.applyModelEditorWrite({ operation: 'write', path: 'new.js', content: 'ab' }, 1, { persist: true });
    await jest.advanceTimersByTimeAsync(100);
    expect(textarea.value).toBe('a');
    expect(editor.profile.writeModelHomeWorkspaceFile).not.toHaveBeenCalled();
    paints.shift()();
    expect(editor.node('ideHighlightCode').textContent).toBe('a');
    await jest.advanceTimersByTimeAsync(100);
    expect(textarea.value).toBe('ab');
    expect(editor.node('ideHighlightCode').textContent).toBe('a');
    expect(editor.profile.writeModelHomeWorkspaceFile).not.toHaveBeenCalled();
    paints.shift()();
    expect(editor.node('ideHighlightCode').textContent).toBe('ab');
    await jest.advanceTimersByTimeAsync(15);
    expect(editor.profile.writeModelHomeWorkspaceFile).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toMatchObject({ saved: true });
    expect(editor.profile.writeModelHomeWorkspaceFile).toHaveBeenCalledTimes(1);
  });

  test('a superseded turn releases its waiters even while waiting for a delayed paint', async () => {
    let paint;
    editor.browser.window.requestAnimationFrame = callback => { paint = callback; return 1; };
    const pending = editor.applyModelEditorWrite({ operation: 'write', path: 'new.js', content: 'abc' }, 1, { persist: true });
    const outcome = pending.catch(error => error);
    await jest.advanceTimersByTimeAsync(100);
    expect(textarea.value).toBe('a');
    editor.state.turnId = 2;
    paint();
    expect((await outcome).message).toContain('nicht mehr aktiv');
    await jest.runAllTimersAsync();
    expect(editor.profile.writeModelHomeWorkspaceFile).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  test('an abort releases an animation whose syntax paint never arrives', async () => {
    let paint;
    editor.browser.window.requestAnimationFrame = callback => { paint = callback; return 1; };
    editor.activateBuffer('original.js', 'keep', 'keep', false);
    const controller = new AbortController();
    const pending = editor.applyModelEditorWrite({ operation: 'write', path: 'new.js', content: 'abc' }, 1, { persist: true, signal: controller.signal });
    const outcome = pending.catch(error => error);
    await jest.advanceTimersByTimeAsync(100);
    expect(textarea.value).toBe('a');
    controller.abort();
    expect((await outcome).name).toBe('AbortError');
    paint();
    await jest.runAllTimersAsync();
    expect(textarea.value).toBe('keep');
    expect(editor.node('ideHighlightCode').textContent).toBe('keep');
    expect(editor.state.liveEditorDraft).toBeNull();
    expect(editor.profile.writeModelHomeWorkspaceFile).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  test('rejects an inconsistent final buffer instead of silently replacing or saving it', async () => {
    editor.activateBuffer('original.js', 'keep', 'keep', false);
    const pending = editor.applyModelEditorWrite({ operation: 'write', path: 'new.js', content: 'a' }, 1, { persist: true });
    const outcome = pending.catch(error => error);
    await jest.advanceTimersByTimeAsync(17);
    expect(editor.node('ideHighlightCode').textContent).toBe('a');
    textarea.value = 'bypassed animation';
    await jest.runAllTimersAsync();
    expect((await outcome).message).toContain('nicht vollständig');
    expect(textarea.value).toBe('keep');
    expect(editor.state.path).toBe('original.js');
    expect(editor.state.buffers['new.js']).toBeUndefined();
    expect(editor.profile.writeModelHomeWorkspaceFile).not.toHaveBeenCalled();
  });

  test.each(['write', 'edit'])('accepts the real textarea CRLF normalization during %s', async operation => {
    let value = '';
    Object.defineProperty(textarea, 'value', {
      get: () => value,
      set: text => { value = String(text).replace(/\r\n?/g, '\n'); }
    });
    const original = 'const value = "WXYZ";\r\nkeep();\r\n';
    const expected = original.replace('WXYZ', 'abcd');
    if (operation === 'edit') editor.activateBuffer('app.js', original, original, false);
    const request = operation === 'write'
      ? { operation, path: 'new.js', content: expected }
      : { operation, path: 'app.js', oldText: 'WXYZ', newText: 'abcd' };
    const pending = editor.applyModelEditorWrite(request, 1, { persist: true });
    await jest.runAllTimersAsync();
    await expect(pending).resolves.toMatchObject({ saved: true });
    expect(textarea.value).toBe(expected.replace(/\r\n/g, '\n'));
    expect(editor.profile.writeModelHomeWorkspaceFile).toHaveBeenCalledTimes(1);
  });

  test.each(['insertion', 'deletion'])('a signal abort during %s promptly restores the view without persisting', async operation => {
    const content = 'keep\n' + 'x'.repeat(1000) + '\n';
    editor.activateBuffer('app.js', content, 'saved before', true);
    textarea.setSelectionRange(2, 5);
    textarea.scrollTop = 70;
    textarea.scrollLeft = 14;
    const controller = new AbortController();
    const request = operation === 'insertion'
      ? { operation: 'write', path: 'new.js', content: 'y'.repeat(1000) }
      : { operation: 'edit', path: 'app.js', oldText: 'x'.repeat(1000), newText: '' };
    const pending = editor.applyModelEditorWrite(request, 1, { persist: true, signal: controller.signal });
    const outcome = pending.catch(error => error);
    await jest.advanceTimersByTimeAsync(34);
    expect(textarea.value).not.toBe(content);
    controller.abort();
    expect((await outcome).name).toBe('AbortError');
    await jest.runAllTimersAsync();
    expect(textarea.value).toBe(content);
    expect(editor.state.path).toBe('app.js');
    expect(editor.state.savedContent).toBe('saved before');
    expect(editor.state.dirty).toBe(true);
    expect([textarea.selectionStart, textarea.selectionEnd, textarea.scrollTop, textarea.scrollLeft]).toEqual([2, 5, 70, 14]);
    expect(editor.profile.writeModelHomeWorkspaceFile).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe('live typing boundaries', () => {
  test.each(['👋', '\r\n'])('inserts and backspaces %j atomically', unit => {
    expect(advanceLiveEditorText('a', 'a' + unit + 'b')).toEqual({ text: 'a' + unit, operation: 'insert', complete: false });
    expect(advanceLiveEditorText('a' + unit, 'a')).toEqual({ text: 'a', operation: 'delete', complete: true });
    expect(advanceLiveEditorTextBatch('a', 'a' + unit.repeat(10), 4).text).toBe('a' + unit.repeat(unit === '\r\n' ? 1 : 4));
  });
});

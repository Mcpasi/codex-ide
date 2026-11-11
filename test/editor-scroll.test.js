'use strict';

const { createEditor } = require('./helpers/editor');

describe('live editor follows the actual edit location', () => {
  let editor;
  let textarea;

  function layout(lineHeight = 20, width = 320) {
    editor.browser.window.getComputedStyle = () => ({
      lineHeight: `${lineHeight}px`, fontSize: '13px', paddingTop: '14px', paddingLeft: '14px',
      letterSpacing: '0px', tabSize: '2'
    });
    textarea.clientHeight = 240;
    textarea.clientWidth = width;
    textarea.scrollWidth = 12000;
    Object.defineProperty(textarea, 'scrollHeight', {
      configurable: true, get: () => textarea.value.split('\n').length * lineHeight + 28
    });
  }

  function expectCaretVisible(lineHeight = 20) {
    const line = textarea.value.slice(0, textarea.selectionEnd).split('\n').length - 1;
    const top = 14 + line * lineHeight;
    expect(top).toBeGreaterThanOrEqual(textarea.scrollTop);
    expect(top + lineHeight).toBeLessThanOrEqual(textarea.scrollTop + textarea.clientHeight);
    expect(editor.node('ideHighlight').scrollTop).toBe(textarea.scrollTop);
    expect(editor.node('ideHighlight').scrollLeft).toBe(textarea.scrollLeft);
  }

  beforeEach(() => {
    jest.useFakeTimers();
    editor = createEditor();
    textarea = editor.node('ideEditor');
    layout();
  });
  afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

  test('reveals an offscreen target before typing or syntax rendering starts, using the real line height', () => {
    layout(52);
    const content = Array.from({ length: 180 }, (_, i) => `line ${i}\n`).join('') + 'const value = old;\n';
    editor.activateBuffer('app.js', content, content, false);
    textarea.scrollTop = 0;
    editor.applyModelEditorDraft({ operation: 'edit', path: 'app.js', oldText: 'old', newText: 'new', complete: true }, 1);
    expect(textarea.value).toBe(content);
    expect(textarea.selectionEnd).toBe(content.indexOf('old') + 3);
    expectCaretVisible(52);
  });

  test('follows long lines horizontally and restores the left edge for a later change', async () => {
    const content = ' '.repeat(700) + 'old\n' + 'keep\n'.repeat(100) + 'before\n';
    editor.activateBuffer('app.js', content, content, false);
    const expected = content.replace('old', 'new').replace('before', 'after');
    editor.applyModelEditorDraft({ operation: 'edit', path: 'app.js', oldText: content, newText: expected, complete: true }, 1);
    expect(textarea.scrollLeft).toBeGreaterThan(5000);
    await jest.runAllTimersAsync();
    expect(textarea.value).toBe(expected);
    expect(textarea.scrollLeft).toBe(0);
    expect(textarea.selectionEnd).toBe(expected.indexOf('after') + 5);
    expectCaretVisible();
  });

  test('continues to follow separate work sites when animation frames are delayed, including persistence', async () => {
    const paints = [];
    editor.browser.window.requestAnimationFrame = jest.fn(callback => { paints.push(callback); return paints.length; });
    editor.browser.window.cancelAnimationFrame = jest.fn();
    const content = Array.from({ length: 240 }, (_, i) => `const item${i} = old;\n`).join('');
    const expected = content.replace('item10 = old', 'item10 = new').replace('item220 = old', 'item220 = new');
    editor.activateBuffer('app.js', content, content, false);
    editor.profile.writeModelHomeWorkspaceFile.mockImplementation(async () => {
      expect(textarea.selectionEnd).toBe(expected.indexOf('item220 = new') + 'item220 = new'.length);
      expectCaretVisible();
      return { ok: true };
    });
    const pending = editor.applyModelEditorWrite({ operation: 'edit', path: 'app.js', oldText: content, newText: expected }, 1, { persist: true });
    await jest.runAllTimersAsync();
    expect(editor.profile.writeModelHomeWorkspaceFile).not.toHaveBeenCalled();
    while (paints.length) {
      paints.shift()();
      await jest.runAllTimersAsync();
    }
    await pending;
    expect(editor.browser.window.cancelAnimationFrame).not.toHaveBeenCalled();
    expect(editor.browser.window.requestAnimationFrame.mock.calls.length).toBeGreaterThan(2);
    expectCaretVisible();
  });

  test('keeps the locked editor focusable so the model caret is visible', () => {
    editor.profile.get = () => 'codex';
    editor.setBusy(true);
    expect(textarea.disabled).toBe(false);
    expect(textarea.readOnly).toBe(true);
    editor.setBusy(false);
    expect(textarea.readOnly).toBe(false);
  });

  test('matches the syntax viewport to native scrollbar space and updates it after resize', async () => {
    textarea.clientWidth = 305;
    textarea.clientHeight = 225;
    editor.activateBuffer('app.js', 'keep\n'.repeat(200), '', false);
    await jest.runAllTimersAsync();
    const highlight = editor.node('ideHighlight');
    expect(highlight.style.width).toBe('305px');
    expect(highlight.style.height).toBe('225px');
    textarea.clientWidth = 240;
    textarea.clientHeight = 180;
    textarea.scrollTop = 120;
    textarea.scrollLeft = 40;
    const resize = editor.browser.window.addEventListener.mock.calls.find(([type]) => type === 'resize')[1];
    resize();
    expect(highlight.style.width).toBe('240px');
    expect(highlight.style.height).toBe('180px');
    expect(highlight.scrollTop).toBe(120);
    expect(highlight.scrollLeft).toBe(40);
  });

  test('reveals the editor panel once per work site instead of on every character', async () => {
    const surface = editor.node('ideEditorSurface');
    surface.scrollIntoView = jest.fn();
    const content = 'first = old;\n' + 'keep\n'.repeat(120) + 'last = before;\n';
    const expected = content.replace('old', 'new').replace('before', 'after');
    editor.activateBuffer('app.js', content, content, false);
    editor.applyModelEditorDraft({ operation: 'edit', path: 'app.js', oldText: content, newText: expected, complete: true }, 1);
    expect(surface.scrollIntoView).toHaveBeenCalledTimes(1);
    await jest.runAllTimersAsync();
    expect(surface.scrollIntoView).toHaveBeenCalledTimes(2);
    expect(surface.scrollIntoView).toHaveBeenLastCalledWith({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
  });

  test('a delayed paint after Stop does not jump back to the cancelled edit', async () => {
    let paint;
    editor.browser.window.requestAnimationFrame = callback => { paint = callback; return 1; };
    editor.browser.window.cancelAnimationFrame = jest.fn();
    const content = 'keep\n'.repeat(150) + 'old'.repeat(100) + '\n';
    editor.activateBuffer('app.js', content, content, false);
    textarea.setSelectionRange(4, 8);
    textarea.scrollTop = 70;
    textarea.scrollLeft = 14;
    editor.applyModelEditorDraft({ operation: 'edit', path: 'app.js', oldText: 'old'.repeat(100), newText: 'new'.repeat(100), complete: true }, 1);
    await jest.advanceTimersByTimeAsync(16);
    editor.node('ideStop').dispatchEvent({ type: 'click' });
    paint();
    expect([textarea.selectionStart, textarea.selectionEnd, textarea.scrollTop, textarea.scrollLeft]).toEqual([4, 8, 70, 14]);
  });
});

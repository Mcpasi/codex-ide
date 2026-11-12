'use strict';

const { performance } = require('perf_hooks');
const { createEditor } = require('./helpers/editor');

const samples = [];
afterAll(() => {
  if (process.env.CODEX_IDE_PERF_REPORT === '1' || process.env.npm_lifecycle_event === 'test:performance') {
    console.log(JSON.stringify({ editorPerformance: samples }, null, 2));
  }
});

describe('long live-editor session budgets', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

  test('bounds transient resources across repeated saves, aborted drafts and streaming bursts', async () => {
    const editor = createEditor();
    const textarea = editor.node('ideEditor');
    const source = 'const context = "Grüße 👋";\n'.repeat(4000) + 'let marker = "old";\n';
    editor.activateBuffer('session.js', source, source, false);
    await jest.runAllTimersAsync();
    const windows = [];
    let aborted = 0, peakTimers = 0;
    let started = performance.now();
    for (let turn = 0; turn < 120; turn++) {
      editor.state.turnId++;
      const oldText = turn % 2 ? 'new' : 'old', newText = turn % 2 ? 'old' : 'new';
      const pending = editor.applyModelEditorWrite({ operation: 'edit', path: 'session.js',
        oldText: `"${oldText}"`, newText: `"${newText}"` }, editor.state.turnId, { persist: true });
      peakTimers = Math.max(peakTimers, jest.getTimerCount());
      await jest.runAllTimersAsync();
      await expect(pending).resolves.toMatchObject({ saved: true });
      if (turn % 4 === 0) {
        const controller = new AbortController();
        const draft = { operation: 'write', path: `cancelled-${turn}.js`, content: 'const 👋' };
        for (let burst = 1; burst <= 30; burst++) {
          editor.applyModelEditorDraft({ ...draft, content: draft.content.repeat(burst) }, editor.state.turnId);
          peakTimers = Math.max(peakTimers, jest.getTimerCount());
        }
        const cancelled = editor.applyModelEditorWrite({ ...draft, content: draft.content.repeat(30) },
          editor.state.turnId, { persist: true, signal: controller.signal }).catch(error => error);
        await jest.advanceTimersByTimeAsync(16);
        controller.abort();
        expect((await cancelled).name).toBe('AbortError');
        await jest.runAllTimersAsync();
        aborted++;
      }
      expect(editor.state.liveEditorDraft).toBeNull();
      expect(editor.state.highlightFrame).toBeNull();
      expect(jest.getTimerCount()).toBe(0);
      expect(Object.keys(editor.state.buffers)).toEqual(['session.js']);
      expect(Object.keys(editor.state.workspaceContents)).toEqual(['session.js']);
      expect(editor.state.files.map(file => file.path)).toEqual(['session.js']);
      expect(textarea.value).toBe(source.replace('"old"', `"${newText}"`));
      expect(editor.node('ideHighlightCode').textContent).toBe(textarea.value);
      // Jest call histories are test-only allocations, not editor retention.
      editor.profile.writeModelHomeWorkspaceFile.mockClear();
      textarea.setRangeText.mockClear();
      editor.browser.document.getElementById.mockClear();
      editor.browser.document.createElement.mockClear();
      if ((turn + 1) % 30 === 0) { windows.push(performance.now() - started); started = performance.now(); }
    }
    samples.push({ name: 'long-session-resources', turns: 120, aborted, contentChars: source.length,
      windowTurns: 30, cpuMs: windows, peakTimers, buffers: Object.keys(editor.state.buffers).length });
    expect(peakTimers).toBeLessThanOrEqual(2);
    expect(Math.max(...windows)).toBeLessThan(5000);
    expect(windows.at(-1)).toBeLessThan(windows[0] * 4 + 250);
  });

  test('coalesces update bursts and avoids retokenizing an unchanged syntax layer', async () => {
    const editor = createEditor();
    const highlight = jest.fn((text, path) => ({
      language: path.endsWith('.js') ? 'javascript' : 'text',
      label: path.endsWith('.js') ? 'JavaScript' : 'Text', html: text
    }));
    editor.browser.window.CodexIdeSyntaxHighlighter = { highlight };
    editor.activateBuffer('app.js', 'same text', 'same text', false);
    await jest.runAllTimersAsync();
    highlight.mockClear();
    for (let frame = 0; frame < 100; frame++) {
      for (let tick = 0; tick < 50; tick++) editor.scheduleEditorHighlight();
      expect(jest.getTimerCount()).toBe(1);
      await jest.runAllTimersAsync();
    }
    const idleCalls = highlight.mock.calls.length;
    samples.push({ name: 'unchanged-syntax', updates: 5000, frames: 100, highlightCalls: idleCalls });
    expect(idleCalls).toBe(0);
    expect(editor.node('ideHighlightCode').textContent).toBe('same text');

    // A filename/language change and a source change must still repaint.
    editor.node('idePath').value = 'app.txt';
    editor.scheduleEditorHighlight();
    await jest.runAllTimersAsync();
    expect(editor.node('ideEditorSurface').getAttribute('data-language')).toBe('text');
    editor.node('ideEditor').value = 'new text';
    editor.scheduleEditorHighlight();
    await jest.runAllTimersAsync();
    expect(editor.node('ideHighlightCode').textContent).toBe('new text');
    expect(highlight).toHaveBeenCalledTimes(2);
    // Loading a different highlighter must also invalidate the last render.
    editor.browser.window.CodexIdeSyntaxHighlighter = { highlight: jest.fn(highlight) };
    editor.scheduleEditorHighlight();
    await jest.runAllTimersAsync();
    expect(highlight).toHaveBeenCalledTimes(3);
  });
});

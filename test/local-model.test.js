'use strict';

const { createBrowser } = require('./helpers/browser');

describe('local browser model without model downloads', () => {
  let browser;
  let model;
  let generator;

  beforeEach(() => {
    browser = createBrowser();
    generator = jest.fn(async prompt => [{ generated_text: prompt + 'Hallo Welt<|im_end|>ignored continuation' }]);
    browser.window.TransformersPipeline = jest.fn(async () => generator);
    browser.load('localModel.js');
    model = browser.window.CodexIdeLocalModel;
  });

  test('requires a loaded model before enabling generation', async () => {
    expect(model.getStatus()).toBe('idle');
    model.setEnabled(true);
    expect(model.isEnabled()).toBe(false);
    await expect(model.generate('Hallo')).resolves.toBeNull();
    await expect(model.chatCompletion([{ role: 'user', content: 'Hallo' }])).rejects.toThrow(/Modell laden/);
  });

  test('loads a model through the injected pipeline and persists its selection', async () => {
    await model.init(' test/model ');
    expect(browser.window.TransformersPipeline).toHaveBeenCalledWith('text-generation', 'test/model', expect.any(Object));
    expect(model.getStatus()).toBe('ready');
    expect(model.isEnabled()).toBe(true);
    expect(browser.values.get('codexIdeChatModel')).toBe('test/model');
    expect(browser.values.get('codexIdeLLMEnabled')).toBe('1');
  });

  test.each(['DOMContentLoaded', 'codex-ide-profile-change'])('keeps a saved disabled model inactive on %s', async event => {
    browser.values.set('codexIdeChatModel', 'test/saved-model');
    browser.values.set('codexIdeLLMEnabled', '0');
    browser.window.codexIdeProfile = { get: () => 'local' };
    browser.document.readyState = 'complete';
    browser.nodes.set('customChatModelId', { value: '' });
    browser.nodes.set('llmEnabledToggle', { checked: true });

    const restore = browser.document.addEventListener.mock.calls.find(([name]) => name === event)[1];
    restore();
    await new Promise(resolve => setImmediate(resolve));

    expect(model.isEnabled()).toBe(false);
    expect(model.getStatus()).toBe('idle');
    expect(browser.values.get('codexIdeLLMEnabled')).toBe('0');
    expect(browser.window.TransformersPipeline).not.toHaveBeenCalled();
    expect(browser.nodes.get('customChatModelId').value).toBe('test/saved-model');
    expect(browser.nodes.get('llmEnabledToggle').checked).toBe(false);
    await expect(model.generate('Hallo')).resolves.toBeNull();
  });

  test('automatically restores a saved enabled model', async () => {
    browser.values.set('codexIdeChatModel', 'test/saved-model');
    browser.values.set('codexIdeLLMEnabled', '1');
    browser.window.codexIdeProfile = { get: () => 'local' };
    browser.document.readyState = 'complete';

    const restore = browser.document.addEventListener.mock.calls.find(([name]) => name === 'DOMContentLoaded')[1];
    restore();
    await new Promise(resolve => setImmediate(resolve));

    expect(model.getStatus()).toBe('ready');
    expect(model.isEnabled()).toBe(true);
    expect(browser.window.TransformersPipeline).toHaveBeenCalledWith('text-generation', 'test/saved-model', expect.any(Object));
    expect(browser.values.get('codexIdeLLMEnabled')).toBe('1');
  });

  test('removes the prompt prefix and model stop tokens from a response', async () => {
    await model.init('test/model');
    await expect(model.generate('Hallo', { conversationHistory: [] })).resolves.toBe('Hallo Welt.');
    expect(generator.mock.calls[0][0]).toContain('Nutzer: Hallo');
  });

  test.each(['generate', 'chatCompletion'])('preserves Markdown, code indentation and literal spaces in %s', async method => {
    await model.init('test/model');
    const reply = '# Beispiel\n\n```python\ndef greet():\n    print("Grüße  👋")\n```\n\nFertig.';
    generator.mockImplementationOnce(async prompt => [{
      generated_text: prompt + reply + '<|im_end|>ignored continuation'
    }]);

    const result = method === 'generate'
      ? model.generate('Zeige Python-Code', { conversationHistory: [] })
      : model.chatCompletion([{ role: 'user', content: 'Zeige Python-Code' }]);
    await expect(result).resolves.toBe(reply);
  });

  test('preserves literal spaces inside a structured editor replacement', async () => {
    await model.init('test/model');
    const request = {
      operation: 'edit', path: 'app.py',
      oldText: '    print("Grüße  👋")', newText: '    print("Hallo  👋")'
    };
    generator.mockImplementationOnce(async prompt => [{
      generated_text: prompt + '<codex_ide_editor_request>' + JSON.stringify(request) + '</codex_ide_editor_request>'
    }]);

    const reply = await model.chatCompletion([{ role: 'user', content: 'Ändere die Begrüßung' }], 100, {
      editorWorkspaceMode: true
    });
    const match = reply.match(/<codex_ide_editor_request>([\s\S]*?)<\/codex_ide_editor_request>/);
    expect(match).not.toBeNull();
    expect(JSON.parse(match[1])).toEqual(request);
  });

  test.each([
    ['workspace completion', '<codex_ide_workspace_complete>{"complete":true}</codex_ide_workspace_complete>', { editorWorkspaceMode: true }],
    ['final answer', '<codex_ide_final>Fertig.</codex_ide_final>', { editorWorkspaceMode: true }],
    ['editor request', '<codex_ide_editor_request>{"operation":"open","path":"app.js"}</codex_ide_editor_request>', { editorWorkspaceMode: true }],
    ['JSON response', '{"complete":true}', { responseFormat: { type: 'json_object' } }]
  ])('does not append punctuation to a structured %s', async (_label, reply, options) => {
    await model.init('test/model');
    generator.mockImplementationOnce(async prompt => [{ generated_text: prompt + reply + '<|im_end|>' }]);
    const onToken = jest.fn();

    await expect(model.chatCompletion([{ role: 'user', content: 'Prüfe die Aufgabe' }], 100, { ...options, onToken }))
      .resolves.toBe(reply);
    expect(onToken).toHaveBeenCalledWith(reply, reply);
  });

  test('accepts the local workspace completion marker and proceeds directly to the final pass', async () => {
    await model.init('test/model');
    browser.load('backendProfile.js');
    const profile = browser.window.codexIdeProfile;
    profile.set('local');
    const complete = '<codex_ide_workspace_complete>{"complete":true}</codex_ide_workspace_complete>';
    const final = '<codex_ide_final>Geprüft.</codex_ide_final>';
    generator
      .mockImplementation(async () => { throw new Error('Unexpected extra model pass'); })
      .mockImplementationOnce(async prompt => [{ generated_text: prompt + complete }])
      .mockImplementationOnce(async prompt => [{ generated_text: prompt + final }]);
    const onPhase = jest.fn();

    const reply = await profile.apiGenerateReply('Prüfe, ob die Aufgabe erledigt ist', {
      editorWriteMode: true, editorWorkspaceMode: true, conversationHistory: [], onPhase
    });

    expect(onPhase.mock.calls.map(([, detail]) => detail.reason)).toEqual(['initial', 'workspace-finalize']);
    expect(generator).toHaveBeenCalledTimes(2);
    expect(reply).toBe(final);
  });

  test('keeps a per-call token budget separate from the saved user limit', async () => {
    await model.init('test/model');
    model.setMaxTokens(1024);
    await model.chatCompletion([{ role: 'user', content: 'Audit' }], 30);
    expect(generator.mock.calls[0][1].max_new_tokens).toBe(30);
    expect(browser.values.get('codexIdeLLMMaxTokens')).toBe('1024');
    await model.chatCompletion([{ role: 'user', content: 'Normal reply' }]);
    expect(generator.mock.calls[1][1].max_new_tokens).toBe(1024);
  });

  test.each([[1, 20], [10000, 4096]])('clamps the token limit %s to %s', async (requested, expected) => {
    await model.init('test/model');
    model.setMaxTokens(requested);
    await model.generate('Hallo');
    expect(generator.mock.calls[0][1].max_new_tokens).toBe(expected);
  });

  test('wraps plain editor replies and delivers the result to the token callback', async () => {
    await model.init('test/model');
    const onToken = jest.fn();
    const expected = '<codex_ide_final>Hallo Welt.</codex_ide_final>';
    await expect(model.chatCompletion([{ role: 'user', content: 'Hallo' }], 50, { editorWorkspaceMode: true, onToken }))
      .resolves.toBe(expected);
    expect(onToken).toHaveBeenCalledWith(expected, expected);
  });

  test('applies the local output filter', async () => {
    await model.init('test/model');
    browser.window.SafetyFilter = { filterModelOutput: jest.fn(() => 'Filtered output') };
    await expect(model.generate('Hallo')).resolves.toBe('Filtered output');
    expect(browser.window.SafetyFilter.filterModelOutput).toHaveBeenCalledWith('Hallo Welt.');
  });

  test.each(['synchronous throw', 'rejected promise'])
    ('rejects failed chat completions instead of returning an empty reply: %s', async failure => {
      await model.init('test/model');
      const error = new Error('Model inference failed');
      generator.mockImplementation(() => {
        if (failure === 'synchronous throw') throw error;
        return Promise.reject(error);
      });
      const onToken = jest.fn();

      await expect(model.chatCompletion([{ role: 'user', content: 'Hallo' }], 50, { onToken }))
        .rejects.toBe(error);
      expect(onToken).not.toHaveBeenCalled();
    });

  test('propagates local inference failures through the selected backend while preserving the legacy fallback', async () => {
    await model.init('test/model');
    browser.load('backendProfile.js');
    browser.window.codexIdeProfile.set('local');
    const error = new Error('Model inference failed');
    generator.mockRejectedValue(error);

    await expect(model.generate('Hallo', { conversationHistory: [] })).resolves.toBeNull();
    await expect(browser.window.codexIdeProfile.apiChatCompletion([{ role: 'user', content: 'Hallo' }], 50))
      .rejects.toBe(error);
    expect(browser.context.fetch).not.toHaveBeenCalled();
  });

  test('ignores a stale load completing after a newer model was selected', async () => {
    let resolveOld;
    browser.window.TransformersPipeline
      .mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }))
      .mockResolvedValueOnce(generator);
    const oldLoad = model.init('old/model');
    await model.init('new/model');
    const oldGenerator = jest.fn();
    resolveOld(oldGenerator);
    await oldLoad;
    await model.generate('Hallo');
    expect(browser.values.get('codexIdeChatModel')).toBe('new/model');
    expect(oldGenerator).not.toHaveBeenCalled();
    expect(generator).toHaveBeenCalledTimes(1);
  });

  test('keeps an explicit disable made during model loading after the download completes', async () => {
    let finishLoad;
    browser.window.TransformersPipeline.mockImplementationOnce(() => new Promise(resolve => { finishLoad = resolve; }));

    const loading = model.init('test/model');
    expect(model.getStatus()).toBe('loading');
    model.setEnabled(false);
    expect(browser.values.get('codexIdeLLMEnabled')).toBe('0');
    finishLoad(generator);
    await loading;

    expect(model.getStatus()).toBe('ready');
    expect(model.isEnabled()).toBe(false);
    expect(browser.values.get('codexIdeLLMEnabled')).toBe('0');
    await expect(model.generate('Hallo')).resolves.toBeNull();
    await expect(model.chatCompletion([{ role: 'user', content: 'Hallo' }])).rejects.toThrow(/Modell laden/);
    expect(generator).not.toHaveBeenCalled();

    model.setEnabled(true);
    await expect(model.generate('Hallo')).resolves.toBe('Hallo Welt.');
    expect(generator).toHaveBeenCalledTimes(1);
  });

  test.each([false, true])('loads through settings while honoring a checkbox disable: %s', async disable => {
    browser.document.getElementById.mockImplementation(id => {
      if (!browser.nodes.has(id)) browser.nodes.set(id, {
        value: '', checked: false, style: {}, options: [],
        addEventListener: jest.fn(), querySelector: () => null, querySelectorAll: () => [],
        classList: { add() {}, remove() {}, toggle() {} }, setAttribute() {}, removeAttribute() {}
      });
      return browser.nodes.get(id);
    });
    browser.load('backendProfile.js');
    browser.load('codex_ide/settings.js');
    const initialize = browser.document.addEventListener.mock.calls.filter(([name]) => name === 'DOMContentLoaded').at(-1)[1];
    await initialize();
    const node = id => browser.document.getElementById(id);
    node('customChatModelId').value = 'test/model';
    node('llmMaxTokensInput').value = '300';
    let finishLoad;
    browser.window.TransformersPipeline.mockImplementationOnce(() => new Promise(resolve => { finishLoad = resolve; }));
    const load = node('reloadChatModelBtn').addEventListener.mock.calls.find(([name]) => name === 'click')[1];
    const change = node('llmEnabledToggle').addEventListener.mock.calls.find(([name]) => name === 'change')[1];

    const loading = load();
    expect(model.getStatus()).toBe('loading');
    if (disable) {
      node('llmEnabledToggle').checked = false;
      change.call(node('llmEnabledToggle'));
    }
    finishLoad(generator);
    await loading;

    expect(model.getStatus()).toBe('ready');
    expect(model.isEnabled()).toBe(!disable);
    expect(node('llmEnabledToggle').checked).toBe(!disable);
    expect(browser.values.get('codexIdeLLMEnabled')).toBe(disable ? '0' : '1');
    await expect(model.generate('Hallo')).resolves.toBe(disable ? null : 'Hallo Welt.');
    expect(generator).toHaveBeenCalledTimes(disable ? 0 : 1);
  });

  test('shows an error state after a failed load and tolerates blocked browser storage', async () => {
    browser.localStorage.setItem.mockImplementation(() => { throw new Error('storage blocked'); });
    await model.init('test/model');
    expect(model.getStatus()).toBe('ready');
    browser.window.TransformersPipeline.mockRejectedValueOnce(new Error('model unavailable'));
    await model.init('missing/model');
    expect(model.getStatus()).toBe('error');
    await expect(model.generate('Hallo')).resolves.toBeNull();
  });

  test.each(['before generation', 'during generation'])('honors cancellation %s', async phase => {
    await model.init('test/model');
    const controller = new AbortController();
    if (phase === 'before generation') controller.abort();
    const result = model.chatCompletion([{ role: 'user', content: 'Hallo' }], 30, { signal: controller.signal });
    if (phase === 'during generation') controller.abort();
    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
    if (phase === 'before generation') expect(generator).not.toHaveBeenCalled();
  });
});

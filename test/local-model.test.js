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

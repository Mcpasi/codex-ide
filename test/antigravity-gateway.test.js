'use strict';

const fs = require('fs');
const path = require('path');
const { createGatewayServer } = require('../scripts/codex-ide-gateway');
const { createAntigravityHarness } = require('./helpers/antigravity');
const { createFixture } = require('./helpers/fixture');
const { createEditor } = require('./helpers/editor');

describe('Antigravity gateway and visible editor reproductions', () => {
  let fixture, server, base, harness;
  async function start(handler) {
    fixture = createFixture();
    harness = createAntigravityHarness(handler);
    server = createGatewayServer({ modelHome: fixture.home, spawnImpl: harness.spawnImpl,
      antigravityStatus: async () => ({ ok: true, loggedIn: true }),
      antigravityModels: async () => [{ id: 'gemini-test', display_name: 'Gemini Test' }] });
    await new Promise((resolve, reject) => {
      server.once('error', reject); server.listen(0, '127.0.0.1', resolve);
    });
    base = 'http://127.0.0.1:' + server.address().port;
  }
  afterEach(async () => {
    if (server && server.listening) {
      server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    }
    if (fixture) fixture.dispose();
  });
  async function completion(stream = false) {
    return fetch(base + '/antigravity/v1/chat/completions', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        model: 'antigravity-cli', messages: [{ role: 'user', content: 'Pruefe die Dateien' }], stream,
        codexIde: { sessionId: 'integration', editorMode: true, editorWorkspaceMode: true }
      }) });
  }

  test('exposes independent auth, models and reset routes behind the existing origin checks', async () => {
    await start();
    const status = await (await fetch(base + '/antigravity/status')).json();
    expect(status).toMatchObject({ loggedIn: true, policies: { ideWorkspace: { workspacePersistence: 'automatic-model-home', ideSandbox: 'read-only-native-live-editor' } } });
    const models = await (await fetch(base + '/antigravity/v1/models')).json();
    expect(models.data.map(model => model.id)).toEqual(['antigravity-cli', 'gemini-test']);
    const blocked = await fetch(base + '/antigravity/status', { headers: { Origin: 'https://untrusted.test' } });
    expect(blocked.status).toBe(403);
    expect((await (await completion()).json()).choices[0].message.content).toBe('Grüße 👋');
    const reset = await fetch(base + '/antigravity/session/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"sessionId":"integration"}' });
    expect(await reset.json()).toMatchObject({ ok: true, reset: true });
    expect(harness.children[0].kill).toHaveBeenCalled();
  });

  test('inspects files and runs the same disposable verification console with live SSE events', async () => {
    let count = 0;
    await start((_prompt, transport) => {
      const outputs = [
        '<codex_ide_workspace_request>{"operation":"list","path":"","depth":1}</codex_ide_workspace_request>',
        '<codex_ide_workspace_request>{"operation":"read","path":"app.ts","purpose":"inspect"}</codex_ide_workspace_request>',
        '',
        'Geprueft.'
      ];
      outputs[2] = '<codex_ide_workspace_request>' + JSON.stringify({ operation: 'terminal', command: 'node -e "require(\'fs\').writeFileSync(\'app.ts\',\'temporary\');console.log(\'checked 👋\')"' }) + '</codex_ide_workspace_request>';
      const content = outputs[count++];
      transport.token(content); transport.result(content); return true;
    });
    fixture.write('app.ts', 'original');
    const response = await completion(true);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const stream = await response.text();
    expect(stream).toContain('workspace_index');
    expect(stream).toContain('workspace_file');
    expect(stream).toContain('checked 👋');
    expect(stream).toContain('"exit_code":0');
    expect(stream).toContain('Geprueft.');
    expect(stream).not.toContain('codex_ide_workspace_request');
    expect(fixture.read('app.ts')).toBe('original');
    expect(harness.spawnImpl).toHaveBeenCalledTimes(1);
  });

  test('streams CLI output through HTTP into the real editor, saves after painting and edits it next turn', async () => {
    let count = 0;
    const original = 'const n = "👋";\n';
    const updated = 'const n = "OK";\n';
    await start((prompt, transport) => {
      let content;
      if (prompt.message.content.includes('Return JSON matching this schema:')) content = '{"complete":true}';
      else {
        count++;
        content = count === 1 ? '<codex_ide_editor_request>' + JSON.stringify({ operation: 'write', path: 'src/new.ts', content: original }) + '</codex_ide_editor_request>'
          : count === 3 ? '<codex_ide_editor_request>' + JSON.stringify({ operation: 'edit', path: 'src/new.ts', oldText: '👋', newText: 'OK' }) + '</codex_ide_editor_request>'
          : '<codex_ide_final>Gespeichert.</codex_ide_final>';
      }
      for (let offset = 0; offset < content.length; offset += 16) transport.token(content.slice(offset, offset + 16));
      transport.result(content); return true;
    });
    const editor = createEditor(); editor.browser.load('backendProfile.js');
    const backend = editor.browser.window.codexIdeProfile;
    backend.set('antigravity'); backend.setCliConfig(base, '');
    editor.browser.context.fetch.mockImplementation((...params) => fetch(...params));
    const persist = backend.writeModelHomeWorkspaceFile;
    const saves = jest.spyOn(backend, 'writeModelHomeWorkspaceFile').mockImplementation(async (file, content, options) => {
      expect(editor.node('ideEditor').value).toBe(content);
      expect(editor.node('ideHighlightCode').textContent).toBe(content);
      if (content === original) expect(fs.existsSync(path.join(fixture.home, file))).toBe(false);
      else expect(fixture.read(file)).toBe(original);
      return persist(file, content, options);
    });
    let turn = 1;
    const options = { sessionId: 'editor', editorWriteMode: true, editorWorkspaceMode: true,
      onEditorDraft: request => editor.applyModelEditorDraft(request, turn),
      onEditorWrite: (request, settings) => editor.applyModelEditorWrite(request, turn, settings) };
    await expect(backend.apiGenerateReply('Erstelle die Datei', options)).resolves.toContain('Gespeichert.');
    expect(fixture.read('src/new.ts')).toBe(original);
    editor.state.turnId = ++turn;
    await expect(backend.apiGenerateReply('Ersetze das Emoji durch OK', { ...options,
      conversationHistory: [{ user: 'Erstelle die Datei', reply: 'Gespeichert.' }] })).resolves.toContain('Gespeichert.');
    expect(fixture.read('src/new.ts')).toBe(updated);
    expect(editor.state.dirty).toBe(false);
    expect(saves).toHaveBeenCalledTimes(2);
    expect(harness.spawnImpl).toHaveBeenCalledTimes(1);
  }, 15000);
});

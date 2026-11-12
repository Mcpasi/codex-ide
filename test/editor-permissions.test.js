'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createFixture } = require('./helpers/fixture');
const { createEditor } = require('./helpers/editor');

// Unix permission bits reproduce the npm installation failure without mocking fs.
const permissionTest = process.platform !== 'win32' && process.getuid() !== 0 ? test : test.skip;

describe.each(['codex', 'antigravity'])('%s editor persistence from a read-only npm installation', provider => {
  let fixture;
  let packageRoot;
  let legacyHome;
  let userHome;
  let bridge;
  let server;
  let baseUrl;

  beforeEach(async () => {
    fixture = createFixture();
    packageRoot = path.join(fixture.root, 'lib/node_modules/codex-ide');
    legacyHome = path.join(packageRoot, 'model-home');
    const userDirectory = path.join(fixture.root, 'user');
    const dataDirectory = process.platform === 'darwin'
      ? path.join(userDirectory, 'Library', 'Application Support')
      : path.join(fixture.root, 'data');
    userHome = path.join(dataDirectory, 'codex-ide/model-home');
    jest.spyOn(os, 'homedir').mockReturnValue(userDirectory);
    fs.cpSync(path.resolve(__dirname, '../scripts'), path.join(packageRoot, 'scripts'), { recursive: true });
    fixture.write('index.html', '<h1>Alt</h1>\n', legacyHome);
    fixture.write('src/app.js', 'original();\n', legacyHome);
    fixture.write('assets/data.bin', Buffer.from([0, 255, 128]), legacyHome);
    const directoryLinkType = process.platform === 'win32' ? 'junction' : 'dir';
    fs.symlinkSync(process.platform === 'win32' ? path.join(legacyHome, 'src') : 'src', path.join(legacyHome, 'linked-src'), directoryLinkType);
    fs.symlinkSync(path.join(legacyHome, 'src'), path.join(legacyHome, 'absolute-src'), directoryLinkType);
    const outside = fixture.write('outside/secret.js', 'private', fixture.root);
    fs.symlinkSync(path.dirname(outside), path.join(legacyHome, 'outside'), directoryLinkType);
    fs.chmodSync(path.join(legacyHome, 'index.html'), 0o444);
    fs.chmodSync(path.join(legacyHome, 'src/app.js'), 0o444);
    fs.chmodSync(path.join(legacyHome, 'src'), 0o555);
    fs.chmodSync(legacyHome, 0o555);
    fs.chmodSync(packageRoot, 0o555);

    const env = { ...process.env, XDG_DATA_HOME: dataDirectory, LOCALAPPDATA: dataDirectory };
    delete env.CODEX_IDE_MODEL_HOME;
    delete env.CODEX_BRIDGE_MODEL_HOME;
    delete env.CODEX_BRIDGE_WORKDIR;
    jest.replaceProperty(process, 'env', env);
    // Load the actual runtime at its installed path, with no modelHome override.
    bridge = require(path.join(packageRoot, 'scripts/codex-bridge'));
  });

  afterEach(async () => {
    if (server && server.listening) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    server = null;
    jest.restoreAllMocks();
    // Restore permissions only on our disposable fixture so cleanup can remove it.
    fs.chmodSync(packageRoot, 0o755);
    if (fs.existsSync(legacyHome)) fs.chmodSync(legacyHome, 0o755);
    if (fs.existsSync(path.join(legacyHome, 'src'))) fs.chmodSync(path.join(legacyHome, 'src'), 0o755);
    fixture.dispose();
  });

  async function startServer() {
    const { createGatewayServer } = require(path.join(packageRoot, 'scripts/codex-ide-gateway'));
    server = createGatewayServer();
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  }

  function connectEditor() {
    const editor = createEditor();
    editor.browser.load('backendProfile.js');
    editor.browser.window.codexIdeProfile.set(provider);
    editor.browser.window.codexIdeProfile.setCliConfig(baseUrl);
    editor.browser.context.fetch.mockImplementation((...args) => fetch(...args));
    return editor;
  }

  permissionTest('reproduces EACCES and saves both new and existing files outside the installation', () => {
    expect(() => fs.writeFileSync(path.join(legacyHome, 'index.html'), 'blocked')).toThrow(/EACCES/);
    expect(() => fs.writeFileSync(path.join(legacyHome, 'new.html'), 'blocked')).toThrow(/EACCES/);

    const home = bridge.getModelHomeDir();
    bridge.writeIdeEditorFile(home, 'index.html', '<h1>Neu</h1>\n', { operation: 'edit' });
    bridge.writeIdeEditorFile(home, 'new.html', '<p>Neu</p>\n', { operation: 'write' });

    expect(home).toBe(userHome);
    expect(fs.readFileSync(path.join(home, 'index.html'), 'utf8')).toBe('<h1>Neu</h1>\n');
    expect(fs.readFileSync(path.join(home, 'new.html'), 'utf8')).toBe('<p>Neu</p>\n');
    expect(fs.readFileSync(path.join(legacyHome, 'index.html'), 'utf8')).toBe('<h1>Alt</h1>\n');
    expect(fs.existsSync(path.join(legacyHome, 'new.html'))).toBe(false);
  });

  test('migrates existing files and internal symlinks once, keeping later user edits across restarts', () => {
    expect(bridge.getModelHomeDir()).toBe(userHome);
    expect(fs.readFileSync(path.join(userHome, 'assets/data.bin'))).toEqual(Buffer.from([0, 255, 128]));
    for (const file of ['linked-src/app.js', 'absolute-src/app.js']) {
      expect(bridge.readIdeEditorFile(userHome, file).content).toBe('original();\n');
    }
    bridge.writeIdeEditorFile(userHome, 'linked-src/app.js', 'updated();\n', { operation: 'edit' });
    expect(bridge.readIdeEditorFile(userHome, 'absolute-src/app.js').content).toBe('updated();\n');
    expect(() => bridge.writeIdeEditorFile(userHome, 'outside/secret.js', 'escape')).toThrow(/Symlink/);
    expect(fs.readFileSync(path.join(fixture.root, 'outside/secret.js'), 'utf8')).toBe('private');
    jest.isolateModules(() => {
      const restartedBridge = require(path.join(packageRoot, 'scripts/codex-bridge'));
      expect(restartedBridge.getModelHomeDir()).toBe(userHome);
    });
    expect(fs.readFileSync(path.join(userHome, 'src/app.js'), 'utf8')).toBe('updated();\n');
    expect(fs.readFileSync(path.join(legacyHome, 'src/app.js'), 'utf8')).toBe('original();\n');
  });

  (process.platform !== 'win32' ? test : test.skip)('preserves file symlinks, missing internal targets and cycles during migration', () => {
    fs.chmodSync(legacyHome, 0o755);
    fs.symlinkSync('src/app.js', path.join(legacyHome, 'entry.js'));
    fs.symlinkSync(path.join(legacyHome, 'src/app.js'), path.join(legacyHome, 'absolute.js'));
    fs.symlinkSync('generated/new.txt', path.join(legacyHome, 'pending.txt'));
    fs.symlinkSync('loop', path.join(legacyHome, 'loop'));
    fs.chmodSync(legacyHome, 0o555);

    expect(bridge.getModelHomeDir()).toBe(userHome);
    bridge.writeIdeEditorFile(userHome, 'entry.js', 'updated();\n');
    expect(bridge.readIdeEditorFile(userHome, 'absolute.js').content).toBe('updated();\n');
    bridge.writeIdeEditorFile(userHome, 'pending.txt', 'new');
    expect(fs.readFileSync(path.join(userHome, 'generated/new.txt'), 'utf8')).toBe('new');
    expect(fs.readlinkSync(path.join(userHome, 'loop'))).toBe('loop');
    expect(fs.existsSync(path.join(legacyHome, 'generated/new.txt'))).toBe(false);
    expect(fs.readFileSync(path.join(legacyHome, 'src/app.js'), 'utf8')).toBe('original();\n');
  });

  test('preserves an already initialized user workspace without importing stale package data again', () => {
    fixture.write('index.html', 'latest user changes', userHome);
    expect(bridge.getModelHomeDir()).toBe(userHome);
    expect(fs.readFileSync(path.join(userHome, 'index.html'), 'utf8')).toBe('latest user changes');
    expect(fs.existsSync(path.join(userHome, 'src/app.js'))).toBe(false);
  });

  test('leaves no partial workspace after a failed migration and retries from the intact source', () => {
    const actualCopy = fs.cpSync.bind(fs);
    const copy = jest.spyOn(fs, 'cpSync').mockImplementation((...args) => {
      actualCopy(...args);
      throw new Error('copy failed');
    });
    expect(() => bridge.getModelHomeDir()).toThrow('copy failed');
    expect(fs.existsSync(userHome)).toBe(false);
    expect(fs.readdirSync(path.dirname(userHome))).toEqual([]);
    expect(fs.readFileSync(path.join(legacyHome, 'index.html'), 'utf8')).toBe('<h1>Alt</h1>\n');
    copy.mockRestore();
    expect(bridge.getModelHomeDir()).toBe(userHome);
    expect(fs.readFileSync(path.join(userHome, 'index.html'), 'utf8')).toBe('<h1>Alt</h1>\n');
  });

  test('initializes a writable user workspace when the package has no legacy directory', () => {
    fs.chmodSync(packageRoot, 0o755);
    fs.chmodSync(legacyHome, 0o755);
    fs.chmodSync(path.join(legacyHome, 'src'), 0o755);
    fs.rmSync(legacyHome, { recursive: true });
    fs.chmodSync(packageRoot, 0o555);
    expect(bridge.getModelHomeDir()).toBe(userHome);
    bridge.writeIdeEditorFile(userHome, 'new.html', 'new file');
    expect(fs.readFileSync(path.join(userHome, 'new.html'), 'utf8')).toBe('new file');
  });

  test('keeps source checkouts and explicitly configured model homes at their existing paths', () => {
    const custom = path.join(fixture.root, 'custom');
    const localBridge = require('../scripts/codex-bridge');
    expect(localBridge.getModelHomeDir()).toBe(path.resolve(__dirname, '../model-home'));
    expect(bridge.getModelHomeDir({ modelHome: custom, workdir: fixture.home })).toBe(custom);
    expect(bridge.getModelHomeDir({ workdir: custom })).toBe(custom);
    for (const name of ['CODEX_BRIDGE_WORKDIR', 'CODEX_BRIDGE_MODEL_HOME', 'CODEX_IDE_MODEL_HOME']) {
      process.env[name] = custom;
      expect(bridge.getModelHomeDir()).toBe(custom);
      delete process.env[name];
    }
    expect(fs.existsSync(userHome)).toBe(false);
  });

  (process.platform === 'linux' ? test : test.skip)('uses the user home when XDG_DATA_HOME is missing or relative', () => {
    const fallback = path.join(fixture.root, 'user/.local/share/codex-ide/model-home');
    delete process.env.XDG_DATA_HOME;
    expect(bridge.getModelHomeDir()).toBe(fallback);
    process.env.XDG_DATA_HOME = 'relative-data';
    expect(bridge.getModelHomeDir()).toBe(fallback);
    expect(fs.readFileSync(path.join(fallback, 'index.html'), 'utf8')).toBe('<h1>Alt</h1>\n');
  });

  test('saves manual editor input through the real HTTP endpoint', async () => {
    await startServer();
    const editor = connectEditor();
    editor.setBusy(false);
    editor.activateBuffer('index.html', '<h1>Alt</h1>\n', '<h1>Alt</h1>\n', false);
    editor.node('ideEditor').value = '<h1>Nutzer 👋</h1>\n';
    editor.node('ideEditor').dispatchEvent({ type: 'input' });

    await editor.saveFile();

    expect(editor.state.dirty).toBe(false);
    expect(editor.node('ideEditorStatus').textContent).toContain('Gespeichert');
    expect(fs.readFileSync(path.join(userHome, 'index.html'), 'utf8')).toBe('<h1>Nutzer 👋</h1>\n');
    expect((await (await fetch(baseUrl + '/health')).json()).modelHome).toBe(userHome);
  });

  test.each(['write', 'edit'])('animates a Codex %s visibly before the real HTTP save', async operation => {
    await startServer();
    const editor = connectEditor();
    const file = operation === 'edit' ? 'index.html' : 'new.html';
    const expected = '<h1>Codex 👋</h1>\n';
    if (operation === 'edit') editor.activateBuffer(file, '<h1>Alt</h1>\n', '<h1>Alt</h1>\n', false);
    const frames = [];
    const textarea = editor.node('ideEditor');
    const update = textarea.setRangeText.getMockImplementation();
    textarea.setRangeText.mockImplementation(function (...args) {
      update.apply(this, args);
      frames.push(this.value);
    });
    editor.browser.context.fetch.mockImplementation((url, request) => {
      if (request.method === 'POST') {
        expect(textarea.value).toBe(expected);
        expect(editor.node('ideHighlightCode').textContent).toBe(expected);
        expect(frames.length).toBeGreaterThan(2);
        if (operation === 'edit') expect(fs.readFileSync(path.join(userHome, file), 'utf8')).toBe('<h1>Alt</h1>\n');
        else expect(fs.existsSync(path.join(userHome, file))).toBe(false);
      }
      return fetch(url, request);
    });

    const request = operation === 'edit'
      ? { operation, path: file, oldText: 'Alt', newText: 'Codex 👋' }
      : { operation, path: file, content: expected };
    await expect(editor.applyModelEditorWrite(request, 1, { persist: true, editorWorkspaceMode: true }))
      .resolves.toMatchObject({ ok: true, saved: true });

    expect(editor.state.dirty).toBe(false);
    expect(fs.readFileSync(path.join(userHome, file), 'utf8')).toBe(expected);
    expect(fs.readFileSync(path.join(legacyHome, 'index.html'), 'utf8')).toBe('<h1>Alt</h1>\n');
  });
});

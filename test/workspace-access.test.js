'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const bridge = require('../scripts/codex-bridge');
const { createFixture } = require('./helpers/fixture');
const { MODEL_HOME_PERMISSION_PROFILE, modelHomeConfigArgs } = require('../scripts/codex-workspace-policy');

let fixture;
beforeEach(() => { fixture = createFixture(); });
afterEach(() => { jest.restoreAllMocks(); fixture.dispose(); });

function workspace(args, callbacks) {
  return JSON.parse(bridge.handleWorkspaceToolCall(fixture.home, {
    tool: 'codex_ide_workspace', arguments: args
  }, callbacks).text);
}

describe('complete model-home access', () => {
  test.each([
    'package.json', 'src/main.ts', 'src/component.tsx', 'Cargo.toml', 'config.yaml',
    'Makefile', '.env', '.env.local', '.git/config', '.codex/config.toml',
    '.agents/skills/local/SKILL.md', '.aws/config', 'node_modules/lib/index.cjs',
    'memory.md', '..notes.txt'
  ])('reads, writes, lists and edits %s without a skill grant', file => {
    expect(bridge.writeIdeEditorFile(fixture.home, file, 'initial 👋')).toMatchObject({ path: file });
    expect(workspace({ operation: 'read', path: file }).file.content).toBe('initial 👋');
    expect(bridge.listScopedWorkspaceEntries(fixture.home, '', 10).files.map(entry => entry.path)).toContain(file);
    bridge.writeIdeEditorFile(fixture.home, file, 'updated', { operation: 'edit' });
    expect(bridge.readIdeEditorFile(fixture.home, file).content).toBe('updated');
  });

  test('normalizes absolute and relative paths that stay inside the home', () => {
    const absolute = path.join(fixture.home, 'src/main.ts');
    bridge.writeIdeEditorFile(fixture.home, absolute, 'inside');
    expect(workspace({ operation: 'read', path: 'src/../src/./main.ts' }).file)
      .toMatchObject({ path: 'src/main.ts', content: 'inside' });
    expect(workspace({ operation: 'list', path: fixture.home }).scope).toBe('');
  });

  test('inspects binary files without opening a text editor tab', () => {
    const bytes = Buffer.from([0, 255, 1, 128, 17]);
    fixture.write('assets/image.bin', bytes);
    const onRead = jest.fn();
    const { file } = workspace({ operation: 'read', path: 'assets/image.bin', encoding: 'base64', purpose: 'edit' }, { onRead });
    expect(file).toMatchObject({ encoding: 'base64', content: bytes.toString('base64'), bytes: bytes.length, openInEditor: false, purpose: 'inspect' });
    expect(fs.readFileSync(path.join(fixture.home, file.path))).toEqual(bytes);
    expect(onRead).toHaveBeenCalledWith(expect.objectContaining({ openInEditor: false }));
  });

  test.each(['write', 'edit', 'apply_patch', 'mkdir', 'move', 'remove', 'delete'])('routes %s through the live editor instead of mutating the workspace tool target', operation => {
    fixture.write('src/main.ts', 'original');
    expect(() => workspace({ operation, path: 'src/main.ts', destination: 'moved.ts', content: 'hidden edit' }))
      .toThrow(/Live-Editor/);
    expect(fixture.read('src/main.ts')).toBe('original');
    expect(fs.existsSync(path.join(fixture.home, 'moved.ts'))).toBe(false);
  });

  test('follows internal symlinks, including not-yet-created targets, without recursive cycles', () => {
    fixture.write('src/main.ts', 'linked');
    fs.symlinkSync('src', path.join(fixture.home, 'linked'));
    fs.symlinkSync('..', path.join(fixture.home, 'src/loop'));
    fs.symlinkSync('generated/output.txt', path.join(fixture.home, 'pending.txt'));
    expect(workspace({ operation: 'list', path: 'linked', depth: 20 }).files.map(file => file.path)).toEqual(['linked/main.ts']);
    bridge.writeIdeEditorFile(fixture.home, 'linked/main.ts', 'changed');
    bridge.writeIdeEditorFile(fixture.home, 'pending.txt', 'created');
    expect(fixture.read('src/main.ts')).toBe('changed');
    expect(fixture.read('generated/output.txt')).toBe('created');
  });

  test('an invalid self-link does not hide valid workspace entries', () => {
    fixture.write('main.ts', 'visible');
    fs.symlinkSync('self', path.join(fixture.home, 'self'));
    expect(workspace({ operation: 'list', depth: 5 }).files.map(file => file.path)).toEqual(['main.ts']);
  });

  test('does not hide files beyond the former depth and entry limits', () => {
    const deepPath = Array.from({ length: 12 }, (_, index) => `level${index}`).join('/') + '/main.ts';
    fixture.write(deepPath, 'deep');
    for (let index = 0; index < 1005; index += 1) fixture.write(`entries/file-${index}.ts`, 'entry');
    const files = bridge.listScopedWorkspaceEntries(fixture.home, '', 20).files;
    expect(files).toHaveLength(1006);
    expect(files.map(file => file.path)).toContain(deepPath);
    expect(bridge.listModelHomeFiles(fixture.home, { includeAll: true })).toHaveLength(1006);
  });

  test('surfaces real directory permission errors instead of hiding a subtree', () => {
    fixture.write('src/main.ts', 'source');
    const readdir = fs.readdirSync;
    jest.spyOn(fs, 'readdirSync').mockImplementation((directory, ...args) => {
      if (directory === path.join(fixture.home, 'src')) throw Object.assign(new Error('directory access denied'), { code: 'EACCES' });
      return readdir(directory, ...args);
    });
    expect(() => workspace({ operation: 'list', path: 'src' })).toThrow('directory access denied');
  });

  test.each(['read', 'write', 'mkdir', 'remove', 'move'])('keeps %s inside the model-home boundary', operation => {
    fixture.write('outside.txt', 'untouched', fixture.root);
    expect(() => workspace({ operation, path: '../outside.txt', destination: 'moved.txt', content: 'escape' })).toThrow();
    expect(fixture.read('outside.txt', fixture.root)).toBe('untouched');
  });

  test('does not follow an escaping symlink through reads or editor persistence', () => {
    fixture.write('outside.txt', 'untouched', fixture.root);
    fs.symlinkSync('../outside.txt', path.join(fixture.home, 'external.txt'));
    expect(() => workspace({ operation: 'read', path: 'external.txt' })).toThrow(/Symlink/);
    expect(() => bridge.writeIdeEditorFile(fixture.home, 'external.txt', 'escape')).toThrow(/Symlink/);
    expect(fixture.read('outside.txt', fixture.root)).toBe('untouched');
  });

  test('allows names starting with two dots without granting parent access', () => {
    bridge.writeIdeEditorFile(fixture.home, '..config/value.ts', 'inside');
    expect(bridge.readIdeEditorFile(fixture.home, '..config/value.ts').content).toBe('inside');
  });

  test('optional memory failures leave the model turn available to repair the workspace', async () => {
    fs.mkdirSync(path.join(fixture.home, 'memory.md'));
    const runCodex = jest.fn().mockResolvedValue('ready');
    await expect(bridge.runCodexCompletion({ messages: [{ role: 'user', content: 'Repair the workspace' }], codexIde: { editorMode: true } }, {
      modelHome: fixture.home, workdir: fixture.root, runCodex
    })).resolves.toMatchObject({ content: 'ready' });
    expect(runCodex).toHaveBeenCalledWith(expect.objectContaining({ workdir: fixture.home, readOnly: true, timeoutMs: 0 }));
    expect(runCodex.mock.calls[0][0].prompt).toContain('memory.md');
  });

  test('workspace memory requests do not silently persist before the live editor runs', () => {
    fixture.write('memory.md', 'existing memory');
    const context = bridge.prepareModelHomeContext([{ role: 'user', content: 'Merke dir: neue Information' }], {
      modelHome: fixture.home, editorWorkspaceMode: true
    });
    expect(context.memoryUpdated).toBe(false);
    expect(fixture.read('memory.md')).toBe('existing memory');
  });

  test('keeps native tools read-only while the live editor owns project persistence', () => {
    expect(MODEL_HOME_PERMISSION_PROFILE.filesystem).toEqual({
      ':root': 'read', ':workspace_roots': { '.': 'read' }, ':tmpdir': 'write', ':slash_tmp': 'write'
    });
    expect(modelHomeConfigArgs()).not.toContain('--sandbox');
    expect(modelHomeConfigArgs().join(' ')).not.toMatch(/read-only|danger-full-access/);
  });
});

describe('verification console without project writes', () => {
  test('the legacy exec path also keeps native project writes read-only', async () => {
    const executable = fixture.write('fake-codex.cjs', `#!/usr/bin/env node
      let input = '';
      process.stdin.on('data', chunk => { input += chunk; });
      process.stdin.on('end', () => console.log(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), input })));
    `);
    fs.chmodSync(executable, 0o700);
    const result = JSON.parse(await bridge.runCodexExec({ codexBin: executable, workdir: fixture.home,
      prompt: 'Check the workspace', readOnly: true, disableWebSearch: true }));
    expect(result).toMatchObject({ cwd: fixture.home, input: 'Check the workspace' });
    expect(result.args).toContain('default_permissions="codex-ide-live-editor"');
    expect(result.args[result.args.indexOf('--sandbox') + 1]).toBe('read-only');
  });

  test('allows build output and temporary writes in the copy without changing the real project', async () => {
    fixture.write('verify.cjs', `
      const fs = require('fs');
      fs.mkdirSync('.git', { recursive: true });
      fs.writeFileSync('.git/config', 'configuration');
      fs.mkdirSync('dist', { recursive: true });
      fs.writeFileSync('dist/output', 'built output');
      fs.chmodSync('dist/output', 0o700);
      fs.truncateSync('dist/output', 5);
      fs.symlinkSync('dist/output', 'result');
      process.stdout.write('Grüße 👋');
    `);
    const onTerminalOutput = jest.fn();
    const result = await bridge.runModelWorkspaceTerminal('node verify.cjs', { workdir: fixture.home, runtime: null, onTerminalOutput });
    expect(result).toMatchObject({ success: true, item: { exitCode: 0, status: 'completed', cwd: fixture.home } });
    expect(fs.existsSync(path.join(fixture.home, '.git'))).toBe(false);
    expect(fs.existsSync(path.join(fixture.home, 'dist'))).toBe(false);
    expect(fs.existsSync(path.join(fixture.home, 'result'))).toBe(false);
    expect(onTerminalOutput.mock.calls.map(([delta]) => delta).join('')).toBe('Grüße 👋');
  });

  test('streams complete output without a byte cap', async () => {
    fixture.write('output.cjs', "process.stdout.write('a'.repeat(200000) + '👋');");
    const result = await bridge.runModelWorkspaceTerminal('node output.cjs', { workdir: fixture.home });
    expect(result.item.aggregatedOutput).toBe('a'.repeat(200000) + '👋');
  });

  test('rebases absolute internal symlinks to the copy before verification writes', async () => {
    fixture.write('src/main.ts', 'original');
    fs.symlinkSync(path.join(fixture.home, 'src'), path.join(fixture.home, 'linked'));
    fixture.write('verify.cjs', "require('fs').writeFileSync('linked/main.ts', 'copy only'); process.stdout.write(require('fs').readFileSync('linked/main.ts', 'utf8'));");
    const result = await bridge.runModelWorkspaceTerminal('node verify.cjs', { workdir: fixture.home });
    expect(result.success).toBe(true);
    expect(result.item.aggregatedOutput).toBe('copy only');
    expect(fixture.read('src/main.ts')).toBe('original');
  });

  test('does not classify a spawn error or signal termination as success', async () => {
    const result = await bridge.runModelWorkspaceTerminal('anything', {
      workdir: fixture.home,
      spawnImpl: () => {
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        setImmediate(() => child.emit('error', new Error('shell unavailable')));
        return child;
      }
    });
    expect(result).toMatchObject({ success: false, item: { exitCode: null, status: 'failed' } });
  });

  test('an explicit user stop ends the process without copying pending writes to the project', async () => {
    fixture.write('wait.cjs', "require('fs').writeFileSync('saved.txt', 'saved'); process.stdout.write('ready'); setInterval(() => {}, 1000);");
    const controller = new AbortController();
    const result = await bridge.runModelWorkspaceTerminal('node wait.cjs', {
      workdir: fixture.home, signal: controller.signal,
      onTerminalOutput: delta => { if (delta.includes('ready')) controller.abort(); }
    });
    expect(result).toMatchObject({ success: false, item: { status: 'declined', exitCode: null } });
    expect(fs.existsSync(path.join(fixture.home, 'saved.txt'))).toBe(false);
  });

  test.each([true, false])('exposes local tools independently of web-search mode: disabled=%s', async disableWebSearch => {
    const appServerClient = { runTurn: jest.fn(async options => {
      expect(options.terminalAccess).toBe(true);
      expect(options.workspaceAccess).toBe(true);
      expect(options.readOnly).toBe(true);
      await options.onTerminalToolCall({ tool: 'codex_ide_terminal', arguments: '{"command":"node --version"}' });
      return { content: 'done' };
    }) };
    const terminalRunner = jest.fn().mockResolvedValue({ success: true });
    await bridge.runCodexAppServer({ prompt: 'check', workdir: fixture.home, disableWebSearch,
      terminalRuntime: false, readOnly: true, appServerClient, terminalRunner });
    expect(terminalRunner).toHaveBeenCalledWith('node --version', expect.objectContaining({ workdir: fixture.home }));
  });

  test('retains call identity and paths for actual workspace tool success and failure', async () => {
    fixture.write('src/main.ts', 'content');
    const onWorkspaceReadStart = jest.fn();
    const onWorkspaceRead = jest.fn();
    const onWorkspaceReadError = jest.fn();
    const scope = { callId: 'read-a', threadId: 'thread', turnId: 'turn', tool: 'codex_ide_workspace' };
    const appServerClient = { runTurn: jest.fn(async options => {
      await options.onWorkspaceToolCall({ ...scope, arguments: JSON.stringify({ operation: 'read', path: 'src/main.ts' }) });
      expect(() => options.onWorkspaceToolCall({ ...scope, callId: 'read-b',
        arguments: JSON.stringify({ operation: 'read', path: 'missing.ts' }) })).toThrow();
      return { content: 'done' };
    }) };
    await bridge.runCodexAppServer({ prompt: 'read', workdir: fixture.home, appServerClient,
      onWorkspaceReadStart, onWorkspaceRead, onWorkspaceReadError });
    expect(onWorkspaceReadStart.mock.calls[0][0]).toMatchObject({ itemId: 'read-a', threadId: 'thread', turnId: 'turn', path: 'src/main.ts' });
    expect(onWorkspaceRead).toHaveBeenCalledWith(expect.objectContaining({ content: 'content' }),
      expect.objectContaining({ itemId: 'read-a', path: 'src/main.ts' }));
    expect(onWorkspaceReadError).toHaveBeenCalledWith(expect.objectContaining({ itemId: 'read-b', path: 'missing.ts', error: expect.any(String) }));
  });

  test('exposes no direct project mutation tool in model turns', async () => {
    fixture.write('src/main.ts', 'before');
    const appServerClient = { runTurn: jest.fn(async options => {
      expect(options.readOnly).toBe(true);
      expect(() => options.onWorkspaceToolCall({ tool: 'codex_ide_workspace',
        arguments: { operation: 'write', path: 'src/main.ts', content: 'hidden edit' } })).toThrow(/Live-Editor/);
      expect(fixture.read('src/main.ts')).toBe('before');
      return { content: 'use the editor' };
    }) };
    await bridge.runCodexAppServer({ prompt: 'change', workdir: fixture.home, appServerClient });
  });

  test('uses the App Server sandbox for the production model console', async () => {
    fixture.write('main.ts', 'original');
    const appServerClient = {
      runVerificationCommand: jest.fn(async (_command, execution) => {
        expect(execution.cwd).not.toBe(fixture.home);
        expect(execution.cwd).toBe(path.join(execution.temporaryRoot, 'model-home'));
        fs.writeFileSync(path.join(execution.cwd, 'main.ts'), 'copy');
        execution.onOutput('verified');
        return { code: 0 };
      }),
      runTurn: jest.fn(async options => {
        const result = await options.onTerminalToolCall({ tool: 'codex_ide_terminal', arguments: { command: 'npm test' } });
        expect(result.success).toBe(true);
        return { content: 'done' };
      })
    };
    await bridge.runCodexAppServer({ prompt: 'verify', workdir: fixture.home, appServerClient });
    expect(appServerClient.runVerificationCommand).toHaveBeenCalledTimes(1);
    expect(fixture.read('main.ts')).toBe('original');
  });
});

'use strict';

const { EventEmitter } = require('events');
const { performance } = require('perf_hooks');
const path = require('path');
const { AntigravityClient, createRunner, getStatus, getModels } = require('../scripts/backends/antigravity');
const { createAntigravityHarness } = require('./helpers/antigravity');
const cli = require('../scripts/codex-ide');

const args = { sessionId: 'chat', workdir: __dirname, prompt: 'full task', followupPrompt: 'next task' };

describe('Antigravity CLI transport', () => {
  let harness, client;
  function setup(handler) {
    harness = createAntigravityHarness(handler);
    client = new AntigravityClient({ spawnImpl: harness.spawnImpl, antigravityBin: 'test-agy' });
  }
  afterEach(() => { if (client) client.close(); });

  test('reuses one process across turns and streams each response exactly once', async () => {
    setup();
    for (let i = 0; i < 10; i++) {
      const tokens = [];
      await expect(client.run({ ...args, onToken: text => tokens.push(text) })).resolves.toMatchObject({ content: 'Grüße 👋', engine: 'antigravity-cli' });
      expect(tokens.join('')).toBe('Grüße 👋');
    }
    expect(harness.spawnImpl).toHaveBeenCalledTimes(1);
    expect(harness.prompts[0].message.content).toBe('full task');
    expect(harness.prompts[9].message.content).toBe('next task');
    const [bin, argv, options] = harness.spawnImpl.mock.calls[0];
    expect(bin).toBe('test-agy');
    expect(argv).toEqual(expect.arrayContaining(['--input-format', 'stream-json', '--output-format', '--disable-slash-commands']));
    expect(argv).not.toContain('--dangerously-skip-permissions');
    const settings = JSON.parse(argv[argv.indexOf('--settings') + 1]);
    expect(settings.permissions.allow).toContain('read_file(' + path.resolve(__dirname) + ')');
    expect(settings.permissions.deny).toEqual(expect.arrayContaining(['write_file(*)', 'command(*)', 'mcp(*)', 'read_url(*)']));
    expect(options.cwd).toBe(__dirname);
  });

  test('delivers a token before the result without waiting for process exit', async () => {
    let release, receive;
    const received = new Promise(resolve => { receive = resolve; });
    setup((_prompt, transport) => {
      transport.token('Grüße 👋', true);
      release = () => transport.result('Grüße 👋');
      return true;
    });
    let finished = false;
    const pending = client.run({ ...args, onToken: receive }).then(value => { finished = true; return value; });
    expect(await received).toBe('Grüße 👋');
    expect(finished).toBe(false);
    release();
    await pending;
    expect(harness.children[0].kill).not.toHaveBeenCalled();
  });

  test('serializes one session while allowing another session to progress', async () => {
    let release;
    setup((prompt, transport) => {
      if (prompt.message.content !== 'held') return false;
      release = () => transport.result('first'); return true;
    });
    const first = client.run({ ...args, prompt: 'held' });
    await harness.waitForPrompt();
    await new Promise(resolve => setImmediate(resolve));
    const second = client.run(args);
    await expect(client.run({ ...args, sessionId: 'independent' })).resolves.toMatchObject({ content: 'Grüße 👋' });
    expect(harness.prompts).toHaveLength(2);
    release(); await first; await second;
    expect(harness.prompts).toHaveLength(3);
  });

  test('a queued abort leaves the active turn intact; active abort starts fresh next time', async () => {
    let release;
    setup((_prompt, transport) => { release = () => transport.result('first'); return true; });
    const first = client.run(args);
    await harness.waitForPrompt(); await new Promise(resolve => setImmediate(resolve));
    const queuedController = new AbortController();
    const queued = client.run({ ...args, signal: queuedController.signal });
    const rejected = expect(queued).rejects.toMatchObject({ name: 'AbortError' });
    queuedController.abort(); release(); await first; await rejected;
    expect(harness.children[0].kill).not.toHaveBeenCalled();
    const controller = new AbortController();
    const active = client.run({ ...args, signal: controller.signal });
    const aborted = expect(active).rejects.toMatchObject({ name: 'AbortError' });
    await harness.waitForPrompt(2); controller.abort(); await aborted;
    const next = client.run({ ...args, threadId: 'stale-thread' });
    await harness.waitForPrompt(3); await new Promise(resolve => setImmediate(resolve)); release(); await next;
    expect(harness.spawnImpl.mock.calls[1][1]).not.toContain('--conversation');
    expect(harness.prompts[2].message.content).toBe('full task');
  });

  test('reset ignores an old browser conversation and model changes resume only their own session', async () => {
    setup();
    await client.run({ ...args, model: 'gemini-model', reasoningEffort: 'max' });
    await client.run({ ...args, model: 'other-model', reasoningEffort: 'high' });
    expect(harness.spawnImpl.mock.calls[1][1]).toEqual(expect.arrayContaining(['--model', 'other-model', '--effort', 'high', '--conversation', 'agy-conversation-1']));
    await client.run({ ...args, resetSession: true, threadId: 'old-browser-thread' });
    expect(harness.spawnImpl.mock.calls[2][1]).not.toContain('--conversation');
    expect(harness.prompts[2].message.content).toBe('full task');
  });

  test('terminates the CLI after a stdin pipe error before recovering in a fresh process', async () => {
    const error = Object.assign(new Error('broken input pipe'), { code: 'EPIPE' });
    setup((_prompt, transport) => {
      if (transport.child !== harness.children[0]) return false;
      transport.child.stdin.emit('error', error);
      return true;
    });

    await expect(client.run(args)).rejects.toBe(error);
    expect(harness.children[0].kill).toHaveBeenCalledWith('SIGTERM');
    await expect(client.run({ ...args, threadId: 'stale-thread' })).resolves.toMatchObject({ content: 'Grüße 👋' });
    expect(harness.spawnImpl).toHaveBeenCalledTimes(2);
    expect(harness.spawnImpl.mock.calls[1][1]).not.toContain('--conversation');
    expect(harness.prompts[1].message.content).toBe('full task');
  });

  test('replays workspace results with the full task when the CLI crashes during a workspace read', async () => {
    const request = '<codex_ide_workspace_request>{"operation":"read","path":"src/a.js","purpose":"inspect"}</codex_ide_workspace_request>';
    const outcome = { success: true, file: { path: 'src/a.js', content: 'const marker = "recovery 👋";' } };
    let calls = 0;
    setup((_prompt, transport) => {
      const text = ++calls === 1 ? request : 'Wiederhergestellt.';
      transport.token(text); transport.result(text);
      return true;
    });
    const workspace = jest.fn(async () => {
      harness.children[0].emit('close', 1);
      return outcome;
    });
    const run = createRunner(client, { workspace, workspaceToolVersion: 3 });
    const tokens = [];

    await expect(run({ ...args, onToken: text => tokens.push(text) })).resolves.toMatchObject({ content: 'Wiederhergestellt.' });
    expect(workspace).toHaveBeenCalledTimes(1);
    expect(harness.spawnImpl).toHaveBeenCalledTimes(2);
    expect(harness.spawnImpl.mock.calls[1][1]).not.toContain('--conversation');
    expect(harness.prompts[1].message.content).toContain(JSON.stringify(outcome));
    expect(harness.prompts[1].message.content).toContain(request);
    expect(harness.prompts[1].message.content).toContain('full task');
    expect(tokens.join('')).toBe('Wiederhergestellt.');
  });

  test.each(['ERROR', 'WAITING', 'RUNNING', 'INVALID'])('rejects a %s result even if the process stays open', async status => {
    setup((_prompt, transport) => { transport.result('', { status, error: 'provider failure' }); return true; });
    await expect(client.run(args)).rejects.toThrow('provider failure');
  });

  test('decodes bytewise UTF-8 and a large fragmented line within the streaming budget', async () => {
    const text = 'Grüße 👋\n'.repeat(16000);
    setup((_prompt, transport) => { transport.token(text, true); transport.result(text); return true; });
    const started = performance.now();
    const tokens = [];
    await expect(client.run({ ...args, onToken: value => tokens.push(value) })).resolves.toMatchObject({ content: text });
    expect(tokens.join('')).toBe(text);
    expect(performance.now() - started).toBeLessThan(3000);
  });

  test('routes workspace requests internally and passes editor writes through without persisting them', async () => {
    let calls = 0;
    const editorRequest = '<codex_ide_editor_request>{"operation":"write","path":"new.js","content":"Grüße 👋"}</codex_ide_editor_request>';
    setup((_prompt, transport) => {
      const text = ++calls === 1 ? '<codex_ide_workspace_request>{"operation":"read","path":"src/a.js","purpose":"inspect"}</codex_ide_workspace_request>' : editorRequest;
      for (const character of text) transport.token(character);
      transport.result(text); return true;
    });
    const workspace = jest.fn(async () => ({ success: true, text: 'current file' }));
    const run = createRunner(client, { workspace, workspaceToolVersion: 3 });
    const tokens = [];
    await expect(run({ ...args, onToken: value => tokens.push(value) })).resolves.toMatchObject({ content: editorRequest, workspaceToolVersion: 3 });
    expect(workspace).toHaveBeenCalledWith({ operation: 'read', path: 'src/a.js', purpose: 'inspect' }, expect.any(Object));
    expect(tokens.join('')).toBe(editorRequest);
    expect(harness.spawnImpl).toHaveBeenCalledTimes(1);
  });
});

describe('Antigravity official authentication', () => {
  function commandSpawn(stdout, code = 0) {
    return jest.fn(() => {
      const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = jest.fn();
      setImmediate(() => { child.stdout.emit('data', Buffer.from(stdout)); child.emit('close', code); });
      return child;
    });
  }
  test.each([0, 1])('uses a successful official usage response as the auth probe (exit %s)', async code => {
    const spawnImpl = commandSpawn(JSON.stringify({ status: 'SUCCESS', command: { name: 'usage', data: { groups: [] } } }), code);
    await expect(getStatus({ spawnImpl })).resolves.toMatchObject({ loggedIn: code === 0 });
    expect(spawnImpl.mock.calls[0][1]).toEqual(['--print', '/usage', '--output-format', 'json']);
  });
  test('does not mistake arbitrary successful output or expired auth for a login', async () => {
    await expect(getStatus({ spawnImpl: commandSpawn('{"status":"SUCCESS"}') })).resolves.toMatchObject({ loggedIn: false });
    await expect(getStatus({ spawnImpl: commandSpawn('{"status":"ERROR","error":"Authentication required"}', 1) })).resolves.toMatchObject({ loggedIn: false });
  });
  test('reads the real CLI model slug format', async () => {
    await expect(getModels({ spawnImpl: commandSpawn('gemini-example-high\tGemini Example (High)\nclaude-example  Claude Example\n') })).resolves.toEqual([
      expect.objectContaining({ id: 'gemini-example-high', display_name: 'Gemini Example (High)' }),
      expect.objectContaining({ id: 'claude-example', display_name: 'Claude Example' })
    ]);
  });
  test('the CLI login delegates to agy acp --login with inherited terminal I/O', async () => {
    const spawnImpl = jest.fn(() => {
      const child = new EventEmitter(); setImmediate(() => child.emit('exit', 0)); return child;
    });
    await expect(cli.main(['antigravity', 'login'], { spawnImpl, antigravityBin: 'test-agy' })).resolves.toBe(0);
    expect(spawnImpl).toHaveBeenCalledWith('test-agy', ['acp', '--login'], expect.objectContaining({ stdio: 'inherit' }));
  });
});

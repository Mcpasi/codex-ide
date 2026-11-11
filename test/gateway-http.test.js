'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const { createGatewayServer } = require('../scripts/codex-ide-gateway');
const { createFixture } = require('./helpers/fixture');

const workspaceHeaders = { 'X-Codex-IDE-Workspace': 'model-home' };
const fileSkillHeaders = { 'X-Codex-IDE-Skill': 'workspace.extended-files', 'X-Codex-IDE-Permission': 'readCode' };

describe('gateway HTTP integration', () => {
  let fixture;
  let server;
  let port;
  let appServerClient;
  let runCodex;

  beforeAll(async () => {
    fixture = createFixture();
    const staticRoot = path.join(fixture.root, 'static');
    fixture.write('index.html', '<!doctype html><title>Test IDE</title>', staticRoot);
    fixture.write('private.txt', 'private shell data', staticRoot);
    const outside = fixture.write('outside.html', 'external secret', fixture.root);
    fs.symlinkSync(outside, path.join(staticRoot, 'Safetyfilter.js'));
    fs.symlinkSync(outside, path.join(fixture.home, 'escape.html'));
    fixture.write('README.md', '# Workspace');
    fixture.write('app.js', 'const answer = 42;');
    fixture.write('page.html', '<h1>Grüße 👋</h1>');
    fixture.write('memory.md', 'private memory');
    fixture.write('.env', 'SECRET=private');

    appServerClient = {
      getStatus: jest.fn(() => ({ sessions: [{ sessionId: 'test', threadId: 'thread-1' }] })),
      resetSession: jest.fn(async () => true),
      request: jest.fn(async method => method === 'model/list' ? { data: [
        { id: 'visible-model', displayName: 'Visible', isDefault: true, defaultReasoningEffort: 'ultra', supportedReasoningEfforts: [{ reasoningEffort: 'ultra' }, 'max'] },
        { id: 'hidden-model', hidden: true }
      ] } : {})
    };
    runCodex = jest.fn(async options => {
      if (options.prompt.includes('simulate-runner-failure')) throw new Error('simulated runner failure');
      if (options.onToken) {
        options.onToken('Grü');
        options.onToken('ße 👋');
      }
      if (options.onReasoningSummary) options.onReasoningSummary('Prüfung bestätigt.', {
        threadId: 'thread-1', turnId: 'turn-1', itemId: 'reasoning-1', summaryIndex: 1, replace: true
      });
      if (options.onTerminalStart) options.onTerminalStart({ itemId: 'terminal-1', command: 'node --check app.js', cwd: 'model-home' });
      if (options.onTerminalOutput) options.onTerminalOutput('syntax ok 👋', { itemId: 'terminal-1' });
      if (options.onTerminalComplete) options.onTerminalComplete({ itemId: 'terminal-1', status: 'completed', exitCode: 0, aggregatedOutput: 'syntax ok 👋' });
      return { content: 'Grüße 👋', threadId: 'thread-1', turnId: 'turn-1' };
    });
    server = createGatewayServer({
      modelHome: fixture.home, staticRoot, engine: 'app-server', appServerClient, runCodex,
      allowedOrigins: ['https://trusted.test'], sseHeartbeatMs: 0
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    port = server.address().port;
  });

  afterAll(async () => {
    if (server && server.listening) {
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
    if (fixture) fixture.dispose();
  });

  function request(route, { method = 'GET', headers = {}, body, raw } = {}) {
    return new Promise((resolve, reject) => {
      const payload = raw == null ? (body == null ? undefined : JSON.stringify(body)) : raw;
      const req = http.request({
        hostname: '127.0.0.1', port, path: route, method,
        headers: { ...(payload == null ? {} : { 'Content-Type': 'application/json' }), ...headers }
      }, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json;
          try { json = JSON.parse(text); } catch (_) { /* SSE, HTML or an empty HEAD response */ }
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      });
      req.on('error', reject);
      req.setTimeout(3000, () => req.destroy(new Error('Test HTTP request timed out')));
      req.end(payload);
    });
  }

  test('exposes health and policy without a Codex login or finite turn timeout', async () => {
    const health = await request('/health');
    expect(health.status).toBe(200);
    expect(health.json).toMatchObject({ ok: true, service: 'codex-ide-gateway', modelHome: fixture.home });
    expect((await request('/gateway/status')).json.policies.ideWorkspace)
      .toMatchObject({ workspaceRead: 'app-server-tool', editorWrite: 'new-files-only' });
    expect(server.requestTimeout).toBe(0);
    expect(server.timeout).toBe(0);
  });

  test.each([
    { Origin: 'https://evil.test' }, { Origin: 'null' },
    { Host: 'rebind.evil.test' }, { Host: 'rebind.evil.test', Origin: 'http://rebind.evil.test' }
  ])('blocks foreign origins and DNS-rebinding hosts: %j', async headers => {
    expect((await request('/health', { headers })).status).toBe(403);
  });

  test('permits same-origin requests and explicit allowlisted origins', async () => {
    const same = await request('/health', { headers: { Origin: `http://127.0.0.1:${port}` } });
    expect(same.status).toBe(200);
    const trusted = await request('/health', { headers: { Origin: 'https://trusted.test' } });
    expect(trusted.status).toBe(200);
    expect(trusted.headers['access-control-allow-origin']).toBe('https://trusted.test');
    expect((await request('/codex-ide/ide-files', { method: 'OPTIONS' })).status).toBe(204);
  });

  test('serves the shell and handles HEAD and cache cleaning', async () => {
    const shell = await request('/');
    expect(shell.status).toBe(200);
    expect(shell.headers['content-type']).toContain('text/html');
    expect(shell.text).toContain('<title>Test IDE</title>');
    const head = await request('/', { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.text).toBe('');
    expect(Number(head.headers['content-length'])).toBe(Buffer.byteLength(shell.text));
    expect((await request('/?codex-ide-clean=1')).headers['clear-site-data']).toBe('"cache"');
  });

  test.each(['/private.txt', '/Safetyfilter.js', '/%2e%2e%2foutside.html', '/nonexistent'])
    ('does not serve private files or escaping static symlinks: %s', async route => {
      const result = await request(route);
      expect(result.status).toBe(404);
      expect(result.text).not.toContain('external secret');
    });

  test('serves an uncached HTML preview in a sandbox without same-origin access', async () => {
    const preview = await request('/codex-ide/preview/page.html');
    expect(preview.status).toBe(200);
    expect(preview.text).toBe('<h1>Grüße 👋</h1>');
    expect(preview.headers['cache-control']).toBe('no-store');
    expect(preview.headers['content-security-policy']).toContain('sandbox');
    expect(preview.headers['content-security-policy']).not.toContain('allow-same-origin');
  });

  test.each(['/codex-ide/preview/escape.html', '/codex-ide/preview/%2e%2e%2foutside.html', '/codex-ide/preview/memory.md'])
    ('rejects an unsafe preview: %s', async route => {
      const result = await request(route);
      expect(result.status).toBe(400);
      expect(result.text).not.toContain('external secret');
      expect(result.text).not.toContain('private memory');
    });

  test('requires the workspace contract before saving editor files', async () => {
    const body = { path: 'saved.js', content: 'const saved = true;', operation: 'write' };
    expect((await request('/codex-ide/ide-files', { method: 'POST', body })).status).toBe(400);
    const result = await request('/codex-ide/ide-files', { method: 'POST', headers: workspaceHeaders, body });
    expect(result.status).toBe(200);
    expect(result.json).toMatchObject({ ok: true, persistence: 'saved', file: { path: 'saved.js', overwritten: false } });
    const read = await request('/codex-ide/ide-files?path=saved.js', { headers: workspaceHeaders });
    expect(read.json.file.content).toBe(body.content);
  });

  test('rejects operation=write for an existing file without losing its contents', async () => {
    const result = await request('/codex-ide/ide-files', {
      method: 'POST', headers: workspaceHeaders,
      body: { path: 'app.js', content: 'overwrite', operation: 'write' }
    });
    expect(result.status).toBe(400);
    expect(fixture.read('app.js')).toBe('const answer = 42;');
  });

  test.each(['src/main.ts', 'package.json', '.git/config', '.env', 'memory.md', 'node_modules/lib/index.cjs'])
    ('persists and lists %s through the workspace contract without a skill', async file => {
      const saved = await request('/codex-ide/ide-files', {
        method: 'POST', headers: workspaceHeaders, body: { path: file, content: 'updated' }
      });
      expect(saved.status).toBe(200);
      const read = await request('/codex-ide/ide-files?path=' + encodeURIComponent(file), { headers: workspaceHeaders });
      expect(read.json.file.content).toBe('updated');
      const listing = await request('/codex-ide/workspace', { headers: workspaceHeaders });
      expect(listing.json.files.map(entry => entry.path)).toContain(file);
    });

  test('only includes extended files in listings when the contract or skill grants access', async () => {
    const basic = await request('/codex-ide/workspace?extended=1');
    expect(basic.json.files.map(file => file.path)).not.toContain('app.js');
    const extended = await request('/codex-ide/workspace?extended=1', { headers: workspaceHeaders });
    expect(extended.json.files.map(file => file.path)).toContain('app.js');
    expect(extended.json.files.map(file => file.path)).toContain('memory.md');
    expect(extended.json.files.map(file => file.path)).toContain('.env');
  });

  test('checks the skill ID and the permission for extended-file reads and writes', async () => {
    const route = '/codex-ide/extended-files?path=app.js';
    expect((await request(route)).status).toBe(400);
    expect((await request(route, { headers: { ...fileSkillHeaders, 'X-Codex-IDE-Permission': 'writeCode' } })).status).toBe(400);
    expect((await request(route, { headers: fileSkillHeaders })).json.file.content).toBe('const answer = 42;');
  });

  test('accepts PDF uploads only with the PDF write permission', async () => {
    const body = { path: 'sample.pdf', base64: Buffer.from('%PDF-1.4\n%%EOF').toString('base64') };
    expect((await request('/codex-ide/pdf-files', { method: 'POST', body })).status).toBe(400);
    const uploaded = await request('/codex-ide/pdf-files', {
      method: 'POST', body, headers: { 'X-Codex-IDE-Skill': 'workspace.pdf', 'X-Codex-IDE-Permission': 'writePdf' }
    });
    expect(uploaded.status).toBe(200);
    expect(uploaded.json.file.path).toBe('sample.pdf');
  });

  test('lists visible models with their advertised reasoning levels', async () => {
    const result = await request('/v1/models');
    expect(result.status).toBe(200);
    expect(result.json.data.map(model => model.id)).toEqual(['codex-cli', 'visible-model']);
    expect(result.json.data[1]).toMatchObject({ default_reasoning_effort: 'ultra', supported_reasoning_efforts: ['ultra', 'max'] });
  });

  test('lists and deletes persistent sessions through the injected App Server', async () => {
    expect((await request('/codex/sessions')).json.sessions).toEqual([{ sessionId: 'test', threadId: 'thread-1' }]);
    const result = await request('/codex/session/reset', { method: 'POST', body: { sessionId: 'test', threadId: 'thread-1' } });
    expect(result.json).toMatchObject({ ok: true, reset: true });
    expect(appServerClient.resetSession).toHaveBeenCalledWith('test', 'thread-1');
  });

  test('returns chat completions with project changes routed through the live editor', async () => {
    const result = await request('/v1/chat/completions', {
      method: 'POST', body: {
        messages: [{ role: 'user', content: 'Bitte prüfe den Code.' }], reasoning_effort: 'ultra',
        codexIde: { editorMode: true, editorWorkspaceMode: true, sessionId: 'test' }
      }
    });
    expect(result.status).toBe(200);
    expect(result.json.choices[0].message.content).toBe('Grüße 👋');
    expect(result.json.codexIde).toMatchObject({ sessionId: 'test', threadId: 'thread-1', turnId: 'turn-1' });
    expect(runCodex).toHaveBeenCalledWith(expect.objectContaining({ readOnly: true, disableWebSearch: true, reasoningEffort: 'ultra' }));
  });

  test('streams Unicode tokens and terminal events once, ending with DONE', async () => {
    const result = await request('/v1/chat/completions', {
      method: 'POST', body: { stream: true, messages: [{ role: 'user', content: 'Hallo' }] }
    });
    expect(result.status).toBe(200);
    expect(result.headers['content-type']).toContain('text/event-stream');
    const events = result.text.split('\n').filter(line => line.startsWith('data: ')).map(line => line.slice(6));
    expect(events.pop()).toBe('[DONE]');
    const chunks = events.map(event => JSON.parse(event));
    expect(chunks.map(chunk => chunk.choices?.[0]?.delta?.content || '').join('')).toBe('Grüße 👋');
    const terminal = chunks.map(chunk => chunk.codexIde?.terminal_event).filter(Boolean);
    expect(terminal.map(event => event.phase)).toEqual(['start', 'output', 'complete']);
    expect(terminal[1].delta).toBe('syntax ok 👋');
    expect(terminal[2].aggregated_output).toBe('');
    expect(chunks.map(chunk => chunk.codexIde?.reasoning_summary).filter(Boolean)).toEqual([{
      delta: 'Prüfung bestätigt.', thread_id: 'thread-1', turn_id: 'turn-1',
      item_id: 'reasoning-1', summary_index: 1, replace: true
    }]);
  });

  test.each([false, true])('delivers completed replies without token deltas over SSE: empty callback=%s', async emitEmptyToken => {
    const content = 'Prüfung abgeschlossen 👋';
    runCodex.mockImplementationOnce(async options => {
      options.onReasoningSummary('Dateien geprüft.', {
        threadId: 'thread-fallback', turnId: 'turn-fallback', itemId: 'reasoning-fallback', summaryIndex: 0
      });
      if (emitEmptyToken) options.onToken('');
      return { content, threadId: 'thread-fallback', turnId: 'turn-fallback' };
    });

    const result = await request('/v1/chat/completions', {
      method: 'POST', body: { stream: true, messages: [{ role: 'user', content: 'Prüfen' }] }
    });
    expect(result.status).toBe(200);
    expect(result.headers['content-type']).toContain('text/event-stream');
    const events = result.text.split('\n').filter(line => line.startsWith('data: ')).map(line => line.slice(6));
    expect(events.pop()).toBe('[DONE]');
    const chunks = events.map(event => JSON.parse(event));
    expect(chunks.filter(chunk => chunk.error)).toEqual([]);
    expect(chunks.map(chunk => chunk.choices?.[0]?.delta?.content).filter(Boolean)).toEqual([content]);
    expect(chunks[chunks.length - 1]).toMatchObject({
      choices: [{ finish_reason: 'stop' }], codexIde: { threadId: 'thread-fallback', turnId: 'turn-fallback' }
    });
  });

  test('streams correlated tool cards and reasoning completion through the real HTTP endpoint', async () => {
    const scope = { itemId: 'read-a', threadId: 'thread-a', turnId: 'turn-a', path: 'src/a.js' };
    runCodex.mockImplementationOnce(async options => {
      expect(options.readOnly).toBe(true);
      options.onReasoningSummary('Prüfung läuft.', { ...scope, itemId: 'reasoning', summaryIndex: 0 });
      options.onReasoningSummary('', { ...scope, itemId: 'reasoning', summaryIndex: 0, completed: true });
      options.onWorkspaceReadStart(scope);
      options.onWorkspaceReadError({ ...scope, error: 'Datei fehlt.' });
      options.onToolEvent({ ...scope, itemId: 'mcp', name: 'lookup', source: 'app-server', status: 'running' });
      options.onToolEvent({ ...scope, itemId: 'mcp', name: 'lookup', source: 'app-server', status: 'completed', output: 'Treffer 👋' });
      options.onToken('Fertig.');
      return { content: 'Fertig.' };
    });
    const result = await request('/v1/chat/completions', {
      method: 'POST', body: { stream: true, messages: [{ role: 'user', content: 'Prüfen' }], codexIde: { editorWorkspaceMode: true } }
    });
    expect(result.status).toBe(200);
    const chunks = result.text.split('\n').filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6)));
    const summaries = chunks.map(chunk => chunk.codexIde?.reasoning_summary).filter(Boolean);
    expect(summaries[1]).toMatchObject({ delta: '', completed: true, item_id: 'reasoning' });
    const skills = chunks.map(chunk => chunk.codexIde?.skill_event).filter(Boolean);
    expect(skills.map(event => event.status)).toEqual(['running', 'failed']);
    expect(skills[1]).toMatchObject({ item_id: 'read-a', thread_id: 'thread-a', turn_id: 'turn-a', path: 'src/a.js', error: 'Datei fehlt.' });
    const tools = chunks.map(chunk => chunk.codexIde?.tool_event).filter(Boolean);
    expect(tools.map(event => event.status)).toEqual(['running', 'completed']);
    expect(tools[1]).toMatchObject({ itemId: 'mcp', output: 'Treffer 👋', source: 'app-server' });
    expect(chunks.map(chunk => chunk.choices?.[0]?.delta?.content || '').join('')).toBe('Fertig.');
  });

  test('returns runner failures through both JSON and SSE responses', async () => {
    const body = { messages: [{ role: 'user', content: 'simulate-runner-failure' }] };
    const plain = await request('/v1/chat/completions', { method: 'POST', body });
    expect(plain.status).toBe(400);
    expect(plain.json.error.message).toBe('simulated runner failure');
    const stream = await request('/v1/chat/completions', { method: 'POST', body: { ...body, stream: true } });
    expect(stream.text).toContain('simulated runner failure');
    expect(stream.text).toContain('data: [DONE]');
  });

  test('handles malformed JSON and an empty conversation as request errors', async () => {
    expect((await request('/v1/chat/completions', { method: 'POST', raw: '{invalid' })).status).toBe(400);
    expect((await request('/v1/chat/completions', { method: 'POST', body: { messages: [] } })).status).toBe(400);
  });

  test('requires the explicit user-console contract and rejects input for absent processes', async () => {
    expect((await request('/codex-ide/console', { method: 'POST', body: { command: 'echo test' } })).status).toBe(400);
    const result = await request('/codex-ide/console/input', {
      method: 'POST', body: { itemId: 'finished-process', input: 'hello' },
      headers: { ...workspaceHeaders, 'X-Codex-IDE-Console': 'user' }
    });
    expect(result.status).toBe(409);
  });
});

'use strict';

// Package-local checks run explicitly with Node's built-in test runner.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const skill = require('./index.js');

const COMMIT_SHA = 'a'.repeat(40);

function jsonResponse(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: Object.assign({ 'Content-Type': 'application/json' }, headers)
  });
}

function textResponse(value, status = 200, headers = {}) {
  return new Response(value, { status, headers });
}

function byteResponse(value, status = 200, headers = {}) {
  const bytes = value instanceof Uint8Array ? value : new TextEncoder().encode(String(value));
  return new Response(bytes, { status, headers });
}

function createGithubFetch(options = {}) {
  const calls = [];
  const owner = options.owner || 'acme';
  const repo = options.repo || 'demo';
  const entries = options.entries || [];
  const rawFiles = options.rawFiles || {};
  const blobFiles = options.blobFiles || {};
  const handler = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const value = String(url);
    if (value === `https://api.github.com/repos/${owner}/${repo}`) {
      return jsonResponse({
        full_name: options.fullName || `${owner}/${repo}`,
        default_branch: options.defaultBranch || 'main',
        private: options.privateValue === undefined ? options.private === true : options.privateValue
      });
    }
    if (value === `https://api.github.com/repos/${owner}/${repo}/commits/main`) {
      return textResponse(options.commitSha || COMMIT_SHA);
    }
    if (value === `https://api.github.com/repos/${owner}/${repo}/git/trees/${COMMIT_SHA}?recursive=1`) {
      return jsonResponse({ tree: entries, truncated: options.truncated === true });
    }
    const blobPrefix = `https://api.github.com/repos/${owner}/${repo}/git/blobs/`;
    if (value.startsWith(blobPrefix)) {
      const sha = value.slice(blobPrefix.length);
      if (!Object.prototype.hasOwnProperty.call(blobFiles, sha)) return textResponse('missing', 404);
      return byteResponse(blobFiles[sha]);
    }
    const rawPrefix = `https://raw.githubusercontent.com/${owner}/${repo}/${COMMIT_SHA}/`;
    if (value.startsWith(rawPrefix)) {
      const path = value.slice(rawPrefix.length).split('/').map(decodeURIComponent).join('/');
      if (!Object.prototype.hasOwnProperty.call(rawFiles, path)) return textResponse('missing', 404);
      return byteResponse(rawFiles[path]);
    }
    throw new Error(`Unexpected URL: ${value}`);
  };
  handler.calls = calls;
  return handler;
}

function createEnvironment(fetchImpl, options = {}) {
  const directories = [];
  const writes = [];
  const environment = {
    fetch: fetchImpl,
    TextDecoder,
    CodexIdeSkillSystem: {
      canRunWithPermissions(id, profile, permission) {
        return options.extendedPermission !== false && id === 'workspace.extended-files' && profile === 'codex' && permission === 'writeCode';
      }
    },
    codexIdeProfile: {
      async createModelHomeWorkspaceDirectory(path, callOptions) {
        directories.push({ path, options: callOptions });
        return { ok: true, directory: { path, created: options.directoryCreated !== false } };
      },
      async writeModelHomeWorkspaceFile(path, content, callOptions) {
        if (typeof options.writeFailureAt === 'number' && writes.length === options.writeFailureAt) {
          throw new Error('mock write failure');
        }
        writes.push({ path, content, options: callOptions });
        return { ok: true, file: { path } };
      }
    }
  };
  return { environment, directories, writes };
}

function context(overrides = {}) {
  return Object.assign({
    language: 'de',
    profile: 'codex',
    config: {},
    permissions: { network: true, writeWorkspace: true, githubToken: false }
  }, overrides);
}

test('parses supported repository forms and rejects ambiguous or foreign URLs', () => {
  assert.deepEqual(skill.parseRepository('acme/demo'), { owner: 'acme', repo: 'demo', fullName: 'acme/demo' });
  assert.equal(skill.parseRepository('https://github.com/acme/demo.git/').fullName, 'acme/demo');
  assert.equal(skill.parseRepository('git@github.com:acme/demo.git').fullName, 'acme/demo');
  assert.equal(skill.parseRepository('http://github.com/acme/demo'), null);
  assert.equal(skill.parseRepository('https://evil.example/acme/demo'), null);
  assert.equal(skill.parseRepository('https://github.com/acme/demo/tree/main'), null);
  assert.equal(skill.parseRepository('../demo'), null);
});

test('registers the exact manifest runtime synchronously in a browser context', () => {
  const registrations = [];
  const source = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
  const window = {
    CodexIdeSkillSystem: {
      registerRuntime(id, runtime) {
        registrations.push({ id, runtime });
        return true;
      }
    }
  };
  vm.runInNewContext(source, { window, URL, TextDecoder }, { filename: 'index.js' });
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].id, 'github.repo-import');
  assert.equal(typeof registrations[0].runtime.run, 'function');
});

test('imports only supported safe UTF-8 files into the deterministic Repos target', async () => {
  const jsSha = 'b'.repeat(40);
  const mdSha = 'c'.repeat(40);
  const fetchImpl = createGithubFetch({
    entries: [
      { path: 'README.md', type: 'blob', mode: '100644', size: 8, sha: mdSha },
      { path: 'src/app.js', type: 'blob', mode: '100644', size: 18, sha: jsSha },
      { path: 'package.json', type: 'blob', mode: '100644', size: 2, sha: 'd'.repeat(40) },
      { path: 'linked.py', type: 'blob', mode: '120000', size: 6, sha: 'e'.repeat(40) },
      { path: 'vendor', type: 'commit', mode: '160000', sha: 'f'.repeat(40) },
      { path: '.env/secret.py', type: 'blob', mode: '100644', size: 5, sha: '1'.repeat(40) },
      { path: 'empty.py', type: 'blob', mode: '100644', size: 0, sha: '2'.repeat(40) },
      { path: 'huge.css', type: 'blob', mode: '100644', size: skill.limits.maxFileBytes + 1, sha: '3'.repeat(40) }
    ],
    rawFiles: {
      'README.md': '# Demo\n',
      'src/app.js': 'console.log("ok");\n'
    }
  });
  const state = createEnvironment(fetchImpl);
  const result = await skill.createRuntime(state.environment).run(
    { repository: 'https://github.com/acme/demo.git', operation: 'import' },
    context()
  );

  assert.deepEqual(state.directories.map(item => item.path), ['Repos/acme--demo']);
  assert.deepEqual(state.writes.map(item => item.path), [
    'Repos/acme--demo/README.md',
    'Repos/acme--demo/src/app.js'
  ]);
  assert.ok(state.writes.every(item => item.options.overwrite === false));
  assert.equal(result.detail.importedCount, 2);
  assert.equal(result.detail.skippedCount, 6);
  assert.equal(result.detail.completeClone, false);
  assert.match(result.context, /kein vollständiger Git-Clone/);
  const apiCalls = fetchImpl.calls.filter(call => call.url.startsWith('https://api.github.com/'));
  assert.ok(apiCalls.every(call => call.init.headers['X-GitHub-Api-Version'] === '2026-03-10'));
  assert.ok(fetchImpl.calls.every(call => !call.init.headers.Authorization));
});

test('uses the optional token only when its permission is granted and updates with overwrite', async () => {
  const fileSha = 'b'.repeat(40);
  const fetchImpl = createGithubFetch({
    private: true,
    entries: [{ path: 'main.py', type: 'blob', mode: '100644', size: 12, sha: fileSha }],
    blobFiles: { [fileSha]: 'print("ok")\n' }
  });
  const state = createEnvironment(fetchImpl, { directoryCreated: false });
  const result = await skill.createRuntime(state.environment).run(
    { repository: 'acme/demo', operation: 'update' },
    context({
      config: { githubToken: 'secret-token' },
      permissions: { network: true, writeWorkspace: true, githubToken: true }
    })
  );

  assert.equal(state.writes.length, 1);
  assert.equal(state.writes[0].options.overwrite, true);
  assert.equal(result.detail.operation, 'update');
  assert.match(result.context, /löscht aber keine lokal verbliebenen Dateien/);
  const apiCalls = fetchImpl.calls.filter(call => call.url.startsWith('https://api.github.com/'));
  assert.ok(apiCalls.every(call => call.init.headers.Authorization === 'Bearer secret-token'));
  assert.ok(!result.context.includes('secret-token'));
  assert.ok(!JSON.stringify(result.detail).includes('secret-token'));
});

test('blocks missing own permissions or the extended-file dependency before network access', async () => {
  let fetchCount = 0;
  const fetchImpl = async () => { fetchCount += 1; throw new Error('must not run'); };
  const deniedOwn = createEnvironment(fetchImpl);
  await assert.rejects(
    skill.createRuntime(deniedOwn.environment).run(
      { repository: 'acme/demo', operation: 'import' },
      context({ permissions: { network: false, writeWorkspace: true, githubToken: false } })
    ),
    /Netzwerk- und Modell-Home-Rechte/
  );
  const deniedDependency = createEnvironment(fetchImpl, { extendedPermission: false });
  await assert.rejects(
    skill.createRuntime(deniedDependency.environment).run(
      { repository: 'acme/demo', operation: 'import' },
      context()
    ),
    /workspace\.extended-files/
  );
  assert.equal(fetchCount, 0);
});

test('allows an explicitly authorized import from a Codex IDE workspace turn', async () => {
  const fileSha = 'b'.repeat(40);
  const fetchImpl = createGithubFetch({
    entries: [{ path: 'app.js', type: 'blob', mode: '100644', size: 3, sha: fileSha }],
    rawFiles: { 'app.js': 'ok\n' }
  });
  const state = createEnvironment(fetchImpl);
  const result = await skill.createRuntime(state.environment).run(
    { repository: 'acme/demo', operation: 'import' },
    context({ editorWorkspaceMode: true })
  );

  assert.equal(result.detail.importedCount, 1);
  assert.deepEqual(state.writes.map(item => item.path), ['Repos/acme--demo/app.js']);
  assert.ok(fetchImpl.calls.length > 0);
});

test('requires an authorized token for a private repository without leaking configuration', async () => {
  const fetchImpl = createGithubFetch({ private: true });
  const state = createEnvironment(fetchImpl);
  await assert.rejects(
    skill.createRuntime(state.environment).run(
      { repository: 'acme/demo', operation: 'import' },
      context({ config: { githubToken: 'hidden-but-not-granted' } })
    ),
    error => {
      assert.match(error.message, /private Repository/);
      assert.ok(!error.message.includes('hidden-but-not-granted'));
      return true;
    }
  );
  assert.equal(fetchImpl.calls.length, 1);
});

test('rejects truncated trees and unsafe canonical metadata before any workspace write', async () => {
  const truncatedFetch = createGithubFetch({ truncated: true });
  const truncatedState = createEnvironment(truncatedFetch);
  await assert.rejects(
    skill.createRuntime(truncatedState.environment).run(
      { repository: 'acme/demo', operation: 'import' },
      context()
    ),
    /gekürzt/
  );
  assert.equal(truncatedState.directories.length, 0);
  assert.equal(truncatedState.writes.length, 0);

  const unsafeFetch = createGithubFetch({ fullName: '../escape' });
  const unsafeState = createEnvironment(unsafeFetch);
  await assert.rejects(
    skill.createRuntime(unsafeState.environment).run(
      { repository: 'acme/demo', operation: 'import' },
      context()
    ),
    /ungültige Repository-Antwort/
  );
  assert.equal(unsafeState.directories.length, 0);

  const missingVisibilityFetch = createGithubFetch({ privateValue: 'false' });
  const missingVisibilityState = createEnvironment(missingVisibilityFetch);
  await assert.rejects(
    skill.createRuntime(missingVisibilityState.environment).run(
      { repository: 'acme/demo', operation: 'import' },
      context()
    ),
    /ungültige Repository-Antwort/
  );
  assert.equal(missingVisibilityState.directories.length, 0);
});

test('enforces file-count and aggregate-size limits before downloads or writes', async () => {
  const tooManyEntries = Array.from({ length: skill.limits.maxFiles + 1 }, (_, index) => ({
    path: `src/file-${index}.js`,
    type: 'blob',
    mode: '100644',
    size: 1,
    sha: 'b'.repeat(40)
  }));
  const tooManyFetch = createGithubFetch({ entries: tooManyEntries });
  const tooManyState = createEnvironment(tooManyFetch);
  await assert.rejects(
    skill.createRuntime(tooManyState.environment).run(
      { repository: 'acme/demo', operation: 'import' },
      context()
    ),
    new RegExp(`mehr als ${skill.limits.maxFiles}`)
  );
  assert.equal(tooManyFetch.calls.filter(call => call.url.startsWith('https://raw.githubusercontent.com/')).length, 0);
  assert.equal(tooManyState.directories.length, 0);

  const largeEntries = Array.from({ length: 40 }, (_, index) => ({
    path: `src/large-${index}.py`,
    type: 'blob',
    mode: '100644',
    size: skill.limits.maxFileBytes,
    sha: 'c'.repeat(40)
  }));
  const tooLargeFetch = createGithubFetch({ entries: largeEntries });
  const tooLargeState = createEnvironment(tooLargeFetch);
  await assert.rejects(
    skill.createRuntime(tooLargeState.environment).run(
      { repository: 'acme/demo', operation: 'import' },
      context()
    ),
    /12 MiB/
  );
  assert.equal(tooLargeFetch.calls.filter(call => call.url.startsWith('https://raw.githubusercontent.com/')).length, 0);
  assert.equal(tooLargeState.directories.length, 0);
});

test('does not overwrite an existing target in import mode', async () => {
  const fileSha = 'b'.repeat(40);
  const fetchImpl = createGithubFetch({
    entries: [{ path: 'app.js', type: 'blob', mode: '100644', size: 3, sha: fileSha }],
    rawFiles: { 'app.js': 'ok\n' }
  });
  const state = createEnvironment(fetchImpl, { directoryCreated: false });
  await assert.rejects(
    skill.createRuntime(state.environment).run(
      { repository: 'acme/demo', operation: 'import' },
      context()
    ),
    /existiert bereits/
  );
  assert.equal(state.writes.length, 0);
});

test('filters invalid UTF-8 and aborts when no writable source remains', async () => {
  const fileSha = 'b'.repeat(40);
  const fetchImpl = createGithubFetch({
    entries: [{ path: 'binary.py', type: 'blob', mode: '100644', size: 2, sha: fileSha }],
    rawFiles: { 'binary.py': new Uint8Array([0xff, 0xfe]) }
  });
  const state = createEnvironment(fetchImpl);
  await assert.rejects(
    skill.createRuntime(state.environment).run(
      { repository: 'acme/demo', operation: 'import' },
      context()
    ),
    /keine importierbaren/
  );
  assert.equal(state.directories.length, 0);
  assert.equal(state.writes.length, 0);
});

test('honors aborts and reports a possible partial workspace after a local write failure', async () => {
  const controller = new AbortController();
  controller.abort();
  let fetchCount = 0;
  const abortedState = createEnvironment(async () => { fetchCount += 1; });
  await assert.rejects(
    skill.createRuntime(abortedState.environment).run(
      { repository: 'acme/demo', operation: 'import' },
      context({ signal: controller.signal })
    ),
    error => error.name === 'AbortError'
  );
  assert.equal(fetchCount, 0);

  const firstSha = 'b'.repeat(40);
  const secondSha = 'c'.repeat(40);
  const fetchImpl = createGithubFetch({
    entries: [
      { path: 'one.js', type: 'blob', mode: '100644', size: 4, sha: firstSha },
      { path: 'two.py', type: 'blob', mode: '100644', size: 4, sha: secondSha }
    ],
    rawFiles: { 'one.js': 'one\n', 'two.py': 'two\n' }
  });
  const partialState = createEnvironment(fetchImpl, { writeFailureAt: 1 });
  await assert.rejects(
    skill.createRuntime(partialState.environment).run(
      { repository: 'acme/demo', operation: 'import' },
      context()
    ),
    /nach 1 Dateien fehlgeschlagen/
  );
  assert.equal(partialState.writes.length, 1);
});

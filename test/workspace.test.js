'use strict';

const fs = require('fs');
const path = require('path');
const bridge = require('../scripts/codex-bridge');
const { createFixture } = require('./helpers/fixture');

let fixture;
beforeEach(() => { fixture = createFixture(); });
afterEach(() => fixture.dispose());

describe('workspace file persistence', () => {
  test('normalizes Markdown and derives a safe filename from the heading', () => {
    const file = bridge.writeModelMarkdownFile(fixture.home, '', '  # Grüße aus Köln\r\n\r\nText.  ');
    expect(file).toEqual({ path: 'gru-e-aus-koln.md', bytes: Buffer.byteLength('# Grüße aus Köln\n\nText.\n'), overwritten: false });
    expect(bridge.readAllowedModelFile(fixture.home, file.path))
      .toEqual({ path: file.path, content: '# Grüße aus Köln\n\nText.\n', truncated: false });
  });

  test('keeps an existing Markdown note unless overwrite is explicit', () => {
    fixture.write('notes.md', 'Original');
    fixture.write('notes-2.md', 'Other note');
    expect(bridge.writeModelMarkdownFile(fixture.home, 'notes.md', 'New').path).toBe('notes-3.md');
    expect(fixture.read('notes.md')).toBe('Original');
    expect(bridge.writeModelMarkdownFile(fixture.home, 'notes.md', 'Replace', { overwrite: true }).overwritten).toBe(true);
    expect(fixture.read('notes.md')).toBe('Replace\n');
  });

  test.each(['', '   ', null])('rejects empty Markdown: %s', content => {
    expect(() => bridge.writeModelMarkdownFile(fixture.home, 'note.md', content)).toThrow();
    expect(fs.existsSync(path.join(fixture.home, 'note.md'))).toBe(false);
  });

  test('rejects oversized content before touching the existing file', () => {
    fixture.write('app.js', 'const original = true;');
    expect(() => bridge.writeIdeEditorFile(fixture.home, 'app.js', 'x'.repeat(21), { maxChars: 20 })).toThrow();
    expect(fixture.read('app.js')).toBe('const original = true;');
  });

  test.each(['app.js', 'style.css', 'index.html', 'main.py', 'README.md'])('saves and reads an editor file: %s', name => {
    const content = 'Grüße 👋\r\nzweite Zeile\r';
    const normalized = 'Grüße 👋\nzweite Zeile\n';
    expect(bridge.writeIdeEditorFile(fixture.home, `src/${name}`, content, { operation: 'write' }))
      .toEqual({ path: `src/${name}`, bytes: Buffer.byteLength(normalized), overwritten: false });
    expect(bridge.readIdeEditorFile(fixture.home, `src/${name}`))
      .toEqual({ path: `src/${name}`, content: normalized, truncated: false, bytes: Buffer.byteLength(normalized) });
  });

  test('enforces create versus edit and keeps rejected writes atomic', () => {
    fixture.write('app.js', 'const value = 1;');
    expect(() => bridge.writeIdeEditorFile(fixture.home, 'app.js', 'replacement', { operation: 'write' })).toThrow();
    expect(fixture.read('app.js')).toBe('const value = 1;');
    expect(() => bridge.writeIdeEditorFile(fixture.home, 'missing.js', 'replacement', { operation: 'edit' })).toThrow();
    expect(fs.existsSync(path.join(fixture.home, 'missing.js'))).toBe(false);
    expect(bridge.writeIdeEditorFile(fixture.home, 'app.js', 'const value = 2;', { operation: 'edit' }).overwritten).toBe(true);
    expect(fixture.read('app.js')).toBe('const value = 2;');
  });

  test('honors overwrite=false and permits an empty editor buffer', () => {
    fixture.write('app.js', 'original');
    expect(() => bridge.writeExtendedModelFile(fixture.home, 'app.js', 'new', { overwrite: false })).toThrow();
    expect(fixture.read('app.js')).toBe('original');
    bridge.writeIdeEditorFile(fixture.home, 'app.js', '', { operation: 'edit' });
    expect(fixture.read('app.js')).toBe('');
  });

  test('keeps format-specific upload channels while the workspace accepts every file type', () => {
    fixture.write('data.json', '{"ok":true}');
    fixture.write('app.js', 'const value = true;');
    expect(bridge.readAllowedModelFile(fixture.home, 'data.json').content).toBe('{"ok":true}');
    expect(bridge.readAllowedModelFile(fixture.home, 'app.js').content).toBe('const value = true;');
    expect(() => bridge.writeModelMarkdownFile(fixture.home, 'app.js', 'content')).toThrow();
    expect(() => bridge.writeExtendedModelFile(fixture.home, 'note.md', 'content')).toThrow();
    expect(bridge.writeIdeEditorFile(fixture.home, 'data.exe', 'content').path).toBe('data.exe');
  });

  test('reports a truncated read while retaining the full byte count', () => {
    fixture.write('app.js', 'x'.repeat(50));
    const read = bridge.readIdeEditorFile(fixture.home, 'app.js', 10);
    expect(read.truncated).toBe(true);
    expect(read.content.startsWith('x'.repeat(10))).toBe(true);
    expect(read.bytes).toBe(50);
  });

  test('creates nested directories idempotently and rejects a file at the target', () => {
    expect(bridge.createExtendedModelDirectory(fixture.home, 'src/components'))
      .toEqual({ path: 'src/components', created: true });
    expect(bridge.createExtendedModelDirectory(fixture.home, 'src/components').created).toBe(false);
    fixture.write('existing.js', 'content');
    expect(() => bridge.createExtendedModelDirectory(fixture.home, 'existing.js')).toThrow();
  });
});

describe('workspace containment and protected files', () => {
  test.each([
    '../escape.js', 'src/../../escape.js', '/tmp/escape.js', 'C:\\temp\\escape.js',
    'file:///tmp/escape.js', 'bad\0name.js', 'bad\nname.js',
    `${'a'.repeat(501)}.js`
  ])('rejects unsafe writes: %s', requested => {
    expect(() => bridge.writeIdeEditorFile(fixture.home, requested, 'unsafe')).toThrow();
    expect(fs.readdirSync(fixture.home)).toEqual([]);
    expect(fs.existsSync(path.join(fixture.root, 'escape.js'))).toBe(false);
  });

  test.each(['memory.md', 'MEMORY.MD'])('permits workspace edits to %s while Markdown uploads use the memory endpoint', name => {
    expect(bridge.writeIdeEditorFile(fixture.home, name, 'replace').path).toBe(name);
    expect(() => bridge.writeModelMarkdownFile(fixture.home, name, 'replace')).toThrow();
  });

  test('rejects reads and writes through an escaping symlink', () => {
    const outside = fixture.write('outside/secret.js', 'secret', fixture.root);
    fs.symlinkSync(path.dirname(outside), path.join(fixture.home, 'link'));
    expect(() => bridge.readIdeEditorFile(fixture.home, 'link/secret.js')).toThrow(/Symlink/);
    expect(() => bridge.writeIdeEditorFile(fixture.home, 'link/new.js', 'escape')).toThrow(/Symlink/);
    expect(fs.existsSync(path.join(fixture.root, 'outside/new.js'))).toBe(false);
    expect(fs.readFileSync(outside, 'utf8')).toBe('secret');
  });

  test('rejects a dangling symlink rather than creating its target', () => {
    const outside = path.join(fixture.root, 'missing.js');
    fs.symlinkSync(outside, path.join(fixture.home, 'link.js'));
    expect(() => bridge.writeIdeEditorFile(fixture.home, 'link.js', 'escape')).toThrow(/Symlink/);
    expect(fs.existsSync(outside)).toBe(false);
  });

  test.each(['../escape', '/tmp/escape'])
    ('rejects an unsafe directory: %s', directory => {
      expect(() => bridge.createExtendedModelDirectory(fixture.home, directory)).toThrow();
    });
});

describe('lazy workspace reads', () => {
  beforeEach(() => {
    fixture.write('README.md', '# Project');
    fixture.write('memory.md', 'private memory');
    fixture.write('.env', 'SECRET=hidden');
    fixture.write('src/app.js', 'const value = 1;');
    fixture.write('src/nested/data.json', '{"ok":true}');
    fixture.write('node_modules/lib/index.js', 'private dependency');
    fixture.write('.git/config', 'private git config');
    fs.symlinkSync(path.join(fixture.home, 'src'), path.join(fixture.home, 'linked'));
  });

  test('lists only the requested branch at the requested depth', () => {
    expect(bridge.listScopedWorkspaceEntries(fixture.home, 'src', 1)).toEqual({
      scope: 'src', depth: 1, directories: ['src/nested'],
      files: [{ path: 'src/app.js', bytes: 16, access: 'extended' }]
    });
    expect(bridge.listScopedWorkspaceEntries(fixture.home, 'src', 2).files.map(file => file.path))
      .toEqual(['src/app.js', 'src/nested/data.json']);
  });

  test('includes memory, hidden files, dependencies and internal symlinks in workspace listings', () => {
    const listing = bridge.listScopedWorkspaceEntries(fixture.home, '', 3);
    expect(listing.directories).toEqual(expect.arrayContaining(['.git', 'node_modules', 'linked', 'src', 'src/nested']));
    expect(listing.files.map(file => file.path)).toEqual(expect.arrayContaining(['.env', '.git/config', 'memory.md', 'README.md', 'src/app.js', 'src/nested/data.json', 'linked/app.js', 'node_modules/lib/index.js']));
  });

  test.each(['inspect', 'edit'])('reads with purpose=%s and reports whether a tab should open', purpose => {
    const onRead = jest.fn();
    const result = bridge.handleWorkspaceToolCall(fixture.home, {
      tool: 'codex_ide_workspace',
      arguments: JSON.stringify({ operation: 'read', path: 'src/app.js', purpose })
    }, { onRead });
    const file = JSON.parse(result.text).file;
    expect(result.success).toBe(true);
    expect(file).toMatchObject({ content: 'const value = 1;', purpose, openInEditor: purpose === 'edit', access: 'extended' });
    expect(onRead).toHaveBeenCalledWith(file);
  });

  test('lists through the dynamic tool and emits its result to the UI', () => {
    const onList = jest.fn();
    const result = bridge.handleWorkspaceToolCall(fixture.home, {
      tool: 'codex_ide_workspace', arguments: { operation: 'list', path: 'src', depth: 1 }
    }, { onList });
    expect(JSON.parse(result.text)).toMatchObject({ ok: true, scope: 'src', depth: 1 });
    expect(onList).toHaveBeenCalledTimes(1);
  });

  test.each([
    { tool: 'unknown', arguments: {} },
    { tool: 'codex_ide_workspace', arguments: 'invalid json' },
    { tool: 'codex_ide_workspace', arguments: [] },
    { tool: 'codex_ide_workspace', arguments: { operation: 'write', path: 'new.js' } },
    { tool: 'codex_ide_workspace', arguments: { operation: 'read', path: '../secret.txt' } }
  ])('rejects unsupported or unsafe tool arguments: %j', request => {
    expect(() => bridge.handleWorkspaceToolCall(fixture.home, request)).toThrow();
  });
});

describe('PDF workspace files', () => {
  const pdf = Buffer.from('%PDF-1.4\n% Test fixture\n%%EOF\n');

  test('round-trips PDF bytes without text conversion', () => {
    const written = bridge.writePdfModelFile(fixture.home, 'docs/sample.pdf', pdf.toString('base64'));
    expect(written).toEqual({ path: 'docs/sample.pdf', bytes: pdf.length, overwritten: false });
    expect(bridge.readPdfModelFile(fixture.home, written.path))
      .toEqual({ path: written.path, bytes: pdf.length, base64: pdf.toString('base64') });
  });

  test('requires explicit overwrite for an existing PDF', () => {
    fixture.write('sample.pdf', pdf);
    expect(() => bridge.writePdfModelFile(fixture.home, 'sample.pdf', pdf.toString('base64'))).toThrow();
    expect(bridge.writePdfModelFile(fixture.home, 'sample.pdf', pdf.toString('base64'), { overwrite: true }).overwritten).toBe(true);
  });

  test.each(['', 'not base64!', 'abc', Buffer.from('not a PDF').toString('base64')])
    ('rejects malformed PDF input: %s', base64 => {
      expect(() => bridge.writePdfModelFile(fixture.home, 'invalid.pdf', base64)).toThrow();
      expect(fs.existsSync(path.join(fixture.home, 'invalid.pdf'))).toBe(false);
    });

  test('enforces the size limit on reads and writes', () => {
    const large = Buffer.concat([pdf, Buffer.alloc(2048)]);
    fixture.write('large.pdf', large);
    expect(() => bridge.readPdfModelFile(fixture.home, 'large.pdf', { maxBytes: 1024 })).toThrow(/gross/);
    expect(() => bridge.writePdfModelFile(fixture.home, 'new.pdf', large.toString('base64'), { maxBytes: 1024 })).toThrow(/gross/);
  });
});

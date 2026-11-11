'use strict';

const fs = require('fs');
const path = require('path');
const { createFixture } = require('./helpers/fixture');
const { validateManifest, validateEntrypointPath, validateSkillDirectory, packSkillDirectory } = require('../scripts/skill-package');

function manifest() {
  return {
    schemaVersion: 1, id: 'test.example', name: 'Example', version: '1.0.0',
    profiles: ['local', 'api', 'codex'], entrypoint: 'index.js',
    permissions: [{ id: 'readFiles', label: { de: 'Dateien lesen', en: 'Read files' } }],
    setup: [{ id: 'mode', type: 'select', permission: 'readFiles', options: [{ value: 'read', label: 'Read' }] }],
    agent: {
      instructions: { en: 'Read the requested file.' },
      parameters: [{ id: 'operation', type: 'string', enum: ['read'] }],
      permissionRules: [{ parameter: 'operation', equals: 'read', permission: 'readFiles' }]
    }
  };
}

describe('skill manifest validation', () => {
  test('accepts a localized manifest with matching permissions and parameters', () => {
    expect(validateManifest(manifest())).toBe('index.js');
    expect(validateEntrypointPath('./src\\index.js')).toBe('src/index.js');
  });

  test.each([
    ['schema version', value => { value.schemaVersion = 2; }],
    ['reserved skill ID', value => { value.id = 'constructor'; }],
    ['invalid skill ID', value => { value.id = '../example'; }],
    ['missing name', value => { value.name = ''; }],
    ['invalid version', value => { value.version = 'latest'; }],
    ['unknown profile', value => { value.profiles = ['remote']; }],
    ['no profiles', value => { value.profiles = []; }],
    ['missing instructions', value => { value.agent.instructions = ''; }],
    ['duplicate permission', value => { value.permissions.push(value.permissions[0]); }],
    ['unknown setup permission', value => { value.setup[0].permission = 'writeFiles'; }],
    ['unsupported setup type', value => { value.setup[0].type = 'script'; }],
    ['empty select options', value => { value.setup[0].options = []; }],
    ['duplicate setup field', value => { value.setup.push(value.setup[0]); }],
    ['reserved agent parameter', value => { value.agent.parameters[0].id = 'skill'; }],
    ['unknown rule parameter', value => { value.agent.permissionRules[0].parameter = 'other'; }],
    ['wrong rule value type', value => { value.agent.permissionRules[0].equals = 1; }],
    ['rule value outside enum', value => { value.agent.permissionRules[0].equals = 'write'; }],
    ['duplicate rule', value => { value.agent.permissionRules.push(value.agent.permissionRules[0]); }],
    ['invalid integrity', value => { value.integrity = 'md5-untrusted'; }]
  ])('rejects %s', (_label, change) => {
    const value = manifest();
    change(value);
    expect(() => validateManifest(value)).toThrow();
  });

  test.each(['../index.js', 'src/../../index.js', '/tmp/index.js', 'C:\\temp\\index.js', 'https://example.test/index.js', 'index.js?x=1', 'index.js#fragment', 'index.ts'])
    ('rejects an unsafe entrypoint: %s', entrypoint => {
      expect(() => validateEntrypointPath(entrypoint)).toThrow();
    });

  test('rejects circular and oversized manifests', () => {
    const circular = manifest();
    circular.self = circular;
    expect(() => validateManifest(circular)).toThrow(/serialisierbar/);
    expect(() => validateManifest({ ...manifest(), padding: 'x'.repeat(250001) })).toThrow(/250.000/);
  });
});

describe('skill directory validation and packaging', () => {
  let fixture;
  beforeEach(() => {
    fixture = createFixture();
    fixture.write('manifest.json', JSON.stringify(manifest()));
    fixture.write('index.js', 'window.exampleSkill = { run() { return "Grüße 👋"; } };\n');
  });
  afterEach(() => fixture.dispose());

  test.each(['PDF_Skill', 'GitHub_Repo_Skill'])('validates the bundled %s package', name => {
    const skill = validateSkillDirectory(path.resolve(__dirname, '../skill_packages', name));
    expect(skill.entrypointSource.length).toBeGreaterThan(0);
    expect(skill.manifest.schemaVersion).toBe(1);
  });

  test('packs the validated manifest and exact source into a readable package', () => {
    const output = path.join(fixture.root, 'example.codexskill');
    expect(packSkillDirectory(fixture.home, output)).toEqual({ outputPath: output, manifest: manifest() });
    const payload = JSON.parse(fs.readFileSync(output, 'utf8'));
    expect(payload).toEqual({ packageVersion: 1, manifest: manifest(), entrypointSource: fixture.read('index.js') });
    expect(fs.statSync(output).mode & 0o777).toBe(0o600);
  });

  test('rejects malformed JSON, missing entrypoints and empty source', () => {
    fixture.write('manifest.json', '{invalid');
    expect(() => validateSkillDirectory(fixture.home)).toThrow(/manifest.json/);
    fixture.write('manifest.json', JSON.stringify({ ...manifest(), entrypoint: 'missing.js' }));
    expect(() => validateSkillDirectory(fixture.home)).toThrow(/entrypoint fehlt/);
    fixture.write('manifest.json', JSON.stringify(manifest()));
    fixture.write('index.js', '  \n');
    expect(() => validateSkillDirectory(fixture.home)).toThrow(/entrypoint ist leer/);
  });

  test('rejects an entrypoint symlink that escapes the skill directory', () => {
    const outside = fixture.write('outside.js', 'secret', fixture.root);
    fixture.write('manifest.json', JSON.stringify({ ...manifest(), entrypoint: 'linked.js' }));
    fs.symlinkSync(outside, path.join(fixture.home, 'linked.js'));
    expect(() => validateSkillDirectory(fixture.home)).toThrow(/Symlink/);
  });

  test('rejects invalid output extensions and symlink output without modifying its target', () => {
    expect(() => packSkillDirectory(fixture.home, path.join(fixture.root, 'package.json'))).toThrow(/codexskill/);
    const outside = fixture.write('original.txt', 'keep me', fixture.root);
    const output = path.join(fixture.root, 'linked.codexskill');
    fs.symlinkSync(outside, output);
    expect(() => packSkillDirectory(fixture.home, output)).toThrow(/Symlink/);
    expect(fs.readFileSync(outside, 'utf8')).toBe('keep me');
  });
});

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createFixture } = require('./helpers/fixture');

const filename = path.resolve(__dirname, '../scripts/codex-model-home.js');
const source = fs.readFileSync(filename, 'utf8');

function loadRuntime({ platform, env = {}, home, projectRoot, filesystem, paths }) {
  const pathApi = paths || (platform === 'win32' ? path.win32 : path.posix);
  const module = { exports: {} };
  vm.runInNewContext(source, {
    module,
    __dirname: pathApi.join(projectRoot, 'scripts'),
    process: { platform, env },
    require(name) {
      if (name === 'path') return pathApi;
      if (name === 'os') return { homedir: () => home };
      if (name === 'fs') return filesystem;
      throw new Error('Unexpected dependency: ' + name);
    }
  }, { filename });
  return module.exports;
}

describe('model-home platform paths', () => {
  test.each([
    ['Linux default', 'linux', '/home/ada', {}, '/home/ada/.local/share/codex-ide/model-home'],
    ['Linux XDG', 'linux', '/home/ada', { XDG_DATA_HOME: '/data/ada' }, '/data/ada/codex-ide/model-home'],
    ['Android Termux', 'android', '/data/data/com.termux/files/home', { TERMUX_VERSION: 'test' }, '/data/data/com.termux/files/home/.local/share/codex-ide/model-home'],
    ['Termux with a Linux Node build', 'linux', '/data/data/com.termux/files/home', { TERMUX_VERSION: 'test' }, '/data/data/com.termux/files/home/.local/share/codex-ide/model-home'],
    ['Android XDG', 'android', '/data/data/com.termux/files/home', { XDG_DATA_HOME: '/data/data/com.termux/files/home/data' }, '/data/data/com.termux/files/home/data/codex-ide/model-home'],
    ['macOS', 'darwin', '/Users/Ada Müller', { XDG_DATA_HOME: '/ignored' }, '/Users/Ada Müller/Library/Application Support/codex-ide/model-home'],
    ['Windows LOCALAPPDATA', 'win32', 'C:/Users/Ada Müller', { LOCALAPPDATA: 'C:/Users/Ada Müller/AppData/Local', APPDATA: 'C:/Users/Ada Müller/AppData/Roaming' }, 'C:/Users/Ada Müller/AppData/Local/codex-ide/model-home'],
    ['Windows APPDATA fallback', 'win32', 'C:/Users/Ada', { APPDATA: 'C:/Users/Ada/AppData/Roaming' }, 'C:/Users/Ada/AppData/Roaming/codex-ide/model-home'],
    ['Windows home fallback', 'win32', 'C:/Users/Ada', {}, 'C:/Users/Ada/AppData/Local/codex-ide/model-home'],
    ['Windows relative LOCALAPPDATA', 'win32', 'C:/Users/Ada', { LOCALAPPDATA: 'relative/cache', APPDATA: 'C:/Users/Ada/AppData/Roaming' }, 'C:/Users/Ada/AppData/Roaming/codex-ide/model-home'],
    ['Windows relative APPDATA', 'win32', 'C:/Users/Ada', { APPDATA: 'relative/cache' }, 'C:/Users/Ada/AppData/Local/codex-ide/model-home'],
    ['Windows UNC data directory', 'win32', 'C:/Users/Ada', { LOCALAPPDATA: '//server/users/Ada/AppData/Local' }, '//server/users/Ada/AppData/Local/codex-ide/model-home']
  ])('%s', (_name, platform, home, env, expected) => {
    const paths = platform === 'win32' ? path.win32 : path.posix;
    const filesystem = { existsSync: jest.fn(() => true) };
    const projectRoot = platform === 'win32'
      ? 'C:/Program Files/node_modules/codex-ide'
      : '/opt/lib/node_modules/codex-ide';
    const runtime = loadRuntime({ platform, env, home, projectRoot, filesystem });

    expect(runtime.getModelHomeDir()).toBe(paths.normalize(expected));
    expect(paths.isAbsolute(runtime.getModelHomeDir())).toBe(true);
  });

  test.each(['linux', 'android', 'darwin', 'win32'])('keeps explicit and source-checkout paths on %s', platform => {
    const windows = platform === 'win32';
    const projectRoot = windows ? 'D:/Projects/Codex IDE' : '/projects/Codex IDE';
    const custom = windows ? 'D:/Workspace/Custom' : '/workspace/custom';
    const paths = windows ? path.win32 : path.posix;
    const runtime = loadRuntime({ platform, env: {}, home: '', projectRoot, filesystem: {} });
    expect(runtime.getModelHomeDir()).toBe(paths.join(projectRoot, 'model-home'));
    expect(runtime.getModelHomeDir({ modelHome: custom })).toBe(paths.normalize(custom));
  });
});

describe('Windows workspace migration policy on the host filesystem', () => {
  let fixture;
  beforeEach(() => { fixture = createFixture(); });
  afterEach(() => fixture.dispose());

  test('recreates directory junctions with an absolute target inside the new workspace', () => {
    const projectRoot = path.join(fixture.root, 'node_modules/codex-ide');
    const legacy = path.join(projectRoot, 'model-home');
    fixture.write('src/app.js', 'original', legacy);
    fs.symlinkSync(path.join(legacy, 'src'), path.join(legacy, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    const filesystem = { ...fs, symlinkSync: jest.fn((...args) => fs.symlinkSync(...args)) };
    const runtime = loadRuntime({
      platform: 'win32', env: { LOCALAPPDATA: path.join(fixture.root, 'data') }, home: fixture.root,
      projectRoot, filesystem, paths: path
    });

    const home = runtime.getModelHomeDir();

    expect(filesystem.symlinkSync).toHaveBeenCalledWith(path.join(home, 'src'), expect.any(String), 'junction');
    fs.writeFileSync(path.join(home, 'linked/app.js'), 'saved');
    expect(fs.readFileSync(path.join(home, 'src/app.js'), 'utf8')).toBe('saved');
    expect(fs.readFileSync(path.join(legacy, 'src/app.js'), 'utf8')).toBe('original');
  });
});

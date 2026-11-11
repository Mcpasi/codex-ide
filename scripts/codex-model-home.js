'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');

function userDataDirectory() {
  if (process.platform === 'win32') {
    return [process.env.LOCALAPPDATA, process.env.APPDATA].find(value => value && path.isAbsolute(value)) ||
      path.join(os.homedir(), 'AppData', 'Local');
  }
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support');
  const configured = process.env.XDG_DATA_HOME;
  return configured && path.isAbsolute(configured) ? configured : path.join(os.homedir(), '.local', 'share');
}

function relativePath(root, target) {
  // Windows links can use a \\?\ namespace while the installation path does not.
  return path.relative(path.toNamespacedPath(root), path.toNamespacedPath(target));
}

function isWithin(root, target) {
  const relative = relativePath(root, target);
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

function prepareWorkspaceCopy(source, directory, legacyRoots, destination, relative = '') {
  const original = path.join(source, relative);
  const target = path.join(directory, relative);
  const stat = fs.lstatSync(original);
  if (stat.isSymbolicLink()) {
    const link = fs.readlinkSync(original);
    const absolute = path.resolve(path.dirname(original), link);
    const root = legacyRoots.find(legacy => isWithin(legacy, absolute));
    const relocated = root ? path.join(destination, relativePath(root, absolute)) : absolute;
    let type = 'file';
    if (process.platform === 'win32') {
      try {
        if (fs.statSync(original).isDirectory()) type = 'junction';
      } catch (error) {
        if (!['ENOENT', 'ENOTDIR', 'ELOOP'].includes(error.code)) throw error;
      }
    }
    // Junctions need an absolute target and work without file-symlink privileges.
    const linkDirectory = path.dirname(path.join(destination, relative));
    const relocatedLink = root ? path.relative(linkDirectory, relocated) || '.' : link;
    fs.symlinkSync(type === 'junction' ? relocated : relocatedLink, target, type);
  } else if (stat.isDirectory()) {
    fs.chmodSync(target, (stat.mode & 0o777) | 0o700);
    for (const name of fs.readdirSync(original)) {
      prepareWorkspaceCopy(source, directory, legacyRoots, destination, path.join(relative, name));
    }
  } else if (stat.isFile()) {
    // npm can leave 0444 files and 0555 directories; the user's copy is editable.
    fs.chmodSync(target, (stat.mode & 0o777) | 0o600);
  }
}

function makeDirectoriesWritable(directory) {
  const stat = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (!stat || !stat.isDirectory()) return;
  fs.chmodSync(directory, (stat.mode & 0o777) | 0o700);
  for (const name of fs.readdirSync(directory)) makeDirectoriesWritable(path.join(directory, name));
}

function initializeInstalledWorkspace(legacyHome, home) {
  if (fs.existsSync(home)) return home;
  const parent = path.dirname(home);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const temporary = fs.mkdtempSync(path.join(parent, '.model-home-'));
  const copy = path.join(temporary, 'model-home');
  try {
    if (fs.existsSync(legacyHome)) {
      const source = fs.realpathSync(legacyHome);
      // Copy ordinary entries first; recreate links with the right Windows type
      // and final target instead of copying junctions as privileged dir symlinks.
      fs.cpSync(source, copy, {
        recursive: true,
        filter: entry => !fs.lstatSync(entry).isSymbolicLink()
      });
      prepareWorkspaceCopy(source, copy, [legacyHome, source], home);
    } else {
      fs.mkdirSync(copy, { mode: 0o700 });
    }
    try {
      // Publish only a complete copy. A failed migration leaves the legacy data intact.
      fs.renameSync(copy, home);
    } catch (error) {
      // Another gateway may have initialized the same per-user workspace first.
      if (!['EEXIST', 'ENOTEMPTY'].includes(error.code) || !fs.statSync(home).isDirectory()) throw error;
    }
  } finally {
    // A failed cp can leave copied 0555 directories. Never follow symlinks here.
    makeDirectoriesWritable(copy);
    fs.rmSync(temporary, { recursive: true, force: true });
  }
  return home;
}

function getModelHomeDir(options = {}) {
  const configured = options.modelHome || options.workdir ||
    process.env.CODEX_IDE_MODEL_HOME || process.env.CODEX_BRIDGE_MODEL_HOME || process.env.CODEX_BRIDGE_WORKDIR;
  if (configured) return path.resolve(String(configured));

  const legacyHome = path.join(PROJECT_ROOT, 'model-home');
  if (path.basename(path.dirname(PROJECT_ROOT)).toLowerCase() !== 'node_modules') return legacyHome;

  // Installed application code may be owned by root; persistent user data must not be.
  const home = path.join(userDataDirectory(), 'codex-ide', 'model-home');
  return initializeInstalledWorkspace(legacyHome, home);
}

module.exports = { getModelHomeDir };

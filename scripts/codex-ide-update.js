#!/usr/bin/env node
'use strict';

const { execFile, spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const MODEL_HOME_NAME = 'model-home';
const DEFAULT_CHECK_TIMEOUT_MS = 20000;

function getNpmBin(options = {}) {
  return options.npmBin || (process.platform === 'win32' ? 'npm.cmd' : 'npm');
}

function parseSemver(value) {
  const text = String(value || '').trim();
  const match = text.match(/^(?:v)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/);
  if (!match) return null;
  return {
    raw: text.replace(/^v/, ''),
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : []
  };
}

function comparePrerelease(left, right) {
  if (!left.length && !right.length) return 0;
  if (!left.length) return 1;
  if (!right.length) return -1;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (index >= left.length) return -1;
    if (index >= right.length) return 1;
    const a = left[index];
    const b = right[index];
    if (a === b) continue;
    const aNumeric = /^\d+$/.test(a);
    const bNumeric = /^\d+$/.test(b);
    if (aNumeric && bNumeric) return Number(a) < Number(b) ? -1 : 1;
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    return a < b ? -1 : 1;
  }
  return 0;
}

function compareVersions(leftValue, rightValue) {
  const left = parseSemver(leftValue);
  const right = parseSemver(rightValue);
  if (!left || !right) throw new Error('Ungueltige semantische Version');
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  return comparePrerelease(left.prerelease, right.prerelease);
}

function readPackageInfo(packageRoot = PROJECT_ROOT) {
  const manifestPath = path.join(packageRoot, 'package.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const name = String(manifest.name || '').trim();
  const version = String(manifest.version || '').trim();
  if (!name || !parseSemver(version)) throw new Error('package.json enthaelt keinen gueltigen Paketnamen und keine gueltige Version');
  return { name, version, manifestPath };
}

function describeExecFileError(error, stdout, stderr, timeoutMs) {
  const stderrText = String(stderr || '').trim();
  if (stderrText) return stderrText;
  if (error && (error.killed || error.signal === 'SIGTERM' || error.code === 'ETIMEDOUT')) {
    return `npm-Abfrage hat nach ${Math.round(timeoutMs / 1000)} Sekunden kein Ergebnis geliefert`;
  }
  const message = String(error && error.message || '').trim();
  const withoutWrapper = message.replace(/^Command failed:\s*[^\r\n]*(?:\r?\n|$)/, '').trim();
  if (withoutWrapper) return withoutWrapper;
  if (error && error.code) return `npm konnte nicht erfolgreich ausgefuehrt werden (${error.code})`;
  if (String(stdout || '').trim()) return String(stdout || '').trim();
  return 'npm konnte nicht erfolgreich ausgefuehrt werden';
}

function execFileText(bin, args, options = {}) {
  const execFileImpl = options.execFileImpl || execFile;
  const timeoutMs = options.timeoutMs || DEFAULT_CHECK_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    execFileImpl(bin, args, {
      cwd: options.cwd || PROJECT_ROOT,
      env: options.env || process.env,
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024
    }, (error, stdout, stderr) => {
      if (error) {
        const detail = describeExecFileError(error, stdout, stderr, timeoutMs);
        reject(new Error(detail || 'npm konnte nicht ausgefuehrt werden'));
        return;
      }
      resolve(String(stdout || '').trim());
    });
  });
}

async function getLatestVersion(packageName, options = {}) {
  const output = await execFileText(getNpmBin(options), [
    'view', packageName, 'dist-tags.latest', '--json'
  ], options);
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch (_) {
    parsed = output;
  }
  const candidate = Array.isArray(parsed) ? parsed[parsed.length - 1] : parsed;
  const version = String(candidate || '').trim();
  if (!parseSemver(version)) throw new Error('npm hat keine gueltige aktuelle Version geliefert');
  return version.replace(/^v/, '');
}

function packagePathFromGlobalRoot(globalRoot, packageName) {
  return path.resolve(globalRoot, ...String(packageName).split('/'));
}

async function resolveGlobalPackageRoot(packageName, options = {}) {
  if (options.globalRoot) return packagePathFromGlobalRoot(options.globalRoot, packageName);
  const globalRoot = await execFileText(getNpmBin(options), ['root', '--global'], options);
  if (!globalRoot) throw new Error('Das globale npm-Paketverzeichnis konnte nicht ermittelt werden');
  return packagePathFromGlobalRoot(globalRoot, packageName);
}

function pathsEqual(left, right) {
  const normalize = value => {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

function looksLikeNpmInstallation(packageRoot = PROJECT_ROOT) {
  const parent = path.dirname(path.resolve(packageRoot));
  return path.basename(parent).toLowerCase() === 'node_modules';
}

function workspacePathFor(packageRoot) {
  return path.join(path.resolve(packageRoot), MODEL_HOME_NAME);
}

function assertWorkspaceTarget(packageRoot, workspacePath) {
  const expected = workspacePathFor(packageRoot);
  if (!pathsEqual(expected, workspacePath)) {
    throw new Error('Der Update-Workspace liegt nicht am festen Codex-IDE-Projektpfad');
  }
}

function workspaceRecords(root) {
  const absoluteRoot = path.resolve(root);
  if (!fs.existsSync(absoluteRoot)) return [];
  const records = [];

  function visit(relativeDirectory) {
    const directory = path.join(absoluteRoot, relativeDirectory);
    const entries = fs.readdirSync(directory).sort((left, right) => left.localeCompare(right));
    for (const name of entries) {
      const relativePath = path.join(relativeDirectory, name);
      const absolutePath = path.join(absoluteRoot, relativePath);
      const stat = fs.lstatSync(absolutePath);
      const normalized = relativePath.replace(/\\/g, '/');
      if (stat.isDirectory()) {
        records.push(`d:${normalized}:${stat.mode & 0o7777}`);
        visit(relativePath);
      } else if (stat.isFile()) {
        const hash = crypto.createHash('sha256').update(fs.readFileSync(absolutePath)).digest('hex');
        records.push(`f:${normalized}:${stat.mode & 0o7777}:${stat.size}:${hash}`);
      } else if (stat.isSymbolicLink()) {
        records.push(`l:${normalized}:${fs.readlinkSync(absolutePath)}`);
      } else {
        throw new Error(`Nicht unterstuetzter Workspace-Eintrag: ${normalized}`);
      }
    }
  }

  visit('');
  return records;
}

function workspaceDigest(root) {
  return crypto.createHash('sha256').update(JSON.stringify(workspaceRecords(root))).digest('hex');
}

function backupWorkspace(packageRoot, temporaryRoot) {
  const workspacePath = workspacePathFor(packageRoot);
  assertWorkspaceTarget(packageRoot, workspacePath);
  fs.mkdirSync(workspacePath, { recursive: true });
  const backupPath = path.join(temporaryRoot, 'workspace-backup');
  const expectedDigest = workspaceDigest(workspacePath);
  fs.cpSync(workspacePath, backupPath, {
    recursive: true,
    dereference: false,
    verbatimSymlinks: true,
    preserveTimestamps: true,
    errorOnExist: true
  });
  if (workspaceDigest(backupPath) !== expectedDigest) {
    throw new Error('Die temporaere Workspace-Sicherung konnte nicht verifiziert werden');
  }
  return { backupPath, expectedDigest, workspacePath };
}

function restoreWorkspace(packageRoot, backup) {
  const workspacePath = workspacePathFor(packageRoot);
  assertWorkspaceTarget(packageRoot, workspacePath);
  if (!backup || !backup.backupPath || !fs.existsSync(backup.backupPath)) {
    throw new Error('Die verifizierte Workspace-Sicherung fehlt');
  }
  if (workspaceDigest(backup.backupPath) !== backup.expectedDigest) {
    throw new Error('Die Workspace-Sicherung wurde vor der Wiederherstellung veraendert');
  }
  fs.rmSync(workspacePath, { recursive: true, force: true });
  fs.cpSync(backup.backupPath, workspacePath, {
    recursive: true,
    dereference: false,
    verbatimSymlinks: true,
    preserveTimestamps: true,
    errorOnExist: true
  });
  if (workspaceDigest(workspacePath) !== backup.expectedDigest) {
    throw new Error('Der Workspace konnte nach dem Update nicht vollstaendig wiederhergestellt werden');
  }
  return workspacePath;
}

function runGlobalInstall(packageSpec, options = {}) {
  const spawnImpl = options.spawnImpl || spawn;
  return new Promise((resolve, reject) => {
    const child = spawnImpl(getNpmBin(options), [
      'install', '--global', packageSpec, '--no-audit', '--no-fund'
    ], {
      cwd: options.cwd || PROJECT_ROOT,
      env: options.env || process.env,
      stdio: options.stdio || 'inherit'
    });
    child.on('error', reject);
    child.on('exit', code => resolve(code == null ? 1 : code));
  });
}

async function performSelfUpdate(targetVersion, options = {}) {
  const logger = options.logger || console;
  const packageRoot = path.resolve(options.packageRoot || PROJECT_ROOT);
  const packageInfo = options.packageInfo || readPackageInfo(packageRoot);
  if (!parseSemver(targetVersion)) throw new Error('Die angeforderte Updateversion ist ungueltig');
  const globalPackageRoot = options.globalPackageRoot || await resolveGlobalPackageRoot(packageInfo.name, options);
  if (!pathsEqual(packageRoot, globalPackageRoot)) {
    throw new Error('Das Selbstupdate ist nur fuer die globale npm-Installation verfuegbar');
  }

  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-ide-update-'));
  let backup;
  try {
    backup = backupWorkspace(packageRoot, temporaryRoot);
  } catch (error) {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
    throw error;
  }

  if (logger && typeof logger.log === 'function') {
    logger.log('[codex-ide] Workspace fuer das Update verifiziert und temporaer gesichert.');
  }

  let installError = null;
  try {
    const installRunner = options.installRunner || runGlobalInstall;
    const code = await installRunner(`${packageInfo.name}@${targetVersion}`, {
      ...options,
      cwd: packageRoot
    });
    if (code !== 0) installError = new Error(`npm-Update fehlgeschlagen (Exit-Code ${code})`);
  } catch (error) {
    installError = error;
  }

  try {
    restoreWorkspace(globalPackageRoot, backup);
  } catch (restoreError) {
    const error = new Error(`${restoreError.message}. Die unveraenderte Sicherung bleibt erhalten: ${backup.backupPath}`);
    error.cause = restoreError;
    throw error;
  }

  if (installError) {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
    throw new Error(`${installError.message}. Der Workspace wurde am festen Projektpfad wiederhergestellt.`);
  }

  let installedVersion;
  try {
    installedVersion = readPackageInfo(globalPackageRoot).version;
  } catch (error) {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
    throw new Error(`Das aktualisierte Paket konnte nicht verifiziert werden: ${error.message}`);
  }
  if (compareVersions(installedVersion, targetVersion) !== 0) {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
    throw new Error(`npm meldete Erfolg, installiert ist jedoch Version ${installedVersion} statt ${targetVersion}`);
  }

  fs.rmSync(temporaryRoot, { recursive: true, force: true });
  if (logger && typeof logger.log === 'function') {
    logger.log(`[codex-ide] Update auf Version ${installedVersion} abgeschlossen.`);
    logger.log('[codex-ide] model-home wurde unveraendert am festen Projektpfad wiederhergestellt.');
    logger.log('[codex-ide] Starte Codex IDE jetzt neu.');
  }
  return { updated: true, version: installedVersion };
}

function confirmUpdate(question, options = {}) {
  if (options.yes) return Promise.resolve(true);
  const input = options.stdin || process.stdin;
  const output = options.stdout || process.stdout;
  if (!input || !output || !input.isTTY || !output.isTTY) return Promise.resolve(false);
  const createInterface = options.createInterface || readline.createInterface;
  return new Promise(resolve => {
    const prompt = createInterface({ input, output });
    prompt.question(question, answer => {
      prompt.close();
      resolve(/^(?:j|ja|y|yes)$/i.test(String(answer || '').trim()));
    });
  });
}

async function runUpdateCommand(flags = {}, options = {}) {
  const logger = options.logger || console;
  const packageRoot = path.resolve(options.packageRoot || PROJECT_ROOT);
  const packageInfo = options.packageInfo || readPackageInfo(packageRoot);
  let latestVersion;
  try {
    latestVersion = options.latestVersion || await getLatestVersion(packageInfo.name, options);
  } catch (error) {
    if (logger && typeof logger.error === 'function') logger.error(`[codex-ide] Update-Pruefung fehlgeschlagen: ${error.message}`);
    return 1;
  }

  if (logger && typeof logger.log === 'function') {
    logger.log(`[codex-ide] Installiert: ${packageInfo.version}`);
    logger.log(`[codex-ide] Verfuegbar: ${latestVersion}`);
  }
  if (compareVersions(latestVersion, packageInfo.version) <= 0) {
    if (logger && typeof logger.log === 'function') logger.log('[codex-ide] Codex IDE ist aktuell.');
    return 0;
  }

  let globalPackageRoot;
  try {
    globalPackageRoot = options.globalPackageRoot || await resolveGlobalPackageRoot(packageInfo.name, options);
  } catch (error) {
    if (logger && typeof logger.error === 'function') logger.error(`[codex-ide] Globale npm-Installation konnte nicht geprueft werden: ${error.message}`);
    return 1;
  }
  if (!pathsEqual(packageRoot, globalPackageRoot)) {
    if (logger && typeof logger.error === 'function') {
      logger.error(`[codex-ide] Diese Kopie ist nicht global installiert. Verwende: npm install -g ${packageInfo.name}@${latestVersion}`);
    }
    return 1;
  }

  const accepted = await (options.confirmUpdate || confirmUpdate)(
    `[codex-ide] Version ${latestVersion} ist verfuegbar. Jetzt herunterladen? (j/N) `,
    { ...options, yes: !!flags.yes }
  );
  if (!accepted) {
    if (logger && typeof logger.log === 'function') logger.log('[codex-ide] Update abgebrochen.');
    return 0;
  }

  try {
    await performSelfUpdate(latestVersion, {
      ...options,
      logger,
      packageRoot,
      packageInfo,
      globalPackageRoot
    });
    if (options.result && typeof options.result === 'object') {
      options.result.updated = true;
      options.result.version = latestVersion;
    }
    return 0;
  } catch (error) {
    if (logger && typeof logger.error === 'function') logger.error(`[codex-ide] ${error.message}`);
    return 1;
  }
}

async function offerUpdateBeforeStart(flags = {}, options = {}) {
  if (flags.noUpdateCheck || process.env.CODEX_IDE_NO_UPDATE_CHECK === '1') return { checked: false };
  const input = options.stdin || process.stdin;
  const output = options.stdout || process.stdout;
  const packageRoot = path.resolve(options.packageRoot || PROJECT_ROOT);
  if (!input || !output || !input.isTTY || !output.isTTY || !looksLikeNpmInstallation(packageRoot)) {
    return { checked: false };
  }

  const packageInfo = options.packageInfo || readPackageInfo(packageRoot);
  let globalPackageRoot;
  try {
    globalPackageRoot = options.globalPackageRoot || await resolveGlobalPackageRoot(packageInfo.name, options);
  } catch (_) {
    return { checked: false };
  }
  if (!pathsEqual(packageRoot, globalPackageRoot)) return { checked: false };

  let latestVersion;
  try {
    latestVersion = options.latestVersion || await getLatestVersion(packageInfo.name, options);
  } catch (_) {
    return { checked: true, available: false };
  }
  if (compareVersions(latestVersion, packageInfo.version) <= 0) {
    return { checked: true, available: false };
  }

  const result = {};
  const code = await runUpdateCommand(flags, {
    ...options,
    packageRoot,
    packageInfo,
    latestVersion,
    globalPackageRoot,
    result
  });
  return { checked: true, available: true, updated: result.updated === true, code };
}

module.exports = {
  DEFAULT_CHECK_TIMEOUT_MS,
  MODEL_HOME_NAME,
  PROJECT_ROOT,
  assertWorkspaceTarget,
  backupWorkspace,
  compareVersions,
  confirmUpdate,
  getLatestVersion,
  looksLikeNpmInstallation,
  offerUpdateBeforeStart,
  packagePathFromGlobalRoot,
  parseSemver,
  pathsEqual,
  performSelfUpdate,
  readPackageInfo,
  resolveGlobalPackageRoot,
  restoreWorkspace,
  runGlobalInstall,
  runUpdateCommand,
  workspaceDigest,
  workspacePathFor,
  workspaceRecords
};

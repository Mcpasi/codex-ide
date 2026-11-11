#!/usr/bin/env node
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');
const {
  DEFAULT_HOST,
  DEFAULT_PORT,
  getGatewayUrl,
  openUrl,
  startGateway
} = require('./codex-ide-gateway');
const {
  runCodexLoginStatus
} = require('./codex-bridge');
const {
  packSkillDirectory,
  validateSkillDirectory
} = require('./skill-package');
const {
  offerUpdateBeforeStart,
  readPackageInfo,
  runUpdateCommand
} = require('./codex-ide-update');

const PROJECT_ROOT = path.resolve(__dirname, '..');

function resolveSkillDirectoryArg(directory) {
  const value = String(directory || '').trim();
  const fromCwd = path.resolve(value || '.');
  if (fs.existsSync(fromCwd)) return fromCwd;

  if (!path.isAbsolute(value)) {
    const fromProject = path.resolve(PROJECT_ROOT, value);
    if (fs.existsSync(fromProject)) return fromProject;
  }

  const normalized = value.replace(/\\/g, '/');
  if (/^\/skill_packages(?:\/|$)/.test(normalized)) {
    const fromProjectAlias = path.resolve(PROJECT_ROOT, normalized.replace(/^\/+/, ''));
    if (fs.existsSync(fromProjectAlias)) return fromProjectAlias;
  }

  return fromCwd;
}

function printUsage(logger = console) {
  logger.log([
    'Codex IDE Gateway CLI',
    '',
    'Nutzung:',
    '  codex-ide start     [--host 127.0.0.1] [--port 8787] [--no-open] [--no-update-check]',
    '  codex-ide gateway   [--host 127.0.0.1] [--port 8787] [--open]',
    '  codex-ide clean     [--host 127.0.0.1] [--port 8787]',
    '  codex-ide version',
    '  codex-ide update    [--yes]',
    '  codex-ide codex login',
    '  codex-ide codex login --device-auth',
    '  codex-ide codex status',
    '  codex-ide skill validate <skill-ordner>',
    '  codex-ide skill pack <skill-ordner> [ausgabe.codexskill]',
    '',
    'Weitere Gateway- und Auth-Befehle:',
    '  codex-ide bridge [--open]             # Gateway-Alias',
    '  codex-ide codex gateway [--open]      # Gateway im Codex-Namensraum',
    '  codex-ide codex bridge [--open]       # Bridge-Alias',
    '  codex-ide codex login-device          # Device-Auth-Alias',
    '  codex-ide codex signin                # Login-Alias',
    '',
    'Lokale Entwicklung ohne globale Installation:',
    '  ./codex-ide start'
  ].join('\n'));
}

function parseArgs(argv) {
  const positionals = [];
  const flags = {};
  function readOptionValue(index) {
    const value = argv[index + 1];
    if (typeof value !== 'string' || !value || value.charAt(0) === '-') {
      return { value: undefined, consumed: false };
    }
    return { value, consumed: true };
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      flags.help = true;
    } else if (arg === '--version' || arg === '-v') {
      flags.version = true;
    } else if (arg === '--open') {
      flags.open = true;
    } else if (arg === '--no-open') {
      flags.noOpen = true;
    } else if (arg === '--no-update-check') {
      flags.noUpdateCheck = true;
    } else if (arg === '--yes' || arg === '-y') {
      flags.yes = true;
    } else if (arg === '--device-auth') {
      flags.deviceAuth = true;
    } else if (arg === '--host') {
      const next = readOptionValue(i);
      if (next.consumed) {
        flags.host = next.value;
        i += 1;
      }
    } else if (arg && arg.startsWith('--host=')) {
      flags.host = arg.slice('--host='.length);
    } else if (arg === '--port') {
      const next = readOptionValue(i);
      if (next.consumed) {
        flags.port = next.value;
        i += 1;
      }
    } else if (arg && arg.startsWith('--port=')) {
      flags.port = arg.slice('--port='.length);
    } else {
      positionals.push(arg);
    }
  }
  return { positionals, flags };
}

function runCodexLogin(options = {}) {
  return new Promise((resolve, reject) => {
    const spawnImpl = options.spawnImpl || spawn;
    const args = [
      'login',
      '-c',
      'cli_auth_credentials_store="auto"'
    ];
    if (options.deviceAuth) args.push('--device-auth');

    const child = spawnImpl(options.codexBin || process.env.CODEX_BIN || 'codex', args, {
      stdio: options.stdio || 'inherit',
      env: process.env
    });

    child.on('error', reject);
    child.on('exit', code => resolve(code == null ? 1 : code));
  });
}

async function runCodexStatus(options = {}) {
  const logger = options.logger || console;
  const status = await runCodexLoginStatus(options);
  if (logger && typeof logger.log === 'function') {
    logger.log(status.message);
    if (status.raw) logger.log(status.raw);
  }
  return status.loggedIn ? 0 : 1;
}

function isGatewayReachable(baseUrl, options = {}) {
  const requestImpl = options.requestImpl || http.get;
  const timeoutMs = options.timeoutMs || 800;
  return new Promise(resolve => {
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let request;
    try {
      request = requestImpl(new URL('health', baseUrl), response => {
        if (response && typeof response.resume === 'function') response.resume();
        finish(!!response && response.statusCode === 200);
      });
    } catch (_) {
      finish(false);
      return;
    }
    if (request && typeof request.setTimeout === 'function') {
      request.setTimeout(timeoutMs, () => {
        if (typeof request.destroy === 'function') request.destroy();
        finish(false);
      });
    }
    if (request && typeof request.on === 'function') request.on('error', () => finish(false));
  });
}

async function runClean(flags = {}, options = {}) {
  const logger = options.logger || console;
  const host = flags.host || DEFAULT_HOST;
  const port = flags.port || DEFAULT_PORT;
  const baseUrl = getGatewayUrl(host, port);
  const cleanUrl = new URL('?codex-ide-clean=1', baseUrl).toString();
  const probe = options.probeGateway || isGatewayReachable;
  const launch = () => {
    const opened = (options.openUrl || openUrl)(cleanUrl, options);
    if (logger && typeof logger.log === 'function') {
      logger.log('[codex-ide] App-Cache und Service Worker werden bereinigt; Einstellungen und Skill-Zustand bleiben erhalten.');
      logger.log(`[codex-ide] Clean-URL: ${cleanUrl}`);
      if (!opened) logger.log('[codex-ide] Oeffne die Clean-URL manuell im Browser.');
    }
  };

  if (await probe(baseUrl, options)) {
    launch();
    if (logger && typeof logger.log === 'function') {
      logger.log('[codex-ide] Falls das Gateway bereits vor einem Update lief, danach beenden und neu starten.');
    }
    return 0;
  }

  startGateway({
    host,
    port,
    openIde: false,
    logger,
    spawnImpl: options.spawnImpl,
    onListening: launch,
    onError: options.onError || (() => process.exit(1))
  });
  return 0;
}

function startCliGateway(flags, openIde, options = {}) {
  const startGatewayImpl = options.startGateway || startGateway;
  return startGatewayImpl({
    host: flags.host || DEFAULT_HOST,
    port: flags.port || DEFAULT_PORT,
    openIde,
    logger: options.logger || console,
    spawnImpl: options.spawnImpl,
    onError: options.onError || (() => process.exit(1))
  });
}

async function main(argv = process.argv.slice(2), options = {}) {
  const logger = options.logger || console;
  const parsed = parseArgs(argv);
  const command = String(parsed.positionals[0] || '').toLowerCase();
  const subcommand = String(parsed.positionals[1] || '').toLowerCase();

  if (parsed.flags.version || command === 'version') {
    const packageInfo = (options.readPackageInfo || readPackageInfo)(PROJECT_ROOT);
    logger.log(`codex-ide ${packageInfo.version}`);
    return 0;
  }

  if (!command || parsed.flags.help) {
    printUsage(logger);
    return 0;
  }

  if (command === 'start') {
    const updateOffer = options.offerUpdateBeforeStart || offerUpdateBeforeStart;
    const updateResult = await updateOffer(parsed.flags, {
      ...options,
      logger,
      packageRoot: PROJECT_ROOT
    });
    if (updateResult && updateResult.code && updateResult.code !== 0) return updateResult.code;
    if (updateResult && updateResult.updated) return 0;
    startCliGateway(parsed.flags, !parsed.flags.noOpen, options);
    return 0;
  }

  if (command === 'update') {
    const updateCommand = options.runUpdateCommand || runUpdateCommand;
    return updateCommand(parsed.flags, {
      ...options,
      logger,
      packageRoot: PROJECT_ROOT
    });
  }

  if (command === 'gateway' || command === 'bridge') {
    startCliGateway(parsed.flags, !!parsed.flags.open, options);
    return 0;
  }

  if (command === 'clean') {
    return runClean(parsed.flags, options);
  }

  if (command === 'codex') {
    if (subcommand === 'login' || subcommand === 'signin' || subcommand === 'sign-in') {
      return runCodexLogin({
        deviceAuth: parsed.flags.deviceAuth,
        spawnImpl: options.spawnImpl,
        stdio: options.stdio,
        codexBin: options.codexBin
      });
    }
    if (subcommand === 'login-device' || subcommand === 'device-login') {
      return runCodexLogin({
        deviceAuth: true,
        spawnImpl: options.spawnImpl,
        stdio: options.stdio,
        codexBin: options.codexBin
      });
    }
    if (subcommand === 'status') {
      return runCodexStatus({
        logger,
        codexBin: options.codexBin,
        spawnImpl: options.spawnImpl,
        timeoutMs: options.timeoutMs
      });
    }
    if (subcommand === 'gateway' || subcommand === 'bridge') {
      startCliGateway(parsed.flags, !!parsed.flags.open, options);
      return 0;
    }
  }

  if (command === 'skill') {
    const directoryArg = parsed.positionals[2];
    if (!directoryArg) {
      logger.log('[codex-ide] Skill-Ordner fehlt.');
      printUsage(logger);
      return 1;
    }
    const directory = resolveSkillDirectoryArg(directoryArg);
    if (subcommand === 'validate') {
      const skill = validateSkillDirectory(directory);
      logger.log(`[codex-ide] Skill gueltig: ${skill.manifest.id}@${skill.manifest.version}`);
      return 0;
    }
    if (subcommand === 'pack') {
      const packed = packSkillDirectory(directory, parsed.positionals[3]);
      logger.log(`[codex-ide] Offline-Paket erstellt: ${packed.outputPath}`);
      return 0;
    }
  }

  printUsage(logger);
  return 1;
}

if (require.main === module) {
  main().then(code => {
    if (code) process.exit(code);
  }).catch(err => {
    console.error(err && err.message ? err.message : String(err));
    process.exit(1);
  });
}

module.exports = {
  main,
  resolveSkillDirectoryArg,
  parseArgs,
  printUsage,
  isGatewayReachable,
  runClean,
  runCodexLogin,
  runCodexStatus
};

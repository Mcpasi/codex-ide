#!/usr/bin/env node
'use strict';

const { spawn } = require('child_process');
const path = require('path');
const {
  createServer,
  getModelHomeDir
} = require('./codex-bridge');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8787;

function normalizeHost(host) {
  const value = String(host || '').trim();
  return value || DEFAULT_HOST;
}

function normalizePort(port) {
  const n = Number(port);
  if (!Number.isFinite(n) || n <= 0 || n > 65535) return DEFAULT_PORT;
  return Math.round(n);
}

function displayHost(host) {
  return host === '127.0.0.1' || host === '::1' || host === '[::1]' ? 'localhost' : host;
}

function getGatewayUrl(host, port) {
  return `http://${displayHost(host)}:${port}/`;
}

function isLoopbackBind(host) {
  const value = String(host || '').trim().toLowerCase();
  return value === 'localhost' ||
    value === '::1' ||
    value === '[::1]' ||
    /^127(?:\.\d{1,3}){3}$/.test(value);
}

function createGatewayServer(options = {}) {
  return createServer({
    ...options,
    serviceName: options.serviceName || 'codex-ide-gateway',
    staticRoot: options.staticRoot || PROJECT_ROOT
  });
}

function openUrl(url, options = {}) {
  const platform = options.platform || process.platform;
  const spawnImpl = options.spawnImpl || spawn;
  let command;
  let args;

  if (platform === 'darwin') {
    command = 'open';
    args = [url];
  } else if (platform === 'win32') {
    command = 'cmd';
    args = ['/c', 'start', '', url];
  } else if (process.env.TERMUX_VERSION || process.env.PREFIX) {
    command = 'termux-open-url';
    args = [url];
  } else {
    command = 'xdg-open';
    args = [url];
  }

  try {
    const child = spawnImpl(command, args, {
      detached: true,
      stdio: 'ignore'
    });
    if (child && typeof child.on === 'function') child.on('error', () => {});
    if (child && typeof child.unref === 'function') child.unref();
    return true;
  } catch (_) {
    return false;
  }
}

function startGateway(options = {}) {
  const host = normalizeHost(options.host || process.env.CODEX_IDE_GATEWAY_HOST || process.env.CODEX_BRIDGE_HOST);
  const port = normalizePort(options.port || process.env.CODEX_IDE_GATEWAY_PORT || process.env.CODEX_BRIDGE_PORT);
  const server = createGatewayServer(options);
  const logger = options.logger || console;
  const ideUrl = getGatewayUrl(host, port);

  server.on('error', err => {
    const message = err && err.code === 'EADDRINUSE'
      ? `[codex-ide-gateway] Port ${port} ist bereits belegt. Setze CODEX_IDE_GATEWAY_PORT oder --port.`
      : `[codex-ide-gateway] ${err && err.message ? err.message : String(err)}`;
    if (logger && typeof logger.error === 'function') logger.error(message);
    if (typeof options.onError === 'function') options.onError(err);
  });

  server.listen(port, host, () => {
    if (!isLoopbackBind(host) && logger && typeof logger.warn === 'function') {
      logger.warn('[codex-ide-gateway] Warnung: Gateway lauscht nicht nur lokal. Nur in vertrauenswuerdigen Netzen verwenden.');
    }
    if (logger && typeof logger.log === 'function') {
      logger.log(`[codex-ide-gateway] Codex IDE: ${ideUrl}`);
      logger.log(`[codex-ide-gateway] Chat-Completions: ${ideUrl}v1/chat/completions`);
      logger.log(`[codex-ide-gateway] Modell-Home: ${getModelHomeDir(options)}`);
      logger.log('[codex-ide-gateway] Codex nutzt standardmaessig den persistenten Codex App Server; Legacy: CODEX_BRIDGE_ENGINE=exec.');
      logger.log('[codex-ide-gateway] Auth laeuft ueber die lokal eingeloggte Codex-CLI. Login: codex-ide codex login');
    }
    if (options.openIde) {
      const opened = openUrl(ideUrl, options);
      if (!opened && logger && typeof logger.warn === 'function') {
        logger.warn(`[codex-ide-gateway] Browser konnte nicht automatisch geoeffnet werden: ${ideUrl}`);
      }
    }
    if (typeof options.onListening === 'function') options.onListening({ server, host, port, ideUrl });
  });

  return server;
}

if (require.main === module) {
  startGateway({ openIde: process.argv.includes('--open') });
}

module.exports = {
  DEFAULT_HOST,
  DEFAULT_PORT,
  PROJECT_ROOT,
  createGatewayServer,
  getGatewayUrl,
  isLoopbackBind,
  normalizeHost,
  normalizePort,
  openUrl,
  startGateway
};

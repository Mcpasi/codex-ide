'use strict';

const { EventEmitter } = require('events');
const path = require('path');
const cli = require('../scripts/codex-ide');
const gateway = require('../scripts/codex-ide-gateway');

describe('CLI arguments and command dispatch', () => {
  let logger;
  beforeEach(() => { logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() }; });

  test('parses values, equals-style options and boolean flags', () => {
    expect(cli.parseArgs(['start', '--host', '::1', '--port=9000', '--no-open', '--no-update-check', '-y']))
      .toEqual({ positionals: ['start'], flags: { host: '::1', port: '9000', noOpen: true, noUpdateCheck: true, yes: true } });
  });

  test('does not swallow the next option as a missing value', () => {
    expect(cli.parseArgs(['start', '--host', '--port', '--no-open']))
      .toEqual({ positionals: ['start'], flags: { noOpen: true } });
  });

  test.each([[], ['--help'], ['-h']].map(args => [args]))('prints help for %j', async args => {
    await expect(cli.main(args, { logger })).resolves.toBe(0);
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('codex-ide start'));
  });

  test.each([['version'], ['--version'], ['-v']].map(args => [args]))('prints the installed version for %j', async args => {
    await expect(cli.main(args, { logger, readPackageInfo: () => ({ version: '1.2.9' }) })).resolves.toBe(0);
    expect(logger.log).toHaveBeenCalledWith('codex-ide 1.2.9');
  });

  test('starts the gateway with the requested host and port', async () => {
    const startGateway = jest.fn();
    const offerUpdateBeforeStart = jest.fn().mockResolvedValue({ checked: false });
    await expect(cli.main(['start', '--host=::1', '--port', '9000', '--no-open'], {
      logger, startGateway, offerUpdateBeforeStart
    })).resolves.toBe(0);
    expect(offerUpdateBeforeStart).toHaveBeenCalledTimes(1);
    expect(startGateway).toHaveBeenCalledWith(expect.objectContaining({ host: '::1', port: '9000', openIde: false }));
  });

  test.each([
    ['gateway'], ['bridge'], ['codex', 'gateway'], ['codex', 'bridge']
  ].map(args => [args]))('supports the gateway alias %j', async args => {
    const startGateway = jest.fn();
    await expect(cli.main([...args, '--open'], { logger, startGateway })).resolves.toBe(0);
    expect(startGateway).toHaveBeenCalledWith(expect.objectContaining({ openIde: true }));
  });

  test.each([{ code: 1 }, { updated: true }])('handles startup update result %j before launching', async result => {
    const startGateway = jest.fn();
    await expect(cli.main(['start'], {
      logger, startGateway, offerUpdateBeforeStart: async () => result
    })).resolves.toBe(result.code || 0);
    expect(startGateway).not.toHaveBeenCalled();
  });

  test('dispatches explicit updates and forwards their exit status', async () => {
    const runUpdateCommand = jest.fn().mockResolvedValue(1);
    await expect(cli.main(['update', '--yes'], { logger, runUpdateCommand })).resolves.toBe(1);
    expect(runUpdateCommand).toHaveBeenCalledWith({ yes: true }, expect.objectContaining({ logger }));
  });

  test('opens the clean URL when a gateway already runs', async () => {
    const openUrl = jest.fn().mockReturnValue(true);
    await expect(cli.runClean({}, { logger, openUrl, probeGateway: async () => true })).resolves.toBe(0);
    expect(openUrl).toHaveBeenCalledWith('http://localhost:8787/?codex-ide-clean=1', expect.any(Object));
  });

  test.each([
    ['127.0.0.1', 'http://localhost:9000/'],
    ['::1', 'http://localhost:9000/'],
    ['2001:db8::1', 'http://[2001:db8::1]:9000/']
  ])('cleans an existing gateway on %s using valid HTTP URLs', async (host, baseUrl) => {
    // Keep URL construction, CLI dispatch and the health probe real; only
    // replace the HTTP transport and browser launcher to avoid external effects.
    const requestImpl = jest.fn((_url, callback) => {
      callback({ statusCode: 200, resume: jest.fn() });
      return { on: jest.fn(), setTimeout: jest.fn() };
    });
    const openUrl = jest.fn().mockReturnValue(true);

    await expect(cli.main(['clean', '--host', host, '--port', '9000'], {
      logger, requestImpl, openUrl
    })).resolves.toBe(0);

    expect(requestImpl).toHaveBeenCalledTimes(1);
    expect(requestImpl.mock.calls[0][0].href).toBe(baseUrl + 'health');
    expect(openUrl).toHaveBeenCalledTimes(1);
    expect(openUrl).toHaveBeenCalledWith(baseUrl + '?codex-ide-clean=1', expect.any(Object));
  });

  test('validates a bundled skill and resolves the /skill_packages alias', async () => {
    const directory = path.resolve(__dirname, '../skill_packages/PDF_Skill');
    expect(cli.resolveSkillDirectoryArg('/skill_packages/PDF_Skill')).toBe(directory);
    await expect(cli.main(['skill', 'validate', directory], { logger })).resolves.toBe(0);
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('workspace.pdf@'));
  });

  test.each([['unknown'], ['skill', 'validate']].map(args => [args]))('rejects incomplete or unknown commands: %j', async args => {
    await expect(cli.main(args, { logger })).resolves.toBe(1);
  });

  test('passes device authentication to the CLI and returns its exit status', async () => {
    const spawnImpl = jest.fn(() => {
      const child = new EventEmitter();
      setImmediate(() => child.emit('exit', 7));
      return child;
    });
    await expect(cli.runCodexLogin({ spawnImpl, codexBin: 'test-codex', deviceAuth: true })).resolves.toBe(7);
    expect(spawnImpl).toHaveBeenCalledWith('test-codex', [
      'login', '-c', 'cli_auth_credentials_store="auto"', '--device-auth'
    ], expect.objectContaining({ stdio: 'inherit' }));
  });

  test('surfaces a failed login process', async () => {
    const spawnImpl = () => {
      const child = new EventEmitter();
      setImmediate(() => child.emit('error', new Error('missing executable')));
      return child;
    };
    await expect(cli.runCodexLogin({ spawnImpl })).rejects.toThrow('missing executable');
  });

  test.each([200, 503])('probes the health endpoint with HTTP %s', async statusCode => {
    const requestImpl = jest.fn((_url, callback) => {
      callback({ statusCode, resume: jest.fn() });
      return { on: jest.fn(), setTimeout: jest.fn() };
    });
    await expect(cli.isGatewayReachable('http://localhost:8787/', { requestImpl })).resolves.toBe(statusCode === 200);
    expect(requestImpl.mock.calls[0][0].pathname).toBe('/health');
  });

  test('a timed-out health probe destroys its request and resolves false', async () => {
    const destroy = jest.fn();
    const requestImpl = () => ({
      on: jest.fn(), destroy,
      setTimeout: (_ms, callback) => setImmediate(callback)
    });
    await expect(cli.isGatewayReachable('http://localhost:8787/', { requestImpl })).resolves.toBe(false);
    expect(destroy).toHaveBeenCalledTimes(1);
  });
});

describe('gateway launch configuration', () => {
  test.each([undefined, '', -1, 0, 65536, 'invalid'])('defaults an invalid port: %s', port => {
    expect(gateway.normalizePort(port)).toBe(8787);
  });

  test('normalizes a valid host, port and IPv6 loopback URL', () => {
    expect(gateway.normalizeHost('  ::1  ')).toBe('::1');
    expect(gateway.normalizePort('9000')).toBe(9000);
    expect(gateway.getGatewayUrl('::1', 9000)).toBe('http://localhost:9000/');
  });

  test.each(['localhost', '127.0.0.1', '127.2.3.4', '::1', '[::1]'])('recognizes loopback: %s', host => {
    expect(gateway.isLoopbackBind(host)).toBe(true);
  });

  test.each(['0.0.0.0', '192.168.1.1', 'example.test', 'localhost.example.test'])('recognizes a non-loopback bind: %s', host => {
    expect(gateway.isLoopbackBind(host)).toBe(false);
  });

  test.each([
    ['darwin', 'open', ['http://localhost:8787/']],
    ['win32', 'cmd', ['/c', 'start', '', 'http://localhost:8787/']]
  ])('chooses the browser launcher for %s without invoking it', (platform, command, args) => {
    const child = { on: jest.fn(), unref: jest.fn() };
    const spawnImpl = jest.fn(() => child);
    expect(gateway.openUrl('http://localhost:8787/', { platform, spawnImpl })).toBe(true);
    expect(spawnImpl).toHaveBeenCalledWith(command, args, { detached: true, stdio: 'ignore' });
    expect(child.unref).toHaveBeenCalledTimes(1);
  });
});

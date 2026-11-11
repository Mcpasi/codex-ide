'use strict';

const bridge = require('../scripts/codex-bridge');
const { createFixture } = require('./helpers/fixture');

describe('bridge message and response contracts', () => {
  test('normalizes mixed text content and removes empty messages', () => {
    expect(bridge.normalizeMessages([
      null, { role: 'system', content: ' policy ' },
      { role: 'assistant', content: [{ type: 'text', text: 'Hallo ' }, '👋', { type: 'image_url' }] },
      { role: 'unknown', content: 42 }, { role: 'user', content: '  ' }
    ])).toEqual([
      { role: 'system', content: 'policy' }, { role: 'assistant', content: 'Hallo 👋' }, { role: 'user', content: '42' }
    ]);
    expect(bridge.normalizeMessages(null)).toEqual([]);
  });

  test('builds a prompt that preserves the conversation and user request', () => {
    const prompt = bridge.buildCodexPrompt([
      { role: 'system', content: 'Project context' },
      { role: 'assistant', content: 'Previous reply' },
      { role: 'user', content: 'Bitte prüfe den Code.' }
    ]);
    expect(prompt).toContain('System: Project context');
    expect(prompt).toContain('Codex IDE: Previous reply');
    expect(prompt).toContain('Nutzer: Bitte prüfe den Code.');
    expect(() => bridge.buildCodexPrompt([])).toThrow();
  });

  test('returns an OpenAI-compatible response with optional session metadata', () => {
    const result = bridge.createChatCompletionResponse(' Fertig 👋 ', 'example-model', { threadId: 'thread-1' });
    expect(result).toMatchObject({
      object: 'chat.completion', model: 'example-model', usage: null,
      choices: [{ index: 0, message: { role: 'assistant', content: 'Fertig 👋' }, finish_reason: 'stop' }],
      codexIde: { threadId: 'thread-1' }
    });
    expect(result.created).toEqual(expect.any(Number));
  });

  test.each(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'])('preserves supported reasoning effort: %s', effort => {
    expect(bridge.normalizeReasoningEffort(` ${effort.toUpperCase()} `)).toBe(effort);
  });

  test.each(['extreme', '', null, 42])('rejects unknown reasoning effort: %s', value => {
    expect(bridge.normalizeReasoningEffort(value)).toBe('');
  });

  test('requires a successful CLI login status before reporting authentication', () => {
    expect(bridge.parseCodexLoginStatus('', 'Logged in using ChatGPT', 0))
      .toMatchObject({ loggedIn: true, method: 'ChatGPT', persistent: true });
    expect(bridge.parseCodexLoginStatus('Logged in using ChatGPT', '', 1).loggedIn).toBe(false);
    expect(bridge.parseCodexLoginStatus('', 'Not logged in', 0).loggedIn).toBe(false);
  });
});

describe('bridge origins and usage limits', () => {
  test('parses an explicit origin allowlist', () => {
    expect(bridge.parseAllowedOrigins(' https://trusted.test, ,http://localhost:9000 '))
      .toEqual(['https://trusted.test', 'http://localhost:9000']);
  });

  test.each([
    [undefined, 'localhost:8787', true], ['http://localhost:8787', 'localhost:8787', true],
    ['http://127.0.0.1:8787', '127.0.0.1:8787', true], ['http://[::1]:8787', '[::1]:8787', true],
    ['http://localhost:9000', 'localhost:8787', false], ['https://localhost:8787', 'localhost:8787', false],
    ['http://evil.test', 'localhost:8787', false], ['null', 'localhost:8787', false],
    ['http://rebind.evil.test:8787', 'rebind.evil.test:8787', false]
  ])('checks origin %s against host %s', (origin, host, allowed) => {
    expect(bridge.isOriginAllowed(origin, [], host)).toBe(allowed);
  });

  test('permits an explicitly allowlisted origin', () => {
    expect(bridge.isOriginAllowed('https://trusted.test', ['https://trusted.test'], 'gateway.test')).toBe(true);
  });

  test('classifies rate limit windows by their actual duration', () => {
    expect(bridge.normalizeCodexUsage({ rateLimits: {
      planType: 'pro',
      primary: { usedPercent: 81.25, windowDurationMins: 10080, resetsAt: 1800000000 },
      secondary: { used_percent: 25, window_minutes: 300, resets_at: 1800000100 }
    } })).toEqual({
      available: true, planType: 'pro',
      daily: { usedPercent: 25, remainingPercent: 75, windowMinutes: 300, resetsAt: 1800000100 },
      weekly: { usedPercent: 81.3, remainingPercent: 18.7, windowMinutes: 10080, resetsAt: 1800000000 }
    });
  });

  test('clamps percentages and leaves unavailable windows empty', () => {
    const result = bridge.normalizeCodexUsage({ rateLimitsByLimitId: { codex: {
      primary: { usedPercent: 150, windowDurationMins: 300 }, secondary: { usedPercent: 'invalid' }
    } } });
    expect(result.daily).toMatchObject({ usedPercent: 100, remainingPercent: 0 });
    expect(result.weekly).toBeNull();
    expect(bridge.normalizeCodexUsage(null)).toEqual({ available: false, planType: null, daily: null, weekly: null });
  });

  test('reports unavailable usage instead of inventing limits after a server failure', async () => {
    await expect(bridge.getCodexUsagePayload({
      engine: 'app-server', readCodexRateLimits: async () => { throw new Error('offline'); }
    })).resolves.toMatchObject({ available: false, reason: 'rate-limits-unavailable', daily: null, weekly: null });
  });
});

describe('explicit memory and file context', () => {
  let fixture;
  beforeEach(() => { fixture = createFixture(); });
  afterEach(() => fixture.dispose());

  test.each([
    ['Bitte merke dir: Ich nutze Linux.', 'Ich nutze Linux.'],
    ['Remember that I use Linux.', 'I use Linux.'],
    ['Bitte prüfe die Datei.', '']
  ])('extracts a memory directive from %s', (text, expected) => {
    expect(bridge.extractMemoryDirective(text)).toBe(expected);
  });

  test('appends dated memory and avoids adding the same entry twice', () => {
    const now = new Date('2026-01-02T12:00:00Z');
    const first = bridge.appendMemoryEntry(fixture.home, 'Ich nutze Linux.', now);
    expect(first.updated).toBe(true);
    expect(first.memory).toContain('- 2026-01-02: Ich nutze Linux.');
    const again = bridge.appendMemoryEntry(fixture.home, 'ich nutze linux.', now);
    expect(again.updated).toBe(false);
    expect(again.memory).toBe(first.memory);
  });

  test('includes explicitly supplied files and reports missing or forbidden files individually', () => {
    fixture.write('notes.md', '# Notes');
    const result = bridge.prepareModelHomeContext([{ role: 'user', content: 'Review these files.' }], {
      modelHome: fixture.home, modelHomeFiles: ['notes.md', 'missing.txt', '../secret.txt']
    });
    expect(result.fileContexts).toEqual([{ path: 'notes.md', content: '# Notes', truncated: false }]);
    expect(result.fileErrors.map(error => error.path)).toEqual(['missing.txt', '../secret.txt']);
  });

  test('keeps editor mode lazy rather than eagerly reading paths from the prompt', () => {
    fixture.write('notes.md', '# Notes');
    const result = bridge.prepareModelHomeContext([{ role: 'user', content: 'Lies bitte notes.md' }], {
      modelHome: fixture.home, editorWorkspaceMode: true
    });
    expect(result.requestedFiles).toEqual([]);
    expect(result.fileContexts).toEqual([]);
  });
});

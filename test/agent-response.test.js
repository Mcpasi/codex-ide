'use strict';

const response = require('../agentResponse');

describe('agent response presentation', () => {
  test('separates the work summary, final answer and selected skills', () => {
    expect(response.parse(
      '<codex_ide_thought>Geprüft.</codex_ide_thought>\n<codex_ide_final>Fertig ✅</codex_ide_final>',
      { skills: [' files ', '', null, 'internet'] }
    )).toEqual({ thought: 'Geprüft.', reply: 'Fertig ✅', skills: ['files', 'internet'] });
  });

  test('supports plain replies and a fallback summary', () => {
    expect(response.parse(' Hallo! ', { fallbackThought: 'Erledigt.' }))
      .toEqual({ thought: 'Erledigt.', reply: 'Hallo!', skills: [] });
    expect(response.parse(null)).toEqual({ thought: '', reply: '', skills: [] });
  });

  test.each(['', ' \n\t '])('keeps an empty final block separate from the work summary: %j', finalText => {
    const raw = '<codex_ide_thought>Datei geprüft.</codex_ide_thought>' +
      '<codex_ide_final>' + finalText + '</codex_ide_final>';

    expect(response.parseLive(raw)).toEqual({ thought: 'Datei geprüft.', reply: '' });
    expect(response.parse(raw)).toEqual({ thought: 'Datei geprüft.', reply: '', skills: [] });
  });

  test.each([
    '/home/alice/model-home/secret.json',
    'C:\\Users\\alice\\model-home\\secret.json',
    'MEMORY.md',
    '/private/config[1].json'
  ])('redacts an internal reference: %s', reference => {
    const parsed = response.parse(
      `<codex_ide_thought>${reference}</codex_ide_thought><codex_ide_final>${reference}</codex_ide_final>`,
      { protectedPaths: ['/private/config[1].json'] }
    );
    expect(parsed.thought).toBe(response.INTERNAL_REFERENCE);
    expect(parsed.reply).toBe(response.INTERNAL_REFERENCE);
  });

  test('keeps ordinary project paths and Markdown intact', () => {
    expect(response.sanitize('Ändere **src/app.js** und docs/README.md.'))
      .toBe('Ändere **src/app.js** und docs/README.md.');
  });

  test('compacts Markdown summaries and truncates at a word boundary', () => {
    expect(response.compactWorkNote('# Prüfung\r\n- Datei gelesen\n> Alles korrekt'))
      .toBe('Prüfung Datei gelesen Alles korrekt');
    const summary = response.compactWorkNote('Eine längere Zusammenfassung. '.repeat(30), 150);
    expect(summary.length).toBeLessThanOrEqual(150);
    expect(summary.endsWith('…')).toBe(true);
  });
});

describe('streaming agent responses', () => {
  test.each([
    '<', '<codex', '<codex_ide_thought', '<codex_ide_editor_request>', '<codex_ide_skill_request>',
    '<codex_ide_workspace_c', '<codex_ide_workspace_complete>', '</codex_ide_final>'
  ])
    ('does not expose incomplete control markup: %s', chunk => {
      expect(response.parseLive(chunk)).toEqual({ thought: '', reply: '' });
    });

  test('shows incremental summaries and final text without partial closing tags', () => {
    expect(response.parseLive('<codex_ide_thought>Datei geprüft.</codex_ide_thought><codex_ide_final>Hallo 👋</codex_'))
      .toEqual({ thought: 'Datei geprüft.', reply: 'Hallo 👋' });
  });

  test.each([
    'Der Vergleich lautet x < 5.',
    '<main>Grüße 👋</main>',
    '```html\n<section',
    'Array<string'
  ])('preserves ordinary angle brackets in a live final answer: %s', reply => {
    const raw = '<codex_ide_final>' + reply;
    expect(response.parseLive(raw)).toEqual({ thought: '', reply });
    expect(response.parseLive(raw + '</codex_ide_final>')).toEqual({ thought: '', reply });
  });

  test.each(['<main>Grüße 👋</main>', '<section', '< 5 ist kleiner als 10'])
    ('streams an untagged answer starting with ordinary angle brackets: %s', reply => {
      expect(response.parseLive(reply)).toEqual({ thought: '', reply });
    });

  test('keeps a completed final answer stable when more markup follows', () => {
    expect(response.parseLive('<codex_ide_final>Fertig.</codex_ide_final><codex_ide_skill_request>'))
      .toEqual({ thought: '', reply: 'Fertig.' });
  });

  test('streams untagged text and applies the same redaction', () => {
    expect(response.parseLive('Datei memory.md gelesen.', { fallbackThought: 'Prüfung' }))
      .toEqual({ thought: 'Prüfung', reply: `Datei ${response.INTERNAL_REFERENCE} gelesen.` });
  });
});

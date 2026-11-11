'use strict';

const filter = require('../Safetyfilter');

describe('local model output filter', () => {
  beforeEach(() => jest.spyOn(console, 'warn').mockImplementation(() => {}));

  test.each([null, undefined, '', 42])('handles empty or non-text input: %s', value => {
    expect(filter.contains(value)).toBe(false);
    expect(filter.filterModelOutput(value)).toBeNull();
  });

  test('leaves ordinary Unicode text intact', () => {
    const text = 'Grüße aus Köln 👋 — JavaScript und Python.';
    expect(filter.filter(text)).toEqual({ text, flagged: false, matches: [] });
    expect(filter.filterModelOutput(text)).toBe(text);
  });

  test('matches whole words case-insensitively and preserves punctuation', () => {
    expect(filter.filter('Du ARSCHLOCH!'))
      .toEqual({ text: 'Du *********!', flagged: true, matches: ['arschloch'] });
    expect(filter.contains('grape, bitchin, tötenberg')).toBe(false);
  });

  test('masks phrases and reports each matched term once', () => {
    expect(filter.filter('kill yourself, kill yourself', { maskChar: '#' }))
      .toEqual({ text: '#############, #############', flagged: true, matches: ['kill yourself'] });
  });

  test('escapes custom terms and keeps them local to the call', () => {
    expect(filter.contains('Nutze c++!', [' C++ ', 'c++'])).toBe(true);
    expect(filter.filter('c++!', { extraTerms: ['c++'], maskChar: '?' }))
      .toEqual({ text: '???!', flagged: true, matches: ['c++'] });
    expect(filter.contains('Nutze c++!')).toBe(false);
  });

  test('supports explicit blocking and the model-output fallback', () => {
    expect(filter.filter('asshole', { blockOnMatch: true }))
      .toEqual({ text: null, flagged: true, matches: ['asshole'] });
    expect(filter.filterModelOutput('asshole')).toBe('*******');
    expect(filter.filterModelOutput('asshole bitch')).toMatch(/Sicherheitsgründen gefiltert/);
  });

  test('does not allow callers to mutate the built-in word list', () => {
    const terms = filter.getBlockedTerms();
    terms.length = 0;
    expect(filter.contains('asshole')).toBe(true);
  });
});

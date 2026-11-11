'use strict';

const { diffText } = require('../codex_ide/editor-diff');

function applyEdits(source, edits) {
  return edits.slice().reverse().reduce((text, edit) => text.slice(0, edit.start) + edit.text + text.slice(edit.end), source);
}

describe('localized editor differences', () => {
  test.each([
    ['', 'new 👋\n'], ['old\n', ''], ['same\r\n', 'same\r\n'],
    ['let x=1; keep(); let y=2;', 'let x=3; keep(); let y=4;'],
    ['one\r\nkeep\r\nthree\r\n', 'ONE\r\nkeep\r\nTHREE\r\n'],
    ['😀 abc', '😃 aXYZbc'], ['a\na\nb\n', 'a\nb\na\n']
  ])('reconstructs %j as %j with ordered nonoverlapping changes', (source, target) => {
    const edits = diffText(source, target);
    expect(applyEdits(source, edits)).toBe(target);
    edits.forEach((edit, index) => {
      expect(edit.start).toBeGreaterThanOrEqual(index ? edits[index - 1].end : 0);
      expect(edit.end).toBeGreaterThanOrEqual(edit.start);
      expect(edit.end).toBeLessThanOrEqual(source.length);
    });
  });

  test('preserves unchanged code between separate changes on the same line', () => {
    const source = 'let first = 1; keepThis(); let second = 2;';
    expect(diffText(source, source.replace('1', '3').replace('2', '4'))).toEqual([
      { start: 12, end: 13, text: '3' }, { start: 40, end: 41, text: '4' }
    ]);
  });

  test('preserves thousands of unchanged lines without a file-size rejection', () => {
    const source = Array.from({ length: 12000 }, (_, i) => `const value${i} = ${i};\n`).join('');
    const target = source.replace('value20 = 20', 'value20 = 200').replace('value11980 = 11980', 'value11980 = 119800');
    const edits = diffText(source, target);
    expect(applyEdits(source, edits)).toBe(target);
    expect(edits).toHaveLength(2);
    expect(edits.every(edit => edit.start === edit.end && edit.text === '0')).toBe(true);
  });

  test('reconstructs deterministic randomized Unicode and repeated-line inputs', () => {
    let seed = 123456;
    const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
    const alphabet = ['foo', 'bar', '\n', '\r\n', ' ', ';', '😀', '😃', 'ä', 'a', 'b'];
    for (let sample = 0; sample < 400; sample += 1) {
      const randomText = () => Array.from({ length: next() % 60 }, () => alphabet[next() % alphabet.length]).join('');
      const source = randomText(), target = randomText();
      const edits = diffText(source, target);
      expect(applyEdits(source, edits)).toBe(target);
      for (const edit of edits) {
        expect(/[\uD800-\uDBFF]$/.test(source.slice(0, edit.start))).toBe(false);
        expect(/^[\uDC00-\uDFFF]/.test(source.slice(edit.end))).toBe(false);
      }
    }
  });
});

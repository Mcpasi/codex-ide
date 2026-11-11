'use strict';

const highlighter = require('../codex_ide/syntax-highlighter');

function renderedText(html) {
  return html.replace(/<span class="tok-[a-z]+">|<\/span>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

describe('editor syntax highlighting', () => {
  test.each([
    ['src/APP.JS', 'javascript'], ['C:\\src\\app.py', 'python'],
    ['index.html', 'html'], ['style.css', 'css'], ['package.json', 'json'],
    ['README.md', 'markdown'], ['plain', 'text'], ['unknown.ts', 'text']
  ])('detects the language of %s', (file, language) => {
    expect(highlighter.languageForPath(file)).toBe(language);
  });

  test.each([
    ['app.js', 'const greeting = "Grüße 👋";\n// <script> & text\nconsole.log(greeting);', 'keyword'],
    ['app.py', '@decorator\ndef greet():\n    return "Grüße 👋" # <tag>\n', 'keyword'],
    ['style.css', '.card { color: #ff00aa; width: 10px; --label: "<&>"; }', 'property'],
    ['package.json', '{"name": "<&>", "enabled": true, "count": -1.5e2}', 'property'],
    ['index.html', '<div title="a > b">Grüße &amp;</div><!-- <script> -->', 'tag'],
    ['README.md', '# Titel\n\n**Text** und [Link](https://example.test)\n```js\n<a>&\n```\n', 'heading'],
    ['notes.txt', '<script>alert("x")</script> & Grüße 👋', null]
  ])('preserves every source character in %s', (file, source, token) => {
    const highlighted = highlighter.highlight(source, file);
    expect(renderedText(highlighted.html)).toBe(source);
    expect(highlighted.html).not.toMatch(/<(?:script|div|a)\b/i);
    if (token) expect(highlighted.html).toContain(`class="tok-${token}"`);
  });

  test('handles embedded JavaScript and CSS without breaking less-than operators', () => {
    const source = '<script>if (a < 2) console.log("<&>");</script><style>.a { color: red; }</style>';
    const { html } = highlighter.highlight(source, 'html');
    expect(renderedText(html)).toBe(source);
    expect(html).toContain('tok-keyword');
    expect(html).toContain('tok-property');
  });

  test.each(['const text = "unfinished', '<div title="unfinished', '/* unfinished', '```\n<unfinished'])
    ('preserves incomplete editor input: %s', source => {
      for (const language of highlighter.supportedLanguages) {
        expect(renderedText(highlighter.highlight(source, language).html)).toBe(source);
      }
    });

  test('handles empty buffers', () => {
    expect(highlighter.highlight(null, 'js')).toEqual({ language: 'javascript', label: 'JavaScript', html: '' });
  });
});

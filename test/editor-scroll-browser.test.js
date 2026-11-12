'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const projectRoot = path.resolve(__dirname, '..');
const browser = process.env.CODEX_IDE_TEST_BROWSER || [
  ...String(process.env.PATH || '').split(path.delimiter).flatMap(directory =>
    ['chromium', 'chromium-browser', 'google-chrome'].map(name => path.join(directory, name))),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
].find(candidate => fs.existsSync(candidate));

// Keep Node-only installations usable. CI can require the browser regression
// with CODEX_IDE_TEST_BROWSER=/path/to/chromium (an invalid path fails the test).
const browserTest = browser ? test : test.skip;

// Runs inside Chromium: actual fonts, syntax spans, DOM ranges and scrolling.
// Only scheduling is controlled so every deletion/insertion frame is checked.
async function checkVisibleWorkSites() {
  const errors = [];
  const frames = [];
  const timers = new Map();
  const paints = new Map();
  let sequence = 0;
  let now = 0;
  window.setTimeout = (callback, delay = 0) => {
    const id = ++sequence;
    timers.set(id, { callback, at: now + delay });
    return id;
  };
  window.clearTimeout = id => timers.delete(id);
  window.requestAnimationFrame = callback => { const id = ++sequence; paints.set(id, callback); return id; };
  window.cancelAnimationFrame = id => paints.delete(id);
  window.codexIdeProfile = {
    get: () => 'codex',
    listModelHomeWorkspaceFiles: async () => ({ files: [], directories: [] }),
    writeModelHomeWorkspaceFile: async () => { inspect('save'); return { ok: true }; }
  };
  const { state, setBusy, activateBuffer, applyModelEditorWrite } = window.browserEditorUnderTest;
  setBusy(true);
  state.turnId = 1;
  const textarea = document.getElementById('ideEditor');
  const code = document.getElementById('ideHighlightCode');
  const highlight = document.getElementById('ideHighlight');

  function inspect(stage) {
    if (!textarea.value || !code.firstChild) return;
    const offset = Math.max(0, textarea.selectionEnd - 1);
    const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
    let node;
    let remaining = offset;
    while ((node = walker.nextNode()) && remaining >= node.textContent.length) remaining -= node.textContent.length;
    if (!node) throw new Error('The visible syntax layer has no text at the active caret.');
    const range = document.createRange();
    range.setStart(node, remaining);
    range.setEnd(node, remaining + 1);
    const glyph = range.getBoundingClientRect();
    const editorBox = textarea.getBoundingClientRect();
    const line = textarea.value.slice(0, textarea.selectionEnd).split('\n').length;
    const frame = {
      stage, line, path: state.path, operation: document.getElementById('ideEditorSurface').dataset.liveEdit,
      scroll: { top: textarea.scrollTop, syntaxTop: highlight.scrollTop, left: textarea.scrollLeft, syntaxLeft: highlight.scrollLeft },
      selection: [textarea.selectionStart, textarea.selectionEnd],
      glyph: { top: glyph.top, bottom: glyph.bottom, left: glyph.left, right: glyph.right },
      viewport: {
        top: Math.max(0, editorBox.top + textarea.clientTop),
        bottom: Math.min(innerHeight, editorBox.top + textarea.clientTop + textarea.clientHeight),
        left: Math.max(0, editorBox.left + textarea.clientLeft),
        right: Math.min(innerWidth, editorBox.left + textarea.clientLeft + textarea.clientWidth)
      }
    };
    frames.push(frame);
    const visible = glyph.top >= frame.viewport.top - 1 && glyph.bottom <= frame.viewport.bottom + 1 &&
      glyph.left >= frame.viewport.left - 1 && glyph.right <= frame.viewport.right + 1;
    // Chromium can round the pre/textarea scroll limits one pixel apart.
    const aligned = Math.abs(textarea.scrollTop - highlight.scrollTop) <= 1 && Math.abs(textarea.scrollLeft - highlight.scrollLeft) <= 1;
    if ((!visible || !aligned || textarea.selectionStart !== textarea.selectionEnd) && errors.length < 10) errors.push(frame);
  }

  async function apply(request) {
    let settled = false;
    let failure;
    const pending = applyModelEditorWrite(request, 1, { persist: true }).then(
      () => { settled = true; }, error => { settled = true; failure = error; });
    for (let ticks = 0; ticks < 10000 && (!settled || timers.size || paints.size); ticks += 1) {
      if (paints.size) {
        const callbacks = [...paints.values()];
        paints.clear();
        callbacks.forEach(callback => callback(now));
        if (state.liveEditorDraft) inspect('paint');
      } else if (timers.size) {
        const [id, timer] = [...timers].sort((left, right) => left[1].at - right[1].at)[0];
        timers.delete(id);
        now = timer.at;
        timer.callback();
      }
      await Promise.resolve();
    }
    if (!settled) throw new Error('The visible editor did not finish its animation.');
    await pending;
    if (failure) throw failure;
    inspect('complete');
  }

  const original = Array.from({ length: 240 }, (_, i) => `const item${i} = old;\n`).join('');
  const expected = original.replace('item10 = old', 'item10 = new').replace('item220 = old', 'item220 = new');
  activateBuffer('app.js', original, original, false);
  await apply({ operation: 'edit', path: 'app.js', oldText: original, newText: expected });

  // A new file follows growing line numbers; a long deletion follows backwards.
  const created = Array.from({ length: 150 }, (_, i) => `const added${i} = ${i};\n`).join('');
  await apply({ operation: 'write', path: 'new.js', content: created });
  await apply({ operation: 'edit', path: 'new.js', oldText: created, newText: '' });

  // Follow horizontal changes too, then return to a later line's left edge.
  const wide = ' '.repeat(700) + 'old\n' + 'keep\n'.repeat(120) + 'before\n';
  activateBuffer('wide.js', wide, wide, false);
  await apply({ operation: 'edit', path: 'wide.js', oldText: wide, newText: wide.replace('old', 'new').replace('before', 'after') });

  // The caret mirror measures only the current unwrapped row. Earlier emoji
  // rows, tabs and combining/CJK characters must not change its real position.
  const unicode = 'const icon = "👋";\n'.repeat(140) + '\tconst label = "é 漢字 👩‍💻 old";\n';
  activateBuffer('unicode.js', unicode, unicode, false);
  await apply({ operation: 'edit', path: 'unicode.js', oldText: 'old', newText: 'new' });

  return {
    errors, frameCount: frames.length,
    followedDistantSite: frames.some(frame => frame.path === 'app.js' && frame.line === 221),
    followedInsertion: frames.some(frame => frame.path === 'new.js' && frame.line > 100 && frame.operation === 'write'),
    followedDeletion: frames.some(frame => frame.path === 'new.js' && frame.line > 100 && frame.operation === 'edit-delete'),
    followedHorizontalSite: frames.some(frame => frame.path === 'wide.js' && frame.scroll.left > 0),
    returnedToLeftEdge: frames.some(frame => frame.path === 'wide.js' && frame.line > 100 && frame.scroll.left === 0),
    followedUnicode: frames.some(frame => frame.path === 'unicode.js' && frame.line === 141),
    fonts: { editor: getComputedStyle(textarea).font, syntax: getComputedStyle(code).font }
  };
}

function browserFixture(largeFont) {
  const read = name => fs.readFileSync(path.join(projectRoot, name), 'utf8');
  const init = "  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });\n  else init();";
  const app = read('codex_ide/codex-ide.js');
  if (!app.includes(init)) throw new Error('The browser fixture must isolate IDE startup before running editor actions.');
  const isolated = app.replace(init, '  window.browserEditorUnderTest = { state, setBusy, activateBuffer, applyModelEditorWrite };');
  const script = source => '<script>' + source.replace(/<\/script/gi, '<\\/script') + '</script>';
  return read('index.html')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<link\b[^>]*>/gi, '').replace(/<img\b[^>]*>/gi, '')
    .replace('</head>', () => '<style>' + read('codex_ide/codex-ide.css') + (largeFont ? '.code-highlight,.code-editor{font-size:28px;line-height:1.9}' : '') + '</style></head>')
    .replace('</body>', () => script(read('codex_ide/editor-diff.js')) + script(read('codex_ide/syntax-highlighter.js')) + script(isolated) +
      script('(' + checkVisibleWorkSites.toString() + ')().then(report => { document.body.innerHTML = "<pre id=browser-result></pre>"; document.getElementById("browser-result").textContent = encodeURIComponent(JSON.stringify(report)); }).catch(error => { document.body.innerHTML = "<pre id=browser-result></pre>"; document.getElementById("browser-result").textContent = encodeURIComponent(JSON.stringify({ error: error.stack })); });') + '</body>');
}

browserTest.each([
  ['desktop', 1600, 900, false], ['tablet', 900, 700, false], ['mobile', 480, 800, false],
  ['large font', 1600, 900, true]
])('keeps every visible edit frame at the real work site in Chromium: %s', (_name, width, height, largeFont) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-ide-scroll-browser-'));
  try {
    const fixture = path.join(temporary, 'editor.html');
    fs.writeFileSync(fixture, browserFixture(largeFont));
    const result = spawnSync(browser, [
      '--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--disable-background-networking',
      '--no-first-run', '--no-default-browser-check', '--dump-dom', `--window-size=${width},${height}`,
      `--user-data-dir=${path.join(temporary, 'profile')}`, require('url').pathToFileURL(fixture).href
    ], { encoding: 'utf8', timeout: 15000, maxBuffer: 2 * 1024 * 1024 });
    if (result.error) throw result.error;
    expect({ status: result.status, stderr: result.status ? result.stderr : '' }).toEqual({ status: 0, stderr: '' });
    const match = result.stdout.match(/<pre id="browser-result">([^<]*)<\/pre>/);
    expect(match).not.toBeNull();
    const report = JSON.parse(decodeURIComponent(match[1]));
    expect(report.error).toBeUndefined();
    expect(report.errors).toEqual([]);
    expect(report.fonts.syntax).toBe(report.fonts.editor);
    expect(report.frameCount).toBeGreaterThan(100);
    for (const check of ['followedDistantSite', 'followedInsertion', 'followedDeletion', 'followedHorizontalSite', 'returnedToLeftEdge', 'followedUnicode']) expect({ check, passed: report[check] }).toEqual({ check, passed: true });
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}, 20000);

'use strict';

const { chromium, runEditorInChromium } = require('./helpers/chromium-editor');
const browserTest = chromium ? test : test.skip;

// Use real DOM/layout/highlighting and CPU time, with a controlled animation
// clock. No model, network latency or wall-clock sleeps enter these budgets.
async function benchmarkEditorSession() {
  const { state, setBusy, activateBuffer, applyModelEditorWrite, scheduleEditorHighlight } = window.browserEditorUnderTest;
  const timers = new Map(), paints = new Map();
  let sequence = 0, now = 0, saves = 0, highlightCalls = 0, mirrorChars = 0, maxMirrorChars = 0;
  let preservedSyntaxTokens = true;
  const workTimes = [], paintTimes = [], checkpoints = [];
  window.setTimeout = (callback, delay = 0) => {
    const id = ++sequence;
    timers.set(id, { callback, at: now + delay });
    return id;
  };
  window.clearTimeout = id => timers.delete(id);
  window.requestAnimationFrame = callback => { const id = ++sequence; paints.set(id, callback); return id; };
  window.cancelAnimationFrame = id => paints.delete(id);
  const textarea = document.getElementById('ideEditor');
  const code = document.getElementById('ideHighlightCode');
  const originalHighlight = window.CodexIdeSyntaxHighlighter.highlight;
  window.CodexIdeSyntaxHighlighter.highlight = (...args) => { highlightCalls++; return originalHighlight(...args); };
  const append = document.body.appendChild;
  document.body.appendChild = function (node) {
    // The invisible caret mirror is the only temporary direct body child.
    const chars = node.textContent.length;
    mirrorChars += chars;
    maxMirrorChars = Math.max(maxMirrorChars, chars);
    return append.call(this, node);
  };
  function check(condition, message) { if (!condition) throw new Error(message); }
  function checkPaint() {
    check(code.textContent === textarea.value + (textarea.value.endsWith('\n') ? ' ' : ''), 'A visible syntax frame lost source characters.');
  }
  window.codexIdeProfile = {
    get: () => 'codex',
    writeModelHomeWorkspaceFile: async (_path, content) => {
      checkPaint();
      check(content === textarea.value, 'A save bypassed the visible editor.');
      check(!state.liveEditorDraft.awaitingPaint && !state.liveEditorDraft.presentationPending, 'A save preceded its presentation frame.');
      saves++;
      return { ok: true };
    }
  };
  setBusy(true);
  async function step() {
    const start = performance.now();
    if (paints.size) {
      const callbacks = [...paints.values()];
      paints.clear();
      callbacks.forEach(callback => callback(now));
      paintTimes.push(performance.now() - start);
      checkPaint();
    } else if (timers.size) {
      const [id, timer] = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
      timers.delete(id);
      now = timer.at;
      timer.callback();
    }
    workTimes.push(performance.now() - start);
    await Promise.resolve();
  }
  async function drain(done = () => true) {
    for (let ticks = 0; ticks < 20000; ticks++) {
      await step();
      if (!timers.size && !paints.size && done()) return;
    }
    throw new Error('Editor animation did not settle.');
  }
  async function apply(request, abort = false) {
    state.turnId++;
    const controller = new AbortController();
    let settled = false, failure;
    const pending = applyModelEditorWrite(request, state.turnId, { persist: true, signal: controller.signal })
      .then(result => { check(result.saved, 'An edit was not saved.'); }, error => { failure = error; })
      .finally(() => { settled = true; });
    if (abort) {
      for (let ticks = 0; ticks < 100 && !state.liveEditorDraft.awaitingPaint; ticks++) await step();
      check(state.liveEditorDraft.awaitingPaint, 'The abort must interrupt a pending syntax paint.');
      controller.abort();
    }
    await drain(() => settled);
    await pending;
    check(abort ? failure && failure.name === 'AbortError' : !failure, 'Unexpected editor outcome: ' + failure);
    check(!state.liveEditorDraft && state.highlightFrame == null, 'A settled edit retained an animation.');
  }
  function checkpoint(turn) {
    check(typeof window.gc === 'function' && performance.memory, 'Chromium heap instrumentation is unavailable.');
    window.gc();
    checkpoints.push({ turn, heapBytes: performance.memory.usedJSHeapSize,
      domNodes: document.querySelectorAll('*').length, buffers: Object.keys(state.buffers).length,
      cachedFiles: Object.keys(state.workspaceContents).length, timers: timers.size, paints: paints.size });
  }
  const source = Array.from({ length: 80 }, (_, i) => `const item${i} = "Grüße 👋";\n`).join('') + 'let marker = "old";\n';
  activateBuffer('session.js', source, source, false);
  await drain();
  // Measure invalidation-only updates separately from actual source changes.
  const idleStarted = performance.now(), idleHighlightsBefore = highlightCalls;
  for (let i = 0; i < 30; i++) { scheduleEditorHighlight(); await drain(); }
  const idle = { updates: 30, highlightCalls: highlightCalls - idleHighlightsBefore, ms: performance.now() - idleStarted };

  // Warm up compilation and DOM allocation before comparing retained heaps.
  for (let turn = 0; turn < 100; turn++) {
    const oldText = turn % 2 ? 'new' : 'old', newText = turn % 2 ? 'old' : 'new';
    const unchangedToken = code.firstChild;
    await apply({ operation: 'edit', path: 'session.js', oldText: `"${oldText}"`, newText: `"${newText}"` });
    preservedSyntaxTokens = preservedSyntaxTokens && unchangedToken === code.firstChild;
    if (turn % 5 === 0) {
      const saved = saves;
      await apply({ operation: 'write', path: `cancelled-${turn}.js`, content: 'const cancelled = "👋";\n'.repeat(200) }, true);
      check(saves === saved && state.path === 'session.js', 'An aborted draft changed the persisted workspace.');
    }
    if ((turn + 1) % 20 === 0) checkpoint(turn + 1);
  }
  check(textarea.value === source, 'The long session changed untouched source.');
  const session = { turns: 100, aborts: 20, contentChars: source.length, saves, checkpoints };

  // Growing syntax DOM, non-BMP characters, multiline deletion and a new write.
  const content = Array.from({ length: 180 }, (_, i) => `const added${i} = "👋";\n`).join('');
  const animationStart = now;
  await apply({ operation: 'write', path: 'animated.js', content });
  await apply({ operation: 'edit', path: 'animated.js', oldText: content, newText: '' });
  check(textarea.value === '' && saves === 102, 'The animated write/deletion did not finish.');
  const sorted = values => values.slice().sort((a, b) => a - b);
  function timings(values) {
    const ordered = sorted(values);
    return { samples: values.length, totalMs: values.reduce((sum, n) => sum + n, 0),
      p50Ms: ordered[Math.floor(ordered.length * 0.5)], p95Ms: ordered[Math.floor(ordered.length * 0.95)],
      maxMs: ordered[ordered.length - 1], over16Ms: values.filter(n => n > 16.7).length };
  }
  return { idle, session, animation: { contentChars: content.length, simulatedMs: now - animationStart },
    work: timings(workTimes), paints: timings(paintTimes), highlightCalls, mirrorChars, maxMirrorChars, preservedSyntaxTokens,
    browser: navigator.userAgent };
}

browserTest('bounds animation work and retained memory over a long Chromium editor session', () => {
  const report = runEditorInChromium(benchmarkEditorSession);
  if (process.env.CODEX_IDE_PERF_REPORT === '1' || process.env.npm_lifecycle_event === 'test:performance') {
    console.log(JSON.stringify({ editorPerformance: report }, null, 2));
  }
  expect(report.idle.highlightCalls).toBe(0);
  expect(report.idle.ms).toBeLessThan(1000);
  expect(report.session.saves).toBe(100);
  const first = report.session.checkpoints[0];
  for (const checkpoint of report.session.checkpoints) {
    expect(checkpoint).toMatchObject({ buffers: 1, cachedFiles: 1, timers: 0, paints: 0 });
    expect(checkpoint.domNodes).toBe(first.domNodes);
    expect(checkpoint.heapBytes - first.heapBytes).toBeLessThan(2 * 1024 * 1024);
  }
  expect(report.maxMirrorChars).toBeLessThan(128);
  expect(report.preservedSyntaxTokens).toBe(true);
  expect(report.paints.samples).toBeGreaterThan(500);
  expect(report.paints.p95Ms).toBeLessThan(100);
  expect(report.work.totalMs).toBeLessThan(25000);
  expect(report.animation.simulatedMs).toBeLessThan(5000);
}, 60000);

async function checkSyntaxUpdates() {
  const { activateBuffer, scheduleEditorHighlight } = window.browserEditorUnderTest;
  const callbacks = [];
  window.requestAnimationFrame = callback => { callbacks.push(callback); return callbacks.length; };
  const textarea = document.getElementById('ideEditor');
  const code = document.getElementById('ideHighlightCode');
  const reference = document.createElement('code');
  let renders = 0;
  function paint(path, content) {
    activateBuffer(path, content, content, false);
    callbacks.splice(0).forEach(callback => callback());
    const result = window.CodexIdeSyntaxHighlighter.highlight(content, path);
    reference.innerHTML = result.html + (content.endsWith('\n') ? ' ' : '');
    if (code.innerHTML !== reference.innerHTML) throw new Error('Incremental syntax differs from a full render: ' + path);
    if (textarea.value !== content) throw new Error('Syntax rendering changed the editable source.');
    renders++;
  }
  const cases = [
    ['app.js', 'const before = 1;\n/* comment\nconst inside = "👋";\n*/\nconst after = 3;\n', '/*', '//'],
    ['app.js', 'const text = `first\nsecond`;\nkeep();\n', '`first', '"first'],
    ['app.py', 'before = 1\ntext = """one\ntwo\n"""\nafter = 2\n', '"""one', '# one'],
    ['index.html', '<style>.a { color: red; }</style>\n<script>const a = "👋";</script>\n', '</style>', '</div>'],
    ['style.css', '/* note\nstill a note */\n.a { color: red; }\n', '/*', ' '],
    ['package.json', '{"name":"👋",\n"enabled":true,"count":12}\n', 'true', 'false'],
    ['README.md', '# Title\n```js\nconst a = 1;\n```\n**after**\n', '```js', 'text'],
    ['plain.txt', '<tag> & Grüße 👋\n', 'Grüße', '漢字 é']
  ];
  for (const [path, source, oldText, newText] of cases) {
    paint(path, source);
    paint(path, source.replace(oldText, newText));
    paint(path, '');
    paint(path, source);
    const token = code.firstChild;
    scheduleEditorHighlight();
    callbacks.splice(0).forEach(callback => callback());
    if (code.firstChild !== token) throw new Error('An unchanged render replaced syntax nodes.');
  }
  paint('same.js', 'const first = 1;\nlet last = "old";\n');
  const first = code.firstChild;
  paint('same.js', 'const first = 1;\nlet last = "new";\n');
  if (code.firstChild !== first) throw new Error('A local edit replaced unchanged syntax nodes.');
  paint('same.txt', textarea.value);
  if (code.querySelector('span')) throw new Error('Changing the language retained stale syntax.');
  return { renders, fixtures: cases.length };
}

browserTest('matches full syntax rendering across multiline edits, language changes and empty buffers', () => {
  expect(runEditorInChromium(checkSyntaxUpdates)).toEqual({ renders: 35, fixtures: 8 });
}, 60000);

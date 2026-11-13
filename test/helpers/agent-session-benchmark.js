'use strict';

const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const { openChromiumSession, chromium } = require('./chromium-session');

const root = path.resolve(__dirname, '../..');

function createAgentBenchmarkFixture(source, styles) {
  const read = file => fs.readFileSync(path.join(root, file), 'utf8');
  const startup = "  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });\n  else init();";
  const app = source || read('codex_ide/codex-ide.js');
  if (!app.includes(startup)) throw new Error('Agent benchmark must isolate IDE startup.');
  const script = text => '<script>' + text.replace(/<\/script/gi, '<\\/script') + '</script>';
  return read('index.html')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<link\b[^>]*>/gi, '').replace(/<img\b[^>]*>/gi, '')
    .replace('</head>', () => '<style>' + (styles || read('codex_ide/codex-ide.css')) + '</style></head>')
    .replace('</body>', () => ['agentResponse.js', 'codex_ide/editor-diff.js', 'codex_ide/syntax-highlighter.js'].map(file => script(read(file))).join('') +
      script(app.replace(startup, '  window.agentBenchmarkApp = { state, activateBuffer, createAgentSession, showAgentSession, bindEvents, runAgent, persistAgentSessions, initializeAgentSessions };')) +
      script('window.benchmarkAgentSession = ' + benchmarkAgentSession.toString()) + '</body>');
}

// Runs entirely inside the real application UI. Only model responses and the
// persistence endpoint are fixtures; all production agent callbacks, editor
// animations, highlighting, chat, disclosure controls and storage are real.
async function benchmarkAgentSession(config) {
  const app = window.agentBenchmarkApp, { state } = app;
  const node = id => document.getElementById(id);
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
  const source = Array.from({ length: 160 }, (_, i) => `const item${i} = "Grüße 👋";\n`).join('') + 'let marker = "0";\n';
  const session = app.createAgentSession('Agent performance');
  state.sessions = [session];
  let saves = 0, cycles = 0, aborts = 0, eventMs = [], frames = [], activeFrames = [], longTasks = [], edits = [];
  let lastFrame = 0, monitoring = true, frameId, mutations = 0, probeMutations, activeUntil = 0, checkpointCycle = 0;
  const checkpoints = [], persisted = new Map();
  const summarize = values => {
    const sorted = values.slice().sort((a, b) => a - b);
    return { samples: sorted.length, p50Ms: sorted[Math.floor(sorted.length * .5)] || 0,
      p95Ms: sorted[Math.floor(sorted.length * .95)] || 0, maxMs: sorted.at(-1) || 0,
      totalMs: values.reduce((sum, value) => sum + value, 0), over50Ms: values.filter(value => value > 50).length };
  };
  function monitor(timestamp) {
    if (!monitoring) return;
    if (lastFrame) {
      frames.push(timestamp - lastFrame);
      if (state.liveEditorDraft || timestamp <= activeUntil) activeFrames.push(timestamp - lastFrame);
    }
    lastFrame = timestamp;
    frameId = requestAnimationFrame(monitor);
  }
  const observer = new MutationObserver(records => { mutations += records.length; });
  const longTaskObserver = new PerformanceObserver(list => { longTasks.push(...list.getEntries().map(entry => entry.duration)); });
  longTaskObserver.observe({ type: 'longtask' });
  function checkpoint() {
    const report = { elapsedMs: performance.now() - started, cycles, windowCycles: cycles - checkpointCycle, saves, aborts,
      activities: state.activities.length, domNodes: document.querySelectorAll('*').length,
      heapBytes: performance.memory ? performance.memory.usedJSHeapSize : null,
      frames: summarize(frames), activeFrames: summarize(activeFrames), events: summarize(eventMs), edits: summarize(edits), longTasks: summarize(longTasks), mutations };
    checkpoints.push(report);
    window.agentBenchmarkProgress = report;
    frames = []; activeFrames = []; eventMs = []; edits = []; longTasks = []; mutations = 0;
    checkpointCycle = cycles;
  }
  function emit(callback, ...args) {
    const begin = performance.now();
    callback(...args);
    activeUntil = performance.now() + 50;
    eventMs.push(performance.now() - begin);
  }
  window.codexIdeProfile = {
    get: () => config.provider || 'codex',
    listModelHomeWorkspaceFiles: async () => ({ files: [...persisted].map(([path]) => ({ path })), directories: [] }),
    writeModelHomeWorkspaceFile: async (path, content, options) => {
      check(options.editorWorkspaceMode, 'A save lost the editor workspace permissions.');
      check(node('ideEditor').value === content && state.path === path, 'A save bypassed the visible editor.');
      check(node('ideHighlightCode').textContent === content + (content.endsWith('\n') ? ' ' : ''), 'A save preceded visible syntax.');
      check(state.liveEditorDraft && !state.liveEditorDraft.awaitingPaint && !state.liveEditorDraft.presentationPending, 'A save preceded its presentation frame.');
      persisted.set(path, content); saves++;
      return { ok: true };
    },
    apiGenerateReply: async (_prompt, options) => {
      check(options.editorWriteMode && options.editorWorkspaceMode, 'Agent editor-only permissions changed.');
      // Reproduce a late-turn UI without waiting fifteen minutes or replaying
      // hundreds of editor animations. Only completed activity history is seeded.
      for (let index = 0; index < config.preloadCycles; index++) {
        const scope = { threadId: 'benchmark', turnId: 'one-long-turn', itemId: 'preload-reason-' + index, completed: true };
        options.onReasoningSummary('Ich prüfe die Änderung 👋.', scope);
        const read = { ...scope, itemId: 'preload-read-' + index, path: 'session.js', operation: 'read', appServerTool: true };
        options.onSkillStart('workspace.extended-files', read);
        options.onSkillUse('workspace.extended-files', read);
        options.onToolEvent({ ...scope, itemId: 'preload-tool-' + index, operation: 'read', target: 'session.js', source: 'app-server', status: 'completed', output: 'Prüfung erfolgreich 👋' });
        options.onToolEvent({ ...scope, itemId: 'preload-editor-' + index, operation: 'edit', target: 'session.js', source: 'editor', status: 'completed' });
        if ((index + 1) % 12 === 0) {
          const terminal = { ...scope, itemId: 'preload-terminal-' + index, command: 'fixture-check', status: 'inProgress' };
          options.onTerminalStart(terminal);
          options.onTerminalOutput('Alle Prüfungen erfolgreich 👋\n'.repeat(8), terminal);
          options.onTerminalComplete({ ...terminal, status: 'completed', exit_code: 0 });
        }
      }
      if (config.preloadCycles) {
        await frame(); await frame(); await wait(200);
        observer.takeRecords();
        frames = []; activeFrames = []; eventMs = []; longTasks = []; edits = []; mutations = 0; lastFrame = 0;
      }
      for (let cycle = 0; cycle < config.cycles; cycle++) {
        window.agentBenchmarkProgress = { ...window.agentBenchmarkProgress, cycle, stage: 'events', activities: state.activities.length };
        const scope = { threadId: 'benchmark', turnId: 'one-long-turn', itemId: 'reason-' + cycle, summaryIndex: 0 };
        emit(options.onReasoningSummary, 'Ich prüfe ', scope);
        emit(options.onReasoningSummary, 'die Änderung 👋.', scope);
        emit(options.onReasoningSummary, '', { ...scope, completed: true });
        const read = { ...scope, itemId: 'read-' + cycle, path: 'session.js', operation: 'read', appServerTool: true };
        emit(options.onSkillStart, 'workspace.extended-files', read);
        emit(options.onSkillUse, 'workspace.extended-files', read);
        const tool = { ...scope, itemId: 'tool-' + cycle, operation: 'read', target: 'session.js', source: 'app-server' };
        emit(options.onToolEvent, { ...tool, status: 'running' });
        emit(options.onToolEvent, { ...tool, status: 'completed', output: 'Prüfung erfolgreich 👋' });
        const begin = performance.now();
        const request = { operation: 'edit', path: 'session.js', oldText: `"${cycle % 2}"`, newText: `"${1 - cycle % 2}"` };
        window.agentBenchmarkProgress.stage = 'editor';
        options.onEditorDraft(request);
        await options.onEditorWrite(request, { persist: true, signal: options.signal, editorWorkspaceMode: true });
        edits.push(performance.now() - begin);
        if ((cycle + 1) % 12 === 0) {
          const terminal = { ...scope, itemId: 'terminal-' + cycle, command: 'fixture-check', status: 'inProgress' };
          emit(options.onTerminalStart, terminal);
          emit(options.onTerminalOutput, 'Alle Prüfungen erfolgreich 👋\n'.repeat(8), terminal);
          emit(options.onTerminalComplete, { ...terminal, status: 'completed', exit_code: 0 });
          // Exercise cancellation and restoration without saving the draft.
          const saved = saves;
          options.onEditorDraft({ operation: 'write', path: 'cancelled.js', content: 'const cancelled = "👋";\n'.repeat(20) });
          await frame(); await frame();
          options.onEditorDraftDiscard(); aborts++;
          check(saves === saved && state.path === 'session.js' && !state.buffers['cancelled.js'], 'A cancelled draft escaped into the workspace.');
        }
        cycles++;
        if (cycles === 1) {
          // A later event must leave the first completed card untouched.
          const first = state.activities[0];
          first.element.open = false;
          const probe = new MutationObserver(() => {});
          probe.observe(first.element, { subtree: true, attributes: true, characterData: true, childList: true });
          options.onToolEvent({ ...tool, status: 'completed', output: 'Prüfung erfolgreich 👋' });
          probeMutations = probe.takeRecords().length;
          probe.disconnect();
        }
        const due = started + config.durationMs * cycles / config.cycles;
        if (due > performance.now()) await wait(due - performance.now());
        // Yield even in the accelerated run: these are native display frames.
        await frame();
        if (cycles % config.checkpointCycles === 0 || cycles === config.cycles) checkpoint();
      }
      return '<codex_ide_final>Alle Änderungen im Editor abgeschlossen.</codex_ide_final>';
    }
  };
  app.showAgentSession(session, false);
  app.bindEvents();
  app.activateBuffer('session.js', source, source, false);
  await frame(); await frame();
  observer.observe(node('ideActivity'), { subtree: true, attributes: true, characterData: true, childList: true });
  const started = performance.now();
  frameId = requestAnimationFrame(monitor);
  try {
    node('idePrompt').value = 'Prüfe und bearbeite die Datei wiederholt im Editor.';
    await app.runAgent();
    check(session.lastTurn.status === 'completed', 'The agent turn failed: ' + session.lastTurn.error);
    check(saves === config.cycles, 'The agent lost editor writes.');
    const expected = source.replace('"0"', `"${cycles % 2}"`);
    check(node('ideEditor').value === expected && persisted.get('session.js') === expected, 'Repeated edits corrupted the file.');
    check(!state.liveEditorDraft && state.highlightFrame == null, 'An animation survived the agent turn.');
    check(Object.keys(state.buffers).length === 1 && Object.keys(state.workspaceContents).length === 1, 'Draft buffers accumulated.');
    check(session.lastTurn.activities.length === state.activities.length, 'Persisting discarded activity history.');
    check(!state.activities[0].element.open, 'An update reset a disclosure control.');
    const expectedActivities = (config.cycles + config.preloadCycles) * 4 + Math.floor(config.cycles / 12) + Math.floor(config.preloadCycles / 12);
    check(state.activities.length === expectedActivities, 'The agent lost activities.');
    await app.persistAgentSessions();
    state.sessions = [];
    state.sessionId = '';
    await app.initializeAgentSessions();
    const restored = state.sessions.find(saved => saved.id === session.id);
    check(restored && restored.lastTurn.activities.length === expectedActivities, 'Storage roundtrip lost activity history.');
    app.showAgentSession(restored, false);
    check(node('ideSessionHistory').querySelectorAll('details').length === expectedActivities, 'Restoring the conversation lost cards.');
    return { config, elapsedMs: performance.now() - started, cycles, saves, aborts, probeMutations,
      activities: expectedActivities, persistedActivities: restored.lastTurn.activities.length, restored: true,
      checkpoints, browser: navigator.userAgent };
  } finally {
    monitoring = false;
    cancelAnimationFrame(frameId);
    observer.disconnect(); longTaskObserver.disconnect();
  }
}

async function runAgentSessionBenchmark(options = {}) {
  const config = { durationMs: 0, cycles: 24, checkpointCycles: 12, preloadCycles: 0, provider: 'codex', ...options };
  delete config.source;
  delete config.styles;
  delete config.onProgress;
  delete config.cpuProfile;
  if (options.cpuProfile && config.durationMs > 60000) throw new Error('CPU profiling is limited to short benchmarks (at most 60 seconds).');
  const source = options.source || fs.readFileSync(path.join(root, 'codex_ide/codex-ide.js'), 'utf8');
  const styles = options.styles || fs.readFileSync(path.join(root, 'codex_ide/codex-ide.css'), 'utf8');
  const browser = await openChromiumSession(createAgentBenchmarkFixture(source, styles), {
    timeoutMs: Math.max(90000, config.durationMs + 60000)
  });
  let polling = false;
  const progressTimer = options.onProgress && setInterval(async () => {
    if (polling) return;
    polling = true;
    try { options.onProgress({ ...await browser.evaluate('window.agentBenchmarkProgress'), resources: { ...browser.resources } }); }
    catch (_) { /* The main evaluation reports failures. */ }
    finally { polling = false; }
  }, 15000);
  try {
    await browser.command('Performance.enable');
    if (options.cpuProfile) {
      await browser.command('Profiler.enable');
      await browser.command('Profiler.setSamplingInterval', { interval: 2000 });
      await browser.command('Profiler.start');
    }
    const report = await browser.evaluate('window.benchmarkAgentSession(' + JSON.stringify(config) + ')', Math.max(120000, config.durationMs + 120000));
    const { metrics } = await browser.command('Performance.getMetrics');
    if (options.cpuProfile) {
      const { profile } = await browser.command('Profiler.stop');
      fs.writeFileSync(options.cpuProfile, JSON.stringify(profile));
    }
    report.browserMetrics = Object.fromEntries(metrics.filter(metric => /Layout|RecalcStyle|TaskDuration/.test(metric.name)).map(metric => [metric.name, metric.value]));
    report.recordedAt = new Date().toISOString();
    report.node = process.version;
    report.sourceSha256 = createHash('sha256').update(source).digest('hex');
    report.stylesSha256 = createHash('sha256').update(styles).digest('hex');
    report.resources = { ...browser.resources };
    return report;
  } finally { clearInterval(progressTimer); await browser.close(); }
}

function agentSessionViolations(report) {
  const failures = [];
  const first = report.checkpoints[0], last = report.checkpoints.at(-1);
  if (report.probeMutations > 0) failures.push(`An unchanged completed card was mutated ${report.probeMutations} times.`);
  if (last.events.p95Ms > first.events.p95Ms * 3 + 5) failures.push('Agent event p95 grows with accumulated history.');
  if (last.events.p95Ms > 25) failures.push('Agent event p95 exceeds 25 ms.');
  if (last.frames.p95Ms > Math.max(50, first.frames.p95Ms * 2)) failures.push('Native frame p95 degrades over the session.');
  if (last.activeFrames.p95Ms > Math.max(75, first.activeFrames.p95Ms * 2)) failures.push('Active editor frame p95 degrades over the session.');
  if (last.edits.p95Ms > first.edits.p95Ms * 2 + 100) failures.push('Visible editor edits slow down with accumulated history.');
  if (report.checkpoints.some(point => point.mutations / point.windowCycles > 180)) failures.push('Activity DOM mutation work grows with history.');
  return failures;
}

module.exports = { chromium, createAgentBenchmarkFixture, runAgentSessionBenchmark, agentSessionViolations };

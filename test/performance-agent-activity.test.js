'use strict';

const { createEditor, createElement } = require('./helpers/editor');
const fs = require('fs');
const { performance } = require('perf_hooks');

test('bounds DOM mutations through a large agent turn without discarding history', () => {
  const sourcePath = process.env.CODEX_IDE_PERF_EDITOR_SOURCE;
  const editor = createEditor(sourcePath ? { source: fs.readFileSync(sourcePath, 'utf8') } : {});
  let mutations = 0;
  editor.browser.document.createElement.mockImplementation(tag => {
    const element = createElement(tag), setAttribute = element.setAttribute;
    element.setAttribute = function (...args) { mutations++; return setAttribute.apply(this, args); };
    return element;
  });
  const windows = [], cpuMs = [];
  let started = performance.now();
  for (let index = 0; index < 512; index++) {
    const event = { threadId: 'one-thread', turnId: 'long-turn', itemId: 'tool-' + index,
      operation: 'read', target: 'session.js', source: 'app-server' };
    editor.updateToolActivity({ ...event, status: 'running' });
    editor.updateToolActivity({ ...event, status: 'completed', output: 'Ergebnis 👋 ' + index });
    if ((index + 1) % 128 === 0) {
      windows.push(mutations); mutations = 0;
      cpuMs.push(performance.now() - started); started = performance.now();
    }
    editor.browser.document.createElement.mockClear();
    editor.browser.document.getElementById.mockClear();
  }
  if (process.env.CODEX_IDE_PERF_REPORT === '1' || process.env.npm_lifecycle_event === 'test:performance') {
    console.log(JSON.stringify({ agentActivityWork: { activities: 512, windowActivities: 128, attributeMutations: windows, cpuMs } }));
  }
  expect(editor.state.activities).toHaveLength(512);
  expect(editor.node('ideActivity').children).toHaveLength(512);
  expect(editor.state.activities.every((activity, index) => activity.nodes.content.textContent === 'Ergebnis 👋 ' + index)).toBe(true);
  expect(editor.state.activities.every(activity => activity.status === 'complete')).toBe(true);
  expect(Math.max(...windows)).toBeLessThanOrEqual(128 * 4);
  expect(windows.at(-1)).toBeLessThanOrEqual(windows[0] + 4);
});

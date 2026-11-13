'use strict';

const fs = require('fs');
const path = require('path');
const { chromium, openChromiumSession } = require('./chromium-session');

const projectRoot = path.resolve(__dirname, '../..');
async function runEditorInChromium(check, options = {}) {
  const read = name => fs.readFileSync(path.join(projectRoot, name), 'utf8');
  const init = "  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });\n  else init();";
  const app = options.source || read('codex_ide/codex-ide.js');
  if (!app.includes(init)) throw new Error('The Chromium fixture must isolate IDE startup.');
  const isolated = app.replace(init, `  window.browserEditorUnderTest = {
    state, setBusy, activateBuffer, applyModelEditorWrite, applyModelEditorDraft,
    discardModelEditorDraft, scheduleEditorHighlight
  };`);
  const script = source => '<script>' + source.replace(/<\/script/gi, '<\\/script') + '</script>';
  const fixtureHtml = read('index.html')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<link\b[^>]*>/gi, '').replace(/<img\b[^>]*>/gi, '')
    .replace('</head>', () => '<style>' + read('codex_ide/codex-ide.css') + (options.extraCss || '') + '</style></head>')
    .replace('</body>', () => script(read('codex_ide/editor-diff.js')) + script(read('codex_ide/syntax-highlighter.js')) + script(isolated) +
      script('window.browserEditorResult = Promise.resolve().then(() => (' + check.toString() + ')()); window.browserEditorResult.catch(() => {});') + '</body>');
  const browser = await openChromiumSession(fixtureHtml, { timeoutMs: 55000, exposeGc: true, ...options });
  try {
    return await browser.evaluate('window.browserEditorResult', options.timeoutMs || 55000);
  } finally {
    await browser.close();
  }
}

module.exports = { chromium, runEditorInChromium };

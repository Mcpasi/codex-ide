'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { pathToFileURL } = require('url');

const projectRoot = path.resolve(__dirname, '../..');
const chromium = process.env.CODEX_IDE_TEST_BROWSER || [
  ...String(process.env.PATH || '').split(path.delimiter).flatMap(directory =>
    ['chromium', 'chromium-browser', 'google-chrome'].map(name => path.join(directory, name))),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
].find(candidate => fs.existsSync(candidate));

function runEditorInChromium(check, options = {}) {
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
    .replace('</head>', () => '<style>' + read('codex_ide/codex-ide.css') + '</style></head>')
    .replace('</body>', () => script(read('codex_ide/editor-diff.js')) + script(read('codex_ide/syntax-highlighter.js')) + script(isolated) +
      script('(' + check.toString() + ')().then(report => { document.body.innerHTML = "<pre id=browser-result></pre>"; document.getElementById("browser-result").textContent = encodeURIComponent(JSON.stringify(report)); }).catch(error => { document.body.innerHTML = "<pre id=browser-result></pre>"; document.getElementById("browser-result").textContent = encodeURIComponent(JSON.stringify({ error: error.stack })); });') + '</body>');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-ide-perf-browser-'));
  try {
    const fixture = path.join(temporary, 'editor.html');
    fs.writeFileSync(fixture, fixtureHtml);
    const result = spawnSync(chromium, [
      '--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--disable-background-networking',
      '--no-first-run', '--no-default-browser-check', '--enable-precise-memory-info', '--js-flags=--expose-gc',
      '--dump-dom', '--window-size=1600,900', `--user-data-dir=${path.join(temporary, 'profile')}`, pathToFileURL(fixture).href
    ], { encoding: 'utf8', timeout: 55000, maxBuffer: 2 * 1024 * 1024 });
    if (result.error) throw new Error(result.error.message + '\n' + String(result.stderr || '').slice(-3000));
    if (result.status !== 0) throw new Error('Chromium exited with ' + result.status + ': ' + result.stderr);
    const match = result.stdout.match(/<pre id="browser-result">([^<]*)<\/pre>/);
    if (!match) throw new Error('Chromium did not return an editor benchmark report.');
    const report = JSON.parse(decodeURIComponent(match[1]));
    if (report.error) throw new Error(report.error);
    return report;
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

module.exports = { chromium, runEditorInChromium };

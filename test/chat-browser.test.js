'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { pathToFileURL } = require('url');

const root = path.resolve(__dirname, '..');
const browser = process.env.CODEX_IDE_TEST_BROWSER || String(process.env.PATH || '').split(path.delimiter)
  .flatMap(directory => ['chromium', 'chromium-browser', 'google-chrome'].map(name => path.join(directory, name)))
  .find(candidate => fs.existsSync(candidate));
const browserTest = browser ? test : test.skip;

async function checkChat() {
  function assert(condition, message) { if (!condition) throw new Error(message); }
  const node = id => document.getElementById(id);
  const app = window.chatUnderTest;
  const session = app.createAgentSession();
  let finish;
  let options;
  window.codexIdeProfile = {
    get: () => 'codex',
    listModelHomeWorkspaceFiles: async () => ({ files: [], directories: [] }),
    apiGenerateReply: async (_prompt, callbacks) => {
      options = callbacks;
      return new Promise(resolve => { finish = resolve; });
    }
  };
  app.state.sessions = [session];
  app.showAgentSession(session, false);
  app.bindEvents();
  const message = 'Bitte prüfe die Chatausgabe.\n<script>window.injected=true</script>';
  node('idePrompt').value = message;
  const pending = app.runAgent();
  assert(node('idePrompt').value === '', 'Accepted input must clear before the response');
  assert(node('ideCurrentUserText').textContent === message, 'The current message must appear verbatim');
  assert(!window.injected && !node('ideCurrentUserText').children.length, 'User text must stay text');
  assert(options.editorWriteMode && options.editorWorkspaceMode, 'Editor-only mode must remain active');
  const scope = { itemId: 'reasoning', threadId: 'thread', turnId: 'turn', summaryIndex: 0 };
  options.onReasoningSummary('Ich prüfe ', scope);
  const thought = node('ideActivity').querySelector('details');
  assert(thought.open, 'Native summaries must start expanded');
  thought.querySelector('summary').click();
  assert(!thought.open, 'Summary controls must collapse the card');
  const read = { itemId: 'read', threadId: 'thread', turnId: 'turn', path: 'src/app.js', operation: 'read', appServerTool: true };
  options.onSkillStart('workspace.extended-files', read);
  options.onReasoningSummary('die Chatausgabe.', scope);
  options.onReasoningSummary('', { ...scope, completed: true });
  options.onSkillUse('workspace.extended-files', read);
  assert(node('ideActivity').children[0] === thought && !thought.open, 'Streaming must preserve card nodes and their disclosure state');
  options.onTerminalStart({ item_id: 'command', command: 'npm test', status: 'inProgress' });
  options.onTerminalOutput('Alle Prüfungen erfolgreich 👋\n', { item_id: 'command' });
  options.onTerminalComplete({ item_id: 'command', command: 'npm test', status: 'completed', exit_code: 0 });
  assert(node('ideTerminalOutput').textContent.includes('erfolgreich 👋'), 'Console output must remain available');
  assert(node('ideActivity').children.length === 3, 'Reasoning, workspace access and console must each have one card');
  node('idePrompt').value = 'Nächste Nachricht als Entwurf';
  const cards = [...node('ideActivity').children];
  cards.forEach(card => {
    assert(card.tagName === 'DETAILS', 'Activities must use keyboard-accessible disclosures');
    assert(card.dataset.state === 'complete', 'Completed activities must show completed status');
    const box = card.getBoundingClientRect();
    const parent = node('ideAnswer').getBoundingClientRect();
    assert(box.width > 0 && box.left >= parent.left && box.right <= parent.right + 1, 'Cards must fit within the chat');
  });
  const prompt = node('idePrompt');
  prompt.value = Array(20).fill('Eine weitere Zeile').join('\n');
  prompt.dispatchEvent(new Event('input'));
  assert(prompt.offsetHeight >= 72 && prompt.offsetHeight <= 220, 'The composer must grow within its height bounds');
  const chat = node('ideAnswer');
  for (let index = 0; index < 12; index++) options.onReasoningSummary('Eine längere Arbeitsnotiz. '.repeat(8), { ...scope, itemId: 'extra-' + index });
  chat.scrollTop = 0;
  options.onReasoningSummary('Weitere Information.', { ...scope, itemId: 'extra-12' });
  assert(chat.scrollTop === 0, 'Reading older messages must not be interrupted by new events');
  chat.scrollTop = chat.scrollHeight;
  options.onReasoningSummary('Noch eine Information. '.repeat(20), { ...scope, itemId: 'extra-13' });
  assert(chat.scrollHeight - chat.scrollTop - chat.clientHeight < 3, 'The chat must follow while at the bottom');
  node('idePrompt').value = 'Nächste Nachricht als Entwurf';
  options.onToken('', '<codex_ide_final>**Ergebnis:** Die Ausgabe funktioniert.</codex_ide_final>');
  finish('<codex_ide_final>**Ergebnis:** Die Ausgabe funktioniert.</codex_ide_final>');
  await pending;
  assert(node('idePrompt').value === 'Nächste Nachricht als Entwurf', 'Finishing must keep the next draft');
  assert(node('ideFinal').querySelector('strong').textContent === 'Ergebnis:', 'Assistant formatting must render');
  const savedCardCount = session.lastTurn.activities.length;
  app.showAgentSession(session, false);
  assert(node('ideSessionHistory').children.length === 1, 'Completed conversation must be restored once');
  assert(node('ideSessionHistory').querySelectorAll('details').length === savedCardCount, 'Persisted cards must restore with the turn');
  assert(node('ideCurrentUser').hidden && node('ideFinalStep').hidden, 'Restoring a session must avoid duplicate messages');
  assert(document.documentElement.scrollWidth <= innerWidth, 'The page must fit the viewport');
  return { cards: cards.length, restored: true, width: innerWidth };
}

function createChatFixture() {
  const read = file => fs.readFileSync(path.join(root, file), 'utf8');
  const startup = "  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });\n  else init();";
  const app = read('codex_ide/codex-ide.js');
  if (!app.includes(startup)) throw new Error('Chat browser fixture must isolate startup.');
  const isolated = app.replace(startup, '  window.chatUnderTest = { state, createAgentSession, showAgentSession, bindEvents, runAgent };');
  const script = source => '<script>' + source.replace(/<\/script/gi, '<\\/script') + '</script>';
  return read('index.html')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<link\b[^>]*>/gi, '').replace(/<img\b[^>]*>/gi, '')
    .replace('</head>', () => '<style>' + read('codex_ide/codex-ide.css') + '</style></head>')
    .replace('</body>', () => ['agentResponse.js', 'codex_ide/editor-diff.js', 'codex_ide/syntax-highlighter.js'].map(file => script(read(file))).join('') +
      script(isolated) + script('(' + checkChat.toString() + ')().then(report => { const result = document.createElement("pre"); result.id = "browser-result"; result.hidden = true; result.textContent = encodeURIComponent(JSON.stringify(report)); document.body.appendChild(result); }).catch(error => { const result = document.createElement("pre"); result.id = "browser-result"; result.textContent = encodeURIComponent(JSON.stringify({ error: error.stack })); document.body.appendChild(result); });') + '</body>');
}

browserTest.each([['desktop', 1600, 900], ['mobile', 390, 844]])('renders the complete chat interaction in Chromium: %s', (_name, width, height) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-ide-chat-browser-'));
  try {
    const fixture = path.join(temporary, 'chat.html');
    fs.writeFileSync(fixture, createChatFixture());
    const result = spawnSync(browser, [
      '--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--disable-background-networking',
      '--no-first-run', '--no-default-browser-check', '--dump-dom', '--virtual-time-budget=2000', `--window-size=${width},${height}`,
      `--user-data-dir=${path.join(temporary, 'profile')}`, pathToFileURL(fixture).href
    ], { encoding: 'utf8', timeout: 15000, maxBuffer: 2 * 1024 * 1024 });
    if (result.error) throw result.error;
    expect({ status: result.status, stderr: result.status ? result.stderr : '' }).toEqual({ status: 0, stderr: '' });
    const match = result.stdout.match(/<pre id="browser-result"[^>]*>([^<]*)<\/pre>/);
    expect(match).not.toBeNull();
    const report = JSON.parse(decodeURIComponent(match[1]));
    expect(report.error).toBeUndefined();
    expect(report).toMatchObject({ cards: 3, restored: true });
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}, 20000);

module.exports = { createChatFixture };

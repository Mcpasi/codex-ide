(function () {
  'use strict';

  var SKILL_ID = 'workspace.extended-files';
  var EXTENSION_PATTERN = /\.(?:js|css|html|py)$/i;

  function bridgeBaseUrl() {
    var profile = window.codexIdeProfile;
    var url = profile && typeof (profile.getCliConfig || profile.getCodexConfig) === 'function'
      ? (profile.getCliConfig || profile.getCodexConfig)().url
      : 'http://localhost:8787';
    return String(url || 'http://localhost:8787')
      .replace(/\/+$/, '')
      .replace(/\/v1\/chat\/completions$/i, '')
      .replace(/\/chat\/completions$/i, '')
      .replace(/\/v1$/i, '');
  }

  function normalizePath(value) {
    var path = String(value || '').trim().replace(/\\/g, '/').replace(/^["'`]+|["'`]+$/g, '');
    if (!path) throw new Error('Dateipfad fehlt');
    if (path.length > 500 || /^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(path) || /[\0-\x1f\x7f]/.test(path) || path.split('/').some(function (part) {
      var lower = part.toLowerCase();
      return !part || part === '.' || part === '..' || lower === '.git' || lower === 'node_modules' || /^\.env(?:\.|$)/i.test(part);
    })) throw new Error('Dateipfad muss sicher und relativ zum Modell-Home sein');
    if (!EXTENSION_PATTERN.test(path)) throw new Error('Der Datei-Skill erlaubt nur .js, .css, .html und .py');
    return path;
  }

  function normalizeDirectoryPath(value) {
    var path = String(value || '').trim().replace(/\\/g, '/').replace(/^["'`]+|["'`]+$/g, '');
    if (!path) throw new Error('Ordnerpfad fehlt');
    if (path.length > 500 || /^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(path) || /[\0-\x1f\x7f]/.test(path) || path.split('/').some(function (part) {
      var lower = part.toLowerCase();
      return !part || part === '.' || part === '..' || lower === '.git' || lower === 'node_modules' || /^\.env(?:\.|$)/i.test(part);
    })) throw new Error('Ordnerpfad muss sicher und relativ zum Modell-Home sein');
    return path;
  }

  async function parseResponse(response, action) {
    var data = null;
    try { data = await response.json(); } catch (_) { /* handled below */ }
    if (!response.ok || !data || !data.ok) {
      var message = data && data.error && (data.error.message || data.error.code);
      throw new Error(action + ' fehlgeschlagen' + (message ? ': ' + message : ''));
    }
    return data;
  }

  async function read(path, options) {
    var opts = options || {};
    var normalized = normalizePath(path);
    var response = await fetch(bridgeBaseUrl() + '/codex-ide/extended-files?path=' + encodeURIComponent(normalized), {
      method: 'GET',
      headers: { 'Accept': 'application/json', 'X-Codex-IDE-Skill': SKILL_ID, 'X-Codex-IDE-Permission': 'readCode' },
      signal: opts.signal
    });
    return parseResponse(response, 'Dateizugriff');
  }

  async function write(path, content, options) {
    var opts = options || {};
    var normalized = normalizePath(path);
    var text = String(content == null ? '' : content).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    if (!text.length) throw new Error('Dateiinhalt fehlt');
    var response = await fetch(bridgeBaseUrl() + '/codex-ide/extended-files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Codex-IDE-Skill': SKILL_ID, 'X-Codex-IDE-Permission': 'writeCode' },
      body: JSON.stringify({ path: normalized, content: text, overwrite: opts.overwrite !== false }),
      signal: opts.signal
    });
    return parseResponse(response, 'Dateischreiben');
  }

  async function mkdir(path, options) {
    var opts = options || {};
    var normalized = normalizeDirectoryPath(path);
    var response = await fetch(bridgeBaseUrl() + '/codex-ide/extended-files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Codex-IDE-Skill': SKILL_ID, 'X-Codex-IDE-Permission': 'writeCode' },
      body: JSON.stringify({ operation: 'mkdir', path: normalized }),
      signal: opts.signal
    });
    return parseResponse(response, 'Ordnererstellung');
  }

  window.CodexIdeExtendedFileSkill = {
    id: SKILL_ID,
    extensions: ['.js', '.css', '.html', '.py'],
    read: read,
    write: write,
    mkdir: mkdir
  };
})();

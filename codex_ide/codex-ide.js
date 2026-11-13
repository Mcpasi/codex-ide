(function () {
  'use strict';

  var SESSION_STORAGE_KEY = 'codexIdeAgentSessionsV1';
  var ACTIVE_SESSION_STORAGE_KEY = 'codexIdeActiveAgentSessionV1';
  var SESSION_DB_NAME = 'codexIdeAgentSessions';
  var SESSION_DB_STORE = 'sessionState';
  var sessionDatabasePromise = null;
  var sessionDatabaseAvailable = false;
  var sessionPersistenceRevision = 0;
  var sessionPersistenceChain = Promise.resolve();
  var LIVE_EDITOR_TYPING_INTERVAL_MS = 16;
  var LIVE_EDITOR_MAX_UNITS_PER_FRAME = 64;
  var LIVE_EDITOR_INSERT_CATCHUP_FRAMES = 90;
  var LIVE_EDITOR_DELETE_CATCHUP_FRAMES = 60;
  var editorDiff = typeof module === 'object' && module.exports
    ? require('./editor-diff') : window.CodexIdeEditorDiff;
  var renderedActivities = [];
  var renderedActivitySource = null;
  var renderedActivityRoot = null;
  var visibleActivityCount = 0;
  var activityChatFollow = null;
  var editorHighlightSnapshot = null;
  var editorCaretMeasurement = null;
  var CODEX_REASONING_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

  var state = {
    path: '',
    savedContent: '',
    dirty: false,
    busy: false,
    fileBusy: false,
    consoleMode: false,
    consoleBusy: false,
    consoleController: null,
    consoleItemId: '',
    terminalPanelDismissed: false,
    controller: null,
    files: [],
    directories: [],
    codexModels: [],
    buffers: Object.create(null),
    workspaceContents: Object.create(null),
    collapsedDirectories: Object.create(null),
    permissions: { read: false, write: false },
    history: [],
    skillRuns: [],
    terminalRuns: [],
    activities: [],
    highlightFrame: null,
    liveEditorFollowPending: false,
    liveEditorRangePending: null,
    liveEditorDraft: null,
    workspaceRefreshPending: false,
    turnId: 0,
    sessions: [],
    sessionId: ''
  };

  function byId(id) { return document.getElementById(id); }
  function parseConsoleDirective(value) {
    var normalized = String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
    if (normalized === '/console start') return 'start';
    if (normalized === '/console close') return 'close';
    return '';
  }
  function safeGet(key, fallback) {
    try { var value = localStorage.getItem(key); return value == null ? fallback : value; } catch (_) { return fallback; }
  }
  function safeSet(key, value) { try { localStorage.setItem(key, String(value)); } catch (_) {} }
  function safeRemove(key) { try { localStorage.removeItem(key); } catch (_) {} }
  function openSessionDatabase() {
    if (typeof indexedDB === 'undefined') return Promise.reject(new Error('IndexedDB ist nicht verfügbar.'));
    if (sessionDatabasePromise) return sessionDatabasePromise;
    var cachedOpening = null;
    var opening = new Promise(function (resolve, reject) {
      var request = indexedDB.open(SESSION_DB_NAME, 1);
      request.onupgradeneeded = function () {
        if (!request.result.objectStoreNames.contains(SESSION_DB_STORE)) {
          request.result.createObjectStore(SESSION_DB_STORE);
        }
      };
      request.onsuccess = function () {
        var database = request.result;
        function releaseCachedDatabase() {
          sessionDatabaseAvailable = false;
          if (sessionDatabasePromise === cachedOpening) sessionDatabasePromise = null;
        }
        database.onversionchange = function () {
          database.close();
          releaseCachedDatabase();
        };
        database.onclose = releaseCachedDatabase;
        resolve(database);
      };
      request.onerror = function () { reject(request.error || new Error('Sitzungsspeicher konnte nicht geöffnet werden.')); };
    });
    cachedOpening = opening.catch(function (error) {
      if (sessionDatabasePromise === cachedOpening) sessionDatabasePromise = null;
      sessionDatabaseAvailable = false;
      throw error;
    });
    sessionDatabasePromise = cachedOpening;
    return sessionDatabasePromise;
  }
  function readIndexedSessionState() {
    return openSessionDatabase().then(function (database) {
      return new Promise(function (resolve, reject) {
        var transaction = database.transaction(SESSION_DB_STORE, 'readonly');
        var request = transaction.objectStore(SESSION_DB_STORE).get('active');
        var result = null;
        request.onsuccess = function () { result = request.result || null; };
        request.onerror = function () { reject(request.error || new Error('Sitzungen konnten nicht gelesen werden.')); };
        transaction.oncomplete = function () { resolve(result); };
        transaction.onerror = function () { reject(transaction.error || new Error('Sitzungen konnten nicht gelesen werden.')); };
        transaction.onabort = function () { reject(transaction.error || new Error('Sitzungslesen wurde abgebrochen.')); };
      });
    });
  }
  function writeIndexedSessionState(snapshot) {
    return openSessionDatabase().then(function (database) {
      return new Promise(function (resolve, reject) {
        var transaction = database.transaction(SESSION_DB_STORE, 'readwrite');
        transaction.objectStore(SESSION_DB_STORE).put(snapshot, 'active');
        transaction.oncomplete = function () { resolve(); };
        transaction.onerror = function () { reject(transaction.error || new Error('Sitzungen konnten nicht gespeichert werden.')); };
        transaction.onabort = function () { reject(transaction.error || new Error('Sitzungsspeicherung wurde abgebrochen.')); };
      });
    });
  }
  function createSessionId() {
    return 'codex-ide-session-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }
  function createAgentSession(title) {
    var now = new Date().toISOString();
    return {
      id: createSessionId(),
      title: String(title || '').trim() || t('conversationUntitled', 'Neue Sitzung'),
      history: [],
      turns: [],
      lastReply: '',
      lastTurn: null,
      codexThreadId: '',
      antigravityThreadId: '',
      workspaceToolVersion: 0,
      createdAt: now,
      updatedAt: now
    };
  }
  function normalizeSessionTurn(value) {
    if (!value || typeof value !== 'object') return null;
    var status = String(value.status || '');
    if (['running', 'completed', 'stopped', 'failed', 'interrupted'].indexOf(status) === -1) return null;
    return {
      id: String(value.id || ''),
      user: typeof value.user === 'string' ? value.user : '',
      status: status,
      reply: typeof value.reply === 'string' ? value.reply : '',
      error: typeof value.error === 'string' ? value.error : '',
      activities: Array.isArray(value.activities) ? value.activities.map(snapshotActivity).filter(Boolean) : [],
      startedAt: typeof value.startedAt === 'string' ? value.startedAt : '',
      finishedAt: typeof value.finishedAt === 'string' ? value.finishedAt : ''
    };
  }
  function normalizeAgentSession(value) {
    if (!value || typeof value !== 'object' || typeof value.id !== 'string' || !value.id.trim()) return null;
    var history = Array.isArray(value.history) ? value.history.filter(function (entry) {
      return entry && typeof entry.user === 'string' && typeof entry.reply === 'string';
    }).map(function (entry) { return { user: entry.user, reply: entry.reply }; }) : [];
    var persistedTurns = Array.isArray(value.turns)
      ? value.turns.map(normalizeSessionTurn).filter(Boolean)
      : [];
    var persistedLastTurn = normalizeSessionTurn(value.lastTurn);
    if (!persistedTurns.length) {
      persistedTurns = history.map(function (entry, index) {
        return {
          id: 'legacy-' + index,
          user: entry.user,
          status: 'completed',
          reply: entry.reply,
          error: '',
          startedAt: '',
          finishedAt: ''
        };
      });
      var lastLegacyTurn = persistedTurns.length ? persistedTurns[persistedTurns.length - 1] : null;
      if (persistedLastTurn && persistedLastTurn.status === 'completed' && lastLegacyTurn &&
          persistedLastTurn.user === lastLegacyTurn.user && persistedLastTurn.reply === lastLegacyTurn.reply) {
        persistedTurns[persistedTurns.length - 1] = persistedLastTurn;
      } else if (persistedLastTurn) {
        persistedTurns.push(persistedLastTurn);
      }
    } else if (persistedLastTurn) {
      var matchedLastTurn = -1;
      for (var turnIndex = persistedTurns.length - 1; turnIndex >= 0; turnIndex--) {
        if (persistedTurns[turnIndex].id === persistedLastTurn.id &&
            persistedTurns[turnIndex].startedAt === persistedLastTurn.startedAt) {
          matchedLastTurn = turnIndex;
          break;
        }
      }
      if (matchedLastTurn === -1) persistedTurns.push(persistedLastTurn);
      else persistedTurns[matchedLastTurn] = persistedLastTurn;
    }
    var lastTurn = persistedTurns.length ? persistedTurns[persistedTurns.length - 1] : persistedLastTurn;
    return {
      id: value.id.trim().slice(0, 160),
      title: String(value.title || '').trim() || t('conversationUntitled', 'Neue Sitzung'),
      history: history,
      turns: persistedTurns,
      lastReply: typeof value.lastReply === 'string'
        ? value.lastReply
        : (history.length ? history[history.length - 1].reply : ''),
      lastTurn: lastTurn || null,
      codexThreadId: typeof value.codexThreadId === 'string' ? value.codexThreadId.trim().slice(0, 200) : '',
      antigravityThreadId: typeof value.antigravityThreadId === 'string' ? value.antigravityThreadId.trim().slice(0, 200) : '',
      workspaceToolVersion: Number(value.workspaceToolVersion) || 0,
      createdAt: typeof value.createdAt === 'string' ? value.createdAt : new Date().toISOString(),
      updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : new Date().toISOString()
    };
  }
  function currentAgentSession() {
    for (var i = 0; i < state.sessions.length; i++) {
      if (state.sessions[i].id === state.sessionId) return state.sessions[i];
    }
    return null;
  }
  function persistAgentSessions() {
    var active = currentAgentSession();
    if (active && active.lastTurn && active.lastTurn.status === 'running') {
      active.lastTurn.activities = state.activities.map(snapshotActivity).filter(Boolean);
    }
    var revision = ++sessionPersistenceRevision;
    var snapshot = {
      revision: revision,
      savedAt: new Date().toISOString(),
      sessions: state.sessions.map(function (session) {
        return {
          id: session.id,
          title: session.title,
          history: session.history.map(function (entry) { return { user: entry.user, reply: entry.reply }; }),
          turns: session.turns.map(function (turn) { return normalizeSessionTurn(turn); }).filter(Boolean),
          lastReply: session.lastReply,
          lastTurn: normalizeSessionTurn(session.lastTurn),
          codexThreadId: session.codexThreadId,
          antigravityThreadId: session.antigravityThreadId,
          workspaceToolVersion: session.workspaceToolVersion,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt
        };
      }),
      activeSessionId: state.sessionId
    };
    safeSet(SESSION_STORAGE_KEY, JSON.stringify(snapshot));
    safeSet(ACTIVE_SESSION_STORAGE_KEY, state.sessionId);
    sessionPersistenceChain = sessionPersistenceChain.catch(function () {}).then(function () {
      return writeIndexedSessionState(snapshot);
    }).then(function () {
      sessionDatabaseAvailable = true;
      if (revision === sessionPersistenceRevision) {
        safeRemove(SESSION_STORAGE_KEY);
        safeRemove(ACTIVE_SESSION_STORAGE_KEY);
      }
    }).catch(function () {
      sessionDatabaseAvailable = false;
    });
    return sessionPersistenceChain;
  }
  function normalizeStoredSessionSnapshot(value, fallbackActiveSessionId) {
    if (Array.isArray(value)) {
      return { revision: 0, savedAt: '', sessions: value, activeSessionId: fallbackActiveSessionId || '' };
    }
    if (!value || typeof value !== 'object' || !Array.isArray(value.sessions)) return null;
    return {
      revision: Number.isFinite(Number(value.revision)) ? Math.max(0, Math.floor(Number(value.revision))) : 0,
      savedAt: typeof value.savedAt === 'string' ? value.savedAt : '',
      sessions: value.sessions,
      activeSessionId: typeof value.activeSessionId === 'string' ? value.activeSessionId : (fallbackActiveSessionId || '')
    };
  }
  function chooseStoredSessionSnapshot(indexedState, fallbackState) {
    if (!indexedState) return fallbackState || null;
    if (!fallbackState) return indexedState;
    if (fallbackState.revision !== indexedState.revision) {
      return fallbackState.revision > indexedState.revision ? fallbackState : indexedState;
    }
    return String(fallbackState.savedAt || '') > String(indexedState.savedAt || '') ? fallbackState : indexedState;
  }
  async function initializeAgentSessions() {
    var indexedSnapshot = null;
    try {
      var indexedState = await readIndexedSessionState();
      sessionDatabaseAvailable = true;
      indexedSnapshot = normalizeStoredSessionSnapshot(indexedState, '');
    } catch (_) { /* migrate the localStorage format below */ }
    var fallbackSnapshot = null;
    try {
      fallbackSnapshot = normalizeStoredSessionSnapshot(
        JSON.parse(safeGet(SESSION_STORAGE_KEY, 'null')),
        safeGet(ACTIVE_SESSION_STORAGE_KEY, '')
      );
    } catch (_) { fallbackSnapshot = null; }
    var selectedSnapshot = chooseStoredSessionSnapshot(indexedSnapshot, fallbackSnapshot);
    var stored = selectedSnapshot
      ? selectedSnapshot.sessions.map(normalizeAgentSession).filter(Boolean)
      : [];
    var requestedId = selectedSnapshot ? selectedSnapshot.activeSessionId : '';
    sessionPersistenceRevision = selectedSnapshot ? selectedSnapshot.revision : 0;
    var recoveredAt = new Date().toISOString();
    for (var sessionIndex = 0; sessionIndex < stored.length; sessionIndex++) {
      for (var storedTurnIndex = 0; storedTurnIndex < stored[sessionIndex].turns.length; storedTurnIndex++) {
        var storedTurn = stored[sessionIndex].turns[storedTurnIndex];
        if (storedTurn.status === 'running') {
          storedTurn.status = 'interrupted';
          storedTurn.reply = t('agentRestartInterrupted', 'Der zuvor laufende Turn wurde durch einen Neustart unterbrochen und sauber abgeschlossen. Du kannst in dieser Sitzung fortfahren.');
          storedTurn.error = 'restart';
          storedTurn.finishedAt = recoveredAt;
          (storedTurn.activities || []).forEach(function (activity) {
            if (activity.status !== 'running' && activity.status !== 'waiting') return;
            activity.status = 'stopped';
            if (activity.run) activity.run.status = 'cancelled';
          });
          stored[sessionIndex].updatedAt = recoveredAt;
        }
      }
      stored[sessionIndex].lastTurn = stored[sessionIndex].turns.length
        ? stored[sessionIndex].turns[stored[sessionIndex].turns.length - 1]
        : null;
    }
    if (!stored.length) stored.push(createAgentSession());
    state.sessions = stored;
    var active = stored.filter(function (session) { return session.id === requestedId; })[0] || stored[0];
    state.sessionId = active.id;
    state.history = active.history;
    persistAgentSessions();
  }
  function sessionTitleFromInstruction(instruction) {
    var value = String(instruction || '').replace(/\s+/g, ' ').trim();
    if (!value) return t('conversationUntitled', 'Neue Sitzung');
    return value.length > 54 ? value.slice(0, 53).trimEnd() + '…' : value;
  }
  function renderSessionControls() {
    var select = byId('ideSessionSelect');
    if (!select) return;
    select.innerHTML = '';
    state.sessions.forEach(function (session) {
      var option = document.createElement('option');
      option.value = session.id;
      option.textContent = session.title + ' · ' + format('conversationMessageCount', '{count} Nachrichten', { count: session.history.length });
      option.selected = session.id === state.sessionId;
      select.appendChild(option);
    });
  }
  function renderSessionHistory() {
    var root = byId('ideSessionHistory');
    if (!root) return;
    root.innerHTML = '';
    var session = currentAgentSession();
    var visibleTurns = session && Array.isArray(session.turns)
      ? session.turns.filter(function (turn) { return turn.status !== 'running'; })
      : [];
    visibleTurns.forEach(function (entry) {
      var article = document.createElement('article');
      article.className = 'session-history-entry';
      article.dataset.state = entry.status;
      var user = document.createElement('div');
      user.className = 'session-history-message user';
      var userLabel = document.createElement('strong');
      userLabel.textContent = t('youPrefix', 'Du:');
      user.appendChild(userLabel);
      var userText = document.createElement('div');
      userText.className = 'chat-user-text';
      userText.textContent = entry.user;
      user.appendChild(userText);
      article.appendChild(user);
      if (entry.activities && entry.activities.length) {
        var activityList = document.createElement('div');
        activityList.className = 'agent-activity';
        entry.activities.forEach(function (saved) {
          var activity = snapshotActivity(saved);
          if (!activity) return;
          createActivityElement(activity);
          updateActivityElement(activity);
          activityList.appendChild(activity.element);
        });
        article.appendChild(activityList);
      }
      var assistant = document.createElement('div');
      assistant.className = 'session-history-message assistant';
      var assistantLabel = document.createElement('strong');
      assistantLabel.textContent = t('agentPrefix', 'Codex IDE:');
      assistant.appendChild(assistantLabel);
      var assistantText = document.createElement('div');
      assistantText.className = 'model-rich-text';
      renderModelText(assistantText, entry.reply || entry.error);
      assistant.appendChild(assistantText);
      article.appendChild(assistant);
      root.appendChild(article);
    });
    root.hidden = visibleTurns.length === 0;
  }
  function format(key, fallback, values) {
    var value = t(key, fallback);
    Object.keys(values || {}).forEach(function (name) {
      value = String(value).replace(new RegExp('\\{' + name + '\\}', 'g'), values[name]);
    });
    return value;
  }
  function t(key, fallback) {
    var runtimeWindow = typeof window === 'object' && window ? window : {};
    var locales = runtimeWindow.CodexIdeLocales || {};
    var language = runtimeWindow.__codexIdeCurrentLanguage || 'de';
    var dictionary = locales[language] && locales[language].ui || {};
    var german = locales.de && locales.de.ui || {};
    return dictionary[key] != null ? dictionary[key] : german[key] != null ? german[key] : fallback || key;
  }
  function setText(id, key, fallback) { var el = byId(id); if (el) el.textContent = t(key, fallback); }
  function appendInlineModelText(parent, value) {
    var text = String(value || '');
    var pattern = /(\*\*[^*\n]+\*\*|__[^_\n]+__|`[^`\n]+`|\*[^*\n]+\*|_[^_\n]+_)/g;
    var cursor = 0;
    var match;
    while ((match = pattern.exec(text))) {
      if (match.index > cursor) parent.appendChild(document.createTextNode(text.slice(cursor, match.index)));
      var token = match[0];
      var node;
      if (token.charAt(0) === '`') {
        node = document.createElement('code');
        node.textContent = token.slice(1, -1);
      } else if (token.slice(0, 2) === '**' || token.slice(0, 2) === '__') {
        node = document.createElement('strong');
        node.textContent = token.slice(2, -2);
      } else {
        node = document.createElement('em');
        node.textContent = token.slice(1, -1);
      }
      parent.appendChild(node);
      cursor = match.index + token.length;
    }
    if (cursor < text.length) parent.appendChild(document.createTextNode(text.slice(cursor)));
  }
  function renderModelText(element, value) {
    if (!element) return;
    element.innerHTML = '';
    var text = String(value == null ? '' : value).replace(/\r\n?/g, '\n').trim();
    if (!text) return;
    var lines = text.split('\n');
    var list = null;
    var listType = '';
    var code = null;
    lines.forEach(function (line) {
      var fence = line.match(/^\s*```\s*([^\s`]*)/);
      if (fence) {
        list = null;
        listType = '';
        if (code) {
          code = null;
        } else {
          var pre = document.createElement('pre');
          code = document.createElement('code');
          if (fence[1]) code.setAttribute('data-language', fence[1]);
          pre.appendChild(code);
          element.appendChild(pre);
        }
        return;
      }
      if (code) {
        code.textContent += (code.textContent ? '\n' : '') + line;
        return;
      }
      if (!line.trim()) {
        list = null;
        listType = '';
        return;
      }
      var heading = line.match(/^\s*(#{1,3})\s+(.+)$/);
      if (heading) {
        list = null;
        listType = '';
        var title = document.createElement('h' + Math.min(4, heading[1].length + 2));
        appendInlineModelText(title, heading[2]);
        element.appendChild(title);
        return;
      }
      var bullet = line.match(/^\s*[-*+]\s+(.+)$/);
      var numbered = line.match(/^\s*\d+[.)]\s+(.+)$/);
      if (bullet || numbered) {
        var requestedType = numbered ? 'ol' : 'ul';
        if (!list || listType !== requestedType) {
          list = document.createElement(requestedType);
          listType = requestedType;
          element.appendChild(list);
        }
        var item = document.createElement('li');
        appendInlineModelText(item, (bullet || numbered)[1]);
        list.appendChild(item);
        return;
      }
      list = null;
      listType = '';
      var quote = line.match(/^\s*>\s?(.*)$/);
      var paragraph = document.createElement(quote ? 'blockquote' : 'p');
      appendInlineModelText(paragraph, quote ? quote[1] : line.trim());
      element.appendChild(paragraph);
    });
  }
  function chatShouldFollow() {
    var root = byId('ideAnswer');
    return root && root.scrollHeight - root.scrollTop - root.clientHeight < 64;
  }
  function followChat(follow) {
    var root = byId('ideAnswer');
    if (root && follow) root.scrollTop = root.scrollHeight;
  }
  function resizePrompt() {
    var prompt = byId('idePrompt');
    if (!prompt) return;
    prompt.style.height = 'auto';
    prompt.style.height = Math.max(72, Math.min(prompt.scrollHeight, 220)) + 'px';
  }
  function setCurrentUser(instruction) {
    var user = byId('ideCurrentUser');
    if (!user) return;
    byId('ideCurrentUserText').textContent = instruction || '';
    user.hidden = !instruction;
  }
  function setFinalText(value) {
    var follow = chatShouldFollow();
    renderModelText(byId('ideFinal'), value);
    var step = byId('ideFinalStep');
    if (step) step.hidden = !value;
    followChat(follow);
  }
  function shortError(error) {
    var message = error && error.message ? error.message : String(error || t('writerUnknownError', 'Unbekannter Fehler'));
    return message.length > 240 ? message.slice(0, 237) + '…' : message;
  }
  function isAbort(error) { return error && (error.name === 'AbortError' || /aborted|abgebrochen/i.test(String(error.message || error))); }
  function throwIfAborted(signal) {
    if (!signal || !signal.aborted) return;
    var error = new Error(t('agentStopped', 'Verarbeitung gestoppt.'));
    error.name = 'AbortError';
    throw error;
  }

  function isHtmlPreviewPath(path) {
    var value = String(path || '').replace(/\\/g, '/');
    if (!/\.html$/i.test(value) || value.charAt(0) === '/') return false;
    return value.split('/').every(function (segment) {
      return !!segment && segment !== '.' && segment !== '..';
    });
  }

  function getHtmlPreviewUrl(path) {
    if (!isHtmlPreviewPath(path)) return '';
    return '/codex-ide/preview/' + String(path).replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/');
  }

  function syncHtmlPreviewControl() {
    var button = byId('idePreviewFile');
    if (!button) return;
    button.hidden = !isHtmlPreviewPath(state.path);
    button.disabled = button.hidden || state.busy || state.fileBusy || state.consoleBusy;
  }

  function openHtmlPreview() {
    if (state.busy || state.fileBusy || state.consoleBusy) return;
    var url = getHtmlPreviewUrl(state.path);
    if (!url) return;
    window.open(url, '_blank', 'noopener');
    setEditorStatus(format('idePreviewOpened', 'Vorschau geöffnet: {path}', { path: state.path }), 'ok');
  }

  function syncLanguageControls(language) {
    var group = byId('ideLanguage');
    if (!group) return;
    Array.prototype.forEach.call(group.querySelectorAll('[data-language]'), function (button) {
      var active = button.dataset.language === language;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
  }

  function initializeTranslations() {
    var language = safeGet('codexIdeLanguage', 'de');
    if (!/^(de|en|fr)$/.test(language)) language = 'de';
    window.__codexIdeCurrentLanguage = language;
    window.codexIdeT = function (key) { return t(key, key); };
    document.documentElement.lang = language;
    syncLanguageControls(language);
    applyTranslations();
  }

  function applyTranslations() {
    document.title = t('ideWindowTitle', 'Codex IDE');
    [
      ['ideTitle', 'ideTitle', 'Codex IDE'], ['ideScope', 'ideScope', 'Dein Agent bei der Arbeit — jede Änderung live.'],
      ['ideBackendLabel', 'backendLabel', 'Backend'],
      ['ideModelLabel', 'codexModelSelectLabel', 'Codex-Modell'], ['ideReasoningLabel', 'codexReasoningSelectLabel', 'Denkstufe'],
      ['ideLanguageLabel', 'languageLabel', 'Sprache'], ['ideFilesTitle', 'ideFilesTitle', 'Workspace'],
      ['ideSettingsOpen', 'settingsBtn', '⚙️ Einstellungen'],
      ['ideFileHint', 'ideFileHint', 'Ordner und freigegebene Dateien im Modell-Home. Codex bearbeitet und speichert validierte IDE-Änderungen automatisch im Modell-Home.'],
      ['ideNewFolder', 'ideNewFolder', 'Ordner'],
      ['ideSkillsTitle', 'ideSkillsTitle', 'Agenten-Skills'], ['ideEditorTitle', 'ideEditorTitle', 'Editor'],
      ['ideNewFile', 'ideNewFile', 'Neu'], ['ideSaveFile', 'ideSaveFile', 'Speichern'],
      ['ideAgentTitle', 'ideAgentTitle', 'Agent'], ['ideClearSession', 'ideClearSession', 'Neue Sitzung'],
      ['ideTerminalTitle', 'ideTerminalTitle', 'Konsole'], ['ideTerminalClear', 'ideTerminalClear', 'Leeren'],
      ['ideFinalTitle', 'ideFinalStepLabel', 'Finale Antwort'],
      ['ideSend', 'sendButton', 'Senden'], ['ideStop', 'ideStop', 'Stoppen']
    ].forEach(function (item) { setText(item[0], item[1], item[2]); });
    setText('ideSessionLabel', 'activeConversationLabel', 'Aktive Sitzung');
    setText('ideCurrentUserLabel', 'youPrefix', 'Du:');
    setText('idePromptLabel', 'agentPromptLabel', 'Nachricht an den Agenten');
    setText('idePromptHint', 'agentPromptHint', 'Enter zum Senden · Shift+Enter für eine neue Zeile');
    var sessionHistory = byId('ideSessionHistory');
    if (sessionHistory) sessionHistory.setAttribute('aria-label', t('sessionHistoryLabel', 'Gespeicherter Sitzungsverlauf'));
    var renameSession = byId('ideRenameSession');
    if (renameSession) {
      var renameLabel = t('conversationRename', 'Sitzung umbenennen');
      renameSession.title = renameLabel;
      renameSession.setAttribute('aria-label', renameLabel);
    }
    var deleteSession = byId('ideDeleteSession');
    if (deleteSession) {
      var deleteLabel = t('conversationDelete', 'Sitzung löschen');
      deleteSession.title = deleteLabel;
      deleteSession.setAttribute('aria-label', deleteLabel);
    }
    byId('idePath').placeholder = t('idePathPlaceholder', 'relativer/pfad.md');
    byId('ideEditor').placeholder = t('ideEditorPlaceholder', 'Öffne eine Datei oder beginne ein neues Dokument …');
    byId('idePrompt').placeholder = t('idePromptPlaceholder', 'Beschreibe, was der Agent im Editor oder Modell-Home tun soll …');
    var previewButton = byId('idePreviewFile');
    if (previewButton) {
      var previewLabel = t('idePreviewFile', 'HTML-Vorschau im Browser öffnen');
      previewButton.title = previewLabel;
      previewButton.setAttribute('aria-label', previewLabel);
    }
    var languageLabels = { de: 'Deutsch', en: 'English', fr: 'Français' };
    var languageGroup = byId('ideLanguage');
    if (languageGroup) {
      Array.prototype.forEach.call(languageGroup.querySelectorAll('[data-language]'), function (button) {
        var label = languageLabels[button.dataset.language] || button.dataset.language;
        button.title = label;
        button.setAttribute('aria-label', label);
      });
    }
    syncLanguageControls(window.__codexIdeCurrentLanguage || 'de');
    var antigravityActive = window.codexIdeProfile && window.codexIdeProfile.get && window.codexIdeProfile.get() === 'antigravity';
    byId('ideModel').options[0].textContent = antigravityActive ? t('antigravityDefaultModel', 'Antigravity-Standard') : t('codexDefaultModel', 'Codex-Standard');
    if (antigravityActive) setText('ideModelLabel', 'antigravityModelLabel', 'Antigravity-Modell');
    var reasoningKeys = { '': 'codexReasoningOff', low: 'codexReasoningLow', medium: 'codexReasoningMedium', high: 'codexReasoningHigh', xhigh: 'codexReasoningXHigh', max: 'codexReasoningMax', ultra: 'codexReasoningUltra' };
    Array.prototype.forEach.call(byId('ideReasoning').options, function (option) { option.textContent = t(reasoningKeys[option.value], option.textContent); });
    if (!state.path && !state.dirty) setEditorStatus(t('ideReady', 'Bereit'));
    scheduleEditorHighlight();
    renderTabs();
    renderSkills();
    renderActivities();
    renderTerminal();
    renderSessionControls();
    renderSessionHistory();
    syncHtmlPreviewControl();
    syncPromptControls();
  }

  function setGatewayStatus(message, kind) {
    var el = byId('ideGatewayStatus');
    el.textContent = message || '';
    el.className = 'status' + (kind ? ' ' + kind : '');
  }
  function setEditorStatus(message, kind) {
    var el = byId('ideEditorStatus');
    if (el.textContent !== (message || '')) el.textContent = message || '';
    if (el.className !== (kind || '')) el.className = kind || '';
  }
  function setTerminalStatus(message, kind) {
    var el = byId('ideTerminalStatus');
    if (!el) return;
    el.textContent = message || '';
    el.className = 'terminal-status' + (kind ? ' ' + kind : '');
  }
  function setTerminalPanelVisible(visible, follow) {
    var panel = byId('ideTerminalPanel');
    if (!panel) return;
    panel.hidden = !visible;
    if (visible && follow && typeof panel.scrollIntoView === 'function') {
      panel.scrollIntoView({ block: 'nearest' });
    }
  }
  function terminalDuration(value) {
    var duration = Number(value);
    if (!Number.isFinite(duration) || duration < 0) return '';
    if (duration < 1000) return Math.round(duration) + ' ms';
    return (duration / 1000).toFixed(duration < 10000 ? 1 : 0) + ' s';
  }
  function terminalStateText(run) {
    if (run.status === 'inProgress') return t('ideTerminalRunning', 'läuft …');
    if (run.status === 'completed') return format('ideTerminalCompleted', 'beendet · Exit {code}', { code: run.exitCode == null ? 0 : run.exitCode });
    if (run.status === 'declined') return t('ideTerminalStopped', 'durch Nutzer gestoppt');
    return format('ideTerminalFailed', 'fehlgeschlagen · Exit {code}', { code: run.exitCode == null ? '?' : run.exitCode });
  }
  function terminalCompletionStatus(run) {
    if (run.source === 'user') {
      if (run.status === 'completed') return t('ideUserConsoleLastSuccess', 'Nutzerbefehl erfolgreich beendet.');
      if (run.status === 'declined') return t('ideUserConsoleLastStopped', 'Nutzerbefehl gestoppt.');
      return t('ideUserConsoleLastFailure', 'Nutzerbefehl ist fehlgeschlagen.');
    }
    if (run.status === 'completed') return t('ideTerminalLastSuccess', 'Letzte Modellprüfung erfolgreich.');
    if (run.status === 'declined') return t('ideTerminalLastStopped', 'Modellprüfung durch Nutzer gestoppt.');
    return t('ideTerminalLastFailure', 'Modellprüfung meldet Fehler; der Agent kann sie jetzt korrigieren.');
  }
  function terminalShouldFollow(root) {
    if (!root) return false;
    return root.scrollHeight - root.scrollTop - root.clientHeight < 36;
  }
  function createTerminalRunElement(run) {
    var article = document.createElement('article');
    article.className = 'terminal-run';
    article.dataset.terminalId = run.id;
    var command = document.createElement('div');
    command.className = 'terminal-command';
    var prompt = document.createElement('span');
    prompt.className = 'terminal-prompt';
    prompt.textContent = run.source === 'user' ? '›' : '$';
    var code = document.createElement('code');
    command.appendChild(prompt);
    command.appendChild(code);
    var stream = document.createElement('pre');
    stream.className = 'terminal-stream';
    var meta = document.createElement('footer');
    meta.className = 'terminal-run-meta';
    var origin = document.createElement('span');
    origin.className = 'terminal-run-origin';
    var cwd = document.createElement('span');
    cwd.className = 'terminal-run-cwd';
    var status = document.createElement('span');
    status.className = 'terminal-run-state';
    var duration = document.createElement('span');
    duration.className = 'terminal-run-duration';
    meta.appendChild(origin);
    meta.appendChild(cwd);
    meta.appendChild(status);
    meta.appendChild(duration);
    article.appendChild(command);
    article.appendChild(stream);
    article.appendChild(meta);
    run.element = article;
    run.renderedOutputLength = 0;
    return article;
  }
  function syncTerminalStreamOutput(stream, run) {
    if (!stream || !run) return;
    var output = String(run.output || '');
    var rendered = Number(run.renderedOutputLength);
    if (!Number.isFinite(rendered) || rendered < 0 || rendered > output.length) {
      stream.textContent = '';
      rendered = 0;
    }
    if (rendered < output.length) {
      var delta = output.slice(rendered);
      var lastNode = stream.lastChild;
      if (lastNode && lastNode.nodeType === 3 && typeof lastNode.appendData === 'function') {
        lastNode.appendData(delta);
      } else if (stream.ownerDocument && typeof stream.ownerDocument.createTextNode === 'function' && typeof stream.appendChild === 'function') {
        stream.appendChild(stream.ownerDocument.createTextNode(delta));
      } else {
        stream.textContent = String(stream.textContent || '') + delta;
      }
    }
    run.renderedOutputLength = output.length;
  }
  function updateTerminalRunElement(run, follow) {
    var root = byId('ideTerminalOutput');
    if (!root) return;
    var shouldDisplay = state.consoleMode || !state.terminalPanelDismissed;
    setTerminalPanelVisible(shouldDisplay, shouldDisplay && follow === true);
    var shouldFollow = follow === true || terminalShouldFollow(root);
    if (!run.element || !run.element.parentNode) {
      var empty = root.querySelector('.terminal-empty');
      if (empty) empty.remove();
      root.appendChild(createTerminalRunElement(run));
    }
    run.element.setAttribute('data-state', run.status || 'inProgress');
    run.element.querySelector('.terminal-command code').textContent = run.command || t('ideTerminalPendingCommand', 'Befehl wird übertragen …');
    syncTerminalStreamOutput(run.element.querySelector('.terminal-stream'), run);
    run.element.querySelector('.terminal-run-origin').textContent = run.source === 'user'
      ? t('ideTerminalOriginUser', 'Nutzer')
      : t('ideTerminalOriginModel', 'Modell');
    run.element.querySelector('.terminal-run-cwd').textContent = run.cwd || 'model-home';
    run.element.setAttribute('data-source', run.source || 'model');
    run.element.querySelector('.terminal-run-state').textContent = terminalStateText(run);
    run.element.querySelector('.terminal-run-duration').textContent = terminalDuration(run.durationMs);
    if (shouldFollow) root.scrollTop = root.scrollHeight;
  }
  function renderTerminal() {
    var root = byId('ideTerminalOutput');
    if (!root) return;
    root.innerHTML = '';
    var shouldDisplay = state.consoleMode || (state.terminalRuns.length > 0 && !state.terminalPanelDismissed);
    if (state.terminalRuns.length === 0) {
      var empty = document.createElement('p');
      empty.className = 'terminal-empty';
      empty.textContent = state.consoleMode
        ? t('ideUserConsoleEmpty', 'Nutzerkonsole aktiv. Gib unten einen Befehl ein oder schließe sie mit /console close.')
        : t('ideTerminalEmpty', 'Modellbefehle und Konsolenausgaben erscheinen hier live.');
      root.appendChild(empty);
      setTerminalStatus(state.consoleMode
        ? t('ideUserConsoleActive', 'Nutzerkonsole aktiv · Arbeitsordner model-home · /console close beendet den Modus.')
        : t('ideTerminalReady', 'Bereit'));
      setTerminalPanelVisible(shouldDisplay, false);
      return;
    }
    setTerminalPanelVisible(shouldDisplay, false);
    state.terminalRuns.forEach(function (run) {
      root.appendChild(createTerminalRunElement(run));
      updateTerminalRunElement(run, false);
    });
  }
  function findTerminalRun(itemId, detail) {
    var threadId = detail && (detail.threadId || detail.thread_id) || '';
    var turnId = detail && (detail.turnId || detail.turn_id) || '';
    for (var i = state.terminalRuns.length - 1; i >= 0; i--) {
      if (state.terminalRuns[i].id === itemId && (!threadId || state.terminalRuns[i].threadId === threadId) &&
          (!turnId || state.terminalRuns[i].turnId === turnId)) return state.terminalRuns[i];
    }
    return null;
  }
  function ensureTerminalRun(event) {
    var itemId = String(event && (event.item_id || event.itemId) || '');
    var source = event && event.source === 'user' ? 'user' : 'model';
    var run = itemId ? findTerminalRun(itemId, event) : null;
    if (!run) {
      run = {
        id: itemId || 'terminal-' + (state.terminalRuns.length + 1),
        threadId: event && (event.threadId || event.thread_id) || '',
        turnId: event && (event.turnId || event.turn_id) || '',
        source: source,
        command: '',
        cwd: 'model-home',
        output: '',
        status: 'inProgress',
        exitCode: null,
        durationMs: null,
        renderedOutputLength: 0,
        element: null
      };
      state.terminalRuns.push(run);
    }
    if (event && event.source) run.source = source;
    return run;
  }
  function startTerminalRun(event) {
    var run = ensureTerminalRun(event);
    run.command = String(event && event.command || run.command || '');
    run.cwd = String(event && event.cwd || run.cwd || 'model-home');
    run.status = 'inProgress';
    state.terminalPanelDismissed = false;
    updateTerminalRunElement(run, run.source === 'user' || chatShouldFollow());
    setTerminalStatus(run.source === 'user'
      ? t('ideUserConsoleRunStatus', 'Nutzerbefehl läuft live …')
      : t('ideTerminalRunStatus', 'Modellprüfung läuft live …'), 'running');
  }
  function appendTerminalOutput(delta, event, isInput) {
    if (!delta) return;
    var run = ensureTerminalRun(event);
    var value = String(delta);
    if (isInput) {
      run.output += (run.output && !/\n$/.test(run.output) ? '\n' : '') + '> ' + value;
    } else {
      run.output += value;
    }
    updateTerminalRunElement(run, false);
  }
  function completeTerminalRun(event) {
    var run = ensureTerminalRun(event);
    run.command = String(event && event.command || run.command || '');
    run.cwd = String(event && event.cwd || run.cwd || 'model-home');
    var exitValue = event && (event.exit_code != null ? event.exit_code : event.exitCode);
    run.exitCode = exitValue != null && Number.isFinite(Number(exitValue)) ? Number(exitValue) : null;
    var durationValue = event && (event.duration_ms != null ? event.duration_ms : event.durationMs);
    run.durationMs = durationValue != null && Number.isFinite(Number(durationValue)) ? Number(durationValue) : null;
    var aggregate = event && (event.aggregated_output != null ? event.aggregated_output : event.aggregatedOutput);
    if (!run.output && typeof aggregate === 'string') run.output = aggregate;
    var reported = String(event && event.status || '');
    run.status = run.exitCode === 0 || (run.exitCode == null && reported === 'completed')
      ? 'completed'
      : reported === 'declined' ? 'declined' : 'failed';
    updateTerminalRunElement(run, run.source === 'user' || chatShouldFollow());
    setTerminalStatus(
      terminalCompletionStatus(run),
      run.status === 'completed' ? 'ok' : run.status === 'declined' ? '' : 'error'
    );
  }
  function stopRunningTerminalRuns() {
    var stopped = false;
    var stoppedRun = null;
    state.terminalRuns.forEach(function (run) {
      if (run.status !== 'inProgress') return;
      run.status = 'declined';
      stopped = true;
      stoppedRun = run;
      updateTerminalRunElement(run, false);
    });
    if (stopped) setTerminalStatus(terminalCompletionStatus(stoppedRun));
  }
  function clearTerminal() {
    if (state.busy || state.consoleBusy) return;
    state.terminalRuns = [];
    renderTerminal();
  }
  function syncPromptControls() {
    var running = state.busy || state.consoleBusy;
    var acceptingInput = state.consoleMode && state.consoleBusy && !!state.consoleItemId;
    var prompt = byId('idePrompt');
    var send = byId('ideSend');
    var stop = byId('ideStop');
    var form = byId('idePromptForm');
    if (prompt) {
      prompt.placeholder = acceptingInput
        ? t('ideUserConsoleInputPrompt', 'Programmeingabe senden · /console close beendet den Modus')
        : state.consoleMode
          ? t('ideUserConsolePrompt', 'Konsolenbefehl in model-home · /console close beendet den Modus')
          : t('idePromptPlaceholder', 'Beschreibe, was Codex im Editor oder Modell-Home tun soll …');
    }
    if (send) {
      send.textContent = acceptingInput
        ? t('ideUserConsoleSendInput', 'Eingabe senden')
        : state.consoleMode ? t('ideUserConsoleRun', 'Ausführen') : t('sendButton', 'Senden');
      send.hidden = state.busy || (state.consoleBusy && !acceptingInput);
    }
    if (stop) stop.hidden = !running;
    if (form) form.setAttribute('aria-busy', running ? 'true' : 'false');
    if (document.body) document.body.dataset.ideConsole = state.consoleMode ? 'true' : '';
    var panel = byId('ideTerminalPanel');
    if (panel) panel.setAttribute('data-user-console', state.consoleMode ? 'active' : '');
  }

  function setConsoleMode(active) {
    var next = active === true;
    if (next && (state.busy || state.fileBusy || state.consoleBusy)) {
      byId('idePrompt').value = '';
      setEditorStatus(t('ideUserConsoleUnavailableBusy', 'Die Nutzerkonsole kann erst nach dem laufenden Vorgang geöffnet werden.'), 'error');
      return false;
    }
    state.consoleMode = next;
    byId('idePrompt').value = '';
    if (next) {
      state.terminalPanelDismissed = false;
      renderTerminal();
      setTerminalPanelVisible(true, true);
      setTerminalStatus(t('ideUserConsoleActive', 'Nutzerkonsole aktiv · Arbeitsordner model-home · /console close beendet den Modus.'), 'ok');
    } else {
      state.terminalPanelDismissed = true;
      if (state.consoleController) state.consoleController.abort();
      setTerminalStatus(t('ideUserConsoleClosed', 'Nutzerkonsole geschlossen.'));
      setTerminalPanelVisible(false, false);
    }
    syncPromptControls();
    byId('idePrompt').focus();
    return true;
  }

  function createUserConsoleRunId() {
    return 'user-terminal-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  async function readUserConsoleStreamResponse(response, callbacks) {
    if (!response || !response.body || typeof response.body.getReader !== 'function' || typeof TextDecoder === 'undefined') {
      throw new Error(t('ideUserConsoleStreamUnavailable', 'Live-Ausgabe der Nutzerkonsole ist in diesem Browser nicht verfügbar.'));
    }
    var reader = response.body.getReader();
    var decoder = new TextDecoder();
    var buffer = '';

    function handleEvent(rawEvent) {
      var lines = String(rawEvent || '').split(/\r?\n/);
      for (var i = 0; i < lines.length; i++) {
        if (lines[i].indexOf('data:') !== 0) continue;
        var data = lines[i].slice(5).trim();
        if (!data || data === '[DONE]') continue;
        var parsed = JSON.parse(data);
        if (parsed && parsed.error) throw new Error(parsed.error.message || t('ideUserConsoleFailed', 'Nutzerkonsole fehlgeschlagen.'));
        var terminalEvent = parsed && parsed.codexIde && parsed.codexIde.terminal_event;
        if (!terminalEvent) continue;
        if (terminalEvent.phase === 'start' && typeof callbacks.onStart === 'function') {
          callbacks.onStart(terminalEvent);
        } else if (terminalEvent.phase === 'output' && typeof callbacks.onOutput === 'function') {
          callbacks.onOutput(String(terminalEvent.delta || ''), terminalEvent);
        } else if (terminalEvent.phase === 'complete' && typeof callbacks.onComplete === 'function') {
          callbacks.onComplete(terminalEvent);
        }
      }
    }

    while (true) {
      var read = await reader.read();
      if (read.done) break;
      buffer += decoder.decode(read.value, { stream: true });
      var marker;
      while ((marker = /\r?\n\r?\n/.exec(buffer))) {
        var eventText = buffer.slice(0, marker.index);
        buffer = buffer.slice(marker.index + marker[0].length);
        handleEvent(eventText);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) handleEvent(buffer);
  }

  async function sendUserConsoleInput(value) {
    if (!state.consoleMode || !state.consoleBusy || !state.consoleItemId) return;
    var itemId = state.consoleItemId;
    var input = String(value == null ? '' : value) + '\n';
    byId('idePrompt').value = '';
    try {
      var response = await fetch('/codex-ide/console/input', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Codex-IDE-Workspace': 'model-home',
          'X-Codex-IDE-Console': 'user'
        },
        body: JSON.stringify({ itemId: itemId, input: input })
      });
      if (!response.ok) {
        var errorText = '';
        try { errorText = await response.text(); } catch (_) {}
        try {
          var errorPayload = JSON.parse(errorText);
          errorText = errorPayload && errorPayload.error && errorPayload.error.message || errorText;
        } catch (_) { /* keep raw response */ }
        throw new Error('Konsole ' + response.status + ': ' + errorText.slice(0, 500));
      }
      var run = findTerminalRun(itemId);
      if (run && run.status === 'inProgress') {
        setTerminalStatus(t('ideUserConsoleInputSent', 'Eingabe gesendet · Nutzerprogramm läuft weiter …'), 'running');
      }
    } catch (error) {
      var activeRun = findTerminalRun(itemId);
      if (activeRun && activeRun.status === 'inProgress') {
        setTerminalStatus(format('ideUserConsoleInputFailed', 'Eingabe konnte nicht gesendet werden: {message}', {
          message: shortError(error)
        }), 'error');
      }
    } finally {
      if (state.consoleMode) byId('idePrompt').focus();
    }
  }

  async function runUserConsoleCommand(command) {
    if (!state.consoleMode || state.consoleBusy || state.busy || state.fileBusy) return;
    var requested = String(command || '').trim();
    if (!requested) return;
    var controller = new AbortController();
    var itemId = createUserConsoleRunId();
    state.consoleController = controller;
    state.consoleItemId = itemId;
    byId('idePrompt').value = '';
    startTerminalRun({
      item_id: itemId,
      source: 'user',
      command: requested,
      cwd: 'model-home',
      status: 'inProgress'
    });
    setConsoleBusy(true);
    try {
      var response = await fetch('/codex-ide/console', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Codex-IDE-Workspace': 'model-home',
          'X-Codex-IDE-Console': 'user'
        },
        body: JSON.stringify({ command: requested, itemId: itemId }),
        signal: controller.signal
      });
      if (!response.ok) {
        var errorText = '';
        try { errorText = await response.text(); } catch (_) {}
        try {
          var errorPayload = JSON.parse(errorText);
          errorText = errorPayload && errorPayload.error && errorPayload.error.message || errorText;
        } catch (_) { /* keep raw response */ }
        throw new Error('Konsole ' + response.status + ': ' + errorText.slice(0, 500));
      }
      await readUserConsoleStreamResponse(response, {
        onStart: startTerminalRun,
        onOutput: function (delta, terminalEvent) { appendTerminalOutput(delta, terminalEvent, false); },
        onComplete: completeTerminalRun
      });
    } catch (error) {
      var run = findTerminalRun(itemId);
      if (run && run.status === 'inProgress') {
        if (isAbort(error)) {
          completeTerminalRun({ item_id: itemId, source: 'user', status: 'declined' });
        } else {
          appendTerminalOutput(shortError(error) + '\n', { item_id: itemId, source: 'user' }, false);
          completeTerminalRun({ item_id: itemId, source: 'user', status: 'failed' });
        }
      }
    } finally {
      if (state.consoleController === controller) state.consoleController = null;
      if (state.consoleItemId === itemId) state.consoleItemId = '';
      setConsoleBusy(false);
      state.workspaceContents = Object.create(null);
      state.workspaceRefreshPending = true;
      flushPendingWorkspaceRefresh();
    }
  }

  async function handlePromptSubmit(event) {
    if (event) event.preventDefault();
    var promptValue = byId('idePrompt').value;
    var instruction = promptValue.trim();
    var directive = parseConsoleDirective(promptValue);
    if (directive === 'start') {
      if (state.consoleMode) {
        byId('idePrompt').value = '';
        state.terminalPanelDismissed = false;
        setTerminalPanelVisible(true, true);
        setTerminalStatus(t('ideUserConsoleActive', 'Nutzerkonsole aktiv · Arbeitsordner model-home · /console close beendet den Modus.'), 'ok');
        syncPromptControls();
      } else {
        setConsoleMode(true);
      }
      return;
    }
    if (directive === 'close') {
      setConsoleMode(false);
      return;
    }
    if (state.consoleMode) {
      if (state.consoleBusy) await sendUserConsoleInput(promptValue);
      else await runUserConsoleCommand(instruction);
      return;
    }
    await runAgent();
  }

  function setStepState(id, value) {
    var el = byId(id);
    if (el) el.setAttribute('data-state', value || 'idle');
  }
  function syncEditorScroll() {
    syncEditorScrollViewport(byId('ideEditor'), byId('ideHighlight'));
  }
  function syncEditorScrollViewport(editor, highlight) {
    if (!editor || !highlight) return;
    // Native scrollbars shrink the textarea's content viewport. The hidden
    // overflow syntax layer must use that same area or its scroll limits clamp
    // before the textarea's, displacing visible code near the file edges.
    if (highlight.style) {
      var width = Number(editor.clientWidth) || 0;
      var height = Number(editor.clientHeight) || 0;
      if (width > 0) highlight.style.width = width + 'px';
      if (height > 0) highlight.style.height = height + 'px';
    }
    highlight.scrollTop = editor.scrollTop;
    highlight.scrollLeft = editor.scrollLeft;
  }
  function liveEditorCaretGeometry(editor, content, offset) {
    var view = editor.ownerDocument && editor.ownerDocument.defaultView || (typeof window !== 'undefined' ? window : null);
    var computed = view && typeof view.getComputedStyle === 'function' ? view.getComputedStyle(editor) : null;
    var fontSize = parseFloat(computed && computed.fontSize) || 13;
    var lineHeight = parseFloat(computed && computed.lineHeight) || fontSize * 1.55;
    var prefix = content.slice(0, offset);
    var lineStart = prefix.lastIndexOf('\n') + 1;
    var lineText = prefix.slice(lineStart);
    var lineIndex = 0;
    for (var newline = content.indexOf('\n'); newline !== -1 && newline < offset; newline = content.indexOf('\n', newline + 1)) {
      lineIndex += 1;
    }
    var columns = 0;
    var tabSize = parseFloat(computed && computed.tabSize) || 2;
    for (var index = 0; index < lineText.length;) {
      var point = lineText.codePointAt(index);
      columns += point === 9 ? tabSize - columns % tabSize : 1;
      index += point > 0xffff ? 2 : 1;
    }
    var geometry = {
      top: (parseFloat(computed && computed.paddingTop) || 0) + lineIndex * lineHeight,
      left: (parseFloat(computed && computed.paddingLeft) || 0) + columns *
        (fontSize * 0.6 + (parseFloat(computed && computed.letterSpacing) || 0)),
      height: lineHeight
    };
    var doc = editor.ownerDocument || (typeof document !== 'undefined' ? document : null);
    if (!computed || !doc || !doc.body || typeof doc.createElement !== 'function' || typeof doc.createTextNode !== 'function') return geometry;
    // Unwrapped textarea rows have a fixed line height. Shape only the active
    // row: mirroring the entire prefix lays out thousands of unchanged rows
    // twice per keystroke and allocates their text/line boxes on every frame.
    // A clipped zero-size host cannot alter the page's scrollable dimensions.
    var measurement = editorCaretMeasurement;
    if (!measurement || measurement.document !== doc || measurement.host.parentNode !== doc.body) {
      if (measurement) {
        measurement.host.remove();
        if (measurement.fonts && typeof measurement.fonts.removeEventListener === 'function') {
          measurement.fonts.removeEventListener('loadingdone', measurement.invalidate);
          measurement.fonts.removeEventListener('loadingerror', measurement.invalidate);
        }
      }
      var host = doc.createElement('div');
      var mirror = doc.createElement('div');
      var caret = doc.createElement('span');
      if (typeof caret.getBoundingClientRect !== 'function') return geometry;
      host.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;contain:strict;overflow:hidden;visibility:hidden;pointer-events:none';
      mirror.style.cssText = 'position:relative;width:max-content;white-space:pre;border:0;margin:0';
      var text = doc.createTextNode('');
      caret.textContent = '\u200b';
      mirror.appendChild(text);
      mirror.appendChild(caret);
      host.appendChild(mirror);
      doc.body.appendChild(host);
      measurement = { document: doc, host: host, mirror: mirror, caret: caret, text: text, fonts: doc.fonts, measured: null };
      measurement.invalidate = function () { measurement.measured = null; };
      if (measurement.fonts && typeof measurement.fonts.addEventListener === 'function') {
        measurement.fonts.addEventListener('loadingdone', measurement.invalidate);
        measurement.fonts.addEventListener('loadingerror', measurement.invalidate);
      }
      editorCaretMeasurement = measurement;
    }
    var properties = ['fontFamily', 'fontSize', 'fontStyle', 'fontWeight', 'fontStretch', 'fontVariant',
      'fontFeatureSettings', 'fontVariationSettings', 'lineHeight', 'letterSpacing', 'wordSpacing',
      'tabSize', 'textIndent', 'textTransform', 'direction', 'paddingTop', 'paddingRight',
      'paddingBottom', 'paddingLeft'];
    // Read computed styles before changing the connected mirror, avoiding a
    // style/layout flush between every copied font property.
    var values = properties.map(function (property) { return computed[property]; });
    var signature = values.join('\u0001') + (lineIndex > 0 ? '\u0001continuation' : '\u0001first');
    if (measurement.signature !== signature) {
      properties.forEach(function (property, index) { measurement.mirror.style[property] = values[index]; });
      if (lineIndex > 0) measurement.mirror.style.textIndent = '0px';
      measurement.signature = signature;
      measurement.measured = null;
    }
    if (measurement.rowText !== lineText) {
      measurement.text.data = lineText;
      measurement.rowText = lineText;
      measurement.measured = null;
    }
    if (!measurement.measured) {
      var origin = measurement.mirror.getBoundingClientRect();
      var position = measurement.caret.getBoundingClientRect();
      if (position.height > 0) {
        measurement.measured = { top: position.top - origin.top, left: position.left - origin.left, height: Math.max(lineHeight, position.height) };
      }
    }
    if (measurement.measured) {
      geometry.top = lineIndex * lineHeight + measurement.measured.top;
      geometry.left = measurement.measured.left;
      geometry.height = measurement.measured.height;
    }
    return geometry;
  }
  function followLiveEditorRange(editor, highlight, start, end) {
    if (!editor) return;
    var content = String(editor.value == null ? '' : editor.value);
    var safeStart = Math.max(0, Math.min(Number(start) || 0, content.length));
    var safeEnd = Math.max(safeStart, Math.min(Number(end) || safeStart, content.length));
    var doc = editor.ownerDocument || (typeof document !== 'undefined' ? document : null);
    if (editor.readOnly && !editor.disabled && doc && doc.activeElement !== editor && typeof editor.focus === 'function') {
      editor.focus({ preventScroll: true });
    }
    if (typeof editor.setSelectionRange === 'function') {
      // A remote edit should look like keyboard input: the replaced range is
      // backspaced and the caret advances behind the streamed replacement.
      // Selecting the complete growing replacement made deletions look like a
      // block was being added or highlighted instead of naturally typed.
      try { editor.setSelectionRange(safeEnd, safeEnd); } catch (_) {}
    }
    var caret = liveEditorCaretGeometry(editor, content, safeEnd);
    var viewportHeight = Math.max(0, Number(editor.clientHeight) || 0);
    if (viewportHeight > 0) {
      var targetTop = caret.top + caret.height / 2 - viewportHeight / 2;
      var maxTop = Math.max(0, Number(editor.scrollHeight) - viewportHeight);
      editor.scrollTop = Math.max(0, Math.min(targetTop, maxTop));
    }
    var viewportWidth = Math.max(0, Number(editor.clientWidth) || 0);
    if (viewportWidth > 0) {
      var maxLeft = Math.max(0, Number(editor.scrollWidth) - viewportWidth);
      editor.scrollLeft = Math.max(0, Math.min(caret.left - viewportWidth / 2, maxLeft));
    }
    syncEditorScrollViewport(editor, highlight);
  }
  function followLiveEditorWrite(editor, highlight) {
    var end = editor ? String(editor.value == null ? '' : editor.value).length : 0;
    followLiveEditorRange(editor, highlight, end, end);
  }
  function updateEditorHighlightHtml(code, html) {
    var doc = code.ownerDocument;
    var template = doc && doc.createElement('template');
    if (!template || !template.content) { code.innerHTML = html; return; }
    template.innerHTML = html;
    var previous = Array.from(code.childNodes);
    var next = Array.from(template.content.childNodes);
    var start = 0;
    var previousEnd = previous.length - 1;
    var nextEnd = next.length - 1;
    while (start <= previousEnd && start <= nextEnd && previous[start].isEqualNode(next[start])) start += 1;
    while (previousEnd >= start && nextEnd >= start && previous[previousEnd].isEqualNode(next[nextEnd])) {
      previousEnd -= 1;
      nextEnd -= 1;
    }
    // Preserve unchanged syntax nodes so a local keystroke does not invalidate
    // layout for every line. Tokenization still sees the entire source, keeping
    // multiline strings/comments and embedded languages correct.
    var anchor = previous[previousEnd + 1] || null;
    for (var remove = start; remove <= previousEnd; remove += 1) code.removeChild(previous[remove]);
    for (var insert = start; insert <= nextEnd; insert += 1) code.insertBefore(next[insert], anchor);
  }
  function renderEditorHighlight() {
    state.highlightFrame = null;
    var editor = byId('ideEditor');
    var code = byId('ideHighlightCode');
    var surface = byId('ideEditorSurface');
    var path = byId('idePath').value.trim() || state.path || 'untitled.txt';
    if (!editor || !code || !surface) return;
    var highlighter = window.CodexIdeSyntaxHighlighter;
    var highlight = highlighter && highlighter.highlight;
    var content = editor.value;
    var result = editorHighlightSnapshot;
    if (!result || result.content !== content || result.path !== path || result.code !== code ||
        result.highlighter !== highlighter || result.highlight !== highlight) {
      result = typeof highlight === 'function'
        ? highlighter.highlight(content, path)
        : { language: 'text', label: 'Text', html: '' };
      if (typeof highlight === 'function') {
        updateEditorHighlightHtml(code, result.html + (content.endsWith('\n') ? ' ' : ''));
      } else {
        code.textContent = content;
      }
      // Keep only the current source and language metadata, never a history of
      // source/HTML snapshots. Scroll following and paint waiters still run.
      editorHighlightSnapshot = { content: content, path: path, code: code,
        highlighter: highlighter, highlight: highlight, language: result.language, label: result.label };
    }
    if (surface.getAttribute('data-language') !== result.language) surface.setAttribute('data-language', result.language);
    var syntaxMode = byId('ideSyntaxMode');
    var syntaxLabel = format('ideSyntaxMode', 'Syntax: {language}', { language: result.label });
    if (syntaxMode.textContent !== syntaxLabel) syntaxMode.textContent = syntaxLabel;
    if (state.liveEditorRangePending) {
      var range = state.liveEditorRangePending;
      state.liveEditorRangePending = null;
      state.liveEditorFollowPending = false;
      followLiveEditorRange(editor, byId('ideHighlight'), range.start, range.end);
    } else if (state.liveEditorFollowPending) {
      state.liveEditorFollowPending = false;
      followLiveEditorWrite(editor, byId('ideHighlight'));
    } else {
      syncEditorScroll();
    }
    var draft = state.liveEditorDraft;
    if (draft && draft.awaitingPaint) {
      if (state.turnId !== draft.turnId || !state.busy || state.path !== draft.path || !liveEditorContentMatches(editor.value, draft.renderedContent)) {
        cancelLiveEditorInsertFrame(draft);
      } else {
        draft.paintedContent = editor.value;
        draft.awaitingPaint = false;
        scheduleLiveEditorInsertion(draft);
      }
    }
  }
  function scheduleEditorHighlight(followLiveWrite, liveRange) {
    if (liveRange && Number.isFinite(Number(liveRange.start)) && Number.isFinite(Number(liveRange.end))) {
      state.liveEditorRangePending = { start: Number(liveRange.start), end: Number(liveRange.end) };
      state.liveEditorFollowPending = false;
      followLiveEditorRange(byId('ideEditor'), byId('ideHighlight'), Number(liveRange.start), Number(liveRange.end));
    } else if (followLiveWrite) {
      state.liveEditorFollowPending = true;
      state.liveEditorRangePending = null;
      followLiveEditorWrite(byId('ideEditor'), byId('ideHighlight'));
    }
    // Coalesce updates without cancelling the pending paint on every model tick.
    if (state.highlightFrame != null) return;
    var schedule = typeof window.requestAnimationFrame === 'function'
      ? window.requestAnimationFrame.bind(window)
      : function (callback) { return setTimeout(callback, 0); };
    state.highlightFrame = schedule(renderEditorHighlight);
  }
  function updateCounts() { byId('idePosition').textContent = format('ideCharacterCount', '{count} Zeichen', { count: byId('ideEditor').value.length }); }
  function isEditorDirty(pathValue, contentValue, savedPath, savedContent) {
    return String(pathValue == null ? '' : pathValue).trim() !== String(savedPath == null ? '' : savedPath).trim() ||
      String(contentValue == null ? '' : contentValue) !== String(savedContent == null ? '' : savedContent);
  }

  function editorLineOffsets(content) {
    var offsets = [0];
    for (var index = 0; index < content.length; index += 1) {
      if (content.charAt(index) === '\n') offsets.push(index + 1);
    }
    return offsets;
  }

  function normalizeEditorLineHint(options) {
    var hint = options && typeof options === 'object' ? options : {};
    var startLine = Math.floor(Number(hint.startLine));
    var endLine = Math.floor(Number(hint.endLine));
    return {
      startLine: Number.isFinite(startLine) && startLine > 0 ? startLine : null,
      endLine: Number.isFinite(endLine) && endLine > 0 ? endLine : null
    };
  }

  function collectTextMatches(content, search) {
    var matches = [];
    var from = 0;
    while (search && from <= content.length - search.length) {
      var found = content.indexOf(search, from);
      if (found === -1) break;
      matches.push({ start: found, end: found + search.length });
      from = found + Math.max(1, search.length);
    }
    return matches;
  }

  function chooseEditorMatch(matches, content, options) {
    if (!matches.length) return null;
    var hint = normalizeEditorLineHint(options);
    if (!hint.startLine || matches.length === 1) return matches[0];
    var offsets = editorLineOffsets(content);
    var hintedOffset = offsets[Math.min(hint.startLine - 1, offsets.length - 1)];
    return matches.reduce(function (best, candidate) {
      return Math.abs(candidate.start - hintedOffset) < Math.abs(best.start - hintedOffset) ? candidate : best;
    }, matches[0]);
  }

  function whitespaceEquivalentMatches(content, oldText) {
    var normalizedContent = '';
    var sourceStarts = [];
    var sourceEnds = [];
    for (var index = 0; index < content.length;) {
      var start = index;
      if (/\s/.test(content.charAt(index))) {
        while (index < content.length && /\s/.test(content.charAt(index))) index += 1;
        normalizedContent += ' ';
      } else {
        normalizedContent += content.charAt(index);
        index += 1;
      }
      sourceStarts.push(start);
      sourceEnds.push(index);
    }
    var normalizedOldText = oldText.replace(/\s+/g, ' ');
    if (!normalizedOldText) return [];
    return collectTextMatches(normalizedContent, normalizedOldText).map(function (match) {
      return {
        start: sourceStarts[match.start],
        end: sourceEnds[match.end - 1]
      };
    });
  }

  function editorTextSimilarity(leftValue, rightValue) {
    var left = String(leftValue || '').replace(/\s+/g, ' ').trim();
    var right = String(rightValue || '').replace(/\s+/g, ' ').trim();
    if (left === right) return 1;
    if (!left || !right) return 0;
    if (left.length > 2400) left = left.slice(0, 1200) + left.slice(-1200);
    if (right.length > 2400) right = right.slice(0, 1200) + right.slice(-1200);
    if (left.length === 1 || right.length === 1) return left === right ? 1 : 0;
    var pairs = Object.create(null);
    for (var index = 0; index < left.length - 1; index += 1) {
      var pair = left.slice(index, index + 2);
      pairs[pair] = (pairs[pair] || 0) + 1;
    }
    var overlap = 0;
    for (var rightIndex = 0; rightIndex < right.length - 1; rightIndex += 1) {
      var rightPair = right.slice(rightIndex, rightIndex + 2);
      if (!pairs[rightPair]) continue;
      pairs[rightPair] -= 1;
      overlap += 1;
    }
    return (2 * overlap) / ((left.length - 1) + (right.length - 1));
  }

  function lineRangeAt(content, offsets, startLineIndex, endLineIndex, oldText) {
    if (startLineIndex < 0 || startLineIndex >= offsets.length) return null;
    var safeEndLine = Math.max(startLineIndex, Math.min(endLineIndex, offsets.length - 1));
    var start = offsets[startLineIndex];
    var nextLineStart = safeEndLine + 1 < offsets.length ? offsets[safeEndLine + 1] : content.length;
    var end = /\r?\n$/.test(oldText) ? nextLineStart : nextLineStart;
    if (!/\r?\n$/.test(oldText) && end > start && content.charAt(end - 1) === '\n') {
      end -= 1;
      if (end > start && content.charAt(end - 1) === '\r') end -= 1;
    }
    return { start: start, end: end };
  }

  function refineSingleLineEditorRange(content, range, oldText) {
    if (!range || /\r|\n/.test(oldText)) return range;
    var segment = content.slice(range.start, range.end);
    var tokenMatch = /[A-Za-z_$][A-Za-z0-9_$-]*/.exec(oldText);
    if (!tokenMatch || tokenMatch[0].length < 2) return range;
    var token = tokenMatch[0];
    var from = 0;
    var best = null;
    var bestScore = 0;
    while (from <= segment.length - token.length) {
      var tokenPosition = segment.indexOf(token, from);
      if (tokenPosition === -1) break;
      var candidateStart = Math.max(0, tokenPosition - tokenMatch.index);
      var candidateEnd = Math.min(segment.length, candidateStart + oldText.length);
      var trailingStructure = oldText.match(/[^A-Za-z0-9_$\s]+$/);
      if (trailingStructure) {
        var structuralPosition = segment.indexOf(trailingStructure[0], Math.max(tokenPosition + token.length, candidateEnd - trailingStructure[0].length));
        if (structuralPosition !== -1) candidateEnd = structuralPosition + trailingStructure[0].length;
      } else if (/[A-Za-z0-9_$]/.test(oldText.charAt(oldText.length - 1))) {
        while (candidateEnd < segment.length && /[A-Za-z0-9_$]/.test(segment.charAt(candidateEnd))) candidateEnd += 1;
      }
      var score = editorTextSimilarity(oldText, segment.slice(candidateStart, candidateEnd));
      if (score > bestScore) {
        bestScore = score;
        best = { start: range.start + candidateStart, end: range.start + candidateEnd };
      }
      from = tokenPosition + Math.max(1, token.length);
    }
    return best && bestScore >= 0.45 ? best : range;
  }

  function findRebasedEditorMatch(content, oldText, options) {
    var hint = normalizeEditorLineHint(options);
    var offsets = editorLineOffsets(content);
    var oldLines = oldText.split(/\r\n?|\n/);
    var oldLineCount = Math.max(1, oldLines.length - (/\r?\n$/.test(oldText) ? 1 : 0));
    if (hint.startLine) {
      var hintedStart = Math.min(hint.startLine - 1, offsets.length - 1);
      var hintedEnd = hint.endLine
        ? Math.max(hintedStart, hint.endLine - 1)
        : hintedStart + oldLineCount - 1;
      var hintedRange = lineRangeAt(content, offsets, hintedStart, hintedEnd, oldText);
      if (hintedRange) {
        var refinedHintedRange = refineSingleLineEditorRange(content, hintedRange, oldText);
        if (refinedHintedRange && editorTextSimilarity(
          oldText,
          content.slice(refinedHintedRange.start, refinedHintedRange.end)
        ) >= 0.5) return refinedHintedRange;
      }
    }

    var contentLines = content.split('\n');
    if (contentLines.length && contentLines[contentLines.length - 1] === '' && content.endsWith('\n')) contentLines.pop();
    if (!contentLines.length || oldLineCount > contentLines.length) return null;
    var windowCount = contentLines.length - oldLineCount + 1;
    var sampleCount = Math.min(12, oldLineCount);
    var bestStart = -1;
    var bestScore = 0;
    for (var startLine = 0; startLine < windowCount; startLine += 1) {
      var score = 0;
      for (var sample = 0; sample < sampleCount; sample += 1) {
        var oldIndex = sampleCount === 1 ? 0 : Math.round(sample * (oldLineCount - 1) / (sampleCount - 1));
        score += editorTextSimilarity(oldLines[oldIndex], contentLines[startLine + oldIndex]);
      }
      score /= sampleCount;
      if (score > bestScore) {
        bestScore = score;
        bestStart = startLine;
      }
    }
    if (bestStart === -1 || bestScore < 0.5) return null;
    return refineSingleLineEditorRange(
      content,
      lineRangeAt(content, offsets, bestStart, bestStart + oldLineCount - 1, oldText),
      oldText
    );
  }

  function resolveEditorTextEditRanges(content, oldText, newText, replaceAll, options) {
    if (!oldText) throw new Error('Der lokale Suchtext der Editoränderung fehlt.');
    var matches = collectTextMatches(content, oldText);
    if (!matches.length) matches = whitespaceEquivalentMatches(content, oldText);
    // Idempotency is deliberately exact. A merely similar or partly overlapping
    // block can be a new user-requested change (notably a later CSS rule).
    var appliedMatches = newText ? collectTextMatches(content, newText) : [];
    function isInsideAppliedReplacement(match) {
      return appliedMatches.some(function (applied) {
        return match.start >= applied.start && match.end <= applied.end;
      });
    }
    function alreadyAppliedResult(fallbackMatch) {
      var applied = chooseEditorMatch(appliedMatches, content, options) || fallbackMatch || { start: 0, end: 0 };
      return {
        ranges: [],
        appliedRange: applied,
        alreadyApplied: true
      };
    }
    if (matches.length) {
      var pendingMatches = matches.filter(function (match) {
        return !isInsideAppliedReplacement(match);
      });
      if (!pendingMatches.length) return alreadyAppliedResult(chooseEditorMatch(matches, content, options));
      matches = pendingMatches;
    }
    if (replaceAll === true) {
      if (!matches.length) {
        if (appliedMatches.length) return alreadyAppliedResult();
        var replaceAllFallback = findRebasedEditorMatch(content, oldText, options);
        if (replaceAllFallback) matches = [replaceAllFallback];
      }
      if (!matches.length) throw new Error('Der lokale Suchtext konnte im aktuellen Editorpuffer nicht zuverlässig zugeordnet werden.');
      return { ranges: matches };
    }
    var selected = chooseEditorMatch(matches, content, options);
    if (!selected) {
      if (appliedMatches.length) return alreadyAppliedResult();
      selected = findRebasedEditorMatch(content, oldText, options);
    }
    if (!selected) throw new Error('Der lokale Suchtext konnte im aktuellen Editorpuffer nicht zuverlässig zugeordnet werden.');
    return { ranges: [selected] };
  }

  function applyEditorTextEdit(contentValue, oldTextValue, newTextValue, replaceAll, options) {
    var content = String(contentValue == null ? '' : contentValue);
    var oldText = String(oldTextValue == null ? '' : oldTextValue);
    var newText = String(newTextValue == null ? '' : newTextValue);
    var resolved = resolveEditorTextEditRanges(content, oldText, newText, replaceAll, options);
    if (resolved.alreadyApplied) {
      return {
        content: content,
        start: resolved.appliedRange.start,
        end: resolved.appliedRange.end,
        replacements: 0,
        changed: false,
        alreadyApplied: true
      };
    }
    var ranges = resolved.ranges;
    var replacedContent = content;
    for (var index = ranges.length - 1; index >= 0; index -= 1) {
      replacedContent = replacedContent.slice(0, ranges[index].start) + newText + replacedContent.slice(ranges[index].end);
    }
    return {
      content: replacedContent,
      start: ranges[0].start,
      end: ranges[0].start + newText.length,
      replacements: ranges.length
    };
  }

  function localizedEditorTextEdits(content, oldText, newText, replaceAll, options) {
    var resolved = resolveEditorTextEditRanges(content, oldText, newText, replaceAll, options);
    var edits = [];
    resolved.ranges.forEach(function (range) {
      editorDiff.diffText(content.slice(range.start, range.end), newText).forEach(function (edit) {
        edits.push({ start: range.start + edit.start, end: range.start + edit.end, text: edit.text });
      });
    });
    return { ranges: resolved.ranges, edits: edits };
  }

  function assertGranularEditorTextEdit(contentValue, oldTextValue, newTextValue, replaceAll, options) {
    var content = String(contentValue == null ? '' : contentValue);
    var oldText = String(oldTextValue == null ? '' : oldTextValue);
    var newText = String(newTextValue == null ? '' : newTextValue);
    var planned = localizedEditorTextEdits(content, oldText, newText, replaceAll, options);
    var affectedChars = planned.edits.reduce(function (sum, edit) { return sum + edit.end - edit.start; }, 0);
    return { replacements: planned.ranges.length, affectedChars: affectedChars,
      affectedShare: content.length ? affectedChars / content.length : 0,
      oldLines: oldText.split(/\r\n?|\n/).length, newLines: newText ? newText.split(/\r\n?|\n/).length : 0 };
  }

  function updateEditorValue(content) {
    var editor = byId('ideEditor');
    var previous = editor.value;
    if (previous === content) return;
    var start = sharedLiveEditorPrefixLength(previous, content);
    var oldEnd = previous.length, newEnd = content.length;
    while (oldEnd > start && newEnd > start && previous.charAt(oldEnd - 1) === content.charAt(newEnd - 1)) {
      oldEnd -= 1;
      newEnd -= 1;
    }
    if (oldEnd < previous.length && /[\uDC00-\uDFFF]/.test(previous.charAt(oldEnd))) { oldEnd += 1; newEnd += 1; }
    if (typeof editor.setRangeText === 'function') editor.setRangeText(content.slice(start, newEnd), start, oldEnd, 'preserve');
    else editor.value = content;
  }
  function refreshEditorDirty() {
    markDirty(isEditorDirty(byId('idePath').value, byId('ideEditor').value, state.path, state.savedContent));
  }
  function markDirty(dirty) {
    state.dirty = !!dirty;
    byId('ideDirty').textContent = dirty ? t('ideUnsaved', 'Nicht gespeichert') : '';
    if (state.path && state.buffers[state.path]) {
      state.buffers[state.path].content = byId('ideEditor').value;
      state.buffers[state.path].savedContent = state.savedContent;
      state.buffers[state.path].dirty = state.dirty;
    }
    renderTabs();
  }

  function storeActiveBuffer() {
    if (!state.path) return;
    state.buffers[state.path] = {
      path: state.path,
      content: byId('ideEditor').value,
      savedContent: state.savedContent,
      dirty: state.dirty
    };
  }

  function activateBuffer(path, content, savedContent, dirty, options) {
    var opts = options || {};
    if (!opts.liveRange && !opts.followLiveWrite) {
      state.liveEditorRangePending = null;
      state.liveEditorFollowPending = false;
    }
    if (opts.capture !== false) storeActiveBuffer();
    state.path = path || '';
    state.savedContent = String(savedContent == null ? '' : savedContent);
    state.dirty = !!dirty;
    byId('idePath').value = state.path;
    updateEditorValue(String(content == null ? '' : content));
    if (state.path) {
      state.buffers[state.path] = {
        path: state.path,
        content: byId('ideEditor').value,
        savedContent: state.savedContent,
        dirty: state.dirty
      };
    }
    byId('ideDirty').textContent = state.dirty ? t('ideUnsaved', 'Nicht gespeichert') : '';
    updateCounts();
    scheduleEditorHighlight(opts.followLiveWrite === true, opts.liveRange);
    renderTabs();
    renderFiles(state.path);
    syncHtmlPreviewControl();
  }

  function rememberWorkspaceContent(path, content) {
    var targetPath = String(path || '');
    if (!targetPath) return;
    state.workspaceContents[targetPath] = String(content == null ? '' : content);
  }

  function workspaceContentSnapshot(path) {
    var targetPath = String(path || '');
    var available = !!targetPath && Object.prototype.hasOwnProperty.call(state.workspaceContents, targetPath);
    return {
      available: available,
      content: available ? String(state.workspaceContents[targetPath]) : ''
    };
  }

  function activeEditorContentSnapshot(path) {
    var targetPath = String(path || '');
    if (!targetPath || state.path !== targetPath) return { available: false };
    var editor = byId('ideEditor');
    var content = editor.value;
    var savedContent = state.savedContent;
    return {
      available: true,
      content: content,
      savedContent: savedContent,
      dirty: state.dirty === true || isEditorDirty(byId('idePath').value, content, state.path, savedContent)
    };
  }

  function selectEditorBaseSnapshot(draft, buffer, cached, active) {
    if (draft && draft.operation === 'edit') {
      return {
        content: String(draft.baseContent == null ? '' : draft.baseContent),
        savedContent: String(draft.targetSavedContent == null ? draft.baseContent || '' : draft.targetSavedContent),
        source: 'draft'
      };
    }
    if (active && active.available === true) {
      return {
        content: String(active.content == null ? '' : active.content),
        savedContent: String(active.savedContent == null ? '' : active.savedContent),
        source: 'active-editor'
      };
    }
    if (buffer) {
      return {
        content: String(buffer.content == null ? '' : buffer.content),
        savedContent: String(buffer.savedContent == null ? '' : buffer.savedContent),
        source: 'buffer'
      };
    }
    if (cached && cached.available === true) {
      return { content: String(cached.content == null ? '' : cached.content), savedContent: String(cached.content == null ? '' : cached.content), source: 'workspace-read' };
    }
    return null;
  }

  function createEditorRuntimeSnapshot(path, content, savedContent, dirty) {
    return {
      path: String(path || ''),
      content: String(content == null ? '' : content),
      savedContent: String(savedContent == null ? '' : savedContent),
      dirty: dirty === true
    };
  }

  function collectEditorRuntimeSnapshots() {
    storeActiveBuffer();
    return Object.keys(state.buffers).map(function (path) {
      var buffer = state.buffers[path];
      return createEditorRuntimeSnapshot(path, buffer.content, buffer.savedContent, buffer.dirty);
    });
  }

  function attachEditorRuntimeSnapshot(error, snapshot) {
    var runtimeError = error instanceof Error ? error : new Error(String(error || 'Editorfehler'));
    runtimeError.codexIdeEditorSnapshot = snapshot;
    return runtimeError;
  }

  function hasDirtyBuffers() {
    if (state.dirty) return true;
    return Object.keys(state.buffers).some(function (path) { return state.buffers[path] && state.buffers[path].dirty; });
  }

  function renderTabs() {
    var root = byId('ideTabs');
    if (!root) return;
    root.innerHTML = '';
    Object.keys(state.buffers).forEach(function (path) {
      var buffer = state.buffers[path];
      var tab = document.createElement('div');
      tab.className = 'editor-tab' + (path === state.path ? ' active' : '');
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', path === state.path ? 'true' : 'false');
      var open = document.createElement('button');
      open.type = 'button';
      open.className = 'editor-tab-open';
      open.title = path;
      var label = document.createElement('span');
      label.className = 'editor-tab-label';
      label.textContent = path.split('/').pop();
      open.appendChild(label);
      if (buffer.dirty) {
        var dirty = document.createElement('span');
        dirty.className = 'editor-tab-dirty';
        dirty.textContent = '●';
        open.appendChild(dirty);
      }
      open.disabled = state.busy || state.fileBusy || state.consoleBusy;
      open.addEventListener('click', function () { openFile(path); });
      var close = document.createElement('button');
      close.type = 'button';
      close.className = 'editor-tab-close';
      close.textContent = '×';
      close.title = t('ideCloseFile', 'Datei schließen');
      close.disabled = state.busy || state.fileBusy || state.consoleBusy;
      close.addEventListener('click', function () { closeBuffer(path); });
      tab.appendChild(open);
      tab.appendChild(close);
      root.appendChild(tab);
    });
  }

  function closeBuffer(path) {
    var buffer = state.buffers[path];
    if (!buffer || state.busy || state.fileBusy || state.consoleBusy) return;
    if (buffer.dirty && !window.confirm(t('ideDiscardConfirm', 'Ungespeicherte Änderungen verwerfen?'))) return;
    var paths = Object.keys(state.buffers);
    var index = paths.indexOf(path);
    delete state.buffers[path];
    if (state.path === path) {
      var nextPath = paths[index + 1] || paths[index - 1] || '';
      if (nextPath && state.buffers[nextPath]) {
        var next = state.buffers[nextPath];
        activateBuffer(nextPath, next.content, next.savedContent, next.dirty, { capture: false });
      } else {
        activateBuffer('', '', '', false, { capture: false });
      }
    } else {
      renderTabs();
    }
  }

  var modelLoadSequence = 0;
  function cliConfig() {
    return window.codexIdeProfile.getCliConfig ? window.codexIdeProfile.getCliConfig() : window.codexIdeProfile.getCodexConfig();
  }
  function setCliConfig(url, model) {
    return (window.codexIdeProfile.setCliConfig || window.codexIdeProfile.setCodexConfig)(url, model);
  }
  function setCliEffort(value) {
    return (window.codexIdeProfile.setCliReasoningEffort || window.codexIdeProfile.setCodexReasoningEffort)(value);
  }
  function usesCli() {
    return /^(codex|antigravity)$/.test(window.codexIdeProfile.get());
  }
  async function loadModels() {
    var requestId = ++modelLoadSequence;
    var profile = window.codexIdeProfile.get();
    if (profile === 'local') {
      var localReady = window.CodexIdeLocalModel && window.CodexIdeLocalModel.getStatus() === 'ready' && window.CodexIdeLocalModel.isEnabled();
      setGatewayStatus(localReady
        ? t('ideLocalReady', 'Lokales Modell ist bereit.')
        : t('ideLocalNeedsModel', 'Lokaler Modus aktiv; Modell in den Einstellungen laden.'), localReady ? 'ok' : '');
      return;
    }
    if (profile === 'api') {
      var apiConfig = window.codexIdeProfile.getApiConfig();
      setGatewayStatus(apiConfig.url
        ? t('ideApiReady', 'API-Backend ist konfiguriert.')
        : t('ideApiNeedsConfig', 'API-Modus aktiv; Endpunkt in den Einstellungen konfigurieren.'), apiConfig.url ? 'ok' : 'error');
      return;
    }
    setGatewayStatus(t('codexModelsLoading', 'Modelle werden geladen…'));
    try {
      var models = await (window.codexIdeProfile.listCliModels || window.codexIdeProfile.listCodexModels)();
      if (requestId !== modelLoadSequence) return;
      state.codexModels = Array.isArray(models) ? models.slice() : [];
      var select = byId('ideModel');
      while (select.options.length > 1) select.remove(1);
      models.forEach(function (model) {
        var option = document.createElement('option');
        option.value = model.id;
        option.textContent = model.display_name || model.id;
        select.appendChild(option);
      });
      var config = cliConfig();
      select.options[0].textContent = profile === 'antigravity' ? t('antigravityDefaultModel', 'Antigravity-Standard') : t('codexDefaultModel', 'Codex-Standard');
      byId('ideModelLabel').textContent = profile === 'antigravity' ? t('antigravityModelLabel', 'Antigravity-Modell') : t('codexModelSelectLabel', 'Codex-Modell');
      select.value = config.model || '';
      var normalizedEffort = renderCodexReasoningOptions(state.codexModels, select.value, config.reasoningEffort);
      if (normalizedEffort !== (config.reasoningEffort || '')) {
        setCliEffort(normalizedEffort);
      }
      var status = await (window.codexIdeProfile.cliBridgeStatus || window.codexIdeProfile.codexBridgeStatus)();
      if (requestId !== modelLoadSequence) return;
      var loggedIn = !!(status && (status.loggedIn === true || (status.login && status.login.loggedIn === true)));
      setGatewayStatus(loggedIn
        ? (profile === 'antigravity' ? t('antigravityReady', 'Gateway und Antigravity sind bereit.') : t('ideGatewayReady', 'Gateway und Codex sind bereit.'))
        : (profile === 'antigravity' ? t('antigravityLoginRequired', 'Gateway erreichbar; Antigravity-Anmeldung fehlt.') : t('ideGatewayLoginRequired', 'Gateway erreichbar; Codex-Anmeldung fehlt.')), loggedIn ? 'ok' : 'error');
    } catch (error) {
      if (requestId !== modelLoadSequence) return;
      setGatewayStatus(t('codexModelsUnavailable', 'Modellliste nicht verfügbar') + ': ' + shortError(error), 'error');
    }
  }

  function reasoningLevelsForModel(models, modelId) {
    var catalog = Array.isArray(models) ? models : [];
    var selected = null;
    if (modelId) {
      selected = catalog.find(function (model) { return model && model.id === modelId; }) || null;
    } else {
      selected = catalog.find(function (model) { return model && model.is_default === true; }) ||
        catalog.find(function (model) { return model && model.id === 'codex-cli'; }) || null;
    }
    var advertised = selected && Array.isArray(selected.supported_reasoning_efforts)
      ? selected.supported_reasoning_efforts
      : CODEX_REASONING_LEVELS;
    return CODEX_REASONING_LEVELS.filter(function (level) { return advertised.indexOf(level) !== -1; });
  }

  function renderCodexReasoningOptions(models, modelId, requestedEffort) {
    var select = byId('ideReasoning');
    var levels = reasoningLevelsForModel(models, modelId);
    var labels = {
      '': ['codexReasoningOff', 'Aus (Codex-Standard)'],
      low: ['codexReasoningLow', 'Low'],
      medium: ['codexReasoningMedium', 'Medium'],
      high: ['codexReasoningHigh', 'High'],
      xhigh: ['codexReasoningXHigh', 'Extra High'],
      max: ['codexReasoningMax', 'Max'],
      ultra: ['codexReasoningUltra', 'Ultra']
    };
    while (select.options.length) select.remove(0);
    [''].concat(levels).forEach(function (level) {
      var option = document.createElement('option');
      option.value = level;
      option.textContent = level === '' && window.codexIdeProfile.get() === 'antigravity'
        ? t('antigravityDefaultModel', 'Antigravity-Standard') : t(labels[level][0], labels[level][1]);
      select.appendChild(option);
    });
    var normalized = levels.indexOf(requestedEffort) !== -1 ? requestedEffort : '';
    select.value = normalized;
    return normalized;
  }

  async function refreshFiles(preferredPath, options) {
    var opts = options || {};
    if (state.fileBusy && opts.nested !== true) {
      state.workspaceRefreshPending = true;
      return;
    }
    var ownsFileBusy = !state.fileBusy;
    if (ownsFileBusy) setFileBusy(true);
    byId('ideFileList').textContent = t('ideFilesLoading', 'Dateien werden geladen …');
    try {
      await synchronizeWorkspaceState(opts.refreshBuffers === true);
      renderFiles(preferredPath || state.path);
      renderSkills();
      syncLockedControls();
    } catch (error) {
      byId('ideFileList').textContent = t('ideFilesUnavailable', 'Dateiliste nicht verfügbar: ') + shortError(error);
    } finally {
      if (ownsFileBusy) setFileBusy(false);
    }
  }

  async function synchronizeWorkspaceState(refreshBuffers) {
    var result = await window.codexIdeProfile.listModelHomeWorkspaceFiles({ editorWorkspaceMode: true });
    state.files = result.files || [];
    state.directories = result.directories || [];
    state.permissions = result.permissions || { read: false, write: false };
    if (refreshBuffers && typeof window.codexIdeProfile.readModelHomeWorkspaceFile === 'function') {
      storeActiveBuffer();
      var paths = Object.keys(state.buffers);
      for (var i = 0; i < paths.length; i++) {
        var path = paths[i];
        var buffer = state.buffers[path];
        if (!buffer || buffer.dirty) continue;
        if (!state.files.some(function (file) { return file.path === path; })) {
          delete state.buffers[path];
          delete state.workspaceContents[path];
          if (state.path === path) activateBuffer('', '', '', false, { capture: false });
          continue;
        }
        try {
          var response = await window.codexIdeProfile.readModelHomeWorkspaceFile(path, { editorWorkspaceMode: true });
          var file = response && response.file;
          if (!file || typeof file.content !== 'string' || state.buffers[path] !== buffer || buffer.dirty) continue;
          rememberWorkspaceContent(path, file.content);
          if (state.path === path) activateBuffer(path, file.content, file.content, false, { capture: false });
          else state.buffers[path] = { path: path, content: file.content, savedContent: file.content, dirty: false };
        } catch (_) { /* A refresh failure must not end the model turn. */ }
      }
      renderTabs();
    }
    return result;
  }

  function rememberPersistedEditorFile(path, file) {
    // The gateway has confirmed this one save. Update its entry immediately;
    // a recursive workspace listing would block every subsequent model step.
    var index = state.files.findIndex(function (entry) { return entry.path === path; });
    var entry = Object.assign({}, index === -1 ? {} : state.files[index], file || {}, { path: path });
    // File contents belong to the buffer cache, not to the file-tree metadata.
    delete entry.content;
    if (index === -1) state.files.push(entry);
    else state.files[index] = entry;
    var parts = path.split('/');
    parts.pop();
    var parent = '';
    parts.forEach(function (part) {
      parent = parent ? parent + '/' + part : part;
      if (state.directories.indexOf(parent) === -1) state.directories.push(parent);
    });
    renderFiles(path);
  }

  function renderFiles(activePath) {
    var list = byId('ideFileList');
    list.innerHTML = '';
    if (!state.files.length && !state.directories.length) {
      list.textContent = t('ideNoFiles', 'Keine freigegebenen Dateien gefunden.');
      return;
    }
    var items = state.directories.map(function (path) { return { kind: 'directory', path: path }; })
      .concat(state.files.map(function (file) { return { kind: 'file', path: file.path, file: file }; }))
      .sort(function (left, right) {
        var compared = left.path.localeCompare(right.path);
        return compared || (left.kind === 'directory' ? -1 : 1);
      });
    function hiddenByCollapsed(path) {
      var parts = path.split('/');
      parts.pop();
      var parent = '';
      for (var i = 0; i < parts.length; i++) {
        parent = parent ? parent + '/' + parts[i] : parts[i];
        if (state.collapsedDirectories[parent]) return true;
      }
      return false;
    }
    items.forEach(function (item) {
      if (hiddenByCollapsed(item.path)) return;
      var button = document.createElement('button');
      button.type = 'button';
      button.style.paddingLeft = (8 + Math.max(0, item.path.split('/').length - 1) * 14) + 'px';
      button.setAttribute('role', 'treeitem');
      button.disabled = state.busy || state.fileBusy || state.consoleBusy;
      if (item.kind === 'directory') {
        button.className = 'file-item folder' + (state.collapsedDirectories[item.path] ? ' collapsed' : '');
        button.textContent = item.path.split('/').pop();
        button.title = item.path;
        button.setAttribute('aria-expanded', state.collapsedDirectories[item.path] ? 'false' : 'true');
        button.addEventListener('click', function () {
          state.collapsedDirectories[item.path] = !state.collapsedDirectories[item.path];
          renderFiles(activePath);
        });
      } else {
        var file = item.file;
        button.className = 'file-item ' + (file.access === 'extended' ? 'extended ' : '') + (file.path === activePath ? 'active' : '');
        button.textContent = file.path.split('/').pop();
        button.title = file.path + ' · ' + file.bytes + ' B';
        button.setAttribute('aria-selected', file.path === activePath ? 'true' : 'false');
        button.addEventListener('click', function () { openFile(file.path); });
      }
      list.appendChild(button);
    });
  }

  async function openFile(path, force) {
    if ((state.busy || state.fileBusy || state.consoleBusy) && !force) return;
    if (!state.path && state.dirty && !force && !window.confirm(t('ideDiscardConfirm', 'Ungespeicherte Änderungen verwerfen?'))) return;
    if (state.buffers[path] && !force) {
      var existing = state.buffers[path];
      activateBuffer(path, existing.content, existing.savedContent, existing.dirty);
      setEditorStatus(format('ideOpenedFile', 'Geöffnet: {path}', { path: path }), 'ok');
      return { ok: true, file: { path: path, content: existing.content }, local: true };
    }
    setFileBusy(true);
    setEditorStatus(t('ideOpeningFile', 'Datei wird geöffnet …'));
    try {
      var result = await window.codexIdeProfile.readModelHomeWorkspaceFile(path, { editorWorkspaceMode: true });
      var file = result && result.file || {};
      var openedPath = file.path || path;
      var content = String(file.content == null ? '' : file.content);
      rememberWorkspaceContent(openedPath, content);
      activateBuffer(openedPath, content, content, false);
      setEditorStatus(format('ideOpenedFile', 'Geöffnet: {path}', { path: openedPath }), 'ok');
      return result;
    } catch (error) {
      setEditorStatus(shortError(error), 'error');
    } finally {
      setFileBusy(false);
    }
  }

  function newFile() {
    if (state.busy || state.fileBusy || state.consoleBusy) return;
    if (!state.path && state.dirty && !window.confirm(t('ideDiscardConfirm', 'Ungespeicherte Änderungen verwerfen?'))) return;
    activateBuffer('', '', '', false);
    setEditorStatus(t('ideNewFileReady', 'Neuer Editor. Gib einen relativen Model-Home-Pfad an.'));
    byId('idePath').focus();
  }

  async function saveFile() {
    if (state.busy || state.fileBusy || state.consoleBusy) return;
    var path = byId('idePath').value.trim();
    var content = byId('ideEditor').value;
    if (!path) { setEditorStatus(t('idePathRequired', 'Ein relativer Dateipfad ist erforderlich.'), 'error'); return; }
    setFileBusy(true);
    setEditorStatus(t('ideSavingFile', 'Datei wird gespeichert …'));
    try {
      var result = await window.codexIdeProfile.writeModelHomeWorkspaceFile(path, content, { overwrite: true, editorWorkspaceMode: true });
      var file = result && result.file || {};
      var savedPath = file.path || path;
      if (state.path && state.path !== savedPath) delete state.buffers[state.path];
      rememberWorkspaceContent(savedPath, content);
      activateBuffer(savedPath, content, content, false, { capture: false });
      await refreshFiles(state.path, { nested: true });
      setEditorStatus(format('ideSavedFile', 'Gespeichert: {path}', { path: state.path }), 'ok');
    } catch (error) {
      setEditorStatus(shortError(error), 'error');
    } finally {
      setFileBusy(false);
    }
  }

  async function createDirectory() {
    if (state.busy || state.fileBusy || state.consoleBusy) return;
    var requested = window.prompt(t('ideFolderPrompt', 'Relativer Pfad für den neuen Ordner:'));
    if (requested == null) return;
    var path;
    try { path = normalizeTurnPath(requested); } catch (error) { setEditorStatus(shortError(error), 'error'); return; }
    if (!path) { setEditorStatus(t('ideFolderPathRequired', 'Ein relativer Ordnerpfad ist erforderlich.'), 'error'); return; }
    setFileBusy(true);
    setEditorStatus(t('ideCreatingFolder', 'Ordner wird erstellt …'));
    try {
      await window.codexIdeProfile.createModelHomeWorkspaceDirectory(path, { editorWorkspaceMode: true });
      await refreshFiles(state.path, { nested: true });
      setEditorStatus(format('ideCreatedFolder', 'Ordner erstellt: {path}', { path: path }), 'ok');
    } catch (error) {
      setEditorStatus(shortError(error), 'error');
    } finally {
      setFileBusy(false);
    }
  }

  function renderSkills() {
    var el = byId('ideSkillsStatus');
    if (!el || !window.CodexIdeSkillSystem || typeof window.CodexIdeSkillSystem.getSkills !== 'function') return;
    var profile = window.codexIdeProfile ? window.codexIdeProfile.get() : 'codex';
    var skills = window.CodexIdeSkillSystem.getSkills().filter(function (skill) {
      return skill.state.installed && skill.state.enabled && skill.state.profiles.indexOf(profile) !== -1 &&
        window.CodexIdeSkillSystem.canRun(skill.manifest.id, profile);
    });
    el.textContent = format('ideSkillsReady', '{count} für das aktive Backend freigegeben', { count: skills.length });
    el.textContent += ' · ' + format('ideFilePermissions', 'Workspace lesen {read} · Editor bearbeiten {edit} · automatisch speichern {write}', {
      read: state.permissions.read ? t('ideYes', 'ja') : t('ideNo', 'nein'),
      edit: t('ideYes', 'ja'),
      write: state.permissions.write ? t('ideYes', 'ja') : t('ideNo', 'nein')
    });
    var extended = window.CodexIdeSkillSystem.getSkill('workspace.extended-files');
    if (extended && extended.state.enabled && !state.permissions.read) {
      el.textContent += ' · ' + t('ideCodeReadPermissionMissing', 'Skill aktiv, aber Code-Leserecht fehlt');
    }
  }

  function translatedSkillName(id) {
    if (id === 'codex.web_search') return t('codexWebSearchSkillName', 'Codex-Webrecherche');
    var skill = window.CodexIdeSkillSystem && window.CodexIdeSkillSystem.getSkill(id);
    if (!skill) return id;
    var manifest = skill.manifest || {};
    return manifest.displayNameKey ? t(manifest.displayNameKey, manifest.name || id) : manifest.name || id;
  }
  function skillStatus(run) {
    if (run.status === 'running') return t('agentSkillRunning', 'Zugriff läuft …');
    if (run.status === 'cancelled') return t('agentSkillStopped', 'Zugriff gestoppt');
    if (run.status === 'blocked') return t('agentSkillBlocked', 'Nicht gestartet');
    if (run.status === 'failed') return t('agentSkillFailed', 'Zugriff fehlgeschlagen');
    if (run.operation === 'list') return t('agentSkillCompletedList', 'Workspace durchsucht');
    if (run.operation === 'read') return t('agentSkillCompletedRead', 'Datei gelesen');
    if (run.operation === 'write') return t('agentSkillCompletedWrite', 'Datei geschrieben');
    if (Number(run.resultCount) > 0) return format('agentSkillCompletedSources', '{count} Quellen verwendet', { count: run.resultCount });
    if (run.resultCount === 0) return t('agentSkillCompletedNoSources', 'Keine Quellen gefunden');
    return t('agentSkillCompleted', 'Zugriff abgeschlossen');
  }
  function snapshotActivity(activity) {
    if (!activity || ['reasoning', 'skill', 'tool'].indexOf(activity.type) === -1) return null;
    var saved = { type: activity.type };
    ['key', 'text', 'status', 'source', 'name', 'operation', 'target', 'error', 'output'].forEach(function (key) {
      if (typeof activity[key] === 'string') saved[key] = activity[key];
    });
    if (activity.type === 'skill') {
      if (!activity.run || typeof activity.run.id !== 'string') return null;
      saved.run = {};
      ['id', 'key', 'status', 'operation', 'target', 'error', 'source'].forEach(function (key) {
        if (typeof activity.run[key] === 'string') saved.run[key] = activity.run[key];
      });
      if (Number.isFinite(activity.run.resultCount)) saved.run.resultCount = activity.run.resultCount;
    }
    return saved;
  }
  function activityStatusText(status) {
    var keys = { running: ['agentActivityRunning', 'Läuft …'], complete: ['agentActivityComplete', 'Abgeschlossen'],
      stopped: ['agentActivityStopped', 'Gestoppt'], error: ['agentActivityError', 'Fehlgeschlagen'],
      blocked: ['agentActivityBlocked', 'Blockiert'] };
    var value = keys[status] || ['agentActivityWaiting', 'Wartet'];
    return t(value[0], value[1]);
  }
  function activityTitle(activity) {
    if (activity.type === 'reasoning') return t('agentThoughtTitle', 'Denkschritt');
    var data = activity.run || activity;
    var operations = {
      list: ['agentToolList', 'Workspace durchsuchen'], read: ['agentToolRead', 'Datei lesen'],
      open: ['agentToolOpen', 'Datei im Editor öffnen'], edit: ['agentToolEdit', 'Datei im Editor bearbeiten'],
      write: ['agentToolWrite', 'Datei im Editor schreiben'], mkdir: ['agentToolMkdir', 'Ordner erstellen'],
      terminal: ['agentToolTerminal', 'Prüfung ausführen']
    };
    var label = operations[data.operation];
    return label ? t(label[0], label[1]) : activity.name || translatedSkillName(data.id || '') || t('agentToolTitle', 'Werkzeug');
  }
  function createActivityElement(activity) {
    var element = document.createElement('details');
    element.className = 'activity-card activity-' + (activity.type === 'reasoning' ? 'reasoning' : 'tool');
    element.open = activity.type === 'reasoning';
    var summary = document.createElement('summary');
    var icon = document.createElement('span');
    icon.className = 'activity-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = activity.type === 'reasoning' ? '✧' : '⌘';
    var heading = document.createElement('span');
    heading.className = 'activity-heading';
    var title = document.createElement('strong');
    var target = document.createElement('span');
    target.className = 'activity-target';
    heading.appendChild(title);
    heading.appendChild(target);
    var status = document.createElement('span');
    status.className = 'activity-status';
    summary.appendChild(icon);
    summary.appendChild(heading);
    summary.appendChild(status);
    var body = document.createElement('div');
    body.className = 'activity-body';
    var source = document.createElement('span');
    source.className = 'activity-source';
    var content = document.createElement(activity.type === 'reasoning' ? 'div' : 'pre');
    content.className = activity.type === 'reasoning' ? 'model-rich-text' : 'activity-output';
    var error = document.createElement('pre');
    error.className = 'activity-error';
    body.appendChild(source);
    body.appendChild(content);
    body.appendChild(error);
    element.appendChild(summary);
    element.appendChild(body);
    activity.element = element;
    activity.nodes = { title: title, target: target, status: status, source: source, content: content, error: error };
    activity.renderedText = null;
  }
  function updateActivityElement(activity) {
    var data = activity.run || activity;
    var nodes = activity.nodes;
    var status = activity.status || 'idle';
    if (activity.element.getAttribute('data-state') !== status) activity.element.setAttribute('data-state', status);
    setActivityHidden(activity.element, activity.type === 'reasoning' && !activity.text);
    setActivityText(nodes.title, activityTitle(activity));
    setActivityText(nodes.target, data.target || '');
    setActivityHidden(nodes.target, !data.target);
    setActivityText(nodes.status, activityStatusText(activity.status));
    setActivityText(nodes.source, activity.source === 'app-server' || data.source === 'app-server'
      ? 'App Server' : activity.source === 'editor' ? t('ideEditorTitle', 'Editor') : translatedSkillName(data.id || ''));
    var text = activity.type === 'skill' ? skillStatus(data) : activity.output || activity.text || '';
    if (activity.renderedText !== text) {
      if (activity.type === 'reasoning') renderModelText(nodes.content, text);
      else nodes.content.textContent = text;
      activity.renderedText = text;
    }
    setActivityHidden(nodes.content, !text);
    setActivityText(nodes.error, data.error || '');
    setActivityHidden(nodes.error, !data.error);
  }
  function setActivityText(node, text) {
    if (node.textContent !== text) node.textContent = text;
  }
  function setActivityHidden(node, hidden) {
    if (node.hidden !== hidden) node.hidden = hidden;
  }
  function scheduleActivityChatFollow() {
    if (activityChatFollow) return;
    var root = byId('ideAnswer');
    if (!root) return;
    var pending = { root: root, follow: chatShouldFollow(), top: root.scrollTop, turnId: state.turnId };
    activityChatFollow = pending;
    pending.frame = window.requestAnimationFrame(function () {
      if (activityChatFollow !== pending) return;
      activityChatFollow = null;
      // A reader scrolling upwards before the paint cancels the pending follow.
      if (pending.turnId === state.turnId && pending.follow && root.scrollTop >= pending.top - 1) followChat(true);
    });
  }
  function renderActivities(changedActivity) {
    var root = byId('ideActivity');
    if (!root) return;
    // Read scroll geometry once per display frame, before the first mutation.
    // Reading it around every streamed event repeatedly flushed the full chat
    // layout, even after old cards stopped being rewritten.
    var deferredFollow = changedActivity && typeof window.requestAnimationFrame === 'function';
    if (deferredFollow) scheduleActivityChatFollow();
    else if (activityChatFollow) {
      if (typeof window.cancelAnimationFrame === 'function') window.cancelAnimationFrame(activityChatFollow.frame);
      activityChatFollow = null;
    }
    var follow = !deferredFollow && chatShouldFollow();
    var activities = state.activities || [];
    var sourceChanged = renderedActivitySource !== activities;
    var reset = renderedActivityRoot !== root || renderedActivities.length > activities.length ||
      ((!changedActivity || sourceChanged) && renderedActivities.some(function (activity, index) {
        return activities[index] !== activity;
      }));
    renderedActivitySource = activities;
    if (reset) {
      root.textContent = '';
      renderedActivities = [];
      visibleActivityCount = 0;
      renderedActivityRoot = root;
    }
    function update(activity) {
      var wasVisible = activity.element && !activity.element.hidden;
      updateActivityElement(activity);
      visibleActivityCount += Number(!activity.element.hidden) - Number(!!wasVisible);
    }
    var mounted = changedActivity && changedActivity.element && changedActivity.element.parentNode === root;
    // Model events change a single card. Visiting and rewriting every old card
    // here forced a full chat layout per token and made long turns quadratic.
    // Full refreshes still handle translations and final/stop state changes.
    for (var index = changedActivity && !reset ? renderedActivities.length : 0; index < activities.length; index += 1) {
      var activity = activities[index];
      if (index >= renderedActivities.length) {
        createActivityElement(activity);
        activity.element.hidden = true;
        root.appendChild(activity.element);
        renderedActivities.push(activity);
      }
      update(activity);
    }
    if (changedActivity && !reset && mounted) update(changedActivity);
    setActivityHidden(root, visibleActivityCount === 0);
    if (!deferredFollow) followChat(follow);
  }

  function appendReasoningSummary(delta, detail, protectedPaths) {
    if (typeof delta !== 'string' || (!delta && !(detail && (detail.replace === true || detail.completed === true)))) return;
    var scope = detail || {};
    var key = JSON.stringify([scope.threadId || '', scope.turnId || '', scope.itemId || '', scope.summaryIndex || 0]);
    var activity = state.activities.find(function (item) { return item.type === 'reasoning' && item.key === key; });
    if (!activity) {
      if (!delta) return;
      activity = { type: 'reasoning', key: key, rawText: '', text: '', status: 'running', source: 'app-server' };
      state.activities.push(activity);
    }
    activity.rawText = (scope.replace === true ? '' : activity.rawText) + delta;
    activity.text = window.CodexIdeAgentResponse.sanitize(activity.rawText, protectedPaths);
    if (scope.completed === true) activity.status = 'complete';
    renderActivities(activity);
  }

  function skillActivityState(status) {
    if (status === 'completed') return 'complete';
    if (status === 'failed') return 'error';
    if (status === 'cancelled') return 'stopped';
    return status;
  }

  function updateSkillRun(runs, id, status, detail) {
    if (!id) return;
    var scope = detail || {};
    var itemId = scope.itemId || scope.item_id || scope.callId || '';
    var key = itemId ? JSON.stringify([scope.threadId || '', scope.turnId || '', itemId]) : '';
    var run = null;
    if (key) run = runs.find(function (item) { return item.id === id && item.key === key; });
    if (!run && !key && status !== 'running' && status !== 'blocked') {
      for (var i = runs.length - 1; i >= 0; i--) {
        if (runs[i].id === id && runs[i].status === 'running' &&
            (!scope.operation || runs[i].operation === scope.operation) &&
            (!scope.path || !runs[i].target || runs[i].target === scope.path)) { run = runs[i]; break; }
      }
    }
    if (!run) {
      run = { id: id, key: key, status: status };
      runs.push(run);
      state.activities.push({ type: 'skill', status: skillActivityState(status), run: run });
    } else {
      run.status = status;
      var activity = state.activities.find(function (item) { return item.type === 'skill' && item.run === run; });
      if (activity) activity.status = skillActivityState(status);
    }
    if (detail && /^(list|read|write)$/.test(detail.operation)) run.operation = detail.operation;
    if (detail && (detail.path || detail.query)) run.target = String(detail.path || detail.query);
    if (detail && detail.error) run.error = String(detail.error);
    if (detail && detail.appServerTool) run.source = 'app-server';
    if (detail && Number.isFinite(Number(detail.resultCount))) run.resultCount = Math.max(0, Math.round(Number(detail.resultCount)));
    var addedActivity = state.activities.find(function (item) { return item.type === 'skill' && item.run === run; });
    if (addedActivity) addedActivity.status = skillActivityState(status);
    renderActivities(addedActivity);
  }

  function updateToolActivity(event) {
    if (!event) return;
    var id = event.itemId || event.item_id;
    if (!id) return;
    var key = JSON.stringify([event.threadId || event.thread_id || '', event.turnId || event.turn_id || '', id]);
    var activity = state.activities.find(function (item) { return item.type === 'tool' && item.key === key; });
    if (!activity) {
      activity = { type: 'tool', key: key, status: 'running' };
      state.activities.push(activity);
    }
    ['name', 'operation', 'target', 'source', 'output', 'error'].forEach(function (field) {
      if (typeof event[field] === 'string') activity[field] = event[field];
    });
    var status = event.status;
    activity.status = /^(completed|complete|success)$/.test(status) ? 'complete'
      : /^(failed|error)$/.test(status) ? 'error' : /^(cancelled|declined|stopped)$/.test(status) ? 'stopped' : 'running';
    renderActivities(activity);
  }

  function settleActivities(status) {
    state.activities.forEach(function (activity) {
      if (activity.status !== 'running' && activity.status !== 'waiting') return;
      activity.status = status;
      if (activity.run) activity.run.status = status === 'complete' ? 'completed' : status === 'stopped' ? 'cancelled' : 'failed';
    });
  }

  async function runEditorActivity(operation, path, action) {
    var event = { itemId: 'editor-' + state.turnId + '-' + state.activities.length,
      operation: operation, target: path || '', source: 'editor', status: 'running' };
    var turnId = state.turnId;
    updateToolActivity(event);
    try {
      var result = await action();
      if (state.turnId === turnId) updateToolActivity(Object.assign({}, event, { status: 'completed' }));
      return result;
    } catch (error) {
      if (state.turnId === turnId) updateToolActivity(Object.assign({}, event, {
        status: isAbort(error) ? 'stopped' : 'failed', error: shortError(error)
      }));
      throw error;
    }
  }

  function workNoteDescribesInternalMechanics(text) {
    return /(?:codex_ide_|editor(?:protokoll|protocol|[- ]?(?:anfrage|request|anweisung|instruction))|steuerblock|control block|aktionsledger|action ledger|(?:completion|vollst(?:ä|ae)ndigkeits)[- ]?audit|workspace[- ]?audit|recovery[- ]?(?:thread|pass|sitzung)|repair[- ]?pass|benutzer.{0,60}(?:mehrdeutig|ambiguous)|user.{0,60}ambiguous|zeichenlimit|character limit|antwort(?:e|en)?\s+(?:ausschlie(?:ß|ss)lich\s+|nur\s+)(?:auf\s+)?deutsch|auf\s+deutsch\s+antwort(?:e|en)?|nur\s+auf\s+(?:die|seine|diese)\s+frage\s+antwort(?:e|en)?|respond\s+only\s+in\s+english|answer\s+only\s+(?:the|his|this)\s+question|sprach(?:vorgabe|anweisung)|language instruction)/i
      .test(String(text || ''));
  }

  function syncLockedControls() {
    var locked = state.busy || state.fileBusy || state.consoleBusy;
    byId('ideStop').disabled = false;
    ['ideRefreshFiles', 'ideNewFolder', 'ideNewFile', 'ideSaveFile', 'idePreviewFile', 'ideClearSession', 'ideRenameSession', 'ideDeleteSession', 'ideSessionSelect', 'ideTerminalClear', 'idePath', 'ideModel', 'ideReasoning', 'ideBackend', 'ideLanguage', 'ideSettingsOpen'].forEach(function (id) {
      var control = byId(id);
      if (control) control.disabled = locked;
    });
    byId('ideEditor').disabled = false;
    byId('ideEditor').readOnly = locked;
    var languageGroup = byId('ideLanguage');
    if (languageGroup) {
      Array.prototype.forEach.call(languageGroup.querySelectorAll('button'), function (button) { button.disabled = locked; });
    }
    Array.prototype.forEach.call(byId('ideFileList').querySelectorAll('button'), function (button) { button.disabled = locked; });
    byId('ideNewFolder').disabled = locked || !state.permissions.write;
    byId('ideSend').disabled = state.fileBusy;
    syncHtmlPreviewControl();
    renderTabs();
  }

  function setBusy(busy) {
    state.busy = !!busy;
    document.body.dataset.ideBusy = busy ? 'true' : '';
    if (busy && byId('ideSettingsOverlay')) byId('ideSettingsOverlay').hidden = true;
    syncPromptControls();
    syncLockedControls();
    flushPendingWorkspaceRefresh();
  }

  function setFileBusy(busy) {
    state.fileBusy = !!busy;
    syncLockedControls();
    flushPendingWorkspaceRefresh();
  }

  function setConsoleBusy(busy) {
    state.consoleBusy = !!busy;
    document.body.dataset.ideConsoleBusy = busy ? 'true' : '';
    if (busy && byId('ideSettingsOverlay')) byId('ideSettingsOverlay').hidden = true;
    syncPromptControls();
    syncLockedControls();
    flushPendingWorkspaceRefresh();
  }

  function flushPendingWorkspaceRefresh() {
    if (!state.workspaceRefreshPending || state.busy || state.fileBusy || state.consoleBusy) return;
    state.workspaceRefreshPending = false;
    refreshFiles();
  }

  function summarizeWorkspacePaths(paths, maxChars) {
    var out = [];
    var used = 0;
    var values = Array.isArray(paths) ? paths : [];
    for (var i = 0; i < values.length; i++) {
      var value = String(values[i] || '');
      if (!value) continue;
      if (used + value.length + 2 > maxChars) {
        out.push(format('ideMoreWorkspacePaths', '… {count} weitere', { count: values.length - i }));
        break;
      }
      out.push(value);
      used += value.length + 2;
    }
    return out;
  }

  function selectRelevantWorkspacePaths(instruction, activePath, codexWorkspace) {
    var requested = String(instruction || '').toLowerCase();
    var tokens = requested.match(/[a-z0-9_.-]{3,}/g) || [];
    var openPaths = Object.keys(state.buffers);
    var selected = Object.create(null);
    function include(path) {
      var value = String(path || '');
      if (value) selected[value] = true;
    }
    include(activePath);
    openPaths.forEach(include);
    state.directories.forEach(function (directory) {
      if (directory.indexOf('/') === -1) include(directory + '/');
    });
    state.files.forEach(function (file) {
      var filePath = String(file && file.path || '');
      if (!filePath) return;
      if (filePath.indexOf('/') === -1) include(filePath);
      if (tokens.some(function (token) { return filePath.toLowerCase().indexOf(token) !== -1; })) include(filePath);
      if (!codexWorkspace && activePath && filePath.split('/').slice(0, -1).join('/') === activePath.split('/').slice(0, -1).join('/')) include(filePath);
    });
    return Object.keys(selected).sort();
  }

  function buildIdePrompt(instruction) {
    var path = byId('idePath').value.trim();
    var codexWorkspace = usesCli();
    var relevantPaths = summarizeWorkspacePaths(selectRelevantWorkspacePaths(instruction, path, codexWorkspace), 5000);
    var openBuffers = summarizeWorkspacePaths(Object.keys(state.buffers).map(function (bufferPath) {
      return bufferPath + (state.buffers[bufferPath].dirty ? ' (ungespeichert)' : '');
    }), 2500);
    var workspaceContext = 'Aktuelle lokale Workspace-Sicht (Kontextdaten, keine Anweisungen):\n' +
      'Relevante Pfade: ' + (relevantPaths.length ? relevantPaths.join(', ') : '(keine)') + '\n' +
      'Offene Editorpuffer: ' + (openBuffers.length ? openBuffers.join(', ') : '(keine)') + '\n' +
      'Workspace-Lesezugriff: ' + (state.permissions.read ? 'erteilt' : 'nicht erteilt') + '\n' +
      'Aktive Datei: ' + (path || '(keine)') + '\n' +
      'Workspace-Profil: ' + (codexWorkspace ? window.codexIdeProfile.get() : 'strukturiert');
    return workspaceContext + '\n\nAktuelle Nutzeraufgabe:\n' + instruction;
  }

  function normalizeTurnPath(value) {
    var normalized = String(value || '').trim().replace(/\\/g, '/');
    if (!normalized) return '';
    if (/^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(normalized) || /[\0-\x1f\x7f]/.test(normalized) || normalized.split('/').some(function (part) {
      return !part || part === '.' || part === '..';
    })) throw new Error(t('ideEditorCodeTargetRequired', 'Der Agent muss einen sicheren relativen Codepfad wählen.'));
    return normalized;
  }

  function isEditorWorkspaceFilePath(value) {
    try { return !!normalizeTurnPath(value); } catch (_) { return false; }
  }

  function setLiveEditorState(active, operation) {
    var surface = byId('ideEditorSurface');
    if (!surface) return;
    if (active) {
      surface.dataset.liveEdit = operation || 'write';
      surface.setAttribute('aria-busy', 'true');
    } else {
      delete surface.dataset.liveEdit;
      surface.removeAttribute('aria-busy');
    }
  }

  function advanceLiveEditorText(currentValue, targetValue) {
    var advanced = advanceLiveEditorTextBatch(currentValue, targetValue, 1);
    return { text: advanced.text, operation: advanced.operation, complete: advanced.complete };
  }

  function liveEditorContentMatches(actual, expected) {
    // HTML textareas normalize CRLF/CR on assignment, just like persistence.
    return actual === expected || (typeof actual === 'string' && typeof expected === 'string' &&
      actual === expected.replace(/\r\n?/g, '\n'));
  }

  function sharedLiveEditorPrefixLength(current, target) {
    var length = Math.min(current.length, target.length);
    var index = 0;
    while (index < length && current.charCodeAt(index) === target.charCodeAt(index)) index += 1;
    if (index > 0) {
      var previousCodeUnit = current.charCodeAt(index - 1);
      if (previousCodeUnit >= 0xd800 && previousCodeUnit <= 0xdbff) index -= 1;
    }
    return index;
  }

  function liveEditorTypingDistance(currentValue, targetValue) {
    var current = String(currentValue == null ? '' : currentValue);
    var target = String(targetValue == null ? '' : targetValue);
    if (current === target) return 0;
    if (target.indexOf(current) === 0) return target.length - current.length;
    var sharedLength = sharedLiveEditorPrefixLength(current, target);
    return current.length - sharedLength + target.length - sharedLength;
  }

  function liveEditorTypingBatchSize(pendingUnits, operation) {
    var pending = Math.floor(Number(pendingUnits));
    if (!isFinite(pending) || pending <= 0) return 0;
    var frames = operation === 'delete' ? LIVE_EDITOR_DELETE_CATCHUP_FRAMES : LIVE_EDITOR_INSERT_CATCHUP_FRAMES;
    return Math.min(pending, LIVE_EDITOR_MAX_UNITS_PER_FRAME, Math.max(1, Math.ceil(pending / frames)));
  }

  function liveEditorDraftTypingBatchSize(draft, current, target) {
    var operation = target.indexOf(current) === 0 ? 'insert' : 'delete';
    var phase = draft.activeRange + ':' + operation;
    if (draft.typingPhase !== phase) {
      draft.typingPhase = phase;
      draft.typingUnitsPerFrame = 1;
    }
    // Small changes use individual keystrokes. A backlog raises the rate for
    // this phase; retaining it avoids an increasingly slow tail on large edits.
    draft.typingUnitsPerFrame = Math.max(draft.typingUnitsPerFrame,
      liveEditorTypingBatchSize(liveEditorTypingDistance(current, target), operation));
    return draft.typingUnitsPerFrame;
  }

  function advanceLiveEditorTextBatch(currentValue, targetValue, maxUnits) {
    var current = String(currentValue == null ? '' : currentValue);
    var target = String(targetValue == null ? '' : targetValue);
    var limit = Math.max(1, Math.floor(Number(maxUnits)) || 1);
    if (current === target) return { text: current, operation: '', complete: true, units: 0 };

    if (target.indexOf(current) !== 0) {
      var sharedLength = sharedLiveEditorPrefixLength(current, target);
      var start = current.length;
      var deletedUnits = 0;
      while (start > sharedLength && deletedUnits < limit) {
        start -= 1;
        var lastCodeUnit = current.charCodeAt(start);
        if (lastCodeUnit === 10 && start > sharedLength && current.charCodeAt(start - 1) === 13) start -= 1;
        if (lastCodeUnit >= 0xdc00 && lastCodeUnit <= 0xdfff && start > sharedLength) {
          var previousCodeUnit = current.charCodeAt(start - 1);
          if (previousCodeUnit >= 0xd800 && previousCodeUnit <= 0xdbff) start -= 1;
        }
        deletedUnits += 1;
        if (limit <= 4 && (lastCodeUnit === 10 || lastCodeUnit === 13)) break;
      }
      var shortened = current.slice(0, start);
      return { text: shortened, operation: 'delete', complete: shortened === target, units: deletedUnits };
    }

    var end = current.length;
    var insertedUnits = 0;
    while (end < target.length && insertedUnits < limit) {
      var nextCodePoint = target.codePointAt(end);
      end += nextCodePoint > 0xffff ? 2 : 1;
      if (nextCodePoint === 13 && target.charCodeAt(end) === 10) end += 1;
      insertedUnits += 1;
      if (limit <= 4 && (nextCodePoint === 10 || nextCodePoint === 13)) break;
    }
    var text = target.slice(0, end);
    return { text: text, operation: 'insert', complete: text === target, units: insertedUnits };
  }

  function resolveLiveEditorRanges(content, oldText, replaceAll, options, newText) {
    return resolveEditorTextEditRanges(content, oldText, String(newText == null ? '' : newText), replaceAll, options).ranges;
  }

  function composeLiveEditorContent(draft, replacementTexts) {
    var sourceOffset = 0;
    var output = '';
    var renderedRanges = [];
    draft.animationRanges.forEach(function (range, index) {
      var replacement = String(replacementTexts[index] == null ? '' : replacementTexts[index]);
      output += draft.baseContent.slice(sourceOffset, range.start);
      var renderedStart = output.length;
      output += replacement;
      renderedRanges.push({ start: renderedStart, end: output.length });
      sourceOffset = range.end;
    });
    output += draft.baseContent.slice(sourceOffset);
    return { content: output, ranges: renderedRanges };
  }

  function renderLiveEditorBuffer(draft, content, liveRange) {
    if (state.path !== draft.path) {
      activateBuffer(draft.path, content, draft.targetSavedContent, true, {
        capture: false,
        liveRange: liveRange
      });
      draft.dirtyRendered = true;
      return;
    }
    state.savedContent = draft.targetSavedContent;
    state.dirty = true;
    if (byId('idePath').value !== draft.path) byId('idePath').value = draft.path;
    updateEditorValue(content);
    state.buffers[draft.path] = {
      path: draft.path,
      content: content,
      savedContent: draft.targetSavedContent,
      dirty: true
    };
    byId('ideDirty').textContent = t('ideUnsaved', 'Nicht gespeichert');
    updateCounts();
    scheduleEditorHighlight(false, liveRange);
    if (!draft.dirtyRendered) {
      draft.dirtyRendered = true;
      renderTabs();
    }
    syncHtmlPreviewControl();
  }

  function revealLiveEditorWorkSite(draft, rangeIndex) {
    if (draft.followedRangeIndex === rangeIndex) return;
    draft.followedRangeIndex = rangeIndex;
    var surface = byId('ideEditorSurface');
    if (surface && typeof surface.scrollIntoView === 'function') {
      surface.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
    }
  }

  function liveEditorDraftTargetText(draft) {
    var request = draft && draft.pendingEditRequest || {};
    return String(draft && draft.operation === 'edit'
      ? request.newText == null ? '' : request.newText
      : request.content == null ? '' : request.content);
  }

  function liveEditorDraftNeedsAnimation(draft) {
    if (!draft) return false;
    if (draft.operation === 'edit') return draft.activeRange < draft.animationRanges.length;
    return draft.typedText !== liveEditorDraftTargetText(draft);
  }

  function liveEditorDraftHasPendingWork(draft) {
    return !!draft && (liveEditorDraftNeedsAnimation(draft) || draft.awaitingPaint || draft.presentationPending);
  }

  function settleLiveEditorAnimation(draft) {
    if (!draft || liveEditorDraftHasPendingWork(draft)) return;
    var waiters = Array.isArray(draft.animationWaiters) ? draft.animationWaiters.splice(0) : [];
    waiters.forEach(function (resolve) { resolve(); });
  }

  function cancelLiveEditorInsertFrame(draft) {
    if (!draft) return;
    if (draft.insertFrame != null) {
      clearTimeout(draft.insertFrame);
      draft.insertFrame = null;
    }
    draft.awaitingPaint = false;
    draft.presentationPending = false;
    var waiters = Array.isArray(draft.animationWaiters) ? draft.animationWaiters.splice(0) : [];
    waiters.forEach(function (resolve) { resolve(); });
  }

  function renderLiveEditorInsertion(draft) {
    if (!draft || state.liveEditorDraft !== draft || state.turnId !== draft.turnId || !state.busy) {
      cancelLiveEditorInsertFrame(draft);
      return false;
    }
    var visualOperation = '';
    var replacements;
    var rangeIndex = 0;
    if (draft.operation === 'edit') {
      rangeIndex = draft.activeRange;
      var range = draft.animationRanges[rangeIndex];
      if (!range) { settleLiveEditorAnimation(draft); return false; }
      var current = draft.remainingTexts[rangeIndex];
      var target = draft.animationPhase === 'delete' ? '' : range.text;
      if (current === target && draft.animationPhase === 'delete') {
        draft.animationPhase = 'insert';
        target = range.text;
      }
      var advancedEdit = advanceLiveEditorTextBatch(current, target,
        liveEditorDraftTypingBatchSize(draft, current, target));
      draft.remainingTexts[rangeIndex] = advancedEdit.text;
      visualOperation = advancedEdit.operation;
      if (advancedEdit.complete) {
        if (draft.animationPhase === 'delete' && range.text) draft.animationPhase = 'insert';
        else { draft.activeRange += 1; draft.animationPhase = 'delete'; }
      }
      replacements = draft.remainingTexts;
    } else {
      var targetText = liveEditorDraftTargetText(draft);
      var advanced = advanceLiveEditorTextBatch(draft.typedText, targetText,
        liveEditorDraftTypingBatchSize(draft, draft.typedText, targetText));
      draft.typedText = advanced.text;
      visualOperation = advanced.operation;
      replacements = [draft.typedText];
    }
    if (!visualOperation) { settleLiveEditorAnimation(draft); return false; }
    var composed = composeLiveEditorContent(draft, replacements);
    var followedRange = composed.ranges[rangeIndex] || { start: 0, end: 0 };
    draft.renderedContent = composed.content;
    draft.lastLiveRange = followedRange;
    draft.awaitingPaint = true;
    draft.presentationPending = true;
    revealLiveEditorWorkSite(draft, rangeIndex);
    renderLiveEditorBuffer(draft, composed.content, followedRange);

    if (visualOperation === 'delete') {
      setLiveEditorState(true, 'edit-delete');
      setEditorStatus(t('ideModelDeletingRange', 'Der Agent löscht Zeichen live an der tatsächlichen Stelle …'));
    } else if (draft.operation === 'write') {
      setLiveEditorState(true, 'write');
      setEditorStatus(t('ideModelTypingFile', 'Der Agent tippt die neue Datei Zeichen für Zeichen …'));
    } else {
      setLiveEditorState(true, 'edit-insert');
      setEditorStatus(t('ideModelInsertingRange', 'Der Agent fügt Zeichen live an der tatsächlichen Stelle ein …'));
    }
    settleLiveEditorAnimation(draft);
    return true;
  }

  function scheduleLiveEditorInsertion(draft) {
    if (draft && (state.liveEditorDraft !== draft || state.turnId !== draft.turnId || !state.busy)) {
      cancelLiveEditorInsertFrame(draft);
      return;
    }
    if (!draft || draft.insertFrame != null || draft.awaitingPaint || !liveEditorDraftHasPendingWork(draft)) {
      settleLiveEditorAnimation(draft);
      return;
    }
    draft.insertFrameKind = 'timeout';
    draft.insertFrame = setTimeout(function render() {
      draft.insertFrame = null;
      // The syntax layer is the visible text (the textarea is transparent).
      // Give each painted step a frame before advancing or persisting it.
      draft.presentationPending = false;
      if (liveEditorDraftNeedsAnimation(draft)) renderLiveEditorInsertion(draft);
      else settleLiveEditorAnimation(draft);
      scheduleLiveEditorInsertion(draft);
    }, LIVE_EDITOR_TYPING_INTERVAL_MS);
  }

  function waitForLiveEditorAnimation(draft, signal) {
    if (!draft || !liveEditorDraftHasPendingWork(draft)) return Promise.resolve();
    return new Promise(function (resolve) {
      function abortAnimation() {
        if (state.liveEditorDraft === draft) discardModelEditorDraft(draft.turnId);
        else cancelLiveEditorInsertFrame(draft);
      }
      draft.animationWaiters.push(function () {
        if (signal) signal.removeEventListener('abort', abortAnimation);
        resolve();
      });
      if (signal) {
        signal.addEventListener('abort', abortAnimation, { once: true });
        if (signal.aborted) { abortAnimation(); return; }
      }
      scheduleLiveEditorInsertion(draft);
    });
  }

  function liveEditorDraftAcceptsRequest(draft, request) {
    if (!draft || !request || draft.operation !== request.operation) return false;
    if (draft.operation !== 'edit') return true;
    var matchesRequest = draft.oldText === String(request.oldText == null ? '' : request.oldText) &&
      String(draft.pendingEditRequest.newText) === String(request.newText) &&
      draft.replaceAll === (request.replaceAll === true) &&
      draft.startLine === (normalizeEditorLineHint(request).startLine || null) &&
      draft.endLine === (normalizeEditorLineHint(request).endLine || null);
    if (!matchesRequest || request.complete !== true) return matchesRequest;
    // Only the completed replacement can identify oldText occurrences that
    // already belong to newText. Recheck ranges when a streamed string closes.
    try {
      var ranges = resolveLiveEditorRanges(draft.baseContent, draft.oldText, draft.replaceAll, request, request.newText);
      return ranges.length === draft.requestRanges.length && ranges.every(function (range, index) {
        return range.start === draft.requestRanges[index].start && range.end === draft.requestRanges[index].end;
      });
    } catch (_) {
      return false;
    }
  }

  function discardModelEditorDraft(turnId) {
    var draft = state.liveEditorDraft;
    if (!draft || (turnId != null && draft.turnId !== turnId)) return;
    var editor = byId('ideEditor');
    cancelLiveEditorInsertFrame(draft);
    if (draft.targetBuffered) state.buffers[draft.path] = draft.targetBuffer;
    else delete state.buffers[draft.path];
    state.path = draft.view.path;
    state.savedContent = draft.view.savedContent;
    state.dirty = draft.view.dirty;
    byId('idePath').value = draft.view.inputPath;
    editor.value = draft.view.content;
    byId('ideDirty').textContent = state.dirty ? t('ideUnsaved', 'Nicht gespeichert') : '';
    state.liveEditorDraft = null;
    state.liveEditorFollowPending = false;
    state.liveEditorRangePending = null;
    setLiveEditorState(false);
    updateCounts();
    scheduleEditorHighlight();
    if (typeof editor.setSelectionRange === 'function') {
      try { editor.setSelectionRange(draft.view.selectionStart, draft.view.selectionEnd); } catch (_) {}
    }
    editor.scrollTop = draft.view.scrollTop;
    editor.scrollLeft = draft.view.scrollLeft;
    syncEditorScroll();
    renderTabs();
    renderFiles(state.path);
  }

  function applyModelEditorDraft(request, turnId) {
    var targetPath = normalizeTurnPath(request && request.path);
    if (state.turnId !== turnId || !state.busy || !targetPath || !isEditorWorkspaceFilePath(targetPath)) return;
    var operation = request && request.operation === 'edit' ? 'edit' : 'write';
    // An edit needs its complete replacement and routing fields before we can
    // distinguish changed text from context. Incomplete strings never erase
    // context speculatively; new files still stream as their tokens arrive.
    if (operation === 'edit' && request.complete !== true) return;
    var content = String(request && request.content != null ? request.content : '');
    if (operation === 'write' && !content.length) return;
    var matchingDraft = state.liveEditorDraft && state.liveEditorDraft.turnId === turnId && state.liveEditorDraft.path === targetPath;
    if (matchingDraft && request.complete === true && !liveEditorDraftAcceptsRequest(state.liveEditorDraft, Object.assign({}, request, { operation: operation }))) {
      discardModelEditorDraft(turnId);
      matchingDraft = false;
    }
    if (operation === 'write' && !matchingDraft && (state.buffers[targetPath] || state.files.some(function (file) { return file.path === targetPath; }))) return;
    if (state.liveEditorDraft && (state.liveEditorDraft.turnId !== turnId || state.liveEditorDraft.path !== targetPath)) {
      discardModelEditorDraft(state.liveEditorDraft.turnId);
    }
    if (!state.liveEditorDraft) {
      storeActiveBuffer();
      var editor = byId('ideEditor');
      var targetBuffered = Object.prototype.hasOwnProperty.call(state.buffers, targetPath);
      var targetBuffer = targetBuffered ? Object.assign({}, state.buffers[targetPath]) : null;
      var cachedContent = workspaceContentSnapshot(targetPath);
      var activeContent = activeEditorContentSnapshot(targetPath);
      if (targetBuffer && activeContent.available) {
        targetBuffer.content = activeContent.content;
        targetBuffer.savedContent = activeContent.savedContent;
        targetBuffer.dirty = activeContent.dirty === true;
      }
      var baseSnapshot = selectEditorBaseSnapshot(null, targetBuffer, cachedContent, activeContent);
      var targetExisted = targetBuffered || cachedContent.available || state.files.some(function (file) { return file.path === targetPath; });
      if (operation === 'edit' && !baseSnapshot) return;
      var baseContent = baseSnapshot ? baseSnapshot.content : '';
      var animationRanges, requestRanges = [];
      try {
        if (operation === 'edit') {
          var planned = localizedEditorTextEdits(baseContent, String(request.oldText || ''), String(request.newText || ''), request.replaceAll === true, request);
          requestRanges = planned.ranges;
          animationRanges = planned.edits;
        } else {
          animationRanges = [{ start: 0, end: 0 }];
        }
      } catch (_) {
        return;
      }
      var hints = normalizeEditorLineHint(request);
      state.liveEditorDraft = {
        turnId: turnId,
        path: targetPath,
        operation: operation,
        targetBuffered: targetBuffered,
        targetExisted: targetExisted,
        targetBuffer: targetBuffer,
        targetSavedContent: baseSnapshot ? baseSnapshot.savedContent : '',
        baseContent: baseContent,
        oldText: operation === 'edit' ? String(request.oldText || '') : '',
        replaceAll: operation === 'edit' && request.replaceAll === true,
        startLine: hints.startLine || null,
        endLine: hints.endLine || null,
        animationRanges: animationRanges,
        requestRanges: requestRanges,
        activeRange: 0,
        remainingTexts: animationRanges.map(function (range) { return baseContent.slice(range.start, range.end); }),
        animationPhase: operation === 'edit' ? 'delete' : 'insert',
        animationWaiters: [],
        typedText: '',
        renderedContent: baseContent,
        pendingEditRequest: Object.assign({}, request, { operation: operation }),
        view: {
          path: state.path,
          inputPath: byId('idePath').value,
          content: byId('ideEditor').value,
          savedContent: state.savedContent,
          dirty: state.dirty,
          selectionStart: editor.selectionStart,
          selectionEnd: editor.selectionEnd,
          scrollTop: editor.scrollTop,
          scrollLeft: editor.scrollLeft
        }
      };
    }
    var draft = state.liveEditorDraft;
    var normalizedRequest = Object.assign({}, request, { operation: operation });
    if (!liveEditorDraftAcceptsRequest(draft, normalizedRequest)) return;
    if (operation === 'edit' && request.complete === true) {
      var completedEdit;
      try {
        completedEdit = applyEditorTextEdit(draft.baseContent, request.oldText, request.newText, request.replaceAll === true, request);
      } catch (_) {
        return;
      }
      if (completedEdit.alreadyApplied === true) {
        draft.alreadyApplied = true;
        cancelLiveEditorInsertFrame(draft);
        activateBuffer(targetPath, draft.baseContent, draft.targetSavedContent, draft.baseContent !== draft.targetSavedContent, {
          capture: false,
          liveRange: { start: completedEdit.end, end: completedEdit.end }
        });
        setLiveEditorState(false);
        setEditorStatus(t('ideModelEditAlreadyApplied', 'Die Änderung ist an dieser Stelle bereits vorhanden; sie wird nicht erneut eingefügt.'), 'ok');
        settleLiveEditorAnimation(draft);
        return;
      }
    }
    draft.alreadyApplied = false;
    draft.pendingEditRequest = normalizedRequest;
    if (!draft.animationStarted) {
      draft.animationStarted = true;
      var initialRange = draft.animationRanges[0] || { start: 0, end: 0 };
      revealLiveEditorWorkSite(draft, 0);
      activateBuffer(targetPath, draft.baseContent, draft.targetSavedContent, draft.baseContent !== draft.targetSavedContent, {
        capture: false,
        liveRange: { start: initialRange.end, end: initialRange.end }
      });
      if (operation === 'edit') {
        setLiveEditorState(true, 'edit-delete');
        setEditorStatus(t('ideModelDeletingRange', 'Der Agent löscht Zeichen live an der tatsächlichen Stelle …'));
      } else {
        setLiveEditorState(true, 'write');
        setEditorStatus(t('ideModelTypingFile', 'Der Agent tippt die neue Datei Zeichen für Zeichen …'));
      }
    }
    scheduleLiveEditorInsertion(draft);
  }

  function commitModelEditorDraft(targetPath, turnId) {
    var draft = state.liveEditorDraft;
    if (draft && draft.turnId === turnId && draft.path === targetPath) {
      cancelLiveEditorInsertFrame(draft);
      state.liveEditorDraft = null;
      return draft;
    }
    return null;
  }

  async function applyModelEditorWrite(request, turnId, options) {
    var operationOptions = options || {};
    var signal = operationOptions.signal;
    throwIfAborted(signal);
    var targetPath = normalizeTurnPath(request && request.path);
    if (state.turnId !== turnId || !state.busy) throw new Error(t('ideEditorTurnExpired', 'Der Editor-Turn ist nicht mehr aktiv.'));
    if (!targetPath || !isEditorWorkspaceFilePath(targetPath)) {
      throw new Error(t('ideEditorCodeTargetRequired', 'Codex muss einen sicheren relativen Codepfad wählen.'));
    }
    var operation = request && request.operation === 'edit' ? 'edit' : 'write';
    var draft = state.liveEditorDraft && state.liveEditorDraft.turnId === turnId && state.liveEditorDraft.path === targetPath
      ? state.liveEditorDraft
      : null;
    var targetAlreadyExists = draft
      ? draft.targetExisted
      : !!state.buffers[targetPath] || workspaceContentSnapshot(targetPath).available || state.files.some(function (file) { return file.path === targetPath; });
    if (operation === 'write' && targetAlreadyExists) {
      throw new Error(t('ideEditorExistingNeedsEdit', 'Eine vorhandene Datei muss mit einer lokalen edit-Aktion bearbeitet werden.'));
    }
    var previous = draft && draft.targetBuffer || state.buffers[targetPath];
    var previousSavedContent = previous ? previous.savedContent : (state.path === targetPath ? state.savedContent : '');
    var content;
    var liveOptions;
    var baseDirty = true;
    var finalDraftRequest = Object.assign({}, request, { operation: operation, complete: true });

    if (operation === 'edit') {
      var activeSnapshot = activeEditorContentSnapshot(targetPath);
      var baseSnapshot = selectEditorBaseSnapshot(
        draft,
        previous,
        workspaceContentSnapshot(targetPath),
        activeSnapshot
      );
      if (!baseSnapshot) {
        if (typeof operationOptions.onReadStart === 'function') operationOptions.onReadStart();
        var readResult = await window.codexIdeProfile.readModelHomeWorkspaceFile(targetPath, {
          signal: signal,
          editorWorkspaceMode: true
        });
        throwIfAborted(signal);
        if (state.turnId !== turnId || !state.busy) throw new Error(t('ideEditorTurnExpired', 'Der Editor-Turn ist nicht mehr aktiv.'));
        var readFile = readResult && readResult.file || {};
        var readPath = readFile.path || targetPath;
        var readContent = String(readFile.content == null ? '' : readFile.content);
        if (readPath !== targetPath) throw new Error(t('ideEditorReadTargetMismatch', 'Der gelesene Editorpuffer gehört nicht zum angeforderten Ziel.'));
        rememberWorkspaceContent(targetPath, readContent);
        baseSnapshot = { content: readContent, savedContent: readContent, source: 'editor-recovery-read' };
      }
      var baseContent = baseSnapshot.content;
      previousSavedContent = baseSnapshot.savedContent;
      baseDirty = baseSnapshot.source === 'active-editor'
        ? activeSnapshot.dirty === true
        : previous ? previous.dirty === true : state.path === targetPath && state.dirty === true;
      var edit;
      try {
        assertGranularEditorTextEdit(baseContent, request.oldText, request.newText, request.replaceAll === true, request);
        edit = applyEditorTextEdit(baseContent, request.oldText, request.newText, request.replaceAll === true, request);
      } catch (editError) {
        throw attachEditorRuntimeSnapshot(editError, createEditorRuntimeSnapshot(
          targetPath,
          baseContent,
          previousSavedContent,
          baseDirty
        ));
      }
      content = edit.content;
      liveOptions = { liveRange: { start: edit.start, end: edit.end } };
      if (edit.alreadyApplied === true) {
        commitModelEditorDraft(targetPath, turnId);
        activateBuffer(targetPath, baseContent, previousSavedContent, baseDirty, Object.assign({ capture: false }, liveOptions));
        setLiveEditorState(false);
        setEditorStatus(t('ideModelEditAlreadyApplied', 'Die Änderung ist an dieser Stelle bereits vorhanden; sie wird nicht erneut eingefügt.'), 'ok');
        return {
          ok: true,
          saved: !baseDirty && baseContent === previousSavedContent,
          unchanged: true,
          alreadyApplied: true,
          file: { path: targetPath, content: baseContent },
          editorSnapshot: createEditorRuntimeSnapshot(targetPath, baseContent, previousSavedContent, baseDirty)
        };
      }
      if (draft && !liveEditorDraftAcceptsRequest(draft, finalDraftRequest)) {
        discardModelEditorDraft(turnId);
        draft = null;
      }
      if (!draft) {
        applyModelEditorDraft(finalDraftRequest, turnId);
        draft = state.liveEditorDraft && state.liveEditorDraft.turnId === turnId && state.liveEditorDraft.path === targetPath
          ? state.liveEditorDraft
          : null;
      } else {
        draft.pendingEditRequest = finalDraftRequest;
        draft.alreadyApplied = false;
        scheduleLiveEditorInsertion(draft);
      }
    } else {
      content = String(request && request.content != null ? request.content : '');
      if (!content.length) throw new Error(t('ideContentRequired', 'Leere Dateien werden nicht geschrieben.'));
      liveOptions = { followLiveWrite: true };
      if (!draft) {
        applyModelEditorDraft(finalDraftRequest, turnId);
        draft = state.liveEditorDraft && state.liveEditorDraft.turnId === turnId && state.liveEditorDraft.path === targetPath
          ? state.liveEditorDraft
          : null;
      } else {
        draft.pendingEditRequest = finalDraftRequest;
        scheduleLiveEditorInsertion(draft);
      }
    }

    if (!draft) {
      throw new Error(t('ideEditorLiveDraftUnavailable', 'Die Änderung konnte nicht sicher im sichtbaren Echtzeit-Editor vorbereitet werden.'));
    }
    await waitForLiveEditorAnimation(draft, signal);
    throwIfAborted(signal);
    if (state.turnId !== turnId || !state.busy || state.liveEditorDraft !== draft) {
      throw new Error(t('ideEditorTurnExpired', 'Der Editor-Turn ist nicht mehr aktiv.'));
    }
    if (state.path !== targetPath || !liveEditorContentMatches(byId('ideEditor').value, content) ||
        draft.renderedContent !== content || !liveEditorContentMatches(draft.paintedContent, content)) {
      discardModelEditorDraft(turnId);
      throw new Error(t('ideEditorLiveContentMismatch', 'Die Änderung wurde nicht vollständig im Echtzeit-Editor dargestellt.'));
    }

    // Keep the caret at the last actual change, including after persistence.
    if (draft.lastLiveRange) liveOptions = { liveRange: draft.lastLiveRange };
    activateBuffer(targetPath, content, previousSavedContent, true, Object.assign({ capture: false }, liveOptions));
    setLiveEditorState(true, operation === 'edit'
      ? (String(request.newText == null ? '' : request.newText).length ? 'edit-insert' : 'edit-delete')
      : 'write');

    if (!operationOptions.persist) {
      commitModelEditorDraft(targetPath, turnId);
      setLiveEditorState(false);
      setEditorStatus(format('ideModelDrafted', 'Codex hat den Code im Editor angelegt. Noch nicht gespeichert: {path}', { path: targetPath }), 'ok');
      return {
        ok: true,
        saved: false,
        file: { path: targetPath, content: content },
        editorSnapshot: createEditorRuntimeSnapshot(targetPath, content, previousSavedContent, true)
      };
    }

    try {
      if (typeof operationOptions.onPersistenceStart === 'function') operationOptions.onPersistenceStart();
      throwIfAborted(signal);
      var result = await window.codexIdeProfile.writeModelHomeWorkspaceFile(targetPath, content, {
        overwrite: operation === 'edit',
        operation: operation,
        signal: signal,
        editorWorkspaceMode: operationOptions.editorWorkspaceMode === true
      });
      throwIfAborted(signal);
      if (state.turnId !== turnId || !state.busy || state.liveEditorDraft !== draft) {
        throw new Error(t('ideEditorTurnExpired', 'Der Editor-Turn ist nicht mehr aktiv.'));
      }
      rememberWorkspaceContent(targetPath, content);
      activateBuffer(targetPath, content, content, false, Object.assign({ capture: false }, liveOptions));
      commitModelEditorDraft(targetPath, turnId);
      setLiveEditorState(false);
      rememberPersistedEditorFile(targetPath, result && result.file);
      setEditorStatus(format('ideModelSaved', 'Codex hat den Code im Editor aktualisiert und gespeichert: {path}', { path: targetPath }), 'ok');
      result = result && typeof result === 'object' ? result : { ok: true };
      result.file = Object.assign({}, result.file || {}, { path: targetPath, content: content });
      result.editorSnapshot = createEditorRuntimeSnapshot(targetPath, content, content, false);
      result.saved = true;
      return result;
    } catch (error) {
      // A stopped or superseded action must not mutate the restored view or
      // report its cancelled save as a successful unsaved editor change.
      if (isAbort(error) || (signal && signal.aborted) || state.turnId !== turnId || !state.busy || state.liveEditorDraft !== draft) {
        if (state.liveEditorDraft === draft) discardModelEditorDraft(turnId);
        throwIfAborted(signal);
        throw error;
      }
      var persistenceMessage = String(error && error.message || error || '');
      if (/operation=write|nur fuer neue dateien|vorhandene datei|existiert bereits|operation=edit|muss bereits existieren/i.test(persistenceMessage)) {
        discardModelEditorDraft(turnId);
        throw error;
      }
      commitModelEditorDraft(targetPath, turnId);
      setLiveEditorState(false);
      markDirty(true);
      setEditorStatus(format('ideModelSaveDeferred', 'Code ist im Editor, konnte aber nicht gespeichert werden: {error}', { error: shortError(error) }), 'error');
      return {
        ok: true,
        saved: false,
        saveError: true,
        file: { path: targetPath, content: content },
        editorSnapshot: createEditorRuntimeSnapshot(targetPath, content, previousSavedContent, true)
      };
    }
  }

  async function applyModelEditorOpen(requestedPath, turnId, options) {
    var operationOptions = options || {};
    var targetPath = normalizeTurnPath(requestedPath);
    if (state.turnId !== turnId || !state.busy) throw new Error(t('ideEditorTurnExpired', 'Der Editor-Turn ist nicht mehr aktiv.'));
    if (!targetPath || !isEditorWorkspaceFilePath(targetPath)) {
      throw new Error(t('ideEditorCodeTargetRequired', 'Codex muss einen sicheren relativen Codepfad wählen.'));
    }
    if (state.buffers[targetPath]) {
      var buffer = state.buffers[targetPath];
      activateBuffer(targetPath, buffer.content, buffer.savedContent, buffer.dirty);
      setEditorStatus(format('ideOpenedFile', 'Geöffnet: {path}', { path: targetPath }), 'ok');
      return {
        ok: true,
        local: true,
        file: { path: targetPath, content: buffer.content },
        editorSnapshot: createEditorRuntimeSnapshot(targetPath, buffer.content, buffer.savedContent, buffer.dirty)
      };
    }
    if (!operationOptions.canRead) return { ok: false, blocked: true };
    if (typeof operationOptions.onReadStart === 'function') operationOptions.onReadStart();
    var result = await window.codexIdeProfile.readModelHomeWorkspaceFile(targetPath, { signal: operationOptions.signal, editorWorkspaceMode: true });
    var file = result && result.file || {};
    var content = String(file.content == null ? '' : file.content);
    rememberWorkspaceContent(file.path || targetPath, content);
    activateBuffer(file.path || targetPath, content, content, false);
    setEditorStatus(format('ideOpenedFile', 'Geöffnet: {path}', { path: file.path || targetPath }), 'ok');
    result.editorSnapshot = createEditorRuntimeSnapshot(file.path || targetPath, content, content, false);
    return result;
  }

  async function applyModelDirectoryCreate(requestedPath, turnId, options) {
    var targetPath = normalizeTurnPath(requestedPath);
    if (state.turnId !== turnId || !state.busy) throw new Error(t('ideEditorTurnExpired', 'Der Editor-Turn ist nicht mehr aktiv.'));
    if (!targetPath) throw new Error(t('ideFolderPathRequired', 'Ein relativer Ordnerpfad ist erforderlich.'));
    var result = await window.codexIdeProfile.createModelHomeWorkspaceDirectory(targetPath, {
      signal: options && options.signal,
      editorWorkspaceMode: !!(options && options.editorWorkspaceMode)
    });
    await refreshFiles(state.path);
    setEditorStatus(format('ideCreatedFolder', 'Ordner erstellt: {path}', { path: targetPath }), 'ok');
    return result;
  }

  function beginPersistedSessionTurn(turnId, instruction) {
    var session = currentAgentSession();
    if (!session) return;
    var now = new Date().toISOString();
    var persistedTurn = {
      id: String(turnId),
      user: instruction,
      status: 'running',
      reply: '',
      error: '',
      activities: [],
      startedAt: now,
      finishedAt: ''
    };
    session.turns.push(persistedTurn);
    session.lastTurn = persistedTurn;
    session.updatedAt = now;
    if (session.history.length === 0) session.title = sessionTitleFromInstruction(instruction);
    persistAgentSessions();
    renderSessionControls();
  }

  function finishPersistedSessionTurn(turnId, status, reply, error) {
    var session = currentAgentSession();
    if (!session || !session.lastTurn || session.lastTurn.id !== String(turnId)) return;
    session.lastTurn.status = status;
    session.lastTurn.reply = String(reply || '');
    session.lastTurn.error = String(error || '');
    session.lastTurn.finishedAt = new Date().toISOString();
    session.lastTurn.activities = state.activities.map(snapshotActivity).filter(Boolean);
    session.updatedAt = session.lastTurn.finishedAt;
    persistAgentSessions();
    renderSessionControls();
  }

  async function runAgent(event) {
    if (event) event.preventDefault();
    var instruction = byId('idePrompt').value.trim();
    if (!instruction || state.busy || state.fileBusy || state.consoleBusy) return;
    var controller = new AbortController();
    var runs = [];
    var turnId = ++state.turnId;
    var requestPath;
    try {
      requestPath = normalizeTurnPath(byId('idePath').value);
    } catch (error) {
      setEditorStatus(shortError(error), 'error');
      return;
    }
    var protectedPaths = state.files.map(function (file) { return file.path; })
      .concat(state.directories)
      .filter(Boolean);
    if (requestPath && protectedPaths.indexOf(requestPath) === -1) protectedPaths.push(requestPath);
    state.controller = controller;
    renderSessionHistory();
    state.skillRuns = runs;
    state.activities = [];
    beginPersistedSessionTurn(turnId, instruction);
    setCurrentUser(instruction);
    byId('idePrompt').value = '';
    resizePrompt();
    setFinalText(t('agentFinalWaiting', 'Antwort wird vorbereitet …'));
    setStepState('ideFinalStep', 'waiting');
    setBusy(true);
    renderActivities();
    followChat(true);
    try {
      var responseLanguage = window.codexIdeProfile.detectUserLanguage
        ? window.codexIdeProfile.detectUserLanguage(instruction, window.__codexIdeCurrentLanguage || 'de')
        : (window.__codexIdeCurrentLanguage || 'de');
      var prompt = buildIdePrompt(instruction);
      var reply = await window.codexIdeProfile.apiGenerateReply(prompt, {
        sessionId: state.sessionId,
        codexThreadId: (currentAgentSession() && currentAgentSession()[window.codexIdeProfile.get() === 'antigravity' ? 'antigravityThreadId' : 'codexThreadId']) || '',
        workspaceToolVersion: (currentAgentSession() && currentAgentSession().workspaceToolVersion) || 0,
        conversationHistory: state.history.slice(),
        reasoningEffort: byId('ideReasoning').value,
        signal: controller.signal,
        editorWriteMode: true,
        editorWorkspaceMode: true,
        responseLanguage: responseLanguage,
        onSessionMetadata: function (detail) {
          if (state.turnId !== turnId || !state.busy || !detail) return;
          var threadId = String(detail.threadId || '').trim().slice(0, 200);
          var session = currentAgentSession();
          var toolVersion = Number(detail.workspaceToolVersion) || 0;
          var threadKey = window.codexIdeProfile.get() === 'antigravity' ? 'antigravityThreadId' : 'codexThreadId';
          if (!threadId || !session || (session[threadKey] === threadId && session.workspaceToolVersion === toolVersion)) return;
          session[threadKey] = threadId;
          session.workspaceToolVersion = toolVersion;
          session.updatedAt = new Date().toISOString();
          persistAgentSessions();
        },
        editorWritePath: requestPath,
        editorSnapshots: collectEditorRuntimeSnapshots(),
        onEditorDraft: function (request) {
          applyModelEditorDraft(request, turnId);
        },
        onEditorDraftDiscard: function () {
          discardModelEditorDraft(turnId);
        },
        onEditorWrite: async function (request, options) {
          var result = await runEditorActivity(request.operation || 'write', request.path, function () {
            return applyModelEditorWrite(request, turnId, options);
          });
          var writtenPath = normalizeTurnPath(request && request.path);
          if (writtenPath && protectedPaths.indexOf(writtenPath) === -1) protectedPaths.push(writtenPath);
          return result;
        },
        onEditorOpen: async function (path, options) {
          var openedPath = normalizeTurnPath(path);
          if (openedPath && protectedPaths.indexOf(openedPath) === -1) protectedPaths.push(openedPath);
          return runEditorActivity('open', openedPath, function () { return applyModelEditorOpen(openedPath, turnId, options); });
        },
        onEditorMkdir: async function (path, options) {
          var directoryPath = normalizeTurnPath(path);
          if (directoryPath && protectedPaths.indexOf(directoryPath) === -1) protectedPaths.push(directoryPath);
          return runEditorActivity('mkdir', directoryPath, function () { return applyModelDirectoryCreate(directoryPath, turnId, options); });
        },
        onReasoningSummary: function (delta, detail) {
          if (state.turnId !== turnId || !state.busy) return;
          appendReasoningSummary(delta, detail, protectedPaths);
        },
        onToolEvent: function (detail) {
          if (state.turnId !== turnId || !state.busy) return;
          updateToolActivity(detail);
        },
        onSkillStart: function (id, detail) {
          if (state.turnId !== turnId || !state.busy) return;
          updateSkillRun(runs, id, 'running', detail);
        },
        onSkillBlocked: function (id, detail) {
          if (state.turnId !== turnId || !state.busy) return;
          updateSkillRun(runs, id, 'blocked', detail);
        },
        onSkillUse: function (id, detail) {
          if (state.turnId !== turnId || !state.busy) return;
          updateSkillRun(runs, id, 'completed', detail);
        },
        onSkillError: function (id, detail) {
          if (state.turnId !== turnId || !state.busy) return;
          updateSkillRun(runs, id, 'failed', detail);
        },
        onWorkspaceList: function (workspaceIndex) {
          if (state.turnId !== turnId || !state.busy || !workspaceIndex) return;
          if (Array.isArray(workspaceIndex.files)) {
            var fileMap = Object.create(null);
            state.files.concat(workspaceIndex.files).forEach(function (file) {
              if (file && file.path) fileMap[file.path] = file;
            });
            state.files = Object.keys(fileMap).sort().map(function (path) { return fileMap[path]; });
          }
          if (Array.isArray(workspaceIndex.directories)) {
            var directoryMap = Object.create(null);
            state.directories.concat(workspaceIndex.directories).forEach(function (directory) {
              if (directory) directoryMap[directory] = true;
            });
            state.directories = Object.keys(directoryMap).sort();
          }
          if (workspaceIndex.permissions) {
            state.permissions = workspaceIndex.permissions;
          } else {
            state.permissions = Object.assign({}, state.permissions, { read: true, workspaceRead: true });
          }
          renderFiles(state.path);
        },
        onWorkspaceRead: function (file) {
          if (state.turnId !== turnId || !state.busy || !file || typeof file.path !== 'string' || typeof file.content !== 'string') return;
          var openedPath = normalizeTurnPath(file.path);
          if (!openedPath) return;
          if (protectedPaths.indexOf(openedPath) === -1) protectedPaths.push(openedPath);
          rememberWorkspaceContent(openedPath, file.content);
          var hasTabRouting = Object.prototype.hasOwnProperty.call(file, 'openInEditor') ||
            Object.prototype.hasOwnProperty.call(file, 'open_in_editor') ||
            Object.prototype.hasOwnProperty.call(file, 'purpose');
          var openInEditor = file.openInEditor === true || file.open_in_editor === true || file.purpose === 'edit' || !hasTabRouting;
          if (!openInEditor) return;
          var activeSnapshot = activeEditorContentSnapshot(openedPath);
          if (activeSnapshot.available && activeSnapshot.dirty) {
            activateBuffer(openedPath, activeSnapshot.content, activeSnapshot.savedContent, true);
            setEditorStatus(format('ideOpenedFile', 'Geöffnet: {path}', { path: openedPath }), 'ok');
            return createEditorRuntimeSnapshot(openedPath, activeSnapshot.content, activeSnapshot.savedContent, true);
          }
          var existingBuffer = state.buffers[openedPath];
          if (!activeSnapshot.available && existingBuffer && existingBuffer.dirty) {
            activateBuffer(openedPath, existingBuffer.content, existingBuffer.savedContent, true);
            setEditorStatus(format('ideOpenedFile', 'Geöffnet: {path}', { path: openedPath }), 'ok');
            return createEditorRuntimeSnapshot(openedPath, existingBuffer.content, existingBuffer.savedContent, true);
          } else {
            activateBuffer(openedPath, file.content, file.content, false);
          }
          setEditorStatus(format('ideOpenedFile', 'Geöffnet: {path}', { path: openedPath }), 'ok');
          return createEditorRuntimeSnapshot(openedPath, file.content, file.content, false);
        },
        onTerminalStart: function (terminalEvent) {
          if (state.turnId !== turnId || !state.busy) return;
          updateToolActivity({ itemId: terminalEvent.item_id || terminalEvent.itemId, threadId: terminalEvent.thread_id || terminalEvent.threadId,
            turnId: terminalEvent.turn_id || terminalEvent.turnId, source: 'app-server',
            operation: 'terminal', target: terminalEvent.command || '', status: 'running' });
          startTerminalRun(terminalEvent);
        },
        onTerminalOutput: function (delta, terminalEvent) {
          if (state.turnId !== turnId || !state.busy) return;
          appendTerminalOutput(delta, terminalEvent, false);
        },
        onTerminalInput: function (input, terminalEvent) {
          if (state.turnId !== turnId || !state.busy) return;
          appendTerminalOutput(input, terminalEvent, true);
        },
        onTerminalComplete: function (terminalEvent) {
          if (state.turnId !== turnId || !state.busy) return;
          completeTerminalRun(terminalEvent);
          var terminalRun = findTerminalRun(terminalEvent.item_id || terminalEvent.itemId, terminalEvent);
          updateToolActivity({ itemId: terminalEvent.item_id || terminalEvent.itemId, threadId: terminalEvent.thread_id || terminalEvent.threadId,
            turnId: terminalEvent.turn_id || terminalEvent.turnId, source: 'app-server',
            operation: 'terminal', target: terminalEvent.command || terminalRun.command || '',
            status: terminalRun.status, output: terminalRun.output });
        },
        onToken: function (_, streamed) {
          if (state.turnId !== turnId || !state.busy) return;
          var live = window.CodexIdeAgentResponse.parseLive(streamed, {
            protectedPaths: protectedPaths
          });
          if (live.reply && !workNoteDescribesInternalMechanics(live.reply)) {
            setFinalText(live.reply);
            setStepState('ideFinalStep', 'running');
          }
        }
      });
      if (state.turnId !== turnId || !state.busy) return;
      if (!reply) throw new Error(t('emptyModelReply', 'Das Modell hat leer geantwortet.'));
      var parsed = window.CodexIdeAgentResponse.parse(reply, {
        protectedPaths: protectedPaths
      });
      setFinalText(parsed.reply);
      settleActivities('complete');
      renderActivities();
      setStepState('ideFinalStep', 'complete');
      state.history.push({ user: instruction, reply: parsed.reply });
      var activeSession = currentAgentSession();
      if (activeSession) {
        activeSession.history = state.history;
        activeSession.lastReply = parsed.reply;
        finishPersistedSessionTurn(turnId, 'completed', parsed.reply, '');
      }
    } catch (error) {
      if (state.turnId !== turnId || !state.busy) return;
      discardModelEditorDraft(turnId);
      if (isAbort(error)) {
        stopRunningTerminalRuns();
        runs.forEach(function (run) { if (run.status === 'running') run.status = 'cancelled'; });
        state.activities.forEach(function (activity) {
          if (activity.type === 'skill' && activity.run.status === 'cancelled') activity.status = 'stopped';
        });
        settleActivities('stopped');
        setFinalText(t('agentStopped', 'Verarbeitung gestoppt.'));
        setStepState('ideFinalStep', 'stopped');
        finishPersistedSessionTurn(turnId, 'stopped', t('agentStopped', 'Verarbeitung gestoppt.'), 'abort');
        renderActivities();
      } else {
        runs.forEach(function (run) { if (run.status === 'running') run.status = 'failed'; });
        state.activities.forEach(function (activity) {
          if (activity.type === 'skill' && activity.run.status === 'failed') activity.status = 'error';
        });
        settleActivities('error');
        renderActivities();
        var persistedError = error && error.message ? String(error.message) : String(error || t('writerUnknownError', 'Unbekannter Fehler'));
        setFinalText(shortError(error));
        setStepState('ideFinalStep', 'error');
        finishPersistedSessionTurn(turnId, 'failed', persistedError, persistedError);
      }
    } finally {
      if (state.controller === controller) state.controller = null;
      if (state.turnId === turnId) {
        setBusy(false);
        renderActivities();
        if (usesCli()) {
          await refreshFiles(state.path, { refreshBuffers: true });
        }
      }
    }
  }

  function showAgentSession(session, fresh) {
    discardModelEditorDraft(state.turnId);
    state.turnId += 1;
    if (state.controller) state.controller.abort();
    state.controller = null;
    setBusy(false);
    state.sessionId = session.id;
    state.history = session.history;
    state.skillRuns = [];
    clearTerminal();
    state.activities = [];
    setCurrentUser('');
    renderSessionHistory();
    setFinalText('');
    setStepState('ideFinalStep', 'idle');
    persistAgentSessions();
    renderSessionControls();
    renderActivities();
  }

  function switchSession(sessionId) {
    if (state.busy || state.fileBusy || state.consoleBusy || sessionId === state.sessionId) return;
    var session = state.sessions.filter(function (entry) { return entry.id === sessionId; })[0];
    if (session) showAgentSession(session, false);
  }

  function createSession() {
    if (state.busy || state.fileBusy || state.consoleBusy) return;
    var session = createAgentSession();
    state.sessions.unshift(session);
    showAgentSession(session, true);
    byId('idePrompt').focus();
  }

  function renameSession() {
    if (state.busy || state.fileBusy || state.consoleBusy) return;
    var session = currentAgentSession();
    if (!session) return;
    var nextTitle = window.prompt(t('conversationRenamePrompt', 'Name der Sitzung:'), session.title);
    if (nextTitle == null || !String(nextTitle).trim()) return;
    session.title = String(nextTitle).replace(/\s+/g, ' ').trim();
    session.updatedAt = new Date().toISOString();
    persistAgentSessions();
    renderSessionControls();
  }

  async function deleteSession() {
    if (state.busy || state.fileBusy || state.consoleBusy) return;
    var session = currentAgentSession();
    if (!session || !window.confirm(t('conversationDeleteConfirm', 'Diese Sitzung wirklich löschen?'))) return;
    if (usesCli()) {
      try { await (window.codexIdeProfile.resetCliSession || window.codexIdeProfile.resetCodexSession)(session.id, session[window.codexIdeProfile.get() === 'antigravity' ? 'antigravityThreadId' : 'codexThreadId']); } catch (_) {}
    }
    state.sessions = state.sessions.filter(function (entry) { return entry.id !== session.id; });
    if (!state.sessions.length) state.sessions.push(createAgentSession());
    showAgentSession(state.sessions[0], state.sessions[0].history.length === 0);
  }

  function bindEvents() {
    byId('ideRefreshFiles').addEventListener('click', function () { refreshFiles(); });
    byId('ideNewFolder').addEventListener('click', createDirectory);
    byId('ideNewFile').addEventListener('click', newFile);
    byId('ideSaveFile').addEventListener('click', saveFile);
    byId('idePreviewFile').addEventListener('click', openHtmlPreview);
    byId('ideClearSession').addEventListener('click', createSession);
    byId('ideRenameSession').addEventListener('click', renameSession);
    byId('ideDeleteSession').addEventListener('click', deleteSession);
    byId('ideSessionSelect').addEventListener('change', function () { switchSession(this.value); });
    byId('ideTerminalClear').addEventListener('click', clearTerminal);
    byId('idePromptForm').addEventListener('submit', handlePromptSubmit);
    byId('ideStop').addEventListener('click', function () {
      this.disabled = true;
      if (state.consoleController) {
        state.consoleController.abort();
        return;
      }
      discardModelEditorDraft(state.turnId);
      if (state.controller) state.controller.abort();
    });
    byId('idePrompt').addEventListener('keydown', function (event) {
      if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229) return;
      event.preventDefault(); byId('idePromptForm').requestSubmit();
    });
    byId('idePrompt').addEventListener('input', resizePrompt);
    byId('ideEditor').addEventListener('input', function () { refreshEditorDirty(); updateCounts(); scheduleEditorHighlight(); });
    byId('ideEditor').addEventListener('scroll', syncEditorScroll);
    byId('ideEditor').addEventListener('keydown', function (event) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); saveFile(); return; }
      if (event.key !== 'Tab' || this.readOnly || this.disabled) return;
      event.preventDefault();
      var start = this.selectionStart; var end = this.selectionEnd;
      this.setRangeText('  ', start, end, 'end');
      this.dispatchEvent(new Event('input'));
    });
    byId('idePath').addEventListener('input', function () { refreshEditorDirty(); scheduleEditorHighlight(); });
    byId('ideModel').addEventListener('change', function () {
      var config = cliConfig();
      setCliConfig(config.url, this.value);
      var effort = renderCodexReasoningOptions(state.codexModels, this.value, config.reasoningEffort);
      if (effort !== (config.reasoningEffort || '')) setCliEffort(effort);
    });
    byId('ideReasoning').addEventListener('change', function () { setCliEffort(this.value); });
    window.addEventListener('beforeunload', function (event) { if (!hasDirtyBuffers()) return; event.preventDefault(); event.returnValue = ''; });
    window.addEventListener('pagehide', function () { persistAgentSessions(); });
    window.addEventListener('resize', syncEditorScroll);
    document.addEventListener('codex-ide-language-change', applyTranslations);
    document.addEventListener('codex-ide-profile-change', function () {
      renderSkills();
      loadModels();
    });
    document.addEventListener('codex-ide-skills-change', function () {
      if (state.busy || state.fileBusy || state.consoleBusy) state.workspaceRefreshPending = true;
      else refreshFiles();
    });
  }

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    var currentUrl;
    try { currentUrl = new URL(window.location.href); } catch (_) { currentUrl = null; }
    if (currentUrl && currentUrl.searchParams.get('codex-ide-clean') === '1') {
      var registrationCleanup = typeof navigator.serviceWorker.getRegistrations === 'function'
        ? navigator.serviceWorker.getRegistrations().then(function (registrations) {
            return Promise.all(registrations.map(function (registration) { return registration.unregister(); }));
          })
        : navigator.serviceWorker.getRegistration().then(function (registration) {
            return registration ? registration.unregister() : false;
          });
      var cacheCleanup = typeof window.caches !== 'undefined'
        ? window.caches.keys().then(function (keys) {
            return Promise.all(keys.map(function (key) { return window.caches.delete(key); }));
          })
        : Promise.resolve();
      Promise.all([registrationCleanup, cacheCleanup]).then(function () {
        currentUrl.searchParams.delete('codex-ide-clean');
        window.location.replace(currentUrl.toString());
      }).catch(function () {
        currentUrl.searchParams.delete('codex-ide-clean');
        window.location.replace(currentUrl.toString());
      });
      return;
    }
    var updateAccepted = false;
    var reloading = false;
    var offeredWorker = null;
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (!updateAccepted || reloading) return;
      reloading = true;
      window.location.reload();
    });
    navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).then(function (registration) {
      function offerUpdate() {
        var worker = registration.waiting;
        if (!worker || offeredWorker === worker) return;
        offeredWorker = worker;
        if (window.confirm(t('pwaUpdatePrompt', 'Ein Update ist verfügbar. Jetzt installieren?'))) {
          updateAccepted = true;
          worker.postMessage({ type: 'DOWNLOAD_UPDATE', reloadHandledByClient: true });
        }
      }
      if (registration.waiting && navigator.serviceWorker.controller) offerUpdate();
      registration.addEventListener('updatefound', function () {
        var worker = registration.installing;
        if (!worker) return;
        worker.addEventListener('statechange', function () {
          if (worker.state === 'installed' && navigator.serviceWorker.controller) offerUpdate();
        });
      });
      registration.update().catch(function () { /* the current offline shell remains usable */ });
    }).catch(function () { /* PWA support remains optional on unsupported origins */ });
  }

  async function init() {
    initializeTranslations();
    await initializeAgentSessions();
    showAgentSession(currentAgentSession(), false);
    if (!window.codexIdeProfile) { setGatewayStatus(t('ideRuntimeMissing', 'IDE-Laufzeit fehlt.'), 'error'); return; }
    bindEvents();
    registerServiceWorker();
    updateCounts();
    scheduleEditorHighlight();
    if (window.CodexIdeSkillSystem && window.CodexIdeSkillSystem.ready) {
      try { await window.CodexIdeSkillSystem.ready; } catch (_) {}
    }
    await Promise.all([loadModels(), refreshFiles()]);
  }

  if (typeof module === 'object' && module.exports && typeof document === 'undefined') {
    module.exports = {
      isEditorDirty: isEditorDirty,
      applyEditorTextEdit: applyEditorTextEdit,
      assertGranularEditorTextEdit: assertGranularEditorTextEdit,
      advanceLiveEditorText: advanceLiveEditorText,
      advanceLiveEditorTextBatch: advanceLiveEditorTextBatch,
      liveEditorTypingBatchSize: liveEditorTypingBatchSize,
      followLiveEditorRange: followLiveEditorRange,
      followLiveEditorWrite: followLiveEditorWrite,
      workNoteDescribesInternalMechanics: workNoteDescribesInternalMechanics,
      selectEditorBaseSnapshot: selectEditorBaseSnapshot,
      isEditorWorkspaceFilePath: isEditorWorkspaceFilePath,
      isHtmlPreviewPath: isHtmlPreviewPath,
      getHtmlPreviewUrl: getHtmlPreviewUrl,
      normalizeSessionTurn: normalizeSessionTurn,
      normalizeAgentSession: normalizeAgentSession,
      normalizeStoredSessionSnapshot: normalizeStoredSessionSnapshot,
      chooseStoredSessionSnapshot: chooseStoredSessionSnapshot,
      parseConsoleDirective: parseConsoleDirective,
      reasoningLevelsForModel: reasoningLevelsForModel,
      syncTerminalStreamOutput: syncTerminalStreamOutput
    };
    return;
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();

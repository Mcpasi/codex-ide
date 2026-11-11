(function () {
  'use strict';

  var statusMessages = Object.create(null);
  var codexUsageSnapshot = null;
  var codexUsageState = 'idle';
  var codexUsageRequestId = 0;

  function byId(id) { return document.getElementById(id); }
  function safeGet(key, fallback) {
    try {
      var value = localStorage.getItem(key);
      return value == null ? fallback : value;
    } catch (_) {
      return fallback;
    }
  }
  function currentLanguage() {
    var language = window.__codexIdeCurrentLanguage || safeGet('codexIdeLanguage', 'de');
    if (!/^(de|en|fr)$/.test(language)) language = 'de';
    if (!window.__codexIdeCurrentLanguage) window.__codexIdeCurrentLanguage = language;
    return language;
  }
  function t(key, fallback) {
    var locales = window.CodexIdeLocales || {};
    var language = currentLanguage();
    var selected = locales[language] && locales[language].ui || {};
    var german = locales.de && locales.de.ui || {};
    return selected[key] != null ? selected[key] : german[key] != null ? german[key] : fallback || key;
  }
  function format(key, fallback, values) {
    var value = t(key, fallback);
    Object.keys(values || {}).forEach(function (name) {
      value = String(value).replace(new RegExp('\\{' + name + '\\}', 'g'), values[name]);
    });
    return value;
  }
  function safeSet(key, value) { try { localStorage.setItem(key, String(value)); } catch (_) {} }
  function setText(id, key, fallback) { var element = byId(id); if (element) element.textContent = t(key, fallback); }
  function setStatus(id, message, error) {
    var element = byId(id);
    if (!element) return;
    element.textContent = message || '';
    element.style.color = error ? '#ff9b9b' : '#82e9bd';
  }

  function localized(value, fallback) {
    if (typeof value === 'string') return value;
    if (!value || typeof value !== 'object') return fallback || '';
    var language = currentLanguage();
    return value[language] || value.de || value.en || value.fr || fallback || '';
  }
  function manifestText(key, value, fallback) {
    var translated = key ? t(key, '') : '';
    return translated && translated !== key ? translated : localized(value, fallback);
  }
  function element(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }
  function syncLanguageControls(language) {
    var group = byId('ideLanguage');
    if (group) {
      Array.prototype.forEach.call(group.querySelectorAll('[data-language]'), function (button) {
        var active = button.dataset.language === language;
        button.classList.toggle('active', active);
        button.setAttribute('aria-pressed', active ? 'true' : 'false');
      });
    }
  }

  function applyTranslations() {
    [
      ['ideSettingsOpen', 'settingsBtn', '⚙️ Einstellungen'], ['ideSettingsTitle', 'settingsTitle', 'Einstellungen'],
      ['ideSettingsIntro', 'settingsIntro', 'Backends und Agenten-Skills der Codex IDE.'],
      ['backendSettingsTitle', 'backendSettingsTitle', 'Generatives Backend'], ['backendSettingsLabel', 'backendLabel', 'Backend'],
      ['backendSettingsHint', 'backendSettingsHint', 'Der Workspace bleibt lokal; nur die Modellerzeugung wechselt.'],
      ['localSettingsTitle', 'localSettingsTitle', 'Lokales Browser-Modell'], ['localSettingsHint', 'localSettingsHint', 'Lädt ein Transformers.js-Textmodell im Browser.'],
      ['localModelLabel', 'chatModelIdLabel', 'Modell-ID'], ['localMaxTokensLabel', 'llmMaxTokensLabel', 'Max. neue Tokens'],
      ['localEnabledLabel', 'llmEnabledLabel', 'Lokales Modell aktivieren'], ['reloadChatModelBtn', 'reloadChatModelBtn', 'Modell laden'],
      ['apiSettingsTitle', 'apiSettingsTitle', 'API-Einstellungen'], ['apiSettingsHint', 'apiSettingsHint', 'OpenAI-kompatible API; Schlüssel bleiben im Browser.'],
      ['apiUrlLabel', 'apiUrlLabel', 'API-URL'], ['apiKeyLabel', 'apiKeyLabel', 'API-Key'], ['apiModelLabel', 'apiModelLabel', 'Modell'],
      ['apiMaxTokensLabel', 'apiMaxTokensLabel', 'Max. Antwort-Tokens'], ['apiSaveBtn', 'apiSaveBtn', 'Speichern'], ['apiTestBtn', 'apiTestBtn', 'Verbindung testen'],
      ['codexSettingsTitle', 'codexSettingsTitle', 'Codex Auth-Bridge'], ['codexSettingsHint', 'codexSettingsHint', 'Verwendet die offizielle Codex-CLI-Anmeldung.'],
      ['codexAuthTitle', 'codexAuthTitle', 'Codex-Anmeldung'], ['codexAuthHint', 'codexAuthHint', 'Führe einen Login-Befehl im Projektordner aus.'],
      ['codexCopyLoginBtn', 'codexCopyLoginBtn', 'Login-Befehl kopieren'], ['codexCopyDeviceLoginBtn', 'codexCopyDeviceLoginBtn', 'Device-Auth-Befehl kopieren'],
      ['codexCopyStatusBtn', 'codexCopyStatusBtn', 'Status-Befehl kopieren'],
      ['codexUsageTitle', 'codexUsageTitle', 'Nutzungslimits'], ['codexUsageHint', 'codexUsageHint', 'Verbleibendes Codex-Kontingent laut lokaler CLI-Anmeldung.'],
      ['codexDailyUsageLabel', 'codexUsageDailyLabel', 'Täglich'], ['codexWeeklyUsageLabel', 'codexUsageWeeklyLabel', 'Wöchentlich'],
      ['codexBridgeUrlLabel', 'codexBridgeUrlLabel', 'Gateway-URL'], ['codexMaxTokensLabel', 'codexMaxTokensLabel', 'Max. Antwort-Tokens'],
      ['codexSaveBtn', 'codexSaveBtn', 'Speichern'], ['codexTestBtn', 'codexTestBtn', 'Gateway testen'], ['codexStatusBtn', 'codexStatusBtn', 'Status prüfen'],
      ['skillSettingsTitle', 'skillSettingsTitle', 'Skills'], ['skillSettingsIntro', 'skillSettingsIntro', 'Verwalte Skills direkt in der IDE.'],
      ['skillInstallTitle', 'skillInstallTitle', 'Skill installieren'], ['skillRuntimeWarning', 'skillRuntimeWarning', 'Installiere nur vertrauenswürdige Quellen.'],
      ['skillManifestUrlLabel', 'skillManifestUrlLabel', 'Manifest-URL'], ['skillInstallFromUrlBtn', 'skillInstallFromUrl', 'Von URL installieren'],
      ['skillChooseLocalFilesBtn', 'skillChooseLocalFiles', 'Lokales Paket auswählen'], ['skillTrustSourceLabel', 'skillTrustSourceLabel', 'Ich vertraue der Quelle.']
    ].forEach(function (item) { setText(item[0], item[1], item[2]); });
    var language = currentLanguage();
    syncLanguageControls(language);
    ['ideBackend', 'settingsBackend'].forEach(function (id) {
      var select = byId(id);
      if (!select) return;
      Array.prototype.forEach.call(select.options, function (option) {
        var keys = { local: 'skillProfileLocal', api: 'skillProfileApi', codex: 'skillProfileCodex' };
        option.textContent = t(keys[option.value], option.textContent);
      });
    });
    renderCodexUsage(codexUsageSnapshot);
    renderCodexUsageStatus();
    renderCatalog();
  }

  function renderCodexUsageStatus() {
    var values = {
      idle: ['codexUsageInitial', 'Wird beim Öffnen geladen.', false],
      loading: ['codexUsageLoading', 'Nutzungslimits werden geladen …', false],
      ready: ['', '', false],
      partial: ['codexUsagePartial', 'Codex stellt aktuell nur eines der beiden Limits bereit.', false],
      unavailable: ['codexUsageUnavailable', 'Nutzungslimits sind für diese Anmeldung derzeit nicht verfügbar.', false],
      error: ['codexUsageError', 'Nutzungslimits konnten nicht geladen werden.', true]
    };
    var value = values[codexUsageState] || values.idle;
    var status = byId('codexUsageStatus');
    if (!status) return;
    status.textContent = value[0] ? t(value[0], value[1]) : '';
    status.style.color = value[2] ? '#ff9b9b' : '';
  }

  function renderCodexUsage(usage) {
    function renderBar(id, windowUsage) {
      var bar = byId(id);
      if (!bar) return;
      var fill = bar.querySelector('.codex-usage-fill');
      var value = bar.querySelector('.codex-usage-value');
      var remaining = windowUsage && Number(windowUsage.remainingPercent);
      if (!Number.isFinite(remaining)) {
        bar.classList.remove('is-low');
        bar.classList.add('is-unavailable');
        bar.removeAttribute('aria-valuenow');
        bar.setAttribute('aria-valuetext', t('codexUsageUnavailableValue', 'Nicht verfügbar'));
        if (fill) fill.style.width = '0%';
        if (value) value.textContent = t('codexUsageUnavailableShort', 'Nicht verfügbar');
        return;
      }
      remaining = Math.max(0, Math.min(100, Math.round(remaining)));
      var low = remaining <= 20;
      var display = low
        ? format('codexUsagePercentLow', '{percent}% · niedrig', { percent: remaining })
        : format('codexUsagePercent', '{percent}%', { percent: remaining });
      bar.classList.toggle('is-low', low);
      bar.classList.remove('is-unavailable');
      bar.setAttribute('aria-valuenow', String(remaining));
      bar.setAttribute('aria-valuetext', display);
      if (fill) fill.style.width = remaining + '%';
      if (value) value.textContent = display;
    }
    renderBar('codexDailyUsageBar', usage && usage.daily);
    renderBar('codexWeeklyUsageBar', usage && usage.weekly);
  }

  async function loadCodexUsage() {
    var requestId = ++codexUsageRequestId;
    codexUsageState = 'loading';
    renderCodexUsageStatus();
    try {
      var usage = await window.codexIdeProfile.codexBridgeUsage();
      if (requestId !== codexUsageRequestId) return;
      codexUsageSnapshot = usage || null;
      renderCodexUsage(codexUsageSnapshot);
      if (!usage || !usage.available) codexUsageState = 'unavailable';
      else if (!usage.daily || !usage.weekly) codexUsageState = 'partial';
      else codexUsageState = 'ready';
      renderCodexUsageStatus();
    } catch (_) {
      if (requestId !== codexUsageRequestId) return;
      codexUsageSnapshot = null;
      codexUsageState = 'error';
      renderCodexUsage(null);
      renderCodexUsageStatus();
    }
  }

  function syncProfileUi() {
    var profile = window.codexIdeProfile.get();
    ['ideBackend', 'settingsBackend'].forEach(function (id) { if (byId(id)) byId(id).value = profile; });
    if (byId('ideModelControl')) byId('ideModelControl').hidden = profile !== 'codex';
    if (byId('ideReasoningControl')) byId('ideReasoningControl').hidden = profile !== 'codex';
    if (byId('localSettings')) byId('localSettings').open = profile === 'local';
    if (byId('apiSettings')) byId('apiSettings').open = profile === 'api';
    if (byId('codexSettings')) byId('codexSettings').open = profile === 'codex';
    var api = window.codexIdeProfile.getApiConfig();
    if (byId('codexIdeApiUrlInput')) byId('codexIdeApiUrlInput').value = api.url || '';
    if (byId('codexIdeApiKeyInput')) byId('codexIdeApiKeyInput').value = api.key || '';
    if (byId('codexIdeApiModelInput')) byId('codexIdeApiModelInput').value = api.model || '';
    if (byId('codexIdeApiMaxTokensInput')) byId('codexIdeApiMaxTokensInput').value = window.codexIdeProfile.getApiMaxTokens();
    var codex = window.codexIdeProfile.getCodexConfig();
    if (byId('codexIdeCodexBridgeUrlInput')) byId('codexIdeCodexBridgeUrlInput').value = codex.url || '';
    if (byId('codexIdeCodexMaxTokensInput')) byId('codexIdeCodexMaxTokensInput').value = window.codexIdeProfile.getCodexMaxTokens();
  }

  function selectProfile(value) {
    if (!/^(local|api|codex)$/.test(value)) return;
    var changed = window.codexIdeProfile.get() !== value;
    window.codexIdeProfile.set(value);
    syncProfileUi();
    if (changed && value === 'codex' && byId('ideSettingsOverlay') && !byId('ideSettingsOverlay').hidden) loadCodexUsage();
  }

  function saveApi() {
    window.codexIdeProfile.setApiConfig(byId('codexIdeApiUrlInput').value, byId('codexIdeApiKeyInput').value, byId('codexIdeApiModelInput').value);
    window.codexIdeProfile.setApiMaxTokens(byId('codexIdeApiMaxTokensInput').value);
    setStatus('apiStatusText', t('apiSavedStatus', 'Gespeichert'));
  }
  async function testApi() {
    saveApi();
    selectProfile('api');
    setStatus('apiStatusText', t('apiTestingStatus', 'Teste …'));
    try {
      await window.codexIdeProfile.apiChatCompletion([{ role: 'user', content: 'Reply only with OK.' }], 20, { stream: false });
      setStatus('apiStatusText', t('apiConnectionOkStatus', 'Verbindung OK'));
    } catch (error) {
      setStatus('apiStatusText', t('apiErrorStatusPrefix', 'Fehler: ') + String(error && error.message || error).slice(0, 160), true);
    }
  }
  function saveCodex() {
    var config = window.codexIdeProfile.getCodexConfig();
    window.codexIdeProfile.setCodexConfig(byId('codexIdeCodexBridgeUrlInput').value, config.model || '');
    window.codexIdeProfile.setCodexMaxTokens(byId('codexIdeCodexMaxTokensInput').value);
    setStatus('codexStatusText', t('codexSavedStatus', 'Gespeichert'));
  }
  async function testCodex() {
    saveCodex();
    selectProfile('codex');
    setStatus('codexStatusText', t('codexTestingStatus', 'Teste …'));
    try {
      await window.codexIdeProfile.codexChatCompletion([{ role: 'user', content: 'Reply only with OK.' }], 20, { stream: false });
      setStatus('codexStatusText', t('codexConnectionOkStatus', 'Gateway OK'));
      await loadCodexUsage();
    } catch (error) {
      setStatus('codexStatusText', t('codexErrorStatusPrefix', 'Fehler: ') + String(error && error.message || error).slice(0, 160), true);
    }
  }
  async function checkCodex() {
    saveCodex();
    setStatus('codexStatusText', t('codexStatusChecking', 'Prüfe Status …'));
    try {
      var status = await window.codexIdeProfile.codexBridgeStatus();
      var login = status && status.login || status || {};
      setStatus('codexStatusText', login.loggedIn
        ? format('codexStatusLoggedIn', 'Gateway OK, angemeldet ({method})', { method: login.method || 'Codex' })
        : t('codexStatusLoginMissing', 'Gateway OK, aber Codex ist nicht angemeldet'), !login.loggedIn);
      if (login.loggedIn) await loadCodexUsage();
      else {
        codexUsageSnapshot = null;
        codexUsageState = 'unavailable';
        renderCodexUsage(null);
        renderCodexUsageStatus();
      }
    } catch (error) {
      setStatus('codexStatusText', t('codexErrorStatusPrefix', 'Fehler: ') + String(error && error.message || error).slice(0, 160), true);
    }
  }
  async function copyCodexCommand(command) {
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(command);
      } else {
        var input = document.createElement('textarea');
        input.value = command;
        input.setAttribute('readonly', '');
        input.style.position = 'fixed'; input.style.opacity = '0';
        document.body.appendChild(input); input.select();
        if (!document.execCommand('copy')) throw new Error('copy unavailable');
        document.body.removeChild(input);
      }
      setStatus('codexStatusText', format('codexCommandCopiedStatus', 'Kopiert: {command}', { command: command }));
    } catch (error) {
      setStatus('codexStatusText', t('codexCommandCopyError', 'Kopieren fehlgeschlagen. Bitte den Befehl manuell markieren.'), true);
    }
  }
  async function loadLocalModel() {
    selectProfile('local');
    if (window.CodexIdeLocalModel) window.CodexIdeLocalModel.setMaxTokens(byId('llmMaxTokensInput').value);
    try {
      await window.CodexIdeLocalModel.init(byId('customChatModelId').value);
      byId('llmEnabledToggle').checked = window.CodexIdeLocalModel.isEnabled();
    } catch (_) { /* the local runtime writes its translated status */ }
  }

  function skillStatus(skill) {
    if (!skill.state.installed) return t('skillNotInstalled', 'Nicht installiert');
    return skill.state.enabled ? t('skillEnabled', 'Aktiv') : t('skillDisabled', 'Deaktiviert');
  }
  function setSkillStatus(id, message) {
    statusMessages[id] = message;
    var card = byId('skill-card-' + id.replace(/[^a-z0-9_-]/gi, '-'));
    var status = card && card.querySelector('.skill-action-status');
    if (status) status.textContent = message;
  }
  function saveSkill(skill, card) {
    var system = window.CodexIdeSkillSystem;
    var enabled = card.querySelector('[data-skill-enabled]');
    if (enabled) system.setEnabled(skill.manifest.id, enabled.checked);
    Array.prototype.forEach.call(card.querySelectorAll('[data-skill-permission]'), function (input) {
      system.setPermission(skill.manifest.id, input.value, input.checked);
    });
    system.setProfiles(skill.manifest.id, Array.prototype.slice.call(card.querySelectorAll('[data-skill-profile]:checked')).map(function (input) { return input.value; }));
    var config = {};
    Array.prototype.forEach.call(card.querySelectorAll('[data-skill-config]'), function (input) { config[input.dataset.skillConfig] = input.value; });
    system.setConfig(skill.manifest.id, config);
    setSkillStatus(skill.manifest.id, t('skillSavedStatus', 'Gespeichert'));
  }
  async function verifySkill(skill, card) {
    saveSkill(skill, card);
    setSkillStatus(skill.manifest.id, t('skillRuntimeCheckingStatus', 'Runtime wird geprüft …'));
    try {
      var profile = window.codexIdeProfile.get();
      if (!window.CodexIdeSkillSystem.canRun(skill.manifest.id, profile)) throw new Error(t('skillUnavailableForProfile', 'Für das aktive Backend nicht freigegeben.'));
      await window.CodexIdeSkillSystem.loadEntrypoint(skill.manifest);
      if (!window.CodexIdeSkillSystem.hasRuntime(skill.manifest.id)) throw new Error(t('skillRuntimeMissing', 'Runtime fehlt.'));
      setSkillStatus(skill.manifest.id, t('skillRuntimeReadyStatus', 'Runtime ist bereit.'));
    } catch (error) {
      setSkillStatus(skill.manifest.id, t('skillRuntimeErrorPrefix', 'Prüfung fehlgeschlagen: ') + String(error && error.message || error));
    }
  }
  async function testInternetSkill(skill, card) {
    saveSkill(skill, card);
    setSkillStatus(skill.manifest.id, t('internetSkillTestingStatus', 'Teste …'));
    try {
      var profile = window.codexIdeProfile.get();
      if (!window.CodexIdeSkillSystem.canRun(skill.manifest.id, profile)) throw new Error(t('skillUnavailableForProfile', 'Nicht freigegeben.'));
      var config = window.CodexIdeSkillSystem.getConfigForRun(skill.manifest.id);
      var result = await window.CodexIdeInternetSkill.search(t('internetSkillTestQuery', 'Codex IDE'), { limit: 3, language: window.__codexIdeCurrentLanguage, config: Object.assign({ enabled: true }, config) });
      window.CodexIdeSkillSystem.recordRun(skill.manifest.id);
      setSkillStatus(skill.manifest.id, format('internetSkillTestOkStatus', 'Suche OK ({count})', { count: result.results.length }));
    } catch (error) {
      setSkillStatus(skill.manifest.id, t('internetSkillErrorStatusPrefix', 'Fehler: ') + String(error && error.message || error));
    }
  }

  function renderCatalog() {
    var catalog = byId('skillCatalog');
    if (!catalog || !window.CodexIdeSkillSystem) return;
    var skills = window.CodexIdeSkillSystem.getSkills();
    if (!skills.length) { catalog.textContent = t('skillLoading', 'Skill-Manifeste werden geladen …'); return; }
    catalog.innerHTML = '';
    skills.forEach(function (skill) {
      var manifest = skill.manifest;
      var state = skill.state;
      var card = element('article', 'skill-card');
      card.id = 'skill-card-' + manifest.id.replace(/[^a-z0-9_-]/gi, '-');
      var header = element('div', 'skill-card-header');
      var heading = element('div');
      heading.appendChild(element('h3', '', manifestText(manifest.displayNameKey, manifest.displayName, manifest.name)));
      heading.appendChild(element('p', 'settings-hint', manifestText(manifest.descriptionKey, manifest.description, manifest.name)));
      heading.appendChild(element('span', 'skill-type-badge', t(manifest.builtIn ? 'skillBuiltInBadge' : 'skillCustomBadge', manifest.builtIn ? 'Standard-Skill' : 'Installierter Skill')));
      header.appendChild(heading);
      if (!manifest.builtIn) {
        var uninstall = element('button', 'skill-install-button', t('skillUninstall', 'Deinstallieren'));
        uninstall.type = 'button';
        uninstall.addEventListener('click', function () {
          if (!window.confirm(format('skillUninstallConfirm', 'Skill „{name}“ deinstallieren?', { name: manifest.name }))) return;
          window.CodexIdeSkillSystem.uninstall(manifest.id);
          renderCatalog();
        });
        header.appendChild(uninstall);
      }
      card.appendChild(header);
      card.appendChild(element('p', 'skill-meta', t('skillVersion', 'Version') + ' ' + manifest.version + ' · ' + skillStatus(skill)));
      if (state.installed) {
        var enabledRow = element('label', 'skill-toggle-row');
        var enabled = element('input'); enabled.type = 'checkbox'; enabled.checked = state.enabled; enabled.dataset.skillEnabled = 'true';
        enabledRow.appendChild(enabled); enabledRow.appendChild(document.createTextNode(t('skillEnable', 'Skill aktivieren'))); card.appendChild(enabledRow);
        if (manifest.permissions.length) card.appendChild(element('h4', '', t('skillPermissions', 'Rechte')));
        manifest.permissions.forEach(function (permission) {
          var row = element('label', 'skill-choice-row');
          var input = element('input'); input.type = 'checkbox'; input.value = permission.id; input.checked = state.permissions[permission.id] === true; input.dataset.skillPermission = permission.id;
          var copy = element('span'); copy.appendChild(element('strong', '', manifestText(permission.labelKey, permission.label, permission.id))); copy.appendChild(element('small', '', manifestText(permission.descriptionKey, permission.description, '')));
          row.appendChild(input); row.appendChild(copy); card.appendChild(row);
        });
        card.appendChild(element('h4', '', t('skillProfiles', 'Backend-Profile')));
        var profiles = element('div', 'skill-profile-list');
        manifest.profiles.forEach(function (profile) {
          var row = element('label', 'skill-profile-choice'); var input = element('input'); input.type = 'checkbox'; input.value = profile; input.checked = state.profiles.indexOf(profile) !== -1; input.dataset.skillProfile = profile;
          row.appendChild(input); row.appendChild(document.createTextNode(t('skillProfile' + profile.charAt(0).toUpperCase() + profile.slice(1), profile))); profiles.appendChild(row);
        });
        card.appendChild(profiles);
        if ((manifest.setup || []).length) card.appendChild(element('h4', '', t('skillSetup', 'Konfiguration')));
        (manifest.setup || []).forEach(function (field) {
          var row = element('label', 'settings-field skill-config-field'); row.appendChild(element('span', '', manifestText(field.labelKey, field.label, field.id)));
          var input = field.type === 'select' ? element('select') : element('input'); input.dataset.skillConfig = field.id;
          if (field.type !== 'select') input.type = field.type || 'text';
          (field.options || []).forEach(function (option) { var node = element('option', '', manifestText(option.labelKey, option.label, option.value)); node.value = option.value; input.appendChild(node); });
          input.value = state.config[field.id] == null ? field.default || '' : state.config[field.id];
          if (field.permission && state.permissions[field.permission] !== true) input.disabled = true;
          row.appendChild(input); card.appendChild(row);
        });
        var actions = element('div', 'settings-actions skill-actions');
        var save = element('button', '', t('skillSave', 'Speichern')); save.type = 'button'; save.addEventListener('click', function () { saveSkill(skill, card); }); actions.appendChild(save);
        if (!manifest.builtIn) { var verify = element('button', '', t('skillRuntimeCheck', 'Runtime prüfen')); verify.type = 'button'; verify.addEventListener('click', function () { verifySkill(skill, card); }); actions.appendChild(verify); }
        if (manifest.testAction === 'internet-search') { var test = element('button', '', t('internetSkillTestBtn', 'Testsuche')); test.type = 'button'; test.addEventListener('click', function () { testInternetSkill(skill, card); }); actions.appendChild(test); }
        actions.appendChild(element('span', 'settings-note skill-action-status', statusMessages[manifest.id] || '')); card.appendChild(actions);
      }
      catalog.appendChild(card);
    });
  }

  async function installFromUrl() {
    var status = byId('skillInstallStatus');
    if (!byId('skillTrustSource').checked) { status.textContent = t('skillTrustRequired', 'Bestätige zuerst dein Vertrauen in die Quelle.'); return; }
    try {
      status.textContent = t('skillInstallingStatus', 'Skill wird installiert …');
      var installed = await window.CodexIdeSkillSystem.installFromUrl(byId('skillManifestUrl').value.trim());
      status.textContent = format('skillInstalledStatus', 'Installiert: {name}', { name: installed.manifest.name });
      byId('skillManifestUrl').value = ''; byId('skillTrustSource').checked = false; renderCatalog();
    } catch (error) { status.textContent = t('skillInstallErrorPrefix', 'Installation fehlgeschlagen: ') + String(error && error.message || error); }
  }
  async function installFromFiles(files) {
    var status = byId('skillInstallStatus');
    if (!files || !files.length) return;
    if (!byId('skillTrustSource').checked) { status.textContent = t('skillTrustRequired', 'Bestätige zuerst dein Vertrauen in die Quelle.'); return; }
    try {
      status.textContent = t('skillInstallingLocalStatus', 'Lokales Paket wird installiert …');
      var installed = await window.CodexIdeSkillSystem.installFromFiles(files);
      status.textContent = format('skillInstalledLocalStatus', 'Installiert: {name}', { name: installed.manifest.name });
      byId('skillTrustSource').checked = false; renderCatalog();
    } catch (error) { status.textContent = t('skillInstallErrorPrefix', 'Installation fehlgeschlagen: ') + String(error && error.message || error); }
  }

  function setLanguage(language) {
    if (!/^(de|en|fr)$/.test(language)) return;
    safeSet('codexIdeLanguage', language);
    window.__codexIdeCurrentLanguage = language;
    document.documentElement.lang = language;
    syncLanguageControls(language);
    applyTranslations();
    document.dispatchEvent(new CustomEvent('codex-ide-language-change', { detail: { language: language } }));
  }
  function openSettings() {
    if (document.body.dataset.ideBusy) return;
    byId('ideSettingsOverlay').hidden = false;
    if (window.codexIdeProfile.get() === 'codex') loadCodexUsage();
  }
  function closeSettings() { byId('ideSettingsOverlay').hidden = true; }

  function bind() {
    byId('ideSettingsOpen').addEventListener('click', openSettings);
    byId('ideSettingsClose').addEventListener('click', closeSettings);
    byId('ideSettingsOverlay').addEventListener('click', function (event) { if (event.target === this) closeSettings(); });
    document.addEventListener('keydown', function (event) { if (event.key === 'Escape') closeSettings(); });
    ['ideBackend', 'settingsBackend'].forEach(function (id) { byId(id).addEventListener('change', function () { selectProfile(this.value); }); });
    if (byId('ideLanguage')) {
      byId('ideLanguage').addEventListener('click', function (event) {
        var button = event.target && event.target.closest ? event.target.closest('[data-language]') : null;
        if (!button || !this.contains(button) || button.disabled) return;
        setLanguage(button.dataset.language);
      });
    }
    byId('apiSaveBtn').addEventListener('click', saveApi); byId('apiTestBtn').addEventListener('click', testApi);
    byId('codexSaveBtn').addEventListener('click', saveCodex); byId('codexTestBtn').addEventListener('click', testCodex); byId('codexStatusBtn').addEventListener('click', checkCodex);
    byId('codexCopyLoginBtn').addEventListener('click', function () { copyCodexCommand('codex-ide codex login'); });
    byId('codexCopyDeviceLoginBtn').addEventListener('click', function () { copyCodexCommand('codex-ide codex login --device-auth'); });
    byId('codexCopyStatusBtn').addEventListener('click', function () { copyCodexCommand('codex-ide codex status'); });
    byId('reloadChatModelBtn').addEventListener('click', loadLocalModel);
    byId('llmEnabledToggle').addEventListener('change', function () { if (window.CodexIdeLocalModel) window.CodexIdeLocalModel.setEnabled(this.checked); });
    byId('llmMaxTokensInput').addEventListener('change', function () { if (window.CodexIdeLocalModel) window.CodexIdeLocalModel.setMaxTokens(this.value); });
    byId('skillInstallFromUrlBtn').addEventListener('click', installFromUrl);
    byId('skillChooseLocalFilesBtn').addEventListener('click', function () { if (byId('skillTrustSource').checked) byId('skillLocalFiles').click(); else byId('skillInstallStatus').textContent = t('skillTrustRequired', 'Bestätige zuerst dein Vertrauen.'); });
    byId('skillLocalFiles').addEventListener('change', function () { installFromFiles(this.files); this.value = ''; });
    document.addEventListener('codex-ide-profile-change', syncProfileUi);
    document.addEventListener('codex-ide-skills-change', renderCatalog);
  }

  async function init() {
    if (!window.codexIdeProfile) return;
    bind(); syncProfileUi(); applyTranslations();
    if (window.CodexIdeSkillSystem && window.CodexIdeSkillSystem.ready) {
      try { await window.CodexIdeSkillSystem.ready; } catch (_) {}
      renderCatalog();
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();

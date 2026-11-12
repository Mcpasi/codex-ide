(function () {
  'use strict';

  var STATE_KEY = 'codexIdeSkillStatesV1';
  var CUSTOM_MANIFESTS_KEY = 'codexIdeInstalledSkillManifestsV1';
  var BUILT_IN_MANIFEST_URLS = [
    'skills/internet/manifest.json',
    'skills/extended-files/manifest.json',
    'skills/codex-ide-tutor/manifest.json'
  ];
  var VALID_PROFILES = ['local', 'api', 'codex', 'antigravity'];
  var AGENT_PROFILES = ['local', 'api', 'codex', 'antigravity'];
  var VALID_SETUP_TYPES = ['text', 'password', 'select'];
  var VALID_PARAMETER_TYPES = ['string', 'number', 'boolean'];
  var LOCAL_PACKAGE_VERSION = 1;
  var MAX_LOCAL_ENTRYPOINT_CHARS = 500000;
  var ID_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
  var FIELD_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;
  var VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
  var RESERVED_IDS = ['constructor', 'prototype', 'tostring', 'valueof', 'hasownproperty'];
  var manifests = [];
  var states = readJson(STATE_KEY, {});
  var customManifests = readJson(CUSTOM_MANIFESTS_KEY, []);
  var entrypointLoads = {};
  var runtimes = {};

  function readJson(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (_) { return fallback; }
  }

  function writeJson(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) { /* ignore */ }
  }

  function dispatchChange() {
    if (typeof document !== 'undefined' && typeof CustomEvent !== 'undefined') {
      document.dispatchEvent(new CustomEvent('codex-ide-skills-change'));
    }
  }

  function writeStates() {
    writeJson(STATE_KEY, states);
    dispatchChange();
  }

  function writeCustomManifests() {
    customManifests = manifests.filter(function (manifest) { return manifest.builtIn !== true; }).map(function (manifest) {
      return clone(manifest);
    });
    writeJson(CUSTOM_MANIFESTS_KEY, customManifests);
  }

  function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
  function cleanText(value, maxLength) { return String(value == null ? '' : value).trim().slice(0, maxLength || 2000); }
  function unique(values) { return values.filter(function (value, index) { return values.indexOf(value) === index; }); }

  function assertId(value, label, source, skillId) {
    var pattern = skillId ? ID_PATTERN : FIELD_ID_PATTERN;
    if (typeof value !== 'string' || value.length > 80 || !pattern.test(value) || RESERVED_IDS.indexOf(value.toLowerCase()) !== -1) {
      throw new Error('Invalid ' + label + ': ' + source);
    }
  }

  function validateLocalized(value, label, source) {
    if (value == null) return;
    if (typeof value === 'string') {
      if (!cleanText(value, 2000)) throw new Error('Invalid ' + label + ': ' + source);
      return;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid ' + label + ': ' + source);
    ['de', 'en', 'fr'].forEach(function (language) {
      if (value[language] != null && (typeof value[language] !== 'string' || !cleanText(value[language], 2000))) throw new Error('Invalid ' + label + ': ' + source);
    });
  }

  function resolveUrl(value, source) {
    try {
      if (typeof URL === 'function') {
        var base = source;
        if (!base && typeof document !== 'undefined') base = document.baseURI;
        if (!base && typeof location !== 'undefined') base = location.href;
        return new URL(value, base).href;
      }
    } catch (_) { /* handled below */ }
    return value;
  }

  function usesSecureTransport(value) {
    if (/^https?:\/\/[^/@]+@/i.test(value)) return false;
    if (!/^https?:\/\//i.test(value)) return false;
    try {
      if (typeof URL !== 'function') return /^https:\/\//i.test(value) || /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::|\/)/i.test(value);
      var parsed = new URL(value);
      if (parsed.username || parsed.password) return false;
      if (parsed.protocol === 'https:') return true;
      if (/^(localhost|127\.0\.0\.1|\[::1\])$/i.test(parsed.hostname)) return true;
      return typeof location !== 'undefined' && parsed.origin === location.origin;
    } catch (_) { return false; }
  }

  function validateLocalEntrypoint(entrypoint, source) {
    var value = typeof entrypoint === 'string' ? entrypoint.trim().replace(/\\/g, '/') : '';
    if (!value || value.length > 1000 || !/\.js$/i.test(value) || /^(?:[a-z]+:|\/|\\)/i.test(value) || /(?:^|\/)\.\.(?:\/|$)/.test(value) || /[?#]/.test(value)) {
      throw new Error('Local skill entrypoint must be a relative JavaScript file: ' + source);
    }
    return value.replace(/^\.\//, '');
  }

  function validateEntrypoint(entrypoint, source, external, localPackage) {
    if (typeof entrypoint !== 'string' || !entrypoint.trim() || entrypoint.length > 1000) {
      throw new Error('Invalid skill manifest field "entrypoint": ' + source);
    }
    if (localPackage) return validateLocalEntrypoint(entrypoint, source);
    if (!external) return entrypoint.trim();
    var resolved = resolveUrl(entrypoint.trim(), source);
    if (!usesSecureTransport(resolved)) throw new Error('Custom skill entrypoint requires HTTPS or a local HTTP origin: ' + source);
    return resolved;
  }

  function validateManifest(input, source, options) {
    var external = options && options.external === true;
    var localPackage = options && options.localPackage === true;
    try {
      if (JSON.stringify(input).length > 250000) throw new Error('Skill manifest is too large: ' + source);
    } catch (error) {
      throw error instanceof Error ? error : new Error('Invalid skill manifest: ' + source);
    }
    var manifest = clone(input);
    if (!manifest || manifest.schemaVersion !== 1) throw new Error('Unsupported skill manifest: ' + source);
    assertId(manifest.id, 'skill id', source, true);
    if (typeof manifest.name !== 'string' || !cleanText(manifest.name, 120)) throw new Error('Invalid skill manifest field "name": ' + source);
    if (typeof manifest.version !== 'string' || !VERSION_PATTERN.test(manifest.version)) throw new Error('Invalid semantic skill version: ' + source);
    manifest.name = cleanText(manifest.name, 120);
    manifest.entrypoint = validateEntrypoint(manifest.entrypoint, source, external, localPackage);
    if (manifest.integrity != null && (typeof manifest.integrity !== 'string' || manifest.integrity.length > 200 || !/^sha(256|384|512)-[A-Za-z0-9+/=]+$/.test(manifest.integrity))) {
      throw new Error('Invalid skill entrypoint integrity: ' + source);
    }
    manifest.builtIn = !external && manifest.builtIn === true;
    if (external) manifest.defaultEnabled = false;
    if (external) manifest.sourceUrl = localPackage
      ? cleanText(source, 1000)
      : resolveUrl(source, typeof document !== 'undefined' ? document.baseURI : undefined);
    validateLocalized(manifest.displayName, 'localized skill name', source);
    validateLocalized(manifest.description, 'localized skill description', source);

    if (!Array.isArray(manifest.permissions) || !Array.isArray(manifest.profiles)) {
      throw new Error('Skill manifest requires permissions and profiles: ' + source);
    }
    manifest.profiles = unique(manifest.profiles.filter(function (profile) { return VALID_PROFILES.indexOf(profile) !== -1; }));
    if (!manifest.profiles.length) throw new Error('Skill manifest has no valid profile: ' + source);
    if (external && !manifest.profiles.some(function (profile) { return AGENT_PROFILES.indexOf(profile) !== -1; })) {
      throw new Error('Custom agent skills require at least one supported backend profile: ' + source);
    }
    if (manifest.permissions.length > 20) throw new Error('Too many skill permissions: ' + source);
    var permissionIds = [];
    manifest.permissions.forEach(function (permission) {
      if (!permission || typeof permission !== 'object') throw new Error('Invalid skill permission: ' + source);
      assertId(permission.id, 'skill permission', source);
      if (permissionIds.indexOf(permission.id) !== -1) throw new Error('Duplicate skill permission: ' + source);
      permissionIds.push(permission.id);
      validateLocalized(permission.label, 'permission label', source);
      validateLocalized(permission.description, 'permission description', source);
      permission.required = permission.required === true;
      permission.defaultGranted = permission.defaultGranted === true;
      if (external) permission.defaultGranted = false;
    });

    manifest.setup = Array.isArray(manifest.setup) ? manifest.setup : [];
    if (manifest.setup.length > 30) throw new Error('Too many skill setup fields: ' + source);
    var setupIds = [];
    manifest.setup.forEach(function (field) {
      if (!field || typeof field !== 'object') throw new Error('Invalid skill setup field: ' + source);
      assertId(field.id, 'skill setup field', source);
      if (setupIds.indexOf(field.id) !== -1) throw new Error('Duplicate skill setup field: ' + source);
      setupIds.push(field.id);
      if (VALID_SETUP_TYPES.indexOf(field.type || 'text') === -1) throw new Error('Unsupported skill setup type: ' + source);
      if (field.permission && permissionIds.indexOf(field.permission) === -1) throw new Error('Unknown setup permission: ' + source);
      validateLocalized(field.label, 'setup label', source);
      if (field.type === 'select') {
        if (!Array.isArray(field.options) || !field.options.length || field.options.length > 50) throw new Error('Invalid skill setup options: ' + source);
        field.options.forEach(function (option) {
          if (!option || typeof option.value !== 'string' || option.value.length > 200) throw new Error('Invalid skill setup option: ' + source);
          validateLocalized(option.label, 'setup option label', source);
        });
      }
    });

    if (external) {
      if (!manifest.agent || typeof manifest.agent !== 'object') throw new Error('Custom skill manifest requires an agent contract: ' + source);
      validateLocalized(manifest.agent.instructions, 'agent instructions', source);
      if (!localized(manifest.agent.instructions, 'en', '')) throw new Error('Custom skill agent instructions are missing: ' + source);
      validateLocalized(manifest.agent.description, 'agent description', source);
      manifest.agent.resultType = manifest.agent.resultType === 'sources' ? 'sources' : 'context';
      manifest.agent.parameters = Array.isArray(manifest.agent.parameters) ? manifest.agent.parameters : [];
      if (manifest.agent.parameters.length > 20) throw new Error('Too many skill parameters: ' + source);
      var parameterIds = [];
      manifest.agent.parameters.forEach(function (parameter) {
        if (!parameter || typeof parameter !== 'object') throw new Error('Invalid skill parameter: ' + source);
        assertId(parameter.id, 'skill parameter', source);
        if (parameter.id === 'skill' || parameterIds.indexOf(parameter.id) !== -1) throw new Error('Duplicate or reserved skill parameter: ' + source);
        parameterIds.push(parameter.id);
        parameter.type = VALID_PARAMETER_TYPES.indexOf(parameter.type) === -1 ? 'string' : parameter.type;
        parameter.required = parameter.required === true;
        validateLocalized(parameter.description, 'skill parameter description', source);
        if (parameter.type === 'string') {
          var declaredMaxLength = Number(parameter.maxLength);
          parameter.maxLength = Number.isFinite(declaredMaxLength) && declaredMaxLength > 0
            ? Math.max(1, Math.floor(declaredMaxLength))
            : 0;
        }
        if (Array.isArray(parameter.enum)) {
          parameter.enum = unique(parameter.enum.filter(function (value) { return typeof value === parameter.type; })).slice(0, 50);
        }
      });
      manifest.agent.permissionRules = Array.isArray(manifest.agent.permissionRules) ? manifest.agent.permissionRules : [];
      if (manifest.agent.permissionRules.length > 20) throw new Error('Too many skill permission rules: ' + source);
      var permissionRuleKeys = [];
      manifest.agent.permissionRules.forEach(function (rule) {
        if (!rule || typeof rule !== 'object') throw new Error('Invalid skill permission rule: ' + source);
        var parameter = manifest.agent.parameters.find(function (item) { return item.id === rule.parameter; });
        if (!parameter || permissionIds.indexOf(rule.permission) === -1 || typeof rule.equals !== parameter.type) {
          throw new Error('Invalid skill permission rule reference: ' + source);
        }
        if (parameter.enum && parameter.enum.length && parameter.enum.indexOf(rule.equals) === -1) {
          throw new Error('Skill permission rule value is outside the parameter enum: ' + source);
        }
        var key = rule.parameter + ':' + JSON.stringify(rule.equals) + ':' + rule.permission;
        if (permissionRuleKeys.indexOf(key) !== -1) throw new Error('Duplicate skill permission rule: ' + source);
        permissionRuleKeys.push(key);
        rule.parameter = parameter.id;
        rule.permission = String(rule.permission);
      });
    }
    return manifest;
  }

  async function verifyLocalIntegrity(source, integrity) {
    if (!integrity) return;
    var match = /^(sha256|sha384|sha512)-([A-Za-z0-9+/=]+)$/.exec(integrity);
    if (!match || typeof crypto === 'undefined' || !crypto.subtle || typeof TextEncoder !== 'function' || typeof btoa !== 'function') {
      throw new Error('Local skill integrity cannot be verified by this browser');
    }
    var algorithm = match[1] === 'sha256' ? 'SHA-256' : match[1] === 'sha384' ? 'SHA-384' : 'SHA-512';
    var digest = await crypto.subtle.digest(algorithm, new TextEncoder().encode(source));
    var bytes = new Uint8Array(digest); var binary = '';
    for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    if (btoa(binary) !== match[2]) throw new Error('Local skill entrypoint integrity does not match the manifest');
  }

  function defaultState(manifest) {
    var permissions = {};
    manifest.permissions.forEach(function (permission) { permissions[permission.id] = permission.defaultGranted === true; });
    return {
      installed: true,
      enabled: manifest.defaultEnabled !== false,
      permissions: permissions,
      profiles: manifest.profiles.slice(),
      config: {},
      lastRunAt: null
    };
  }

  function migrateInternetState(state) {
    if (state.__legacyMigrated) return state;
    try {
      var enabled = localStorage.getItem('codexIdeSkillInternetEnabled');
      if (enabled != null) state.enabled = enabled !== 'false';
      var provider = localStorage.getItem('codexIdeInternetSearchProvider');
      var googleApiKey = localStorage.getItem('codexIdeInternetGoogleApiKey');
      var googleCx = localStorage.getItem('codexIdeInternetGoogleCx');
      if (provider) state.config.provider = provider;
      if (googleApiKey) state.config.googleApiKey = googleApiKey;
      if (googleCx) state.config.googleCx = googleCx;
      if (googleApiKey || googleCx) state.permissions.credentials = true;
    } catch (_) { /* ignore */ }
    state.__legacyMigrated = true;
    return state;
  }

  function ensureState(manifest) {
    var state = states[manifest.id];
    if (!state || typeof state !== 'object') state = defaultState(manifest);
    var defaults = defaultState(manifest);
    state.installed = true;
    state.enabled = typeof state.enabled === 'boolean' ? state.enabled : defaults.enabled;
    state.permissions = Object.assign({}, defaults.permissions, state.permissions || {});
    Object.keys(state.permissions).forEach(function (permissionId) {
      if (!manifest.permissions.some(function (permission) { return permission.id === permissionId; })) delete state.permissions[permissionId];
    });
    state.profiles = Array.isArray(state.profiles) ? state.profiles.filter(function (profile) {
      return manifest.profiles.indexOf(profile) !== -1;
    }) : defaults.profiles;
    state.config = state.config && typeof state.config === 'object' ? state.config : {};
    state.lastRunAt = typeof state.lastRunAt === 'string' ? state.lastRunAt : null;
    if (manifest.id === 'internet.research') state = migrateInternetState(state);
    states[manifest.id] = state;
    return state;
  }

  function syncStatesFromStorage() {
    var stored = readJson(STATE_KEY, {});
    if (stored && typeof stored === 'object' && !Array.isArray(stored)) states = stored;
  }

  function findManifest(id) { return manifests.find(function (manifest) { return manifest.id === id; }) || null; }
  function getSkill(id) {
    syncStatesFromStorage();
    var manifest = findManifest(id);
    return manifest ? { manifest: clone(manifest), state: clone(ensureState(manifest)) } : null;
  }
  function getSkills() { return manifests.map(function (manifest) { return getSkill(manifest.id); }); }

  function update(id, callback) {
    syncStatesFromStorage();
    var manifest = findManifest(id);
    if (!manifest) return false;
    callback(ensureState(manifest), manifest);
    writeStates();
    return true;
  }

  function loadEntrypoint(manifest) {
    if (!manifest || typeof document === 'undefined' || typeof document.createElement !== 'function') return Promise.resolve();
    var loadKey = manifest.localEntrypointSource ? 'local:' + manifest.id : manifest.entrypoint;
    if (entrypointLoads[loadKey]) return entrypointLoads[loadKey];
    var existing = typeof document.querySelector === 'function'
      ? document.querySelector('script[data-skill-id="' + manifest.id + '"]')
      : null;
    if (existing && hasRuntime(manifest.id)) return Promise.resolve();
    if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
    entrypointLoads[loadKey] = new Promise(function (resolve, reject) {
      var script = document.createElement('script');
      var objectUrl = '';
      if (manifest.localEntrypointSource) {
        var debugSource = manifest.localEntrypointSource + '\n//# sourceURL=codex-ide-skill/' + manifest.id + '/' + manifest.entrypoint;
        if (typeof Blob === 'function' && typeof URL === 'function' && typeof URL.createObjectURL === 'function') {
          objectUrl = URL.createObjectURL(new Blob([debugSource], { type: 'text/javascript' }));
          script.src = objectUrl;
        } else {
          script.src = 'data:text/javascript;charset=utf-8,' + encodeURIComponent(debugSource);
        }
      } else {
        script.src = manifest.entrypoint;
      }
      script.async = true;
      script.dataset.skillEntrypoint = manifest.entrypoint;
      script.dataset.skillId = manifest.id;
      if (!manifest.localEntrypointSource && manifest.integrity && /^sha(256|384|512)-/i.test(manifest.integrity)) {
        script.integrity = manifest.integrity;
        script.crossOrigin = 'anonymous';
      }
      script.onload = function () {
        if (objectUrl && typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(objectUrl);
        resolve();
      };
      script.onerror = function () {
        if (objectUrl && typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(objectUrl);
        delete entrypointLoads[loadKey];
        reject(new Error('Skill entrypoint could not be loaded: ' + manifest.entrypoint));
      };
      (document.head || document.documentElement).appendChild(script);
    });
    return entrypointLoads[loadKey];
  }

  function setInstalled(id, installed) {
    var manifest = findManifest(id);
    if (!manifest) return false;
    if (!installed) return manifest.builtIn === true ? false : uninstall(id);
    return true;
  }
  function setEnabled(id, enabled) { return update(id, function (state) { state.enabled = !!enabled; }); }
  function setPermission(id, permissionId, granted) {
    return update(id, function (state, manifest) {
      if (manifest.permissions.some(function (permission) { return permission.id === permissionId; })) state.permissions[permissionId] = !!granted;
    });
  }
  function setProfiles(id, profiles) {
    return update(id, function (state, manifest) {
      state.profiles = unique((profiles || []).filter(function (profile) { return manifest.profiles.indexOf(profile) !== -1; }));
    });
  }
  function setConfig(id, config) {
    return update(id, function (state, manifest) {
      (manifest.setup || []).forEach(function (field) {
        if (!Object.prototype.hasOwnProperty.call(config || {}, field.id)) return;
        var value = config[field.id];
        state.config[field.id] = typeof value === 'string' ? value.trim().slice(0, 10000) : value;
      });
    });
  }
  function getConfig(id) { var skill = getSkill(id); return skill ? clone(skill.state.config) : {}; }

  function canRun(id, profile) {
    var skill = getSkill(id);
    if (!skill || !skill.state.enabled || skill.state.profiles.indexOf(profile) === -1) return false;
    return skill.manifest.permissions.every(function (permission) {
      return permission.required !== true || skill.state.permissions[permission.id] === true;
    });
  }

  function canRunWithPermissions(id, profile, permissionIds) {
    var skill = getSkill(id);
    if (!skill || !canRun(id, profile)) return false;
    var requested = Array.isArray(permissionIds) ? permissionIds : [permissionIds];
    return requested.filter(Boolean).every(function (permissionId) {
      return skill.manifest.permissions.some(function (permission) { return permission.id === permissionId; }) &&
        skill.state.permissions[permissionId] === true;
    });
  }

  function conditionalPermissionsForRequest(manifest, normalizedRequest) {
    if (!manifest || !manifest.agent || !Array.isArray(manifest.agent.permissionRules)) return [];
    return unique(manifest.agent.permissionRules.filter(function (rule) {
      return normalizedRequest && normalizedRequest[rule.parameter] === rule.equals;
    }).map(function (rule) { return rule.permission; }));
  }

  function hasContextPermissions(manifest, state, profile, context) {
    if (!context || context.editorWorkspaceMode !== true || (profile !== 'codex' && profile !== 'antigravity')) return true;
    var declaresNetwork = manifest.permissions.some(function (permission) { return permission.id === 'network'; });
    return !declaresNetwork || state.permissions.network === true;
  }

  function canRunRequest(id, profile, request, context) {
    var skill = getSkill(id);
    if (!skill || !canRun(id, profile)) return false;
    if (!hasContextPermissions(skill.manifest, skill.state, profile, context)) return false;
    var normalized = validateRequest(request);
    if (!normalized || normalized.skill !== id) return false;
    return conditionalPermissionsForRequest(skill.manifest, normalized).every(function (permissionId) {
      return skill.state.permissions[permissionId] === true;
    });
  }

  function getConfigForRun(id) {
    var skill = getSkill(id);
    if (!skill) return {};
    var config = clone(skill.state.config);
    (skill.manifest.setup || []).forEach(function (field) {
      if (field.permission && skill.state.permissions[field.permission] !== true) delete config[field.id];
    });
    return config;
  }

  function recordRun(id, date) {
    return update(id, function (state) { state.lastRunAt = (date instanceof Date ? date : new Date(date || Date.now())).toISOString(); });
  }

  function registerRuntime(id, runtime) {
    if (!findManifest(id) || !runtime || typeof runtime.run !== 'function') return false;
    if (typeof document !== 'undefined' && document.currentScript && document.currentScript.dataset &&
        document.currentScript.dataset.skillId && document.currentScript.dataset.skillId !== id) return false;
    runtimes[id] = runtime;
    return true;
  }

  function hasRuntime(id) { return typeof runtimes[id] === 'object' && typeof runtimes[id].run === 'function'; }

  function validateRequest(request) {
    if (!request || typeof request !== 'object' || Array.isArray(request) || typeof request.skill !== 'string') return null;
    var manifest = findManifest(request.skill);
    if (!manifest || manifest.builtIn === true || !manifest.agent) return null;
    var allowed = ['skill'].concat(manifest.agent.parameters.map(function (parameter) { return parameter.id; }));
    if (Object.keys(request).some(function (key) { return allowed.indexOf(key) === -1; })) return null;
    var normalized = { skill: manifest.id };
    for (var i = 0; i < manifest.agent.parameters.length; i++) {
      var parameter = manifest.agent.parameters[i];
      var value = request[parameter.id];
      if (value == null || value === '') {
        if (parameter.required) return null;
        continue;
      }
      if (typeof value !== parameter.type) return null;
      if (parameter.type === 'string') {
        value = value.trim();
        if (parameter.maxLength > 0) value = value.slice(0, parameter.maxLength);
      }
      if (parameter.enum && parameter.enum.length && parameter.enum.indexOf(value) === -1) return null;
      normalized[parameter.id] = value;
    }
    return normalized;
  }

  function localized(value, language, fallback) {
    if (typeof value === 'string') return value;
    if (value && typeof value === 'object') return cleanText(value[language] || value.en || value.de || value.fr || fallback, 2000);
    return fallback || '';
  }

  function requestExample(manifest, language) {
    var example = { skill: manifest.id };
    manifest.agent.parameters.forEach(function (parameter) {
      if (parameter.enum && parameter.enum.length) example[parameter.id] = parameter.enum[0];
      else if (parameter.type === 'boolean') example[parameter.id] = true;
      else if (parameter.type === 'number') example[parameter.id] = 1;
      else example[parameter.id] = localized(parameter.description, language, parameter.id);
    });
    return JSON.stringify(example);
  }

  function getAgentDefinitions(profile, language, options) {
    return manifests.filter(function (manifest) {
      if (manifest.builtIn === true || !manifest.agent || !canRun(manifest.id, profile) || !hasRuntime(manifest.id)) return false;
      var state = ensureState(manifest);
      if (!hasContextPermissions(manifest, state, profile, options)) return false;
      var rules = manifest.agent.permissionRules || [];
      if (!rules.length) return true;
      return rules.some(function (rule) { return state.permissions[rule.permission] === true; });
    }).map(function (manifest) {
      return {
        id: manifest.id,
        name: localized(manifest.displayName, language, manifest.name),
        description: localized(manifest.agent.description, language, localized(manifest.description, language, manifest.name)),
        instructions: localized(manifest.agent.instructions, language, ''),
        requestExample: requestExample(manifest, language),
        resultType: manifest.agent.resultType,
        networkAccess: manifest.permissions.some(function (permission) { return permission.id === 'network'; })
      };
    });
  }

  async function runSkill(id, request, context) {
    var ctx = context || {};
    var manifest = findManifest(id);
    if (!manifest || manifest.builtIn === true || !canRun(id, ctx.profile)) throw new Error('Skill is not available');
    await loadEntrypoint(manifest);
    var runtime = runtimes[id];
    if (!runtime || typeof runtime.run !== 'function') throw new Error('Skill runtime is not registered');
    var normalized = validateRequest(request);
    if (!normalized) throw new Error('Invalid skill request');
    if (!canRunRequest(id, ctx.profile, request, ctx)) throw new Error('Skill permission is not available');
    delete normalized.skill;
    var state = ensureState(manifest);
    var result = await runtime.run(clone(normalized), {
      language: ctx.language || 'de',
      profile: ctx.profile,
      config: getConfigForRun(id),
      permissions: clone(state.permissions),
      editorWorkspaceMode: ctx.editorWorkspaceMode === true,
      signal: ctx.signal
    });
    if (!result || typeof result.context !== 'string' || !result.context.trim()) throw new Error('Skill returned no model context');
    var resultCount;
    if (manifest.agent.resultType === 'sources') {
      if (typeof result.resultCount !== 'number' || !Number.isFinite(result.resultCount) ||
          !Number.isInteger(result.resultCount) || result.resultCount < 0) {
        throw new Error('Source skill returned an invalid result count');
      }
      resultCount = result.resultCount;
    }
    recordRun(id);
    return {
      context: result.context.trim(),
      resultCount: resultCount,
      detail: result.detail && typeof result.detail === 'object' ? clone(result.detail) : {}
    };
  }

  async function installManifest(input, sourceUrl) {
    var source = resolveUrl(sourceUrl, typeof document !== 'undefined' ? document.baseURI : undefined);
    if (!usesSecureTransport(source)) throw new Error('Skill manifest URL requires HTTPS or a local HTTP origin');
    var safeInput = clone(input);
    if (safeInput && typeof safeInput === 'object') delete safeInput.localEntrypointSource;
    var manifest = validateManifest(safeInput, source, { external: true });
    if (manifests.some(function (item) { return item.builtIn === true && item.id === manifest.id; })) {
      throw new Error('Built-in skill ids cannot be replaced');
    }
    return installValidatedManifest(manifest);
  }

  async function installFromUrl(url) {
    var source = cleanText(url, 2000);
    if (!source) throw new Error('Skill manifest URL is required');
    source = resolveUrl(source, typeof document !== 'undefined' ? document.baseURI : undefined);
    if (!usesSecureTransport(source)) throw new Error('Skill manifest URL requires HTTPS or a local HTTP origin');
    var response = await fetch(source, { cache: 'no-cache' });
    if (!response.ok) throw new Error('Skill manifest could not be loaded: ' + source);
    return installManifest(await response.json(), source);
  }

  function readLocalFile(file) {
    if (file && typeof file.text === 'function') return file.text();
    if (typeof FileReader !== 'function') return Promise.reject(new Error('Local files are not supported by this browser'));
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(String(reader.result || '')); };
      reader.onerror = function () { reject(new Error('Local skill file could not be read')); };
      reader.readAsText(file);
    });
  }

  async function installLocalPackage(input, sourceLabel) {
    if (!input || input.packageVersion !== LOCAL_PACKAGE_VERSION || !input.manifest || typeof input.entrypointSource !== 'string') {
      throw new Error('Unsupported local skill package');
    }
    if (!input.entrypointSource.trim() || input.entrypointSource.length > MAX_LOCAL_ENTRYPOINT_CHARS) {
      throw new Error('Local skill entrypoint is empty or too large');
    }
    var source = 'local:' + cleanText(sourceLabel || 'offline.codexskill', 900).replace(/^local:/, '');
    var manifestInput = clone(input.manifest);
    if (manifestInput && typeof manifestInput === 'object') delete manifestInput.localEntrypointSource;
    var manifest = validateManifest(manifestInput, source, { external: true, localPackage: true });
    await verifyLocalIntegrity(input.entrypointSource, manifest.integrity);
    manifest.localEntrypointSource = input.entrypointSource;
    if (manifests.some(function (item) { return item.builtIn === true && item.id === manifest.id; })) {
      throw new Error('Built-in skill ids cannot be replaced');
    }
    return installValidatedManifest(manifest);
  }

  async function installFromFiles(fileList) {
    var files = Array.prototype.slice.call(fileList || []).filter(Boolean);
    if (!files.length) throw new Error('Select a .codexskill package or manifest.json and its JavaScript entrypoint');
    if (files.length === 1 && /\.codexskill$/i.test(files[0].name || '')) {
      return installLocalPackage(JSON.parse(await readLocalFile(files[0])), files[0].name);
    }
    var manifestFiles = files.filter(function (file) { return /(?:^|\/)manifest\.json$/i.test(file.webkitRelativePath || file.name || ''); });
    if (manifestFiles.length !== 1) throw new Error('Select exactly one manifest.json');
    var manifestInput = JSON.parse(await readLocalFile(manifestFiles[0]));
    var entrypoint = validateLocalEntrypoint(manifestInput && manifestInput.entrypoint, manifestFiles[0].name || 'manifest.json');
    var entrypointName = entrypoint.split('/').pop();
    var entrypointFiles = files.filter(function (file) {
      var filePath = String(file.webkitRelativePath || file.name || '').replace(/\\/g, '/');
      return filePath === entrypoint || filePath.slice(-(entrypoint.length + 1)) === '/' + entrypoint || (!file.webkitRelativePath && file.name === entrypointName);
    });
    if (entrypointFiles.length !== 1) throw new Error('Select the JavaScript entrypoint declared by manifest.json: ' + entrypoint);
    return installLocalPackage({
      packageVersion: LOCAL_PACKAGE_VERSION,
      manifest: manifestInput,
      entrypointSource: await readLocalFile(entrypointFiles[0])
    }, manifestFiles[0].webkitRelativePath || manifestFiles[0].name || 'manifest.json');
  }

  async function installValidatedManifest(manifest) {
    var existingIndex = manifests.findIndex(function (item) { return item.id === manifest.id; });
    var previousManifest = existingIndex === -1 ? null : manifests[existingIndex];
    var previousRuntime = runtimes[manifest.id];
    var hadPreviousState = Object.prototype.hasOwnProperty.call(states, manifest.id);
    var previousState = hadPreviousState ? clone(states[manifest.id]) : null;
    if (previousManifest) {
      delete runtimes[manifest.id];
      delete entrypointLoads[previousManifest.localEntrypointSource ? 'local:' + manifest.id : previousManifest.entrypoint];
      if (typeof document !== 'undefined' && typeof document.querySelector === 'function') {
        var previousScript = document.querySelector('script[data-skill-id="' + manifest.id + '"]');
        if (previousScript && previousScript.parentNode) previousScript.parentNode.removeChild(previousScript);
      }
    }
    if (existingIndex === -1) manifests.push(manifest);
    else manifests[existingIndex] = manifest;
    ensureState(manifest).installed = true;
    try {
      await loadEntrypoint(manifest);
      if (typeof document !== 'undefined' && typeof document.createElement === 'function' && !runtimes[manifest.id]) {
        throw new Error('Skill entrypoint did not register its runtime: ' + manifest.id);
      }
    } catch (error) {
      delete entrypointLoads[manifest.localEntrypointSource ? 'local:' + manifest.id : manifest.entrypoint];
      delete runtimes[manifest.id];
      if (typeof document !== 'undefined' && typeof document.querySelector === 'function') {
        var failedScript = document.querySelector('script[data-skill-id="' + manifest.id + '"]');
        if (failedScript && failedScript.parentNode) failedScript.parentNode.removeChild(failedScript);
      }
      if (previousManifest) manifests[existingIndex] = previousManifest;
      else manifests.splice(manifests.indexOf(manifest), 1);
      if (previousRuntime) runtimes[manifest.id] = previousRuntime;
      if (hadPreviousState) states[manifest.id] = previousState;
      else delete states[manifest.id];
      throw error;
    }
    writeCustomManifests();
    writeStates();
    return getSkill(manifest.id);
  }

  function uninstall(id) {
    var manifest = findManifest(id);
    if (!manifest || manifest.builtIn === true) return false;
    manifests = manifests.filter(function (item) { return item.id !== id; });
    delete states[id];
    delete runtimes[id];
    delete entrypointLoads[manifest.localEntrypointSource ? 'local:' + manifest.id : manifest.entrypoint];
    if (typeof document !== 'undefined' && typeof document.querySelector === 'function') {
      var script = document.querySelector('script[data-skill-id="' + id + '"]');
      if (script && script.parentNode) script.parentNode.removeChild(script);
    }
    writeCustomManifests();
    writeStates();
    return true;
  }

  var ready = Promise.all(BUILT_IN_MANIFEST_URLS.map(function (url) {
    return fetch(url, { cache: 'no-cache' }).then(function (response) {
      if (!response.ok) throw new Error('Skill manifest could not be loaded: ' + url);
      return response.json();
    }).then(function (manifest) { return validateManifest(manifest, url, { external: false }); });
  })).then(function (builtIns) {
    var builtInIds = builtIns.map(function (manifest) { return manifest.id; });
    var restored = Array.isArray(customManifests) ? customManifests.map(function (manifest) {
      try {
        var source = manifest && manifest.sourceUrl;
        var isLocalPackage = !!(manifest && typeof manifest.localEntrypointSource === 'string');
        var manifestInput = clone(manifest);
        if (manifestInput && typeof manifestInput === 'object') delete manifestInput.localEntrypointSource;
        var loaded = validateManifest(manifestInput, source, { external: true, localPackage: isLocalPackage });
        if (isLocalPackage) {
          if (!manifest.localEntrypointSource.trim() || manifest.localEntrypointSource.length > MAX_LOCAL_ENTRYPOINT_CHARS) return null;
          loaded.localEntrypointSource = manifest.localEntrypointSource;
        }
        return builtInIds.indexOf(loaded.id) === -1 ? loaded : null;
      } catch (error) {
        console.error('[skillSystem]', error);
        return null;
      }
    }).filter(Boolean) : [];
    manifests = builtIns.concat(restored.filter(function (manifest, index, list) {
      return list.findIndex(function (item) { return item.id === manifest.id; }) === index;
    }));
    manifests.forEach(ensureState);
    writeCustomManifests();
    writeStates();
    return Promise.all(manifests.map(function (manifest) {
      return loadEntrypoint(manifest).catch(function (error) { console.error('[skillSystem]', error); });
    })).then(getSkills);
  }).catch(function (error) {
    console.error('[skillSystem]', error);
    return [];
  });

  if (typeof window.addEventListener === 'function') {
    window.addEventListener('storage', function (event) {
      if (event && event.key !== STATE_KEY) return;
      syncStatesFromStorage();
      dispatchChange();
    });
  }

  window.CodexIdeSkillSystem = {
    ready: ready,
    getSkills: getSkills,
    getSkill: getSkill,
    setInstalled: setInstalled,
    uninstall: uninstall,
    installManifest: installManifest,
    installFromUrl: installFromUrl,
    installLocalPackage: installLocalPackage,
    installFromFiles: installFromFiles,
    setEnabled: setEnabled,
    setPermission: setPermission,
    setProfiles: setProfiles,
    setConfig: setConfig,
    getConfig: getConfig,
    getConfigForRun: getConfigForRun,
    canRun: canRun,
    canRunRequest: canRunRequest,
    canRunWithPermissions: canRunWithPermissions,
    recordRun: recordRun,
    loadEntrypoint: loadEntrypoint,
    registerRuntime: registerRuntime,
    hasRuntime: hasRuntime,
    validateRequest: validateRequest,
    getAgentDefinitions: getAgentDefinitions,
    runSkill: runSkill
  };
})();

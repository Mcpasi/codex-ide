(function (root, factory) {
  'use strict';

  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root && root.CodexIdeSkillSystem && typeof root.CodexIdeSkillSystem.registerRuntime === 'function') {
    root.CodexIdeSkillSystem.registerRuntime('github.repo-import', api.createRuntime(root));
  }
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  var SKILL_ID = 'github.repo-import';
  var API_ORIGIN = 'https://api.github.com';
  var RAW_ORIGIN = 'https://raw.githubusercontent.com';
  var API_VERSION = '2026-03-10';
  var SUPPORTED_EXTENSIONS = ['.md', '.js', '.css', '.html', '.py'];
  var MAX_TREE_ENTRIES = 100000;
  var MAX_FILES = 300;
  var MAX_FILE_BYTES = 360000;
  var MAX_TOTAL_BYTES = 12 * 1024 * 1024;
  var MAX_TOTAL_CHARS = MAX_TOTAL_BYTES;
  var DOWNLOAD_CONCURRENCY = 6;

  var MESSAGES = {
    de: {
      permission: 'Die erforderlichen Netzwerk- und Modell-Home-Rechte sind nicht freigegeben.',
      dependency: 'Der Standard-Skill workspace.extended-files muss im aktiven Backend-Profil aktiviert und für writeCode freigegeben sein.',
      helpers: 'Die Model-Home-Dateifunktionen der IDE sind nicht verfügbar.',
      repository: 'Das Repository muss als owner/repository oder als normale https://github.com/owner/repository-URL angegeben werden.',
      operation: 'Die Aktion muss import oder update sein.',
      token: 'Das konfigurierte GitHub-Token ist ungültig.',
      privateToken: 'Für dieses private Repository ist ein GitHub-Token mit Leserecht auf Repository-Inhalte erforderlich.',
      githubStatus: 'GitHub konnte nicht gelesen werden (HTTP {value}).',
      rateLimit: 'Das GitHub-API-Limit ist erreicht. Hinterlege optional ein GitHub-Token und versuche es später erneut.',
      githubData: 'GitHub hat eine unvollständige oder ungültige Repository-Antwort geliefert.',
      truncated: 'Der Repository-Baum ist für einen sicheren Import zu groß oder wurde von GitHub gekürzt.',
      tooMany: 'Das Repository enthält mehr als {value} unterstützte Dateien. Der Import wurde vor dem Schreiben abgebrochen.',
      tooLarge: 'Die unterstützten Repository-Dateien überschreiten zusammen das Importlimit von 12 MiB.',
      noFiles: 'Das Repository enthält keine importierbaren, nichtleeren UTF-8-Dateien der Typen .md, .js, .css, .html oder .py.',
      targetExists: 'Der Zielordner {value} existiert bereits. Verwende update nur bei ausdrücklichem Aktualisierungswunsch.',
      directory: 'Die IDE hat die Erstellung des Zielordners nicht bestätigt.',
      fileStatus: 'Eine Repository-Datei konnte nicht von GitHub geladen werden (HTTP {value}).',
      partial: 'Der Schreibvorgang ist nach {value} Dateien fehlgeschlagen. Der Zielordner kann unvollständig sein.',
      aborted: 'Der Repository-Import wurde abgebrochen.',
      titleImport: 'GitHub-Workspace-Import abgeschlossen.',
      titleUpdate: 'GitHub-Workspace-Aktualisierung abgeschlossen.',
      imported: 'Importierte Dateien',
      skipped: 'Ausgelassene Repository-Einträge',
      supported: 'Unterstützte Dateitypen',
      warning: 'Hinweis: Dies ist ein bearbeitbarer Snapshot und kein vollständiger Git-Clone. Git-Metadaten, nicht unterstützte Dateitypen, Binärdateien und zu große Dateien werden nicht importiert.',
      updateWarning: 'Der Update-Modus überschreibt passende unterstützte Dateien, löscht aber keine lokal verbliebenen Dateien.',
      skipUnsupported: 'nicht unterstützter Dateityp',
      skipUnsafe: 'geschützter oder ungültiger Pfad',
      skipLink: 'Symlink',
      skipSubmodule: 'Submodul',
      skipEmpty: 'leere Datei',
      skipOversized: 'zu große Datei',
      skipBinary: 'keine gültige UTF-8-Textdatei'
    },
    en: {
      permission: 'The required network and model-home permissions have not been granted.',
      dependency: 'The built-in workspace.extended-files skill must be enabled in the active backend profile and granted writeCode.',
      helpers: 'The IDE model-home file functions are unavailable.',
      repository: 'The repository must be owner/repository or a regular https://github.com/owner/repository URL.',
      operation: 'The operation must be import or update.',
      token: 'The configured GitHub token is invalid.',
      privateToken: 'This private repository requires a GitHub token with read access to repository contents.',
      githubStatus: 'GitHub could not be read (HTTP {value}).',
      rateLimit: 'The GitHub API limit has been reached. Optionally configure a GitHub token and try again later.',
      githubData: 'GitHub returned an incomplete or invalid repository response.',
      truncated: 'The repository tree is too large for a safe import or was truncated by GitHub.',
      tooMany: 'The repository contains more than {value} supported files. The import stopped before writing.',
      tooLarge: 'The supported repository files exceed the combined 12 MiB import limit.',
      noFiles: 'The repository contains no importable, non-empty UTF-8 files of type .md, .js, .css, .html, or .py.',
      targetExists: 'The target folder {value} already exists. Use update only for an explicit update request.',
      directory: 'The IDE did not confirm creation of the target folder.',
      fileStatus: 'A repository file could not be loaded from GitHub (HTTP {value}).',
      partial: 'Writing failed after {value} files. The target folder may be incomplete.',
      aborted: 'The repository import was aborted.',
      titleImport: 'GitHub workspace import completed.',
      titleUpdate: 'GitHub workspace update completed.',
      imported: 'Imported files',
      skipped: 'Skipped repository entries',
      supported: 'Supported file types',
      warning: 'Note: This is an editable snapshot, not a complete Git clone. Git metadata, unsupported file types, binary files, and oversized files are not imported.',
      updateWarning: 'Update mode overwrites matching supported files but does not delete locally remaining files.',
      skipUnsupported: 'unsupported file type',
      skipUnsafe: 'protected or invalid path',
      skipLink: 'symlink',
      skipSubmodule: 'submodule',
      skipEmpty: 'empty file',
      skipOversized: 'oversized file',
      skipBinary: 'not valid UTF-8 text'
    },
    fr: {
      permission: 'Les autorisations réseau et d’écriture dans le dossier modèle ne sont pas accordées.',
      dependency: 'Le skill standard workspace.extended-files doit être activé dans le profil backend actif avec l’autorisation writeCode.',
      helpers: 'Les fonctions de fichiers du dossier modèle de l’IDE ne sont pas disponibles.',
      repository: 'Le dépôt doit être indiqué sous la forme propriétaire/dépôt ou avec une URL https://github.com/propriétaire/dépôt standard.',
      operation: 'L’action doit être import ou update.',
      token: 'Le jeton GitHub configuré est invalide.',
      privateToken: 'Ce dépôt privé nécessite un jeton GitHub avec accès en lecture au contenu.',
      githubStatus: 'GitHub n’a pas pu être lu (HTTP {value}).',
      rateLimit: 'La limite de l’API GitHub est atteinte. Configurez éventuellement un jeton GitHub et réessayez plus tard.',
      githubData: 'GitHub a renvoyé une réponse de dépôt incomplète ou invalide.',
      truncated: 'L’arborescence du dépôt est trop grande pour un import sûr ou a été tronquée par GitHub.',
      tooMany: 'Le dépôt contient plus de {value} fichiers pris en charge. L’import a été arrêté avant toute écriture.',
      tooLarge: 'Les fichiers pris en charge dépassent ensemble la limite d’import de 12 Mio.',
      noFiles: 'Le dépôt ne contient aucun fichier UTF-8 non vide et importable de type .md, .js, .css, .html ou .py.',
      targetExists: 'Le dossier cible {value} existe déjà. Utilisez update uniquement pour une demande explicite de mise à jour.',
      directory: 'L’IDE n’a pas confirmé la création du dossier cible.',
      fileStatus: 'Un fichier du dépôt n’a pas pu être chargé depuis GitHub (HTTP {value}).',
      partial: 'L’écriture a échoué après {value} fichiers. Le dossier cible peut être incomplet.',
      aborted: 'L’import du dépôt a été annulé.',
      titleImport: 'Import de l’espace de travail GitHub terminé.',
      titleUpdate: 'Mise à jour de l’espace de travail GitHub terminée.',
      imported: 'Fichiers importés',
      skipped: 'Entrées du dépôt ignorées',
      supported: 'Types de fichiers pris en charge',
      warning: 'Remarque : il s’agit d’un instantané modifiable, et non d’un clone Git complet. Les métadonnées Git, les types non pris en charge, les fichiers binaires et les fichiers trop volumineux ne sont pas importés.',
      updateWarning: 'Le mode mise à jour remplace les fichiers pris en charge correspondants mais ne supprime pas les fichiers locaux restants.',
      skipUnsupported: 'type de fichier non pris en charge',
      skipUnsafe: 'chemin protégé ou invalide',
      skipLink: 'lien symbolique',
      skipSubmodule: 'sous-module',
      skipEmpty: 'fichier vide',
      skipOversized: 'fichier trop volumineux',
      skipBinary: 'texte UTF-8 invalide'
    }
  };

  function languageOf(value) {
    return value === 'en' || value === 'fr' ? value : 'de';
  }

  function message(language, key, value) {
    var text = (MESSAGES[languageOf(language)] || MESSAGES.de)[key] || MESSAGES.en[key] || key;
    return String(text).replace('{value}', String(value == null ? '' : value));
  }

  function fail(language, key, value) {
    throw new Error(message(language, key, value));
  }

  function abortError(language) {
    var error = new Error(message(language, 'aborted'));
    error.name = 'AbortError';
    return error;
  }

  function throwIfAborted(signal, language) {
    if (signal && signal.aborted) throw abortError(language);
  }

  function cleanRepositoryPart(value, kind) {
    var part = String(value || '');
    if (kind === 'repo') part = part.replace(/\.git$/i, '');
    if (!part || part.length > 100 || part === '.' || part === '..') return '';
    if (kind === 'owner') {
      if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(part)) return '';
    } else if (!/^[A-Za-z0-9._-]+$/.test(part)) {
      return '';
    }
    return part;
  }

  function parseRepository(value) {
    var input = String(value || '').trim().replace(/^['"`]+|['"`]+$/g, '');
    if (!input || input.length > 300 || /[\0-\x1f\x7f]/.test(input)) return null;
    if (/^git@github\.com:/i.test(input)) input = input.replace(/^git@github\.com:/i, '');
    if (/^https?:\/\//i.test(input)) {
      var parsed;
      try { parsed = new URL(input); } catch (_) { return null; }
      if (parsed.protocol !== 'https:' || !/^(?:www\.)?github\.com$/i.test(parsed.hostname) || parsed.search || parsed.hash) return null;
      input = parsed.pathname.replace(/^\/+|\/+$/g, '');
    } else {
      input = input.replace(/^(?:www\.)?github\.com\//i, '').replace(/^\/+|\/+$/g, '');
    }
    var parts = input.split('/');
    if (parts.length !== 2) return null;
    var owner = cleanRepositoryPart(parts[0], 'owner');
    var repo = cleanRepositoryPart(parts[1], 'repo');
    return owner && repo ? { owner: owner, repo: repo, fullName: owner + '/' + repo } : null;
  }

  function encodePath(value) {
    return String(value).split('/').map(function (part) { return encodeURIComponent(part); }).join('/');
  }

  function safeRepositoryPath(value, targetRoot) {
    var path = String(value || '').replace(/\\/g, '/');
    if (!path || path.length > 500 || targetRoot.length + path.length + 1 > 500 || /^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(path) || /[\0-\x1f\x7f]/.test(path)) return '';
    if (path.split('/').some(function (part) {
      var lower = part.toLowerCase();
      return !part || part === '.' || part === '..' || lower === '.git' || lower === 'node_modules' || /^\.env(?:\.|$)/i.test(part);
    })) return '';
    return path;
  }

  function extensionOf(path) {
    var name = String(path || '').toLowerCase();
    for (var i = 0; i < SUPPORTED_EXTENSIONS.length; i++) {
      if (name.endsWith(SUPPORTED_EXTENSIONS[i])) return SUPPORTED_EXTENSIONS[i];
    }
    return '';
  }

  function requestHeaders(token, accept) {
    var headers = {
      'Accept': accept || 'application/vnd.github+json',
      'X-GitHub-Api-Version': API_VERSION
    };
    if (token) headers.Authorization = 'Bearer ' + token;
    return headers;
  }

  async function checkedFetch(env, url, options, language, statusKey) {
    throwIfAborted(options && options.signal, language);
    var response = await env.fetch(url, options || {});
    if (!response.ok) {
      if (response.status === 403 && response.headers && response.headers.get('x-ratelimit-remaining') === '0') {
        fail(language, 'rateLimit');
      }
      fail(language, statusKey || 'githubStatus', response.status);
    }
    return response;
  }

  async function githubJson(env, path, token, signal, language) {
    var response = await checkedFetch(env, API_ORIGIN + path, {
      method: 'GET',
      headers: requestHeaders(token),
      signal: signal
    }, language, 'githubStatus');
    try { return await response.json(); } catch (_) { fail(language, 'githubData'); }
  }

  async function resolveCommitSha(env, repository, ref, token, signal, language) {
    var response = await checkedFetch(env,
      API_ORIGIN + '/repos/' + encodeURIComponent(repository.owner) + '/' + encodeURIComponent(repository.repo) + '/commits/' + encodeURIComponent(ref), {
        method: 'GET',
        headers: requestHeaders(token, 'application/vnd.github.sha'),
        signal: signal
      }, language, 'githubStatus');
    var sha = String(await response.text()).trim();
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(sha)) fail(language, 'githubData');
    return sha;
  }

  function newSkipStats() {
    return { unsupported: 0, unsafe: 0, links: 0, submodules: 0, empty: 0, oversized: 0, binary: 0 };
  }

  function increment(stats, reason) {
    if (Object.prototype.hasOwnProperty.call(stats, reason)) stats[reason] += 1;
  }

  function prepareCandidates(tree, targetRoot, stats, language) {
    if (!tree || !Array.isArray(tree.tree)) fail(language, 'githubData');
    if (tree.truncated === true || tree.tree.length > MAX_TREE_ENTRIES) fail(language, 'truncated');
    var candidates = [];
    var declaredBytes = 0;
    tree.tree.forEach(function (entry) {
      if (!entry || typeof entry !== 'object') return;
      if (entry.mode === '160000' || entry.type === 'commit') {
        increment(stats, 'submodules');
        return;
      }
      if (entry.type !== 'blob') return;
      if (entry.mode === '120000') {
        increment(stats, 'links');
        return;
      }
      var path = safeRepositoryPath(entry.path, targetRoot);
      if (!path) {
        increment(stats, 'unsafe');
        return;
      }
      if (!extensionOf(path)) {
        increment(stats, 'unsupported');
        return;
      }
      var size = Number(entry.size);
      if (!Number.isInteger(size) || size < 0) {
        increment(stats, 'oversized');
        return;
      }
      if (size === 0) {
        increment(stats, 'empty');
        return;
      }
      if (size > MAX_FILE_BYTES) {
        increment(stats, 'oversized');
        return;
      }
      if (typeof entry.sha !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(entry.sha)) {
        increment(stats, 'unsafe');
        return;
      }
      declaredBytes += size;
      candidates.push({ path: path, sha: entry.sha, size: size });
    });
    if (candidates.length > MAX_FILES) fail(language, 'tooMany', MAX_FILES);
    if (declaredBytes > MAX_TOTAL_BYTES) fail(language, 'tooLarge');
    return candidates;
  }

  async function responseBytes(response, maximum) {
    var stated = response.headers ? Number(response.headers.get('content-length')) : NaN;
    if (Number.isFinite(stated) && stated > maximum) return null;
    var buffer = await response.arrayBuffer();
    return buffer.byteLength <= maximum ? new Uint8Array(buffer) : null;
  }

  async function loadCandidate(env, repository, commitSha, candidate, isPrivate, token, signal, language) {
    var url;
    var headers;
    if (isPrivate) {
      url = API_ORIGIN + '/repos/' + encodeURIComponent(repository.owner) + '/' + encodeURIComponent(repository.repo) + '/git/blobs/' + encodeURIComponent(candidate.sha);
      headers = requestHeaders(token, 'application/vnd.github.raw+json');
    } else {
      url = RAW_ORIGIN + '/' + encodeURIComponent(repository.owner) + '/' + encodeURIComponent(repository.repo) + '/' + encodeURIComponent(commitSha) + '/' + encodePath(candidate.path);
      headers = { 'Accept': 'text/plain, application/octet-stream;q=0.9' };
    }
    var response = await checkedFetch(env, url, { method: 'GET', headers: headers, signal: signal }, language, 'fileStatus');
    var bytes = await responseBytes(response, MAX_FILE_BYTES);
    if (!bytes || !bytes.length) return { reason: bytes && !bytes.length ? 'empty' : 'oversized' };
    var decoder = new env.TextDecoder('utf-8', { fatal: true });
    var content;
    try { content = decoder.decode(bytes); } catch (_) { return { reason: 'binary' }; }
    if (!content || content.indexOf('\0') !== -1) return { reason: content ? 'binary' : 'empty' };
    return { file: { path: candidate.path, content: content, bytes: bytes.length } };
  }

  async function mapConcurrent(items, concurrency, worker) {
    var results = new Array(items.length);
    var cursor = 0;
    async function runWorker() {
      while (cursor < items.length) {
        var index = cursor++;
        results[index] = await worker(items[index], index);
      }
    }
    var workers = [];
    for (var i = 0; i < Math.min(concurrency, items.length); i++) workers.push(runWorker());
    await Promise.all(workers);
    return results;
  }

  function countSkipped(stats) {
    return Object.keys(stats).reduce(function (sum, key) { return sum + stats[key]; }, 0);
  }

  function skipSummary(stats, language) {
    var labels = {
      unsupported: 'skipUnsupported',
      unsafe: 'skipUnsafe',
      links: 'skipLink',
      submodules: 'skipSubmodule',
      empty: 'skipEmpty',
      oversized: 'skipOversized',
      binary: 'skipBinary'
    };
    return Object.keys(labels).filter(function (key) { return stats[key] > 0; }).map(function (key) {
      return message(language, labels[key]) + ': ' + stats[key];
    }).join(', ');
  }

  function formatResult(language, operation, repository, commitSha, targetRoot, importedCount, stats) {
    var skippedCount = countSkipped(stats);
    var lines = [
      message(language, operation === 'update' ? 'titleUpdate' : 'titleImport'),
      'Repository: ' + repository.fullName,
      'Commit: ' + commitSha,
      'Ziel/Target: ' + targetRoot,
      message(language, 'imported') + ': ' + importedCount,
      message(language, 'supported') + ': ' + SUPPORTED_EXTENSIONS.join(', '),
      message(language, 'skipped') + ': ' + skippedCount + (skippedCount ? ' (' + skipSummary(stats, language) + ')' : ''),
      message(language, 'warning')
    ];
    if (operation === 'update') lines.push(message(language, 'updateWarning'));
    return lines.join('\n');
  }

  function createRuntime(environment) {
    var env = environment || {};
    if (typeof env.fetch !== 'function' && typeof fetch === 'function') env.fetch = fetch.bind(typeof globalThis !== 'undefined' ? globalThis : null);
    if (typeof env.TextDecoder !== 'function' && typeof TextDecoder === 'function') env.TextDecoder = TextDecoder;
    return {
      async run(request, context) {
        var ctx = context || {};
        var language = languageOf(ctx.language);
        var signal = ctx.signal;
        throwIfAborted(signal, language);
        if (!ctx.permissions || ctx.permissions.network !== true || ctx.permissions.writeWorkspace !== true) fail(language, 'permission');
        if (!env.CodexIdeSkillSystem || typeof env.CodexIdeSkillSystem.canRunWithPermissions !== 'function' ||
            !env.CodexIdeSkillSystem.canRunWithPermissions('workspace.extended-files', ctx.profile, 'writeCode')) {
          fail(language, 'dependency');
        }
        if (!env.codexIdeProfile || typeof env.codexIdeProfile.createModelHomeWorkspaceDirectory !== 'function' ||
            typeof env.codexIdeProfile.writeModelHomeWorkspaceFile !== 'function' || typeof env.fetch !== 'function' ||
            typeof env.TextDecoder !== 'function') {
          fail(language, 'helpers');
        }

        var repository = parseRepository(request && request.repository);
        if (!repository) fail(language, 'repository');
        var operation = request && request.operation;
        if (operation !== 'import' && operation !== 'update') fail(language, 'operation');
        var token = ctx.permissions.githubToken === true && ctx.config ? String(ctx.config.githubToken || '').trim() : '';
        if (token && (token.length > 10000 || /[\r\n]/.test(token))) fail(language, 'token');

        var metadata = await githubJson(env,
          '/repos/' + encodeURIComponent(repository.owner) + '/' + encodeURIComponent(repository.repo),
          token, signal, language);
        var canonical = parseRepository(metadata && metadata.full_name);
        var defaultBranch = typeof metadata.default_branch === 'string' ? metadata.default_branch.trim() : '';
        if (!canonical || !defaultBranch || defaultBranch.length > 200 || /[\0-\x1f\x7f]/.test(defaultBranch) ||
            typeof metadata.private !== 'boolean') {
          fail(language, 'githubData');
        }
        repository = canonical;
        var isPrivate = metadata.private === true;
        if (isPrivate && !token) fail(language, 'privateToken');
        var targetRoot = 'Repos/' + repository.owner + '--' + repository.repo;
        var commitSha = await resolveCommitSha(env, repository, defaultBranch, token, signal, language);
        var tree = await githubJson(env,
          '/repos/' + encodeURIComponent(repository.owner) + '/' + encodeURIComponent(repository.repo) + '/git/trees/' + encodeURIComponent(commitSha) + '?recursive=1',
          token, signal, language);
        var stats = newSkipStats();
        var candidates = prepareCandidates(tree, targetRoot, stats, language);
        if (!candidates.length) fail(language, 'noFiles');

        var downloads = await mapConcurrent(candidates, DOWNLOAD_CONCURRENCY, function (candidate) {
          throwIfAborted(signal, language);
          return loadCandidate(env, repository, commitSha, candidate, isPrivate, token, signal, language);
        });
        var files = [];
        var totalChars = 0;
        downloads.forEach(function (download) {
          if (download.file) {
            totalChars += download.file.content.length;
            files.push(download.file);
          } else {
            increment(stats, download.reason);
          }
        });
        if (totalChars > MAX_TOTAL_CHARS) fail(language, 'tooLarge');
        if (!files.length) fail(language, 'noFiles');
        throwIfAborted(signal, language);

        var directoryResult = await env.codexIdeProfile.createModelHomeWorkspaceDirectory(targetRoot, { signal: signal });
        var directory = directoryResult && directoryResult.directory ? directoryResult.directory : directoryResult;
        if (!directory || typeof directory.created !== 'boolean') fail(language, 'directory');
        if (operation === 'import' && directory.created !== true) fail(language, 'targetExists', targetRoot);

        var written = 0;
        try {
          for (var i = 0; i < files.length; i++) {
            throwIfAborted(signal, language);
            await env.codexIdeProfile.writeModelHomeWorkspaceFile(targetRoot + '/' + files[i].path, files[i].content, {
              overwrite: operation === 'update',
              signal: signal
            });
            written += 1;
          }
        } catch (error) {
          if (error && error.name === 'AbortError') throw error;
          if (written > 0) fail(language, 'partial', written);
          throw error;
        }

        return {
          context: formatResult(language, operation, repository, commitSha, targetRoot, written, stats),
          detail: {
            operation: operation,
            repository: repository.fullName,
            commit: commitSha,
            path: targetRoot,
            importedCount: written,
            skippedCount: countSkipped(stats),
            completeClone: false
          }
        };
      }
    };
  }

  return {
    id: SKILL_ID,
    createRuntime: createRuntime,
    parseRepository: parseRepository,
    safeRepositoryPath: safeRepositoryPath,
    prepareCandidates: prepareCandidates,
    limits: {
      maxFiles: MAX_FILES,
      maxFileBytes: MAX_FILE_BYTES,
      maxTotalBytes: MAX_TOTAL_BYTES,
      maxTotalChars: MAX_TOTAL_CHARS
    }
  };
});

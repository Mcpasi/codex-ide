(function () {
  'use strict';

  var SEARCH_LIMIT = 5;
  var MAX_SNIPPET_LENGTH = 420;
  var GOOGLE_SEARCH_ENDPOINT = 'https://www.googleapis.com/customsearch/v1';

  function normalizeText(value) {
    return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  }

  function stripTags(value) {
    return normalizeText(String(value == null ? '' : value)
      .replace(/<[^>]*>/g, ' ')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>'));
  }

  function limitText(value, maxLength) {
    var text = normalizeText(value);
    if (text.length <= maxLength) return text;
    return text.slice(0, maxLength - 1).trim() + '...';
  }

  function extractQuery(text) {
    var input = normalizeText(text);
    if (!input) return '';

    var quoted = input.match(/["“„']([^"“”„']{3,})["”']/);
    if (quoted && quoted[1]) return normalizeText(quoted[1]);

    var query = input
      .replace(/\b(suche|such|recherchiere|recherche|finde|google|googel)\b/ig, ' ')
      .replace(/\b(search|look up|research|find)\b/ig, ' ')
      .replace(/\b(fuer|für|mir|mich|bitte|mal|kurz|im|in|aus|dem|der|das|den)\b/ig, ' ')
      .replace(/\b(internet|web|netz|online)\b/ig, ' ')
      .replace(/\b(und|then|and|please)\b/ig, ' ')
      .replace(/\b(fasse|zusammen|zusammenfassen|summary|summarize)\b/ig, ' ');

    query = normalizeText(query.replace(/[?:!.]+$/g, ''));
    return query || input;
  }

  function normalizeProvider(value) {
    var provider = normalizeText(value).toLowerCase();
    if (provider === 'google' || provider === 'fallback') return provider;
    return 'auto';
  }

  function getSearchConfig(options) {
    var opts = options || {};
    var cfg = opts.config && typeof opts.config === 'object' ? opts.config : {};
    return {
      enabled: opts.enabled === false || cfg.enabled === false ? false : true,
      provider: normalizeProvider(opts.provider || cfg.provider || cfg.searchProvider),
      googleApiKey: normalizeText(opts.googleApiKey || opts.googleKey || cfg.googleApiKey || cfg.googleKey),
      googleCx: normalizeText(opts.googleCx || opts.googleSearchEngineId || cfg.googleCx || cfg.googleSearchEngineId)
    };
  }

  function sourceKey(item) {
    return normalizeText(item && item.url ? item.url : item && item.title).toLowerCase();
  }

  function addResult(results, item) {
    var title = limitText(item && item.title, 120);
    var snippet = limitText(item && item.snippet, MAX_SNIPPET_LENGTH);
    var url = normalizeText(item && item.url);
    if (!title || !snippet) return;

    var candidate = {
      title: title,
      snippet: snippet,
      url: /^https?:\/\//i.test(url) ? url : '',
      source: normalizeText(item && item.source) || 'web'
    };

    var key = sourceKey(candidate);
    for (var i = 0; i < results.length; i++) {
      if (sourceKey(results[i]) === key) return;
    }
    results.push(candidate);
  }

  function flattenDuckTopics(topics, out) {
    if (!Array.isArray(topics)) return;
    for (var i = 0; i < topics.length; i++) {
      var item = topics[i];
      if (!item) continue;
      if (Array.isArray(item.Topics)) {
        flattenDuckTopics(item.Topics, out);
      } else if (item.Text) {
        addResult(out, {
          title: item.FirstURL ? item.FirstURL.replace(/^https?:\/\/[^/]+\//, '').replace(/_/g, ' ') : 'DuckDuckGo',
          snippet: item.Text,
          url: item.FirstURL || '',
          source: 'DuckDuckGo'
        });
      }
      if (out.length >= SEARCH_LIMIT) return;
    }
  }

  async function searchDuckDuckGo(query, limit) {
    var url = 'https://api.duckduckgo.com/?q=' + encodeURIComponent(query) +
      '&format=json&no_redirect=1&no_html=1&skip_disambig=1';
    var resp = await fetch(url, { method: 'GET' });
    if (!resp || !resp.ok) return [];

    var data = await resp.json();
    var results = [];
    if (data && data.AbstractText) {
      addResult(results, {
        title: data.Heading || query,
        snippet: data.AbstractText,
        url: data.AbstractURL || data.AbstractSource || '',
        source: data.AbstractSource || 'DuckDuckGo'
      });
    }

    if (data && Array.isArray(data.Results)) {
      for (var i = 0; i < data.Results.length && results.length < limit; i++) {
        addResult(results, {
          title: data.Results[i].Text || data.Results[i].FirstURL || query,
          snippet: data.Results[i].Text || '',
          url: data.Results[i].FirstURL || '',
          source: 'DuckDuckGo'
        });
      }
    }

    if (data && Array.isArray(data.RelatedTopics) && results.length < limit) {
      flattenDuckTopics(data.RelatedTopics, results);
    }
    return results.slice(0, limit);
  }

  async function searchGoogleProgrammable(query, limit, language, config) {
    var cfg = config || {};
    if (!cfg.googleApiKey || !cfg.googleCx) return [];

    var lang = /^[a-z]{2}$/i.test(language || '') ? String(language).toLowerCase() : '';
    var url = GOOGLE_SEARCH_ENDPOINT +
      '?key=' + encodeURIComponent(cfg.googleApiKey) +
      '&cx=' + encodeURIComponent(cfg.googleCx) +
      '&q=' + encodeURIComponent(query) +
      '&num=' + encodeURIComponent(String(Math.max(1, Math.min(limit, 10)))) +
      '&safe=active';
    if (lang) {
      url += '&hl=' + encodeURIComponent(lang) +
        '&lr=' + encodeURIComponent('lang_' + lang);
    }

    var resp = await fetch(url, { method: 'GET' });
    if (!resp || !resp.ok) return [];

    var data = await resp.json();
    var rows = data && Array.isArray(data.items) ? data.items : [];
    var out = [];
    for (var i = 0; i < rows.length && out.length < limit; i++) {
      var row = rows[i] || {};
      addResult(out, {
        title: row.title || query,
        snippet: row.snippet || row.htmlSnippet || '',
        url: row.link || '',
        source: row.displayLink || 'Google'
      });
    }
    return out;
  }

  async function searchWikipedia(query, limit, language) {
    var lang = /^[a-z]{2}$/i.test(language || '') ? String(language).toLowerCase() : 'de';
    var url = 'https://' + lang + '.wikipedia.org/w/api.php?action=query&list=search&format=json&origin=*&srlimit=' +
      encodeURIComponent(String(limit)) + '&srsearch=' + encodeURIComponent(query);
    var resp = await fetch(url, { method: 'GET' });
    if (!resp || !resp.ok) return [];

    var data = await resp.json();
    var rows = data && data.query && Array.isArray(data.query.search) ? data.query.search : [];
    var out = [];
    for (var i = 0; i < rows.length && out.length < limit; i++) {
      var row = rows[i] || {};
      addResult(out, {
        title: row.title || query,
        snippet: stripTags(row.snippet || ''),
        url: row.pageid ? ('https://' + lang + '.wikipedia.org/?curid=' + row.pageid) : '',
        source: 'Wikipedia'
      });
    }
    return out;
  }

  async function search(queryOrText, options) {
    if (typeof fetch !== 'function') throw new Error('Fetch API nicht verfügbar');
    var opts = options || {};
    var query = opts.rawQuery ? normalizeText(queryOrText) : extractQuery(queryOrText);
    if (!query) throw new Error('Keine Suchanfrage vorhanden');

    var limit = Math.max(1, Math.min(parseInt(opts.limit || SEARCH_LIMIT, 10) || SEARCH_LIMIT, 8));
    var config = getSearchConfig(opts);
    var results = [];
    if (!config.enabled) {
      return {
        query: query,
        results: []
      };
    }

    if (config.provider !== 'fallback') {
      try {
        var googleResults = await searchGoogleProgrammable(query, limit, opts.language || 'de', config);
        for (var g = 0; g < googleResults.length && results.length < limit; g++) {
          addResult(results, googleResults[g]);
        }
      } catch (_) {
        results = [];
      }
    }

    try {
      if (results.length < limit) {
        var duckResults = await searchDuckDuckGo(query, limit - results.length);
        for (var d = 0; d < duckResults.length && results.length < limit; d++) {
          addResult(results, duckResults[d]);
        }
      }
    } catch (_) {
      /* keep existing results */
    }

    if (results.length < Math.min(3, limit)) {
      try {
        var wikiResults = await searchWikipedia(query, limit - results.length, opts.language || 'de');
        for (var i = 0; i < wikiResults.length && results.length < limit; i++) {
          addResult(results, wikiResults[i]);
        }
      } catch (_) { /* keep existing results */ }
    }

    return {
      query: query,
      results: results.slice(0, limit)
    };
  }

  function formatForPrompt(research) {
    var data = research || {};
    var results = Array.isArray(data.results) ? data.results : [];
    var lines = ['Internet-Recherche zu: ' + normalizeText(data.query)];
    if (!results.length) {
      lines.push('Keine verwertbaren Web-Suchergebnisse gefunden.');
      return lines.join('\n');
    }
    for (var i = 0; i < results.length; i++) {
      var item = results[i];
      var line = '[' + (i + 1) + '] ' + item.title + ' - ' + item.snippet;
      if (item.url) line += ' Quelle: ' + item.url;
      lines.push(line);
    }
    return lines.join('\n');
  }

  var api = {
    extractQuery: extractQuery,
    search: search,
    formatForPrompt: formatForPrompt
  };

  if (typeof window !== 'undefined') window.CodexIdeInternetSkill = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();

(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CodexIdeAgentResponse = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  var THOUGHT_TAG = 'codex_ide_thought';
  var FINAL_TAG = 'codex_ide_final';
  var INTERNAL_REFERENCE = '[interner Dateiverweis ausgeblendet]';

  function escapeRegex(value) {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function sanitize(text, protectedPaths) {
    var value = String(text == null ? '' : text);
    var paths = Array.isArray(protectedPaths) ? protectedPaths : [];
    for (var i = 0; i < paths.length; i++) {
      var path = String(paths[i] || '').trim();
      if (!path) continue;
      value = value.replace(new RegExp(escapeRegex(path), 'gi'), INTERNAL_REFERENCE);
    }
    value = value
      .replace(/(?:[a-z]:[\\/]|\/)?(?:[^\s"'<>]+[\\/])*model-home(?:[\\/][^\s"'<>]*)?/gi, INTERNAL_REFERENCE)
      .replace(/\bmemory\.md\b/gi, INTERNAL_REFERENCE)
      .replace(/\b(?:Codex IDE Modell-Home-Kontext|Persistenter Codex-IDE-Nutzerkontext|Inhalt von memory\.md)\s*:?/gi, INTERNAL_REFERENCE);
    return value.replace(/(?:\[interner Dateiverweis ausgeblendet\]\s*){2,}/g, INTERNAL_REFERENCE + ' ').trim();
  }

  function compactWorkNote(text, maxChars) {
    var limit = Number.isFinite(Number(maxChars)) ? Math.max(120, Math.min(Number(maxChars), 2000)) : 800;
    var value = String(text == null ? '' : text)
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map(function (line) {
        return line
          .replace(/^\s*```[^`]*$/, '')
          .replace(/^\s*#{1,6}\s+/, '')
          .replace(/^\s*>\s?/, '')
          .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')
          .trim();
      })
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (value.length <= limit) return value;
    var shortened = value.slice(0, limit - 1);
    var boundary = shortened.lastIndexOf(' ');
    if (boundary >= Math.floor(limit * 0.65)) shortened = shortened.slice(0, boundary);
    return shortened.trimEnd() + '…';
  }

  function taggedValue(text, tag) {
    var match = String(text || '').match(new RegExp('<' + tag + '>([\\s\\S]*?)<\\/' + tag + '>', 'i'));
    return match ? match[1].trim() : null;
  }

  function stripIncompleteTag(text) {
    var value = String(text || '');
    var partial = value.match(/<[^>]*$/);
    // Ordinary comparisons, generics and HTML are answer content. Only hold
    // back a suffix that could still become an internal control tag.
    if (!partial || !startsWithControlMarkup(partial[0])) return value;
    return value.slice(0, partial.index);
  }

  function startsWithControlMarkup(text) {
    var value = String(text || '').trimStart().toLowerCase().replace(/^<\//, '<');
    if (!value || value.charAt(0) !== '<') return false;
    var tags = [
      '<' + THOUGHT_TAG,
      '<' + FINAL_TAG,
      '<codex_ide_skill_request',
      '<codex_ide_editor_request',
      '<codex_ide_workspace_complete'
    ];
    for (var i = 0; i < tags.length; i++) {
      if (tags[i].indexOf(value) === 0 || value.indexOf(tags[i]) === 0) return true;
    }
    return false;
  }

  function parse(rawReply, options) {
    var opts = options || {};
    var raw = String(rawReply == null ? '' : rawReply).trim();
    var thought = taggedValue(raw, THOUGHT_TAG);
    var finalReply = taggedValue(raw, FINAL_TAG);
    if (finalReply === null) finalReply = raw;
    if (!thought) thought = String(opts.fallbackThought || '').trim();
    return {
      thought: sanitize(thought, opts.protectedPaths),
      reply: sanitize(finalReply, opts.protectedPaths),
      skills: Array.isArray(opts.skills)
        ? opts.skills.map(function (skill) { return String(skill || '').trim(); }).filter(Boolean)
        : []
    };
  }

  function parseLive(rawReply, options) {
    var opts = options || {};
    var raw = String(rawReply == null ? '' : rawReply);
    var thoughtOpen = raw.toLowerCase().indexOf('<' + THOUGHT_TAG + '>');
    var thoughtClose = raw.toLowerCase().indexOf('</' + THOUGHT_TAG + '>');
    var finalOpen = raw.toLowerCase().indexOf('<' + FINAL_TAG + '>');
    var finalClose = raw.toLowerCase().indexOf('</' + FINAL_TAG + '>');
    var thought = '';
    var finalReply = '';

    if (thoughtOpen !== -1) {
      var thoughtStart = thoughtOpen + THOUGHT_TAG.length + 2;
      thought = stripIncompleteTag(raw.slice(thoughtStart, thoughtClose === -1 ? raw.length : thoughtClose));
    }
    if (finalOpen !== -1) {
      var finalStart = finalOpen + FINAL_TAG.length + 2;
      finalReply = stripIncompleteTag(raw.slice(finalStart, finalClose === -1 ? raw.length : finalClose));
    } else if (thoughtOpen === -1 && !startsWithControlMarkup(raw)) {
      finalReply = raw;
    }

    return {
      thought: sanitize(thought || opts.fallbackThought || '', opts.protectedPaths),
      reply: sanitize(finalReply, opts.protectedPaths)
    };
  }

  return {
    THOUGHT_TAG: THOUGHT_TAG,
    FINAL_TAG: FINAL_TAG,
    INTERNAL_REFERENCE: INTERNAL_REFERENCE,
    parse: parse,
    parseLive: parseLive,
    sanitize: sanitize,
    compactWorkNote: compactWorkNote
  };
});

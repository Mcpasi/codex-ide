(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CodexIdeSyntaxHighlighter = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  var LANGUAGE_BY_EXTENSION = {
    js: 'javascript', css: 'css', html: 'html', py: 'python',
    json: 'json', md: 'markdown', txt: 'text'
  };
  var LANGUAGE_LABELS = {
    javascript: 'JavaScript', css: 'CSS', html: 'HTML', python: 'Python',
    json: 'JSON', markdown: 'Markdown', text: 'Text'
  };

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>]/g, function (char) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[char];
    });
  }

  function token(kind, value) {
    return '<span class="tok-' + kind + '">' + escapeHtml(value) + '</span>';
  }

  function languageForPath(value) {
    var normalized = String(value || '').trim().toLowerCase().replace(/\\/g, '/');
    if (LANGUAGE_LABELS[normalized]) return normalized;
    if (normalized === 'js') return 'javascript';
    if (normalized === 'py') return 'python';
    if (normalized === 'md') return 'markdown';
    if (normalized === 'txt' || normalized === 'plain') return 'text';
    var match = normalized.match(/\.([a-z0-9]+)$/);
    return match && LANGUAGE_BY_EXTENSION[match[1]] || 'text';
  }

  function highlightWithRules(value, rules) {
    var source = String(value == null ? '' : value);
    var compiledRules = rules.map(function (rule) {
      var flags = rule.pattern.flags.replace(/[gy]/g, '') + 'y';
      var patternSource = rule.pattern.source.replace(/^\^/, '');
      return { kind: rule.kind, pattern: new RegExp(patternSource, flags) };
    });
    var out = '';
    var index = 0;

    function matchAt(rule, position) {
      rule.pattern.lastIndex = position;
      return rule.pattern.exec(source);
    }

    while (index < source.length) {
      var matched = null;
      for (var ruleIndex = 0; ruleIndex < compiledRules.length; ruleIndex++) {
        var match = matchAt(compiledRules[ruleIndex], index);
        if (match && match[0]) {
          matched = { kind: compiledRules[ruleIndex].kind, value: match[0] };
          break;
        }
      }
      if (matched) {
        out += token(matched.kind, matched.value);
        index += matched.value.length;
        continue;
      }
      var plainStart = index;
      index += 1;
      while (index < source.length) {
        var startsToken = false;
        for (var nextRuleIndex = 0; nextRuleIndex < compiledRules.length; nextRuleIndex++) {
          if (matchAt(compiledRules[nextRuleIndex], index)) { startsToken = true; break; }
        }
        if (startsToken) break;
        index += 1;
      }
      out += escapeHtml(source.slice(plainStart, index));
    }
    return out;
  }

  function highlightJavaScript(value) {
    return highlightWithRules(value, [
      { kind: 'comment', pattern: /^\/\/[^\n]*/ },
      { kind: 'comment', pattern: /^\/\*[\s\S]*?(?:\*\/|$)/ },
      { kind: 'string', pattern: /^'(?:\\[\s\S]|[^'\\\n])*(?:'|$)/ },
      { kind: 'string', pattern: /^"(?:\\[\s\S]|[^"\\\n])*(?:"|$)/ },
      { kind: 'template', pattern: /^`(?:\\[\s\S]|[^`\\])*(?:`|$)/ },
      { kind: 'number', pattern: /^(?:0[xob][0-9a-f]+n?|\d+(?:\.\d+)?(?:e[+-]?\d+)?n?)(?![\w$])/i },
      { kind: 'keyword', pattern: /^(?:async|await|break|case|catch|class|const|continue|debugger|default|delete|do|else|export|extends|finally|for|from|function|get|if|import|in|instanceof|let|new|of|return|set|static|super|switch|throw|try|typeof|var|void|while|with|yield)\b/ },
      { kind: 'literal', pattern: /^(?:true|false|null|undefined|NaN|Infinity)\b/ },
      { kind: 'builtin', pattern: /^(?:Array|BigInt|Boolean|Date|Error|JSON|Map|Math|Number|Object|Promise|RegExp|Set|String|Symbol|WeakMap|WeakSet|console|document|globalThis|window)\b/ },
      { kind: 'function', pattern: /^[A-Za-z_$\u00A0-\uFFFF][\w$\u00A0-\uFFFF]*(?=\s*\()/ },
      { kind: 'identifier', pattern: /^[A-Za-z_$\u00A0-\uFFFF][\w$\u00A0-\uFFFF]*/ },
      { kind: 'operator', pattern: /^(?:===|!==|>>>|\*\*|=>|==|!=|<=|>=|&&|\|\||\?\?|\?\.|\+\+|--|\+=|-=|\*=|\/=|%=|&=|\|=|\^=|<<|>>|[+\-*\/%=&|^!<>?:~])/ },
      { kind: 'punctuation', pattern: /^[{}[\]();,.]/ }
    ]);
  }

  function highlightPython(value) {
    return highlightWithRules(value, [
      { kind: 'comment', pattern: /^#[^\n]*/ },
      { kind: 'string', pattern: /^(?:[rubf]{0,2})(?:'''[\s\S]*?(?:'''|$)|"""[\s\S]*?(?:"""|$))/i },
      { kind: 'string', pattern: /^(?:[rubf]{0,2})'(?:\\[\s\S]|[^'\\\n])*(?:'|$)/i },
      { kind: 'string', pattern: /^(?:[rubf]{0,2})"(?:\\[\s\S]|[^"\\\n])*(?:"|$)/i },
      { kind: 'decorator', pattern: /^@[A-Za-z_][\w.]*/ },
      { kind: 'number', pattern: /^(?:0[xob][0-9a-f_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:e[+-]?\d[\d_]*)?j?)\b/i },
      { kind: 'keyword', pattern: /^(?:and|as|assert|async|await|break|case|class|continue|def|del|elif|else|except|finally|for|from|global|if|import|in|is|lambda|match|nonlocal|not|or|pass|raise|return|try|while|with|yield)\b/ },
      { kind: 'literal', pattern: /^(?:True|False|None|NotImplemented|Ellipsis)\b/ },
      { kind: 'builtin', pattern: /^(?:abs|all|any|bool|bytes|dict|enumerate|filter|float|frozenset|int|len|list|map|max|min|object|open|print|range|reversed|set|sorted|str|sum|super|tuple|type|zip)\b/ },
      { kind: 'operator', pattern: /^(?:\*\*|\/\/|:=|==|!=|<=|>=|<<|>>|->|\+=|-=|\*=|\/=|%=|[+\-*\/%=&|^~<>:])/ },
      { kind: 'punctuation', pattern: /^[{}[\]();,.]/ }
    ]);
  }

  function highlightCss(value) {
    return highlightWithRules(value, [
      { kind: 'comment', pattern: /^\/\*[\s\S]*?(?:\*\/|$)/ },
      { kind: 'string', pattern: /^'(?:\\[\s\S]|[^'\\\n])*(?:'|$)/ },
      { kind: 'string', pattern: /^"(?:\\[\s\S]|[^"\\\n])*(?:"|$)/ },
      { kind: 'keyword', pattern: /^@[\w-]+/ },
      { kind: 'literal', pattern: /^!important\b/i },
      { kind: 'color', pattern: /^#[0-9a-f]{3,8}\b/i },
      { kind: 'variable', pattern: /^--[\w-]+/ },
      { kind: 'property', pattern: /^-?[a-z][\w-]*(?=\s*:)/i },
      { kind: 'selector', pattern: /^(?:#[A-Za-z_][\w-]*|\.[A-Za-z_][\w-]*|::?[A-Za-z_][\w-]*)/ },
      { kind: 'number', pattern: /^-?(?:\d*\.)?\d+(?:%|[a-z]+)?(?![\w-])/i },
      { kind: 'function', pattern: /^-?(?:[A-Za-z_]|[^\x00-\x7F])(?:[\w-]|[^\x00-\x7F])*(?=\()/ },
      { kind: 'value', pattern: /^-?(?:[A-Za-z_]|[^\x00-\x7F])(?:[\w-]|[^\x00-\x7F])*/ },
      { kind: 'operator', pattern: /^(?:~=|\|=|\^=|\$=|\*=|[>+~=:])/ },
      { kind: 'punctuation', pattern: /^[{}[\]();,]/ }
    ]);
  }

  function highlightJson(value) {
    return highlightWithRules(value, [
      { kind: 'property', pattern: /^"(?:\\[\s\S]|[^"\\])*(?:"|$)(?=\s*:)/ },
      { kind: 'string', pattern: /^"(?:\\[\s\S]|[^"\\])*(?:"|$)/ },
      { kind: 'number', pattern: /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:e[+-]?\d+)?\b/i },
      { kind: 'literal', pattern: /^(?:true|false|null)\b/ },
      { kind: 'punctuation', pattern: /^[{}[\],:]/ }
    ]);
  }

  function highlightHtmlText(value) {
    return highlightWithRules(value, [
      { kind: 'entity', pattern: /^&(?:#\d+|#x[0-9a-f]+|[a-z][\w-]*);/i }
    ]);
  }

  function highlightHtmlTag(value) {
    var source = String(value || '');
    var out = '';
    var index = 0;
    var nameSeen = false;
    while (index < source.length) {
      var rest = source.slice(index);
      var match;
      if ((match = rest.match(/^<\/?|^\/?>/))) {
        out += token('punctuation', match[0]); index += match[0].length; continue;
      }
      if ((match = rest.match(/^\s+/))) {
        out += match[0]; index += match[0].length; continue;
      }
      if ((match = rest.match(/^(?:"(?:\\.|[^"\\])*(?:"|$)|'(?:\\.|[^'\\])*(?:'|$))/))) {
        out += token('string', match[0]); index += match[0].length; continue;
      }
      if ((match = rest.match(/^[A-Za-z_:][\w:.-]*/))) {
        out += token(nameSeen ? 'attr' : 'tag', match[0]);
        nameSeen = true; index += match[0].length; continue;
      }
      if ((match = rest.match(/^=/))) {
        out += token('operator', match[0]); index += 1; continue;
      }
      out += escapeHtml(source.charAt(index)); index += 1;
    }
    return out;
  }

  function findHtmlTagEnd(source, start) {
    var quote = '';
    for (var index = start + 1; index < source.length; index++) {
      var char = source.charAt(index);
      if (quote) {
        if (char === quote && source.charAt(index - 1) !== '\\') quote = '';
        continue;
      }
      if (char === '"' || char === "'") { quote = char; continue; }
      if (char === '>') return index;
    }
    return -1;
  }

  function findHtmlRawTextEnd(source, tagName, start) {
    var pattern = new RegExp('</' + tagName + '\\s*>', 'ig');
    pattern.lastIndex = start;
    return pattern.exec(source);
  }

  function highlightHtml(value) {
    var source = String(value == null ? '' : value);
    var out = '';
    var index = 0;
    while (index < source.length) {
      var commentStart = source.indexOf('<!--', index);
      var tagStart = source.indexOf('<', index);
      var next = commentStart !== -1 && (tagStart === -1 || commentStart <= tagStart) ? commentStart : tagStart;
      if (next === -1) { out += highlightHtmlText(source.slice(index)); break; }
      out += highlightHtmlText(source.slice(index, next));
      if (next === commentStart) {
        var commentEnd = source.indexOf('-->', next + 4);
        var commentStop = commentEnd === -1 ? source.length : commentEnd + 3;
        out += token('comment', source.slice(next, commentStop));
        index = commentStop;
        continue;
      }
      var tagEnd = findHtmlTagEnd(source, next);
      if (tagEnd === -1) { out += escapeHtml(source.slice(next)); break; }
      var rawTag = source.slice(next, tagEnd + 1);
      out += /^<!doctype\b/i.test(rawTag) ? token('keyword', rawTag) : highlightHtmlTag(rawTag);
      index = tagEnd + 1;
      var rawTextTag = rawTag.match(/^<\s*(script|style)\b/i);
      if (rawTextTag && !/\/\s*>$/.test(rawTag)) {
        var tagName = rawTextTag[1].toLowerCase();
        var closingTag = findHtmlRawTextEnd(source, tagName, index);
        var contentEnd = closingTag ? closingTag.index : source.length;
        var embeddedSource = source.slice(index, contentEnd);
        out += tagName === 'style'
          ? highlightCss(embeddedSource)
          : highlightJavaScript(embeddedSource);
        if (!closingTag) break;
        out += highlightHtmlTag(closingTag[0]);
        index = closingTag.index + closingTag[0].length;
      }
    }
    return out;
  }

  function highlightMarkdownInline(value) {
    return highlightWithRules(value, [
      { kind: 'code', pattern: /^`+[^\n]*?`+/ },
      { kind: 'link', pattern: /^!?\[[^\]\n]*\]\([^\)\n]+\)/ },
      { kind: 'markup', pattern: /^(?:\*\*|__|~~)[^\n]+?(?:\*\*|__|~~)/ },
      { kind: 'markup', pattern: /^(?:\*|_)[^\n]+?(?:\*|_)/ },
      { kind: 'tag', pattern: /^<\/?[A-Za-z][^>\n]*>/ },
      { kind: 'escape', pattern: /^\\[\\`*{}[\]()#+.!_>-]/ }
    ]);
  }

  function highlightMarkdown(value) {
    var source = String(value == null ? '' : value);
    var lines = source.match(/[^\n]*\n|[^\n]+$/g) || [];
    var fenced = false;
    return lines.map(function (line) {
      var fence = line.match(/^(\s*)(```+|~~~+)([^\n]*)(\n?)$/);
      if (fence) {
        fenced = !fenced;
        return escapeHtml(fence[1]) + token('fence', fence[2]) + token('keyword', fence[3]) + fence[4];
      }
      if (fenced) return token('code', line.replace(/\n$/, '')) + (line.endsWith('\n') ? '\n' : '');
      var heading = line.match(/^(\s*)(#{1,6})(\s+)(.*?)(\n?)$/);
      if (heading) return escapeHtml(heading[1]) + token('heading', heading[2]) + heading[3] + highlightMarkdownInline(heading[4]) + heading[5];
      var quote = line.match(/^(\s*)(>+)(\s?)(.*?)(\n?)$/);
      if (quote) return escapeHtml(quote[1]) + token('markup', quote[2]) + quote[3] + highlightMarkdownInline(quote[4]) + quote[5];
      var list = line.match(/^(\s*)((?:[-+*]|\d+\.)\s+)(.*?)(\n?)$/);
      if (list) return escapeHtml(list[1]) + token('markup', list[2]) + highlightMarkdownInline(list[3]) + list[4];
      return highlightMarkdownInline(line);
    }).join('');
  }

  function highlightText(value) {
    return escapeHtml(value);
  }

  var HIGHLIGHTERS = {
    javascript: highlightJavaScript,
    css: highlightCss,
    html: highlightHtml,
    python: highlightPython,
    json: highlightJson,
    markdown: highlightMarkdown,
    text: highlightText
  };

  function highlight(value, pathOrLanguage) {
    var language = languageForPath(pathOrLanguage);
    return {
      language: language,
      label: LANGUAGE_LABELS[language],
      html: HIGHLIGHTERS[language](String(value == null ? '' : value))
    };
  }

  return {
    escapeHtml: escapeHtml,
    highlight: highlight,
    languageForPath: languageForPath,
    supportedLanguages: Object.keys(HIGHLIGHTERS)
  };
});

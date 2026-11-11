(function () {
  'use strict';

  var SKILL_ID = 'workspace.pdf';
  var MAX_TEXT_CHARS = 100000;
  var MAX_PDF_BYTES = 5 * 1024 * 1024;

  function bridgeBaseUrl() {
    var url = window.codexIdeProfile && typeof window.codexIdeProfile.getCodexConfig === 'function'
      ? window.codexIdeProfile.getCodexConfig().url
      : 'http://localhost:8787';
    return String(url || 'http://localhost:8787')
      .replace(/\/+$/, '')
      .replace(/\/v1\/chat\/completions$/i, '')
      .replace(/\/chat\/completions$/i, '')
      .replace(/\/v1$/i, '');
  }

  function normalizePath(value) {
    var clean = String(value || '').trim().replace(/\\/g, '/').replace(/^["'`]+|["'`]+$/g, '');
    if (!clean) throw new Error('PDF-Dateipfad fehlt');
    if (clean.length > 500 || /^(?:[a-z]+:|\/)/i.test(clean) || clean.split('/').indexOf('..') !== -1) {
      throw new Error('PDF-Pfad muss relativ innerhalb des Modell-Homes liegen');
    }
    if (!/\.pdf$/i.test(clean)) throw new Error('Der PDF-Skill erlaubt nur .pdf-Dateien');
    if (clean.split('/').some(function (part) {
      return part === '.git' || part === 'node_modules' || /^\.env(?:\.|$)/i.test(part);
    })) throw new Error('Geschuetzter Pfad darf nicht verwendet werden');
    return clean;
  }

  function bytesToBase64(bytes) {
    var parts = [];
    for (var offset = 0; offset < bytes.length; offset += 32768) {
      var end = Math.min(offset + 32768, bytes.length);
      var chunk = '';
      for (var i = offset; i < end; i++) chunk += String.fromCharCode(bytes[i]);
      parts.push(chunk);
    }
    return btoa(parts.join(''));
  }

  function base64ToBytes(value) {
    var binary = atob(String(value || ''));
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i) & 255;
    return bytes;
  }

  async function parseResponse(response, action) {
    var data = null;
    try { data = await response.json(); } catch (_) { /* handled below */ }
    if (!response.ok || !data || !data.ok || !data.file) {
      var detail = data && data.error && (data.error.message || data.error.code);
      throw new Error(action + ' fehlgeschlagen' + (detail ? ': ' + detail : ''));
    }
    return data.file;
  }

  async function readPdfBytes(path, signal) {
    var response = await fetch(bridgeBaseUrl() + '/codex-ide/pdf-files?path=' + encodeURIComponent(path), {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'X-Codex-IDE-Skill': SKILL_ID,
        'X-Codex-IDE-Permission': 'readPdf'
      },
      signal: signal
    });
    var file = await parseResponse(response, 'PDF-Lesen');
    var bytes = base64ToBytes(file.base64);
    if (!bytes.length || bytes.length > MAX_PDF_BYTES) throw new Error('Ungueltige PDF-Dateigroesse');
    return { file: file, bytes: bytes };
  }

  async function writePdfBytes(path, bytes, overwrite, signal) {
    var response = await fetch(bridgeBaseUrl() + '/codex-ide/pdf-files', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Codex-IDE-Skill': SKILL_ID,
        'X-Codex-IDE-Permission': 'writePdf'
      },
      body: JSON.stringify({ path: path, base64: bytesToBase64(bytes), overwrite: overwrite === true }),
      signal: signal
    });
    return parseResponse(response, 'PDF-Schreiben');
  }

  function binaryString(bytes) {
    var chunks = [];
    for (var i = 0; i < bytes.length; i += 32768) {
      var part = '';
      for (var j = i; j < Math.min(i + 32768, bytes.length); j++) part += String.fromCharCode(bytes[j]);
      chunks.push(part);
    }
    return chunks.join('');
  }

  function bytesFromBinary(value) {
    var bytes = new Uint8Array(value.length);
    for (var i = 0; i < value.length; i++) bytes[i] = value.charCodeAt(i) & 255;
    return bytes;
  }

  function decodeAsciiHex(bytes) {
    var hex = binaryString(bytes).replace(/\s+/g, '').replace(/>.*$/, '');
    if (hex.length % 2) hex += '0';
    var out = new Uint8Array(Math.floor(hex.length / 2));
    for (var i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16) || 0;
    return out;
  }

  function decodeAscii85(bytes) {
    var input = binaryString(bytes).replace(/\s+/g, '').replace(/^<~/, '').replace(/~>.*$/, '');
    var output = [];
    var group = [];
    for (var i = 0; i < input.length; i++) {
      var code = input.charCodeAt(i);
      if (input[i] === 'z' && group.length === 0) {
        output.push(0, 0, 0, 0);
        continue;
      }
      if (code < 33 || code > 117) continue;
      group.push(code - 33);
      if (group.length === 5) {
        var value = 0;
        for (var g = 0; g < 5; g++) value = value * 85 + group[g];
        output.push((value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255);
        group = [];
      }
    }
    if (group.length) {
      var count = group.length;
      while (group.length < 5) group.push(84);
      var tail = 0;
      for (var t = 0; t < 5; t++) tail = tail * 85 + group[t];
      var tailBytes = [(tail >>> 24) & 255, (tail >>> 16) & 255, (tail >>> 8) & 255, tail & 255];
      for (var b = 0; b < count - 1; b++) output.push(tailBytes[b]);
    }
    return new Uint8Array(output);
  }

  async function inflate(bytes, maxBytes) {
    if (typeof DecompressionStream !== 'function') {
      throw new Error('Dieser Browser kann komprimierte PDF-Streams nicht offline entpacken');
    }
    var stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
    var reader = stream.getReader();
    var chunks = [];
    var total = 0;
    try {
      while (true) {
        var result = await reader.read();
        if (result.done) break;
        var chunk = result.value instanceof Uint8Array ? result.value : new Uint8Array(result.value);
        total += chunk.byteLength;
        if (total > maxBytes) {
          try { await reader.cancel('Entpackter PDF-Stream ist zu gross'); } catch (_) { /* ignore */ }
          throw new Error('Entpackter PDF-Stream ist zu gross');
        }
        chunks.push(chunk);
      }
    } finally {
      if (typeof reader.releaseLock === 'function') reader.releaseLock();
    }
    var output = new Uint8Array(total);
    var offset = 0;
    chunks.forEach(function (chunk) {
      output.set(chunk, offset);
      offset += chunk.byteLength;
    });
    return output;
  }

  function filterNames(dictionary) {
    var match = String(dictionary || '').match(/\/Filter\s*(?:\/([A-Za-z0-9]+)|\[([^\]]+)\])/);
    if (!match) return [];
    if (match[1]) return [match[1]];
    return Array.from(match[2].matchAll(/\/([A-Za-z0-9]+)/g)).map(function (item) { return item[1]; });
  }

  async function decodeStream(stream) {
    var bytes = stream.bytes;
    var filters = filterNames(stream.dictionary);
    for (var i = 0; i < filters.length; i++) {
      if (filters[i] === 'FlateDecode' || filters[i] === 'Fl') bytes = await inflate(bytes, MAX_PDF_BYTES * 4);
      else if (filters[i] === 'ASCIIHexDecode' || filters[i] === 'AHx') bytes = decodeAsciiHex(bytes);
      else if (filters[i] === 'ASCII85Decode' || filters[i] === 'A85') bytes = decodeAscii85(bytes);
      else throw new Error('Nicht unterstuetzter PDF-Streamfilter: ' + filters[i]);
      if (bytes.length > MAX_PDF_BYTES * 4) throw new Error('Entpackter PDF-Stream ist zu gross');
    }
    return bytes;
  }

  function parseObjects(source) {
    var matches = Array.from(source.matchAll(/(?:^|[\r\n])\s*(\d+)\s+(\d+)\s+obj\b/g));
    var objects = new Map();
    matches.forEach(function (match, index) {
      var start = match.index + match[0].length;
      var boundary = index + 1 < matches.length ? matches[index + 1].index : source.length;
      var end = source.lastIndexOf('endobj', boundary);
      if (end < start) end = boundary;
      var raw = source.slice(start, end);
      var streamMatch = /\bstream(?:\r\n|\r|\n)/.exec(raw);
      var stream = null;
      if (streamMatch) {
        var dataStart = streamMatch.index + streamMatch[0].length;
        var dictionary = raw.slice(0, streamMatch.index);
        var lengthMatch = dictionary.match(/\/Length\s+(\d+)(?!\s+\d+\s+R)/);
        var dataEnd = lengthMatch ? dataStart + Number(lengthMatch[1]) : raw.indexOf('endstream', dataStart);
        if (dataEnd < dataStart || dataEnd > raw.length) dataEnd = raw.indexOf('endstream', dataStart);
        if (dataEnd >= dataStart) stream = {
          dictionary: dictionary,
          bytes: bytesFromBinary(raw.slice(dataStart, dataEnd))
        };
      }
      objects.set(Number(match[1]), { raw: raw, stream: stream });
    });
    return objects;
  }

  function unicodeFromHex(hex) {
    var clean = String(hex || '').replace(/\s+/g, '');
    var bytes = [];
    for (var i = 0; i + 1 < clean.length; i += 2) bytes.push(parseInt(clean.slice(i, i + 2), 16));
    if (bytes.length >= 2 && bytes.length % 2 === 0) {
      var text = '';
      for (var j = 0; j < bytes.length; j += 2) text += String.fromCharCode((bytes[j] << 8) | bytes[j + 1]);
      return text;
    }
    return decodeWinAnsi(bytes);
  }

  function incrementHex(hex, offset) {
    var width = hex.length;
    var value = parseInt(hex, 16) + offset;
    return value.toString(16).toUpperCase().padStart(width, '0');
  }

  function addCMapMappings(text, cmap) {
    var bfcharBlocks = String(text || '').matchAll(/beginbfchar([\s\S]*?)endbfchar/g);
    for (var block of bfcharBlocks) {
      for (var pair of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
        if (!cmap.has(pair[1].toUpperCase())) cmap.set(pair[1].toUpperCase(), unicodeFromHex(pair[2]));
      }
    }
    var rangeBlocks = String(text || '').matchAll(/beginbfrange([\s\S]*?)endbfrange/g);
    for (var rangeBlock of rangeBlocks) {
      var lines = rangeBlock[1].split(/[\r\n]+/);
      for (var i = 0; i < lines.length; i++) {
        var simple = lines[i].match(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/);
        var array = lines[i].match(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*\[([^\]]+)\]/);
        if (!simple && !array) continue;
        var start = parseInt((simple || array)[1], 16);
        var finish = parseInt((simple || array)[2], 16);
        var width = (simple || array)[1].length;
        if (finish - start > 4096) continue;
        if (simple) {
          for (var n = start; n <= finish; n++) {
            var key = n.toString(16).toUpperCase().padStart(width, '0');
            if (!cmap.has(key)) cmap.set(key, unicodeFromHex(incrementHex(simple[3], n - start)));
          }
        } else {
          var values = Array.from(array[3].matchAll(/<([0-9A-Fa-f]+)>/g));
          values.forEach(function (value, offset) {
            var key = (start + offset).toString(16).toUpperCase().padStart(width, '0');
            if (start + offset <= finish && !cmap.has(key)) cmap.set(key, unicodeFromHex(value[1]));
          });
        }
      }
    }
  }

  var WIN_ANSI_EXTRA = {
    128: '\u20ac', 130: '\u201a', 131: '\u0192', 132: '\u201e', 133: '\u2026', 134: '\u2020',
    135: '\u2021', 136: '\u02c6', 137: '\u2030', 138: '\u0160', 139: '\u2039', 140: '\u0152',
    142: '\u017d', 145: '\u2018', 146: '\u2019', 147: '\u201c', 148: '\u201d', 149: '\u2022',
    150: '\u2013', 151: '\u2014', 152: '\u02dc', 153: '\u2122', 154: '\u0161', 155: '\u203a',
    156: '\u0153', 158: '\u017e', 159: '\u0178'
  };

  function decodeWinAnsi(bytes) {
    return Array.from(bytes || []).map(function (byte) {
      return WIN_ANSI_EXTRA[byte] || String.fromCharCode(byte);
    }).join('');
  }

  function decodeTextBytes(bytes, cmap) {
    if (!bytes || !bytes.length) return '';
    if (bytes.length >= 2 && bytes[0] === 254 && bytes[1] === 255) {
      var utf16 = '';
      for (var i = 2; i + 1 < bytes.length; i += 2) utf16 += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
      return utf16;
    }
    if (cmap && cmap.size) {
      var lengths = Array.from(new Set(Array.from(cmap.keys()).map(function (key) { return key.length / 2; })))
        .sort(function (a, b) { return b - a; });
      var mapped = '';
      var hits = 0;
      for (var pos = 0; pos < bytes.length;) {
        var found = false;
        for (var l = 0; l < lengths.length; l++) {
          var size = lengths[l];
          if (pos + size > bytes.length) continue;
          var key = '';
          for (var k = 0; k < size; k++) key += bytes[pos + k].toString(16).toUpperCase().padStart(2, '0');
          if (cmap.has(key)) {
            mapped += cmap.get(key);
            pos += size;
            hits += 1;
            found = true;
            break;
          }
        }
        if (!found) {
          mapped += decodeWinAnsi([bytes[pos]]);
          pos += 1;
        }
      }
      if (hits) return mapped;
    }
    if (bytes.length >= 4 && bytes.length % 2 === 0 && bytes.filter(function (byte, index) { return index % 2 === 0 && byte === 0; }).length >= bytes.length / 4) {
      var guessed = '';
      for (var g = 0; g + 1 < bytes.length; g += 2) guessed += String.fromCharCode((bytes[g] << 8) | bytes[g + 1]);
      return guessed;
    }
    return decodeWinAnsi(bytes);
  }

  function readLiteral(source, start) {
    var bytes = [];
    var depth = 1;
    var i = start + 1;
    while (i < source.length && depth > 0) {
      var code = source.charCodeAt(i) & 255;
      if (code === 92) {
        i += 1;
        if (i >= source.length) break;
        var escaped = source[i];
        var replacements = { n: 10, r: 13, t: 9, b: 8, f: 12 };
        if (Object.prototype.hasOwnProperty.call(replacements, escaped)) bytes.push(replacements[escaped]);
        else if (escaped === '\r' || escaped === '\n') {
          if (escaped === '\r' && source[i + 1] === '\n') i += 1;
        } else if (/[0-7]/.test(escaped)) {
          var octal = escaped;
          while (octal.length < 3 && /[0-7]/.test(source[i + 1] || '')) { i += 1; octal += source[i]; }
          bytes.push(parseInt(octal, 8) & 255);
        } else bytes.push(source.charCodeAt(i) & 255);
      } else if (code === 40) {
        depth += 1;
        bytes.push(code);
      } else if (code === 41) {
        depth -= 1;
        if (depth > 0) bytes.push(code);
      } else bytes.push(code);
      i += 1;
    }
    return { value: bytes, end: i };
  }

  function readHex(source, start) {
    var end = source.indexOf('>', start + 1);
    if (end === -1) return { value: [], end: source.length };
    var hex = source.slice(start + 1, end).replace(/\s+/g, '');
    if (hex.length % 2) hex += '0';
    var bytes = [];
    for (var i = 0; i + 1 < hex.length; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16) || 0);
    return { value: bytes, end: end + 1 };
  }

  function extractTextFromContent(bytes, cmap) {
    var source = binaryString(bytes);
    var stack = [];
    var output = [];
    var i = 0;
    function newline() {
      if (output.length && output[output.length - 1] !== '\n') output.push('\n');
    }
    while (i < source.length) {
      var ch = source[i];
      if (/\s/.test(ch)) { i += 1; continue; }
      if (ch === '%') { while (i < source.length && source[i] !== '\n' && source[i] !== '\r') i += 1; continue; }
      if (ch === '(') {
        var literal = readLiteral(source, i);
        stack.push({ type: 'text', value: literal.value });
        i = literal.end;
        continue;
      }
      if (ch === '<' && source[i + 1] !== '<') {
        var hex = readHex(source, i);
        stack.push({ type: 'text', value: hex.value });
        i = hex.end;
        continue;
      }
      if (ch === '[') {
        var array = [];
        i += 1;
        while (i < source.length && source[i] !== ']') {
          if (/\s/.test(source[i])) { i += 1; continue; }
          if (source[i] === '(') {
            var item = readLiteral(source, i);
            array.push({ type: 'text', value: item.value });
            i = item.end;
          } else if (source[i] === '<' && source[i + 1] !== '<') {
            var hexItem = readHex(source, i);
            array.push({ type: 'text', value: hexItem.value });
            i = hexItem.end;
          } else {
            var itemEnd = i;
            while (itemEnd < source.length && !/[\s\]]/.test(source[itemEnd])) itemEnd += 1;
            var token = source.slice(i, itemEnd);
            if (/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(token)) array.push({ type: 'number', value: Number(token) });
            i = itemEnd;
          }
        }
        stack.push({ type: 'array', value: array });
        i += 1;
        continue;
      }
      var end = i;
      while (end < source.length && !/[\s\[\]()<>]/.test(source[end])) end += 1;
      if (end === i) { i += source.slice(i, i + 2) === '<<' || source.slice(i, i + 2) === '>>' ? 2 : 1; continue; }
      var operator = source.slice(i, end);
      i = end;
      if (/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(operator) || operator[0] === '/') {
        stack.push({ type: 'operand', value: operator });
        continue;
      }
      if (operator === 'Tj' || operator === "'" || operator === '"') {
        if (operator !== 'Tj') newline();
        for (var s = stack.length - 1; s >= 0; s--) {
          if (stack[s].type === 'text') { output.push(decodeTextBytes(stack[s].value, cmap)); break; }
        }
      } else if (operator === 'TJ') {
        for (var a = stack.length - 1; a >= 0; a--) {
          if (stack[a].type !== 'array') continue;
          stack[a].value.forEach(function (part) {
            if (part.type === 'text') output.push(decodeTextBytes(part.value, cmap));
            else if (part.type === 'number' && part.value <= -120) output.push(' ');
          });
          break;
        }
      } else if (operator === 'T*' || operator === 'Td' || operator === 'TD' || operator === 'ET') newline();
      stack = [];
    }
    return output.join('');
  }

  async function extractPdfText(bytes) {
    var source = binaryString(bytes);
    if (source.slice(0, 1024).indexOf('%PDF-') === -1) throw new Error('Datei besitzt keinen gueltigen PDF-Header');
    if (/\/Encrypt\b/.test(source)) return { text: '', pages: 0, encrypted: true, truncated: false };
    var objects = parseObjects(source);
    var decodedStreams = new Map();
    for (var entry of objects.entries()) {
      if (!entry[1].stream || /\/Subtype\s*\/Image\b/.test(entry[1].stream.dictionary)) continue;
      try { decodedStreams.set(entry[0], await decodeStream(entry[1].stream)); } catch (_) { /* unsupported streams are skipped */ }
    }
    var cmap = new Map();
    for (var decoded of decodedStreams.values()) {
      var cmapText = binaryString(decoded);
      if (/beginbf(?:char|range)/.test(cmapText)) addCMapMappings(cmapText, cmap);
    }
    var pageObjects = Array.from(objects.entries()).filter(function (entry) { return /\/Type\s*\/Page\b/.test(entry[1].raw); });
    var contentIds = [];
    pageObjects.forEach(function (entry) {
      var direct = entry[1].raw.match(/\/Contents\s+(\d+)\s+\d+\s+R/);
      var list = entry[1].raw.match(/\/Contents\s*\[([^\]]+)\]/);
      if (direct) contentIds.push(Number(direct[1]));
      if (list) Array.from(list[1].matchAll(/(\d+)\s+\d+\s+R/g)).forEach(function (ref) { contentIds.push(Number(ref[1])); });
    });
    if (!contentIds.length) {
      for (var streamEntry of decodedStreams.entries()) {
        var candidate = binaryString(streamEntry[1]);
        if (/\b(?:BT|Tj|TJ)\b/.test(candidate)) contentIds.push(streamEntry[0]);
      }
    }
    var sections = [];
    contentIds.forEach(function (id) {
      if (!decodedStreams.has(id)) return;
      var text = extractTextFromContent(decodedStreams.get(id), cmap).trim();
      if (text) sections.push(text);
    });
    var cleaned = sections.join('\n\n')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n[ \t]+/g, '\n')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    var truncated = cleaned.length > MAX_TEXT_CHARS;
    return {
      text: truncated ? cleaned.slice(0, MAX_TEXT_CHARS) : cleaned,
      pages: pageObjects.length,
      encrypted: false,
      truncated: truncated
    };
  }

  var UNICODE_TO_WIN_ANSI = (function () {
    var map = {};
    Object.keys(WIN_ANSI_EXTRA).forEach(function (byte) { map[WIN_ANSI_EXTRA[byte]] = Number(byte); });
    return map;
  })();

  function encodeWinAnsi(text) {
    var bytes = [];
    var replaced = 0;
    Array.from(String(text || '')).forEach(function (character) {
      var code = character.codePointAt(0);
      if (code === 9) bytes.push(32, 32, 32, 32);
      else if ((code >= 32 && code <= 126) || (code >= 160 && code <= 255)) bytes.push(code);
      else if (Object.prototype.hasOwnProperty.call(UNICODE_TO_WIN_ANSI, character)) bytes.push(UNICODE_TO_WIN_ANSI[character]);
      else { bytes.push(63); replaced += 1; }
    });
    return { bytes: bytes, replaced: replaced };
  }

  function estimatedWidth(character) {
    if (/[ilI1.,'`:;!|]/.test(character)) return 280;
    if (/[mwMW@%&]/.test(character)) return 850;
    if (/[A-Z0-9]/.test(character)) return 650;
    if (character === ' ') return 278;
    return 520;
  }

  function wrapText(text, maxUnits) {
    var lines = [];
    String(text || '').replace(/\r\n?/g, '\n').split('\n').forEach(function (paragraph) {
      if (!paragraph.trim()) { lines.push(''); return; }
      var current = '';
      var width = 0;
      paragraph.trim().split(/\s+/).forEach(function (word) {
        var wordWidth = Array.from(word).reduce(function (sum, character) { return sum + estimatedWidth(character); }, 0);
        var spaceWidth = current ? 278 : 0;
        if (current && width + spaceWidth + wordWidth > maxUnits) {
          lines.push(current);
          current = '';
          width = 0;
        }
        if (wordWidth <= maxUnits) {
          current += (current ? ' ' : '') + word;
          width += spaceWidth + wordWidth;
          return;
        }
        Array.from(word).forEach(function (character) {
          var charWidth = estimatedWidth(character);
          if (current && width + charWidth > maxUnits) { lines.push(current); current = ''; width = 0; }
          current += character;
          width += charWidth;
        });
      });
      if (current) lines.push(current);
    });
    return lines.length ? lines : [''];
  }

  function pdfLiteralBytes(bytes) {
    return bytes.map(function (byte) {
      if (byte === 40 || byte === 41 || byte === 92) return '\\' + String.fromCharCode(byte);
      if (byte < 32 || byte > 126) return '\\' + byte.toString(8).padStart(3, '0');
      return String.fromCharCode(byte);
    }).join('');
  }

  function binaryBytes(value) {
    var out = new Uint8Array(value.length);
    for (var i = 0; i < value.length; i++) out[i] = value.charCodeAt(i) & 255;
    return out;
  }

  function createTextPdf(content, title) {
    var fontSize = 11;
    var maxWidthUnits = Math.floor((595 - 100) * 1000 / fontSize);
    var lines = wrapText(content, maxWidthUnits);
    var linesPerPage = 48;
    var pages = [];
    var replaced = 0;
    for (var offset = 0; offset < lines.length; offset += linesPerPage) pages.push(lines.slice(offset, offset + linesPerPage));
    if (!pages.length) pages.push(['']);

    var objects = {};
    var pageIds = [];
    var contentIds = [];
    for (var p = 0; p < pages.length; p++) {
      pageIds.push(4 + p * 2);
      contentIds.push(5 + p * 2);
    }
    var infoId = 4 + pages.length * 2;
    objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
    objects[2] = '<< /Type /Pages /Count ' + pages.length + ' /Kids [' + pageIds.map(function (id) { return id + ' 0 R'; }).join(' ') + '] >>';
    objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
    pages.forEach(function (pageLines, index) {
      objects[pageIds[index]] = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ' + contentIds[index] + ' 0 R >>';
      var commands = ['BT', '/F1 ' + fontSize + ' Tf', '15 TL', '50 792 Td'];
      pageLines.forEach(function (line, lineIndex) {
        var encoded = encodeWinAnsi(line);
        replaced += encoded.replaced;
        if (lineIndex > 0) commands.push('T*');
        if (encoded.bytes.length) commands.push('(' + pdfLiteralBytes(encoded.bytes) + ') Tj');
      });
      commands.push('ET');
      var stream = commands.join('\n') + '\n';
      objects[contentIds[index]] = '<< /Length ' + stream.length + ' >>\nstream\n' + stream + 'endstream';
    });
    var titleEncoding = encodeWinAnsi(title || 'Codex IDE PDF');
    replaced += titleEncoding.replaced;
    objects[infoId] = '<< /Title (' + pdfLiteralBytes(titleEncoding.bytes) + ') /Producer (Codex IDE Model Home PDF Skill) >>';

    var maxId = infoId;
    var parts = ['%PDF-1.4\n%\xE2\xE3\xCF\xD3\n'];
    var offsets = [0];
    var byteLength = parts[0].length;
    for (var id = 1; id <= maxId; id++) {
      offsets[id] = byteLength;
      var objectSource = id + ' 0 obj\n' + objects[id] + '\nendobj\n';
      parts.push(objectSource);
      byteLength += objectSource.length;
    }
    var xrefOffset = byteLength;
    var xref = 'xref\n0 ' + (maxId + 1) + '\n0000000000 65535 f \n';
    for (var x = 1; x <= maxId; x++) xref += String(offsets[x]).padStart(10, '0') + ' 00000 n \n';
    var trailer = 'trailer\n<< /Size ' + (maxId + 1) + ' /Root 1 0 R /Info ' + infoId + ' 0 R >>\nstartxref\n' + xrefOffset + '\n%%EOF\n';
    parts.push(xref, trailer);
    return { bytes: binaryBytes(parts.join('')), pages: pages.length, replaced: replaced };
  }

  function languageText(language, values) {
    return values[language] || values.en || values.de;
  }

  async function run(request, context) {
    var operation = request.operation;
    var path = normalizePath(request.path);
    if (operation === 'read') {
      if (!context.permissions.readPdf) throw new Error('Lesefreigabe fuer PDF-Dateien fehlt');
      var loaded = await readPdfBytes(path, context.signal);
      var parsed = await extractPdfText(loaded.bytes);
      if (parsed.encrypted) {
        return { context: languageText(context.language, {
          de: 'Die PDF-Datei ist verschluesselt. Der Offline-PDF-Skill extrahiert daraus keinen Text.',
          en: 'The PDF file is encrypted. The offline PDF skill cannot extract text from it.',
          fr: "Le fichier PDF est chiffré. Le skill PDF hors ligne ne peut pas en extraire le texte."
        }), detail: { operation: 'read', bytes: loaded.file.bytes, pages: 0 } };
      }
      if (!parsed.text) {
        return { context: languageText(context.language, {
          de: 'In der PDF-Datei wurde kein extrahierbarer Text gefunden. Sie ist moeglicherweise gescannt oder verwendet eine nicht unterstuetzte Schriftkodierung.',
          en: 'No extractable text was found in the PDF file. It may be scanned or use an unsupported font encoding.',
          fr: "Aucun texte extractible n'a été trouvé dans le PDF. Il peut être numérisé ou utiliser un encodage de police non pris en charge."
        }), detail: { operation: 'read', bytes: loaded.file.bytes, pages: parsed.pages } };
      }
      var header = languageText(context.language, {
        de: 'Gepruefter PDF-Kontext aus dem Modell-Home. Seiten: ' + (parsed.pages || 'unbekannt') + '. Text' + (parsed.truncated ? ' (gekuerzt)' : '') + ':',
        en: 'Verified PDF context from the model home. Pages: ' + (parsed.pages || 'unknown') + '. Text' + (parsed.truncated ? ' (truncated)' : '') + ':',
        fr: 'Contexte PDF vérifié du dossier modèle. Pages : ' + (parsed.pages || 'inconnu') + '. Texte' + (parsed.truncated ? ' (tronqué)' : '') + ' :'
      });
      return {
        context: header + '\n---\n' + parsed.text + '\n---',
        detail: { operation: 'read', bytes: loaded.file.bytes, pages: parsed.pages, truncated: parsed.truncated }
      };
    }

    if (operation === 'write') {
      if (!context.permissions.writePdf) throw new Error('Schreibfreigabe fuer PDF-Dateien fehlt');
      if (typeof request.content !== 'string' || !request.content.trim()) throw new Error('PDF-Textinhalt fehlt');
      var created = createTextPdf(request.content, request.title || '');
      if (created.bytes.length > MAX_PDF_BYTES) throw new Error('Erzeugte PDF-Datei ist zu gross');
      var saved = await writePdfBytes(path, created.bytes, request.overwrite === true, context.signal);
      var message = languageText(context.language, {
        de: 'Die Text-PDF wurde im Modell-Home gespeichert. Seiten: ' + created.pages + ', Bytes: ' + saved.bytes + '.',
        en: 'The text PDF was saved in the model home. Pages: ' + created.pages + ', bytes: ' + saved.bytes + '.',
        fr: 'Le PDF texte a été enregistré dans le dossier modèle. Pages : ' + created.pages + ', octets : ' + saved.bytes + '.'
      });
      if (created.replaced) message += ' ' + languageText(context.language, {
        de: created.replaced + ' nicht durch WinAnsi darstellbare Zeichen wurden durch ? ersetzt.',
        en: created.replaced + ' characters unavailable in WinAnsi were replaced with ?.',
        fr: created.replaced + " caractères indisponibles en WinAnsi ont été remplacés par ?."
      });
      return {
        context: message,
        detail: { operation: 'write', bytes: saved.bytes, pages: created.pages, overwritten: saved.overwritten, replacedCharacters: created.replaced }
      };
    }
    throw new Error('Unbekannte PDF-Aktion');
  }

  window.CodexIdeSkillSystem.registerRuntime(SKILL_ID, { run: run });
})();

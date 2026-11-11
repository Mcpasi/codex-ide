(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CodexIdeEditorDiff = factory();
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  // Myers' bidirectional search uses linear space. Work is split with an
  // explicit stack so large files do not exhaust the JavaScript call stack.
  function middleSplit(left, right, a, z, b, y) {
    var n = z - a;
    var m = y - b;
    var depth = Math.ceil((n + m) / 2);
    var offset = depth + 1;
    var forward = new Int32Array(2 * depth + 3).fill(-1);
    var reverse = new Int32Array(2 * depth + 3).fill(-1);
    forward[offset + 1] = reverse[offset + 1] = 0;
    var delta = n - m;
    var odd = delta % 2 !== 0;
    for (var d = 0; d <= depth; d += 1) {
      for (var k = -d; k <= d; k += 2) {
        var index = offset + k;
        var x = k === -d || (k !== d && forward[index - 1] < forward[index + 1])
          ? forward[index + 1] : forward[index - 1] + 1;
        var row = x - k;
        while (x < n && row < m && left[a + x] === right[b + row]) { x += 1; row += 1; }
        forward[index] = x;
        var other = offset + delta - k;
        if (odd && other >= 0 && other < reverse.length && reverse[other] !== -1 && x + reverse[other] >= n) {
          return { a: a + x, b: b + row };
        }
      }
      for (var back = -d; back <= d; back += 2) {
        var backIndex = offset + back;
        var rx = back === -d || (back !== d && reverse[backIndex - 1] < reverse[backIndex + 1])
          ? reverse[backIndex + 1] : reverse[backIndex - 1] + 1;
        var ry = rx - back;
        while (rx < n && ry < m && left[z - rx - 1] === right[y - ry - 1]) { rx += 1; ry += 1; }
        reverse[backIndex] = rx;
        var frontIndex = offset + delta - back;
        if (!odd && frontIndex >= 0 && frontIndex < forward.length && forward[frontIndex] !== -1 && forward[frontIndex] + rx >= n) {
          var frontX = forward[frontIndex];
          return { a: a + frontX, b: b + frontX - (delta - back) };
        }
      }
    }
    return null;
  }

  function tokenEdits(left, right) {
    var pending = [{ a: 0, z: left.length, b: 0, y: right.length }];
    var edits = [];
    while (pending.length) {
      var part = pending.pop();
      var a = part.a, z = part.z, b = part.b, y = part.y;
      while (a < z && b < y && left[a] === right[b]) { a += 1; b += 1; }
      while (a < z && b < y && left[z - 1] === right[y - 1]) { z -= 1; y -= 1; }
      if (a === z && b === y) continue;
      var split = null;
      if (a < z && b < y) {
        var values = new Set(left.slice(a, z));
        if (right.slice(b, y).some(function (value) { return values.has(value); })) {
          split = middleSplit(left, right, a, z, b, y);
        }
      }
      if (split && (split.a !== a || split.b !== b) && (split.a !== z || split.b !== y)) {
        pending.push({ a: split.a, z: z, b: split.b, y: y });
        pending.push({ a: a, z: split.a, b: b, y: split.b });
      } else {
        var previous = edits[edits.length - 1];
        if (previous && previous.z === a && previous.y === b) { previous.z = z; previous.y = y; }
        else edits.push({ a: a, z: z, b: b, y: y });
      }
    }
    return edits;
  }

  function offsets(tokens) {
    var result = [0];
    tokens.forEach(function (token) { result.push(result[result.length - 1] + token.length); });
    return result;
  }

  function refine(source, target, tokenize, base) {
    var left = tokenize(source), right = tokenize(target);
    var leftOffsets = offsets(left), rightOffsets = offsets(right);
    return tokenEdits(left, right).map(function (edit) {
      return {
        start: base + leftOffsets[edit.a], end: base + leftOffsets[edit.z],
        text: target.slice(rightOffsets[edit.b], rightOffsets[edit.y])
      };
    });
  }

  function diffText(sourceValue, targetValue) {
    var source = String(sourceValue == null ? '' : sourceValue);
    var target = String(targetValue == null ? '' : targetValue);
    if (source === target) return [];
    var lines = refine(source, target, function (value) { return value.match(/[^\n]*\n|[^\n]+$/g) || []; }, 0);
    var result = [];
    lines.forEach(function (line) {
      var words = refine(source.slice(line.start, line.end), line.text, function (value) {
        return value.match(/[\p{L}\p{N}_$]+|[^\S\r\n]+|\r\n|[^]/gu) || [];
      }, line.start);
      words.forEach(function (word) {
        // Trim equal code points inside changed tokens, preserving UTF-16
        // offsets without ever splitting an emoji's surrogate pair.
        var before = Array.from(source.slice(word.start, word.end));
        var after = Array.from(word.text);
        var prefix = 0, suffix = 0;
        while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1;
        while (suffix < before.length - prefix && suffix < after.length - prefix &&
            before[before.length - suffix - 1] === after[after.length - suffix - 1]) suffix += 1;
        result.push({
          start: word.start + before.slice(0, prefix).join('').length,
          end: word.end - (suffix ? before.slice(-suffix).join('').length : 0),
          text: after.slice(prefix, after.length - suffix).join('')
        });
      });
    });
    return result;
  }

  return { diffText: diffText };
});

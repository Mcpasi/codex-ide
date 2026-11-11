'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

function createBrowser(initialStorage = {}) {
  const values = new Map(Object.entries(initialStorage));
  const nodes = new Map();
  const localStorage = {
    getItem: jest.fn(key => values.has(key) ? values.get(key) : null),
    setItem: jest.fn((key, value) => values.set(key, String(value))),
    removeItem: jest.fn(key => values.delete(key))
  };
  const document = {
    readyState: 'loading',
    getElementById: jest.fn(id => nodes.get(id) || null),
    addEventListener: jest.fn(), dispatchEvent: jest.fn()
  };
  const window = { addEventListener: jest.fn(), location: new URL('http://localhost:8787/') };
  const context = vm.createContext({
    window, document, localStorage, location: window.location,
    console: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
    fetch: jest.fn(() => Promise.reject(new Error('Unexpected fetch in isolated browser test'))),
    URL, TextDecoder, TextEncoder, AbortController,
    setTimeout, clearTimeout, setInterval, clearInterval,
    CustomEvent: class CustomEvent {
      constructor(type, options = {}) { this.type = type; this.detail = options.detail; }
    }
  });
  return {
    window, document, localStorage, values, nodes, context,
    load(relativePath) {
      const filename = path.resolve(__dirname, '../..', relativePath);
      vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename });
    }
  };
}

module.exports = { createBrowser };

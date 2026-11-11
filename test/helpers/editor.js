'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createBrowser } = require('./browser');

function createElement() {
  const listeners = new Map();
  const attributes = new Map();
  const element = {
    value: '', children: [], tagName: String(arguments[0] || 'div').toUpperCase(),
    dataset: {}, style: {}, scrollTop: 0, scrollLeft: 0,
    scrollHeight: 400, clientHeight: 200, selectionStart: 0, selectionEnd: 0,
    appendChild(child) { this.children.push(child); child.parentNode = this; return child; },
    setAttribute(name, value) { attributes.set(name, String(value)); },
    removeAttribute(name) { attributes.delete(name); },
    getAttribute(name) { return attributes.get(name) || null; },
    focus() {},
    setRangeText: jest.fn(function (text, start, end) { this.value = this.value.slice(0, start) + text + this.value.slice(end); }),
    querySelectorAll() { return []; },
    setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; },
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(listener);
    },
    dispatchEvent(event) {
      (listeners.get(event.type) || []).forEach(listener => listener.call(this, event));
    }
  };
  let ownText = '';
  Object.defineProperty(element, 'textContent', {
    get() { return ownText + this.children.map(child => child.textContent).join(''); },
    set(value) { ownText = String(value); this.children = []; }
  });
  Object.defineProperty(element, 'innerHTML', {
    get() { return this.textContent; },
    set(value) { this.textContent = value; }
  });
  return element;
}

function createEditor() {
  const browser = createBrowser();
  const projectRoot = path.resolve(__dirname, '../..');
  const html = fs.readFileSync(path.join(projectRoot, 'index.html'), 'utf8');
  for (const [, id] of html.matchAll(/\bid="([^"]+)"/g)) {
    browser.nodes.set(id, createElement());
  }
  browser.document.createElement = jest.fn(createElement);
  browser.document.createTextNode = value => Object.assign(createElement('#text'), { textContent: value });
  browser.document.body = createElement('body');
  browser.load('agentResponse.js');
  browser.load('codex_ide/editor-diff.js');
  browser.window.codexIdeProfile = {
    writeModelHomeWorkspaceFile: jest.fn().mockResolvedValue({ ok: true }),
    listModelHomeWorkspaceFiles: jest.fn().mockResolvedValue({ files: [], directories: [] })
  };

  const filename = path.join(projectRoot, 'codex_ide/codex-ide.js');
  const source = fs.readFileSync(filename, 'utf8');
  // Expose the closure only in this VM, without adding test hooks to the app.
  vm.runInContext(source.replace(/\}\)\(\);\s*$/, `
    window.editorUnderTest = {
      state: state,
      activateBuffer: activateBuffer,
      bindEvents: bindEvents,
      applyModelEditorDraft: applyModelEditorDraft,
      applyModelEditorWrite: applyModelEditorWrite,
      discardModelEditorDraft: discardModelEditorDraft,
      synchronizeWorkspaceState: synchronizeWorkspaceState,
      scheduleEditorHighlight: scheduleEditorHighlight,
      setBusy: setBusy,
      appendReasoningSummary: appendReasoningSummary,
      renderActivities: renderActivities,
      updateSkillRun: updateSkillRun,
      updateToolActivity: updateToolActivity,
      initializeAgentSessions: initializeAgentSessions,
      createAgentSession: createAgentSession,
      showAgentSession: showAgentSession,
      renderSessionHistory: renderSessionHistory,
      persistAgentSessions: persistAgentSessions,
      runAgent: runAgent
    };
  })();`), browser.context, { filename });
  const editor = browser.window.editorUnderTest;
  editor.state.busy = true;
  editor.state.turnId = 1;
  editor.bindEvents();
  return {
    ...editor,
    browser,
    profile: browser.window.codexIdeProfile,
    node: id => browser.nodes.get(id)
  };
}

module.exports = { createEditor };

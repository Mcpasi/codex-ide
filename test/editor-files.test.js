'use strict';

const fs = require('fs');
const path = require('path');
const bridge = require('../scripts/codex-bridge');
const { createEditor } = require('./helpers/editor');
const { createFixture } = require('./helpers/fixture');

describe('navigation away from a new editor file', () => {
  let editor;

  beforeEach(() => {
    jest.useFakeTimers();
    editor = createEditor();
    editor.setBusy(false);
    editor.state.files = [{ path: 'existing.js', bytes: 11 }];
    editor.activateBuffer('existing.js', 'existing();', 'existing();', false);
    editor.node('ideNewFile').dispatchEvent({ type: 'click' });
    editor.node('ideEditor').value = 'unsaved draft 👋';
    editor.node('ideEditor').dispatchEvent({ type: 'input' });
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  function openExistingFile(via) {
    const button = via === 'tab'
      ? editor.node('ideTabs').children[0].children[0]
      : editor.node('ideFileList').children[0];
    button.dispatchEvent({ type: 'click' });
  }

  test.each([
    ['tab', ''], ['file tree', ''], ['tab', 'draft.js'], ['file tree', 'draft.js']
  ])('keeps a new draft when %s navigation is declined (path: %j)', (via, draftPath) => {
    editor.node('idePath').value = draftPath;
    editor.node('idePath').dispatchEvent({ type: 'input' });
    editor.browser.window.confirm = jest.fn().mockReturnValue(false);

    openExistingFile(via);

    expect(editor.node('ideEditor').value).toBe('unsaved draft 👋');
    expect(editor.node('idePath').value).toBe(draftPath);
    expect(editor.state.dirty).toBe(true);
    expect(editor.state.buffers['existing.js'].content).toBe('existing();');
    expect(editor.browser.window.confirm).toHaveBeenCalledTimes(1);
  });

  test.each(['tab', 'file tree'])('opens the existing file through the %s after discarding is confirmed', via => {
    editor.browser.window.confirm = jest.fn().mockReturnValue(true);

    openExistingFile(via);

    expect(editor.browser.window.confirm).toHaveBeenCalledTimes(1);
    expect(editor.state.path).toBe('existing.js');
    expect(editor.node('ideEditor').value).toBe('existing();');
    expect(editor.state.dirty).toBe(false);
  });

  test.each(['tab', 'file tree'])('keeps edits in a named buffer when switching through the %s', via => {
    editor.activateBuffer('other.js', 'unsaved changes', 'original', true);
    editor.browser.window.confirm = jest.fn();

    openExistingFile(via);

    expect(editor.state.path).toBe('existing.js');
    expect(editor.state.buffers['other.js']).toMatchObject({ content: 'unsaved changes', dirty: true });
    expect(editor.browser.window.confirm).not.toHaveBeenCalled();
  });
});

describe('manually saving empty editor files', () => {
  let editor;
  let fixture;

  beforeEach(() => {
    jest.useFakeTimers();
    fixture = createFixture();
    editor = createEditor();
    editor.setBusy(false);
    editor.profile.writeModelHomeWorkspaceFile.mockImplementation(async (file, content, options) => ({
      ok: true, file: bridge.writeIdeEditorFile(fixture.home, file, content, options)
    }));
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    fixture.dispose();
  });

  test.each(['new', 'existing'])('persists an empty %s file and clears its dirty state', async kind => {
    if (kind === 'existing') {
      fixture.write('empty.txt', 'previous content');
      editor.activateBuffer('empty.txt', 'previous content', 'previous content', false);
    }
    editor.node('idePath').value = 'empty.txt';
    editor.node('ideEditor').value = '';
    editor.node('ideEditor').dispatchEvent({ type: 'input' });
    expect(editor.state.dirty).toBe(true);

    await editor.saveFile();

    expect(editor.profile.writeModelHomeWorkspaceFile).toHaveBeenCalledWith('empty.txt', '', {
      overwrite: true, editorWorkspaceMode: true
    });
    expect(fs.existsSync(path.join(fixture.home, 'empty.txt'))).toBe(true);
    expect(fixture.read('empty.txt')).toBe('');
    expect(editor.state.buffers['empty.txt']).toMatchObject({ content: '', savedContent: '', dirty: false });
    expect(editor.state.dirty).toBe(false);
  });
});

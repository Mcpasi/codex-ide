'use strict';

const { createEditor } = require('./helpers/editor');

describe('editor buffers after native workspace changes', () => {
  let editor;
  beforeEach(() => { editor = createEditor(); });

  test('refreshes clean active buffers and retains unsaved user changes', async () => {
    editor.activateBuffer('package.json', 'old package', 'old package', false);
    editor.activateBuffer('.env', 'unsaved value', 'original value', true);
    editor.activateBuffer('package.json', 'old package', 'old package', false);
    editor.profile.listModelHomeWorkspaceFiles.mockResolvedValue({ files: [{ path: 'package.json' }, { path: '.env' }] });
    editor.profile.readModelHomeWorkspaceFile = jest.fn().mockResolvedValue({ file: { content: 'native update' } });
    await editor.synchronizeWorkspaceState(true);
    expect(editor.node('ideEditor').value).toBe('native update');
    expect(editor.state.buffers['package.json']).toMatchObject({ content: 'native update', savedContent: 'native update', dirty: false });
    expect(editor.state.buffers['.env']).toMatchObject({ content: 'unsaved value', dirty: true });
    expect(editor.profile.readModelHomeWorkspaceFile).toHaveBeenCalledTimes(1);
  });

  test('closes a clean buffer deleted by native tools without discarding a dirty buffer', async () => {
    editor.activateBuffer('.env', 'unsaved value', 'original', true);
    editor.activateBuffer('deleted.ts', 'old', 'old', false);
    editor.profile.readModelHomeWorkspaceFile = jest.fn();
    await editor.synchronizeWorkspaceState(true);
    expect(editor.state.buffers['deleted.ts']).toBeUndefined();
    expect(editor.state.buffers['.env'].content).toBe('unsaved value');
    expect(editor.node('ideEditor').value).toBe('');
    expect(editor.profile.readModelHomeWorkspaceFile).not.toHaveBeenCalled();
  });
});

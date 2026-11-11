'use strict';

const { createEditor } = require('./helpers/editor');

describe('chat input and persisted conversation', () => {
  let editor;
  let session;

  beforeEach(() => {
    editor = createEditor();
    editor.state.busy = false;
    editor.profile.get = () => 'codex';
    session = editor.createAgentSession();
    editor.state.sessions = [session];
    editor.state.sessionId = session.id;
    editor.state.history = session.history;
  });

  test('moves the user message into the chat before generation and preserves the next draft', async () => {
    let finish;
    const instruction = 'Prüfe **diesen** Code.\n<script>unverändert</script>';
    editor.node('idePrompt').value = instruction;
    editor.profile.apiGenerateReply = jest.fn((_prompt, options) => {
      expect(options).toMatchObject({ editorWriteMode: true, editorWorkspaceMode: true, conversationHistory: [] });
      expect(editor.node('idePrompt').value).toBe('');
      expect(editor.node('ideCurrentUser').hidden).toBe(false);
      expect(editor.node('ideCurrentUserText').textContent).toBe(instruction);
      expect(editor.node('ideCurrentUserText').children).toHaveLength(0);
      expect(session.lastTurn).toMatchObject({ user: instruction, status: 'running' });
      return new Promise(resolve => { finish = resolve; });
    });
    const pending = editor.runAgent();
    editor.node('idePrompt').value = 'Mein nächster Entwurf';
    await editor.runAgent();
    expect(editor.profile.apiGenerateReply).toHaveBeenCalledTimes(1);
    finish('<codex_ide_final>Geprüft.</codex_ide_final>');
    await pending;
    expect(editor.node('idePrompt').value).toBe('Mein nächster Entwurf');
    expect(editor.node('ideFinal').textContent).toBe('Geprüft.');
    expect(session.turns).toHaveLength(1);
    expect(session.lastTurn.status).toBe('completed');
    expect(session.history).toEqual([{ user: instruction, reply: 'Geprüft.' }]);
  });

  test.each([
    ['plain HTML', '<main>Grüße 👋</main>', '<main>Grüße 👋</main>'],
    ['tagged comparison', '<codex_ide_final>Prüfe x < 5.', 'Prüfe x < 5.']
  ])('shows %s in the chat before generation completes', async (_label, streamed, reply) => {
    let callbacks;
    let finish;
    editor.node('idePrompt').value = 'Erkläre den Code';
    editor.profile.apiGenerateReply = jest.fn((_prompt, options) => {
      callbacks = options;
      return new Promise(resolve => { finish = resolve; });
    });
    const pending = editor.runAgent();
    try {
      callbacks.onToken(streamed, streamed);
      expect(editor.node('ideFinal').textContent).toBe(reply);
    } finally {
      finish('<codex_ide_final>' + reply + '</codex_ide_final>');
      await pending;
    }

    expect(session.lastTurn.status).toBe('completed');
    expect(session.lastTurn.reply).toBe(reply);
    expect(editor.node('ideFinal').textContent).toBe(reply);
  });

  test('archives cards between turns and restores them once with the conversation', async () => {
    const scope = { itemId: 'summary', threadId: 'thread', turnId: 'turn', summaryIndex: 0 };
    editor.profile.apiGenerateReply = jest.fn(async (_prompt, options) => {
      options.onReasoningSummary('Ich prüfe die Ausgabe.', scope);
      options.onSkillStart('workspace.extended-files', { itemId: 'read', operation: 'read', path: 'app.js' });
      options.onSkillUse('workspace.extended-files', { itemId: 'read', operation: 'read', path: 'app.js' });
      options.onToolEvent({ itemId: 'lookup', name: 'lookup', status: 'completed', output: 'Treffer' });
      return '<codex_ide_final>Erledigt.</codex_ide_final>';
    });
    editor.node('idePrompt').value = 'Erster Beitrag';
    await editor.runAgent();
    expect(session.lastTurn.activities.map(activity => activity.status)).toEqual(['complete', 'complete', 'complete']);
    expect(() => JSON.stringify(session.turns)).not.toThrow();
    expect(session.lastTurn.activities[0]).not.toHaveProperty('element');
    expect(session.lastTurn.activities[0]).not.toHaveProperty('rawText');

    editor.node('idePrompt').value = 'Zweiter Beitrag';
    await editor.runAgent();
    expect(editor.node('ideSessionHistory').children).toHaveLength(1);
    expect(editor.node('ideCurrentUserText').textContent).toBe('Zweiter Beitrag');
    expect(editor.profile.apiGenerateReply.mock.calls[1][1].conversationHistory).toHaveLength(1);
    await editor.persistAgentSessions();
    const saved = editor.browser.values.get('codexIdeAgentSessionsV1');
    expect(JSON.parse(saved).sessions[0].turns).toHaveLength(2);

    const restored = createEditor();
    restored.browser.values.set('codexIdeAgentSessionsV1', saved);
    await restored.initializeAgentSessions();
    restored.showAgentSession(restored.state.sessions[0], false);
    expect(restored.node('ideSessionHistory').children).toHaveLength(2);
    expect(restored.node('ideCurrentUser').hidden).toBe(true);
    expect(restored.node('ideFinalStep').hidden).toBe(true);
    const first = restored.node('ideSessionHistory').children[0];
    expect(first.children[0].textContent).toContain('Erster Beitrag');
    expect(first.children[1].children.map(card => card.tagName)).toEqual(['DETAILS', 'DETAILS', 'DETAILS']);
    expect(first.children[1].children.map(card => card.getAttribute('data-state'))).toEqual(['complete', 'complete', 'complete']);
  });

  test.each([
    ['stopped', Object.assign(new Error('Abbruch'), { name: 'AbortError' }), 'stopped'],
    ['failed', new Error('Verbindung unterbrochen'), 'error']
  ])('retains the user message and settles cards after a %s turn', async (status, error, cardStatus) => {
    editor.node('idePrompt').value = 'Aufgabe';
    editor.profile.apiGenerateReply = jest.fn(async (_prompt, options) => {
      options.onReasoningSummary('Prüfung läuft.', { itemId: 'r' });
      options.onSkillStart('workspace.extended-files', { operation: 'read' });
      options.onToolEvent({ itemId: 't', name: 'lookup', status: 'running' });
      editor.node('idePrompt').value = 'Entwurf bleibt';
      throw error;
    });
    await editor.runAgent();
    expect(editor.node('idePrompt').value).toBe('Entwurf bleibt');
    expect(editor.node('ideCurrentUserText').textContent).toBe('Aufgabe');
    expect(session.lastTurn.status).toBe(status);
    expect(session.lastTurn.activities.every(activity => activity.status === cardStatus)).toBe(true);
    expect(editor.state.history).toEqual([]);
    expect(editor.state.busy).toBe(false);
  });

  test('recovers interrupted cards after a restart and still accepts legacy sessions', async () => {
    editor.browser.values.set('codexIdeAgentSessionsV1', JSON.stringify([
      { id: 'running', history: [], turns: [{ id: '1', user: 'Aufgabe', status: 'running',
        activities: [{ type: 'reasoning', text: 'Prüfung', status: 'running' },
          { type: 'skill', status: 'running', run: { id: 'workspace.extended-files', status: 'running' } }] }] },
      { id: 'legacy', history: [{ user: 'Frage', reply: 'Antwort' }] }
    ]));
    await editor.initializeAgentSessions();
    expect(editor.state.sessions[0].lastTurn.status).toBe('interrupted');
    expect(editor.state.sessions[0].lastTurn.activities.map(activity => activity.status)).toEqual(['stopped', 'stopped']);
    expect(editor.state.sessions[0].lastTurn.activities[1].run.status).toBe('cancelled');
    editor.showAgentSession(editor.state.sessions[1], false);
    expect(editor.node('ideSessionHistory').textContent).toContain('Antwort');
  });

  test('shows an editor action while all file persistence still goes through the visible editor', async () => {
    editor.node('idePrompt').value = 'Neue Datei';
    editor.profile.apiGenerateReply = jest.fn(async (_prompt, options) => {
      await options.onEditorWrite({ operation: 'write', path: 'fresh.js', content: 'x' }, { persist: true });
      expect(editor.node('ideEditor').value).toBe('x');
      return '<codex_ide_final>Gespeichert.</codex_ide_final>';
    });
    await editor.runAgent();
    expect(editor.profile.writeModelHomeWorkspaceFile).toHaveBeenCalledTimes(1);
    expect(session.lastTurn.activities).toEqual([expect.objectContaining({
      type: 'tool', source: 'editor', operation: 'write', target: 'fresh.js', status: 'complete'
    })]);
  });

  test.each(['busy', 'fileBusy', 'consoleBusy'])('keeps input intact when %s prevents submission', async field => {
    editor.state[field] = true;
    editor.node('idePrompt').value = 'Noch nicht senden';
    editor.profile.apiGenerateReply = jest.fn();
    await editor.runAgent();
    expect(editor.node('idePrompt').value).toBe('Noch nicht senden');
    expect(session.turns).toHaveLength(0);
    expect(editor.profile.apiGenerateReply).not.toHaveBeenCalled();
  });

  test('keeps invalid-path and blank submissions out of the conversation', async () => {
    editor.profile.apiGenerateReply = jest.fn();
    editor.node('idePrompt').value = '  \n ';
    await editor.runAgent();
    editor.node('idePrompt').value = 'Aufgabe';
    editor.node('idePath').value = '../outside.js';
    await editor.runAgent();
    expect(editor.node('idePrompt').value).toBe('Aufgabe');
    expect(session.turns).toHaveLength(0);
    expect(editor.profile.apiGenerateReply).not.toHaveBeenCalled();
  });

  test('sends on Enter, respects Shift+Enter and composition, and grows the composer', () => {
    const prompt = editor.node('idePrompt');
    const submit = editor.node('idePromptForm').requestSubmit = jest.fn();
    const event = { type: 'keydown', key: 'Enter', preventDefault: jest.fn() };
    prompt.dispatchEvent({ ...event, shiftKey: true });
    prompt.dispatchEvent({ ...event, isComposing: true });
    prompt.dispatchEvent({ ...event, keyCode: 229 });
    expect(submit).not.toHaveBeenCalled();
    prompt.dispatchEvent(event);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    prompt.scrollHeight = 150;
    prompt.dispatchEvent({ type: 'input' });
    expect(prompt.style.height).toBe('150px');
    prompt.scrollHeight = 900;
    prompt.dispatchEvent({ type: 'input' });
    expect(prompt.style.height).toBe('220px');
  });

  test('ignores late output from a turn that already finished', async () => {
    let callbacks;
    editor.node('idePrompt').value = 'Aufgabe';
    editor.profile.apiGenerateReply = jest.fn(async (_prompt, options) => {
      callbacks = options;
      return '<codex_ide_final>Erledigt.</codex_ide_final>';
    });
    await editor.runAgent();
    callbacks.onReasoningSummary('Verspätet', { itemId: 'r' });
    callbacks.onSkillStart('workspace.extended-files', { operation: 'read' });
    callbacks.onToolEvent({ itemId: 't', name: 'lookup', status: 'running' });
    callbacks.onToken('', '<codex_ide_final>Verspätet</codex_ide_final>');
    expect(editor.state.activities).toHaveLength(0);
    expect(session.lastTurn.activities).toHaveLength(0);
    expect(editor.node('ideFinal').textContent).toBe('Erledigt.');
  });
});

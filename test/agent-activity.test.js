'use strict';

const { createEditor } = require('./helpers/editor');

describe('native App Server work summaries', () => {
  let editor;
  const scope = { threadId: 'thread-1', turnId: 'turn-1', itemId: 'reasoning-1', summaryIndex: 0 };

  beforeEach(() => { editor = createEditor(); });

  test('renders actual server summaries as cards without duplicating tagged model thoughts', async () => {
    editor.state.busy = false;
    editor.node('idePrompt').value = 'Bitte prüfe die Anwendung.';
    editor.profile.get = () => 'codex';
    editor.profile.apiGenerateReply = jest.fn(async (_prompt, options) => {
      expect(editor.node('ideActivity').hidden).toBe(true);
      expect(editor.state.activities).toHaveLength(0);
      if (options.onPhase) options.onPhase('model', { reason: 'editor-repair' });
      options.onReasoningSummary('Die Prüfung ist abgeschlossen.', scope);
      options.onToken('', '<codex_ide_thought>Doppelte Arbeitsnotiz.</codex_ide_thought>');
      return '<codex_ide_thought>Doppelte Arbeitsnotiz.</codex_ide_thought><codex_ide_final>Erledigt.</codex_ide_final>';
    });
    await editor.runAgent();
    expect(editor.profile.apiGenerateReply).toHaveBeenCalledTimes(1);
    expect(editor.state.activities.map(activity => activity.type)).toEqual(['reasoning']);
    expect(editor.state.activities[0].nodes.content.textContent).toBe('Die Prüfung ist abgeschlossen.');
    expect(editor.node('ideActivity').children[0].tagName).toBe('DETAILS');
    expect(editor.state.activities[0].nodes.title.textContent).toBe('Denkschritt');
    expect(editor.state.activities[0].nodes.source.textContent).toBe('App Server');
    expect(editor.node('ideFinal').textContent).toBe('Erledigt.');
  });

  test('keeps all summary parts and stable DOM nodes across skill events', () => {
    editor.appendReasoningSummary('Ich prüfe ', scope);
    const first = editor.node('ideActivity').children[0];
    first.open = false;
    const runs = [];
    editor.updateSkillRun(runs, 'workspace.extended-files', 'running', { operation: 'read' });
    editor.appendReasoningSummary('die Einfügung.', scope);
    editor.appendReasoningSummary('Die Löschung passt.', { ...scope, summaryIndex: 1 });
    editor.updateSkillRun(runs, 'workspace.extended-files', 'completed', { operation: 'read' });
    expect(editor.node('ideActivity').children[0]).toBe(first);
    expect(first.open).toBe(false);
    expect(editor.state.activities[0].nodes.content.textContent).toBe('Ich prüfe die Einfügung.');
    expect(editor.state.activities.filter(activity => activity.type === 'reasoning').map(activity => activity.text))
      .toEqual(['Ich prüfe die Einfügung.', 'Die Löschung passt.']);
  });

  test('does not truncate or heuristically suppress server summaries', () => {
    const note = 'Die einzelnen unveränderten Zeilen bleiben bei dieser Prüfung erhalten. '.repeat(25).trim();
    editor.appendReasoningSummary(note, scope);
    editor.appendReasoningSummary(note, { ...scope, itemId: 'reasoning-2' });
    expect(editor.state.activities).toHaveLength(2);
    expect(editor.state.activities.every(activity => activity.text === note)).toBe(true);
    expect(editor.state.activities.every(activity => activity.nodes.content.textContent === note)).toBe(true);
  });

  test('separates reused IDs in recovery threads and accepts completed corrections', () => {
    editor.appendReasoningSummary('Alter Stand.', scope);
    editor.appendReasoningSummary('Neuer Stand.', { ...scope, threadId: 'recovery-thread' });
    editor.appendReasoningSummary('Bestätigter Stand.', { ...scope, replace: true });
    expect(editor.state.activities.map(activity => activity.text)).toEqual(['Bestätigter Stand.', 'Neuer Stand.']);
  });

  test('redacts private references without corrupting raw streamed whitespace', () => {
    editor.appendReasoningSummary('Ich prüfe ', scope, ['private.js']);
    editor.appendReasoningSummary('private.js gründlich.', scope, ['private.js']);
    expect(editor.state.activities[0].rawText).toBe('Ich prüfe private.js gründlich.');
    expect(editor.state.activities[0].text).toBe('Ich prüfe [interner Dateiverweis ausgeblendet] gründlich.');
  });

  test('finishes an unchanged native summary without appending text or creating a card', () => {
    editor.appendReasoningSummary('Prüfung läuft.', scope);
    const card = editor.state.activities[0].element;
    editor.appendReasoningSummary('', { ...scope, completed: true });
    expect(editor.state.activities).toHaveLength(1);
    expect(editor.state.activities[0].text).toBe('Prüfung läuft.');
    expect(card.getAttribute('data-state')).toBe('complete');
    editor.appendReasoningSummary('', { ...scope, itemId: 'empty', completed: true });
    expect(editor.state.activities).toHaveLength(1);
  });

  test('matches concurrent tool completions by server identity and retains paths and errors', () => {
    const runs = [];
    const first = { ...scope, itemId: 'read-a', operation: 'read', path: 'src/a.js', appServerTool: true };
    const second = { ...first, itemId: 'read-b', path: 'src/b.js' };
    editor.updateSkillRun(runs, 'workspace.extended-files', 'running', first);
    editor.updateSkillRun(runs, 'workspace.extended-files', 'running', second);
    const card = editor.state.activities[0].element;
    card.open = true;
    editor.updateSkillRun(runs, 'workspace.extended-files', 'failed', { ...first, error: 'Datei fehlt.' });
    editor.updateSkillRun(runs, 'workspace.extended-files', 'completed', second);
    editor.updateSkillRun(runs, 'workspace.extended-files', 'completed', second);
    expect(runs.map(run => run.status)).toEqual(['failed', 'completed']);
    expect(editor.state.activities).toHaveLength(2);
    expect(editor.state.activities[0].nodes.target.textContent).toBe('src/a.js');
    expect(editor.state.activities[0].nodes.error.textContent).toBe('Datei fehlt.');
    expect(editor.state.activities[0].element).toBe(card);
    expect(card.open).toBe(true);
    expect(card.getAttribute('data-state')).toBe('error');
    expect(editor.state.activities[1].nodes.status.textContent).toBe('Abgeschlossen');
  });

  test('keeps native tools in different threads separate and renders result text safely', () => {
    const event = { ...scope, itemId: 'mcp-1', source: 'app-server', name: 'search', target: 'docs', status: 'running' };
    editor.updateToolActivity(event);
    const card = editor.state.activities[0].element;
    editor.updateToolActivity({ ...event, status: 'completed', output: '<script>evil()</script>' });
    editor.updateToolActivity({ ...event, threadId: 'recovery', status: 'failed', error: 'Offline' });
    expect(editor.state.activities).toHaveLength(2);
    expect(editor.state.activities[0].element).toBe(card);
    expect(editor.state.activities[0].nodes.content.children).toHaveLength(0);
    expect(editor.state.activities[0].nodes.content.textContent).toBe('<script>evil()</script>');
    expect(editor.state.activities[1].status).toBe('error');
  });
});

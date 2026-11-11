#!/usr/bin/env node
'use strict';

const { spawn } = require('child_process');
const path = require('path');
const { StringDecoder } = require('string_decoder');
const { MODEL_HOME_PERMISSIONS, MODEL_HOME_TOOL_VERSION, modelHomeConfigArgs } = require('./codex-workspace-policy');

const DEFAULT_REQUEST_TIMEOUT_MS = 0;
const DEFAULT_TURN_TIMEOUT_MS = 0;
const DEFAULT_CLIENT_INFO = {
  name: 'codex_ide_gateway',
  title: 'Codex IDE Gateway',
  version: '1.0.0'
};
const CODEX_IDE_WORKSPACE_TOOL_NAME = 'codex_ide_workspace';
const CODEX_IDE_TERMINAL_TOOL_NAME = 'codex_ide_terminal';
const CODEX_IDE_WORKSPACE_TOOL = {
  type: 'function',
  name: CODEX_IDE_WORKSPACE_TOOL_NAME,
  description: 'List or read files inside the current Codex IDE model-home. All file types, hidden files, memory, dependencies and internal symlinks are accessible. Read with purpose=inspect for context, or purpose=edit to open an editor tab. Make every project change through the visible live-editor actions supplied by the current system message.',
  inputSchema: {
    type: 'object',
    properties: {
      operation: { type: 'string', enum: ['list', 'read'] },
      path: { type: 'string', description: 'Path inside model-home. Defaults to the workspace root for list.' },
      depth: { type: 'integer', minimum: 1, description: 'List depth. Defaults to one shallow level.' },
      encoding: { type: 'string', enum: ['utf8', 'base64'], description: 'Read encoding. Use base64 to inspect binary files.' },
      purpose: { type: 'string', enum: ['inspect', 'edit'], description: 'Required intent for read. inspect avoids a new editor tab; edit opens and focuses the file.' }
    },
    required: ['operation'],
    additionalProperties: false
  }
};
const CODEX_IDE_TERMINAL_TOOL = {
  type: 'function',
  name: CODEX_IDE_TERMINAL_TOOL_NAME,
  description: 'Run a verification command, test, linter or build against a disposable workspace copy. Caches and generated output may be written in that copy; they never update the real project. Edit project files only through the visible live editor. All output streams live without a runtime or output limit.',
  inputSchema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        minLength: 1,
        description: 'The exact verification command to run against the workspace copy.'
      }
    },
    required: ['command'],
    additionalProperties: false
  }
};

function asErrorMessage(err) {
  if (!err) return 'Unbekannter App-Server-Fehler';
  if (err.message) return String(err.message);
  return String(err);
}

function createJsonRpcError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { id, error };
}

function createAbortError(message) {
  const error = new Error(message || 'Codex-Turn wurde abgebrochen');
  error.name = 'AbortError';
  return error;
}

function normalizeTurnTimeoutMs(value) {
  const timeout = Number(value);
  if (!Number.isFinite(timeout) || timeout <= 0) return 0;
  return Math.min(Math.round(timeout), 2147483647);
}

function normalizeResponseLanguage(value) {
  const language = String(value || '').trim().toLowerCase();
  return /^(de|en|fr)$/.test(language) ? language : 'de';
}

function extractAgentTextFromTurn(turn) {
  if (!turn || !Array.isArray(turn.items)) return '';
  return turn.items
    .filter(item => item && item.type === 'agentMessage' && typeof item.text === 'string')
    .map(item => item.text)
    .join('\n')
    .trim();
}

class CodexAppServerClient {
  constructor(options = {}) {
    this.codexBin = options.codexBin || process.env.CODEX_BIN || 'codex';
    this.spawnImpl = options.spawnImpl || spawn;
    this.cwd = options.cwd || process.cwd();
    this.env = options.env || process.env;
    this.clientInfo = options.clientInfo || DEFAULT_CLIENT_INFO;
    this.requestTimeoutMs = options.requestTimeoutMs == null
      ? DEFAULT_REQUEST_TIMEOUT_MS : normalizeTurnTimeoutMs(options.requestTimeoutMs);
    this.turnTimeoutMs = options.turnTimeoutMs == null
      ? DEFAULT_TURN_TIMEOUT_MS
      : normalizeTurnTimeoutMs(options.turnTimeoutMs);
    this.persistSessions = options.persistSessions != null
      ? !!options.persistSessions
      : process.env.CODEX_BRIDGE_PERSIST_SESSIONS !== '0';

    this.child = null;
    this.stdoutBuffer = '';
    this.stdoutDecoder = new StringDecoder('utf8');
    this.stderrTail = '';
    this.stderrDecoder = new StringDecoder('utf8');
    this.nextId = 1;
    this.pending = new Map();
    this.notificationHandlers = new Set();
    this.turnCloseHandlers = new Set();
    this.workspaceToolHandlers = new Map();
    this.terminalToolHandlers = new Map();
    this.sessions = new Map();
    this.sessionQueues = new Map();
    this.initializing = null;
    this.initialized = false;
    this.closed = false;
    this.lastInitialize = null;
  }

  start() {
    if (this.child) return this.child;
    this.closed = false;
    // A restarted app-server is a new JSONL stream. Discard any incomplete
    // bytes or lines from the previous process so they cannot corrupt the
    // first response of the new process.
    this.stdoutBuffer = '';
    this.stdoutDecoder = new StringDecoder('utf8');
    this.stderrTail = '';
    this.stderrDecoder = new StringDecoder('utf8');
    const child = this.spawnImpl(this.codexBin, ['app-server', '--stdio', ...modelHomeConfigArgs()], {
      cwd: this.cwd,
      env: this.env,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    this.child = child;

    if (child.stdout && typeof child.stdout.on === 'function') {
      child.stdout.on('data', chunk => {
        if (this.child === child) this._handleStdout(chunk);
      });
    }
    if (child.stderr && typeof child.stderr.on === 'function') {
      child.stderr.on('data', chunk => {
        if (this.child === child) this._handleStderr(chunk);
      });
    }
    if (typeof child.on === 'function') {
      // Exit can trigger a restart before the old pipes close. Events from
      // that retired process must not affect the replacement connection.
      const handleExit = code => {
        if (this.child !== child) return;
        const detail = this.stderrTail ? ` ${this.stderrTail.trim().slice(-800)}` : '';
        this._handleClose(new Error(`Codex App Server beendet${code == null ? '' : ` mit Code ${code}`}.${detail}`.trim()));
      };
      child.on('error', err => {
        if (this.child === child) this._handleClose(err);
      });
      child.on('close', handleExit);
      child.on('exit', handleExit);
    }
    return child;
  }

  async initialize() {
    if (this.initialized) return this.lastInitialize;
    if (this.initializing) return this.initializing;

    this.start();
    this.initializing = this._requestRaw('initialize', {
      clientInfo: this.clientInfo,
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
        mcpServerOpenaiFormElicitation: false,
        optOutNotificationMethods: []
      }
    }, this.requestTimeoutMs)
      .then(response => {
        this.initialized = true;
        this.lastInitialize = response;
        this._write({ method: 'initialized' });
        return response;
      })
      .catch(err => {
        this.initializing = null;
        throw err;
      });

    return this.initializing;
  }

  async request(method, params, timeoutMs) {
    await this.initialize();
    return this._requestRaw(method, params, timeoutMs == null ? this.requestTimeoutMs : timeoutMs);
  }

  async runTurn(options = {}) {
    const sessionId = String(options.sessionId || 'default');
    return this._enqueueSession(sessionId, () => this._runTurnNow({
      ...options,
      sessionId
    }));
  }

  async runVerificationCommand(command, options = {}) {
    if (options.signal && options.signal.aborted) throw createAbortError();
    await this.initialize();
    if (options.signal && options.signal.aborted) throw createAbortError();
    const processId = `codex-ide-check-${this.nextId++}`;
    const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
    const streamed = new Set();
    const emit = value => { if (value && typeof options.onOutput === 'function') options.onOutput(value); };
    const handler = message => {
      if (message.method !== 'command/exec/outputDelta') return;
      const params = message.params || {};
      if (params.processId !== processId || !decoders[params.stream]) return;
      streamed.add(params.stream);
      emit(decoders[params.stream].write(Buffer.from(params.deltaBase64 || '', 'base64')));
    };
    const abort = () => {
      this.request('command/exec/terminate', { processId }, 0).catch(() => {});
    };
    this.notificationHandlers.add(handler);
    try {
      const completion = this.request('command/exec', {
        command, cwd: options.cwd, env: options.env,
        processId, streamStdoutStderr: true, disableTimeout: true, disableOutputCap: true,
        sandboxPolicy: {
          type: 'workspaceWrite', writableRoots: [options.temporaryRoot], networkAccess: false,
          excludeTmpdirEnvVar: true, excludeSlashTmp: true
        }
      }, 0);
      if (options.signal) {
        options.signal.addEventListener('abort', abort, { once: true });
        if (options.signal.aborted) abort();
      }
      const result = await completion;
      for (const stream of ['stdout', 'stderr']) {
        emit(decoders[stream].end());
        if (!streamed.has(stream)) emit(result[stream] || '');
      }
      if (options.signal && options.signal.aborted) throw createAbortError();
      return { code: result.exitCode };
    } finally {
      this.notificationHandlers.delete(handler);
      if (options.signal) options.signal.removeEventListener('abort', abort);
    }
  }

  async resetSession(sessionId = 'default', threadId = '') {
    const key = String(sessionId || 'default');
    const session = this.sessions.get(key);
    const persistentThreadId = String(session && session.threadId || threadId || '').trim().slice(0, 200);
    if (session) this.sessions.delete(key);
    if (!persistentThreadId) return false;
    if (this.persistSessions) {
      await this.request('thread/delete', { threadId: persistentThreadId });
    }
    return true;
  }

  getStatus() {
    return {
      running: !!this.child && !this.closed,
      initialized: !!this.initialized,
      pid: this.child && this.child.pid ? this.child.pid : null,
      codexBin: this.codexBin,
      persistSessions: this.persistSessions,
      queuedSessions: this.sessionQueues.size,
      activeTurns: this.turnCloseHandlers.size,
      sessions: Array.from(this.sessions.entries()).map(([sessionId, session]) => ({
        sessionId,
        threadId: session.threadId,
        turnCount: session.turnCount || 0,
        model: session.model || '',
        workspaceAccess: session.workspaceAccess === true,
        terminalAccess: session.terminalAccess === true,
        nativeWebSearch: session.disableWebSearch === true ? 'disabled' : 'default',
        activeTurnId: session.activeTurnId || '',
        needsResume: session.needsResume === true,
        lastStatus: session.lastStatus || '',
        createdAt: session.createdAt,
        updatedAt: session.updatedAt
      })),
      stderrTail: this.stderrTail.trim().slice(-800)
    };
  }

  _enqueueSession(sessionId, fn) {
    const previous = this.sessionQueues.get(sessionId) || Promise.resolve();
    const next = previous.catch(() => {}).then(fn);
    const queued = next.catch(() => {});
    this.sessionQueues.set(sessionId, queued);
    queued.finally(() => {
      if (this.sessionQueues.get(sessionId) === queued) {
        this.sessionQueues.delete(sessionId);
      }
    });
    return next;
  }

  async _runTurnNow(options) {
    const signal = options.signal;
    if (signal && signal.aborted) throw createAbortError();
    const workdir = path.resolve(String(options.workdir || this.cwd));
    const session = await this._ensureThread(options);
    if (signal && signal.aborted) throw createAbortError();
    const hadPreviousTurns = session.turnCount > 0;
    const text = hadPreviousTurns && options.followupPrompt
      ? options.followupPrompt
      : options.prompt;
    if (!String(text || '').trim()) {
      throw new Error('Codex App Server Prompt fehlt');
    }

    const workspaceToolHandler = options.workspaceAccess === true && typeof options.onWorkspaceToolCall === 'function'
      ? options.onWorkspaceToolCall
      : null;
    const terminalToolHandler = options.terminalAccess === true && typeof options.onTerminalToolCall === 'function'
      ? options.onTerminalToolCall
      : null;
    if (workspaceToolHandler) this.workspaceToolHandlers.set(session.threadId, workspaceToolHandler);
    if (terminalToolHandler) this.terminalToolHandlers.set(session.threadId, terminalToolHandler);
    const releaseWorkspaceToolHandler = () => {
      if (workspaceToolHandler && this.workspaceToolHandlers.get(session.threadId) === workspaceToolHandler) {
        this.workspaceToolHandlers.delete(session.threadId);
      }
      if (terminalToolHandler && this.terminalToolHandlers.get(session.threadId) === terminalToolHandler) {
        this.terminalToolHandlers.delete(session.threadId);
      }
    };

    let turnId = '';
    let contentChunks = [];
    let contentHasNonWhitespace = false;
    const completedAgentItems = [];
    let finalTurn = null;
    const reasoningSummaries = new Map();
    const completedSummaries = new Set();
    const emitReasoningSummary = (text, itemId, summaryIndex, completed = false) => {
      if (typeof text !== 'string') return;
      const key = JSON.stringify([itemId || '', summaryIndex]);
      const previous = reasoningSummaries.get(key) || '';
      if (completed && completedSummaries.has(key) && previous === text) return;
      const replace = completed && !text.startsWith(previous);
      const delta = completed && !replace ? text.slice(previous.length) : text;
      reasoningSummaries.set(key, completed ? text : previous + text);
      if (completed) completedSummaries.add(key);
      if ((delta || replace || completed) && typeof options.onReasoningSummary === 'function') {
        options.onReasoningSummary(delta, {
          threadId: session.threadId, turnId, itemId: itemId || '', summaryIndex,
          ...(replace ? { replace: true } : {}),
          ...(completed ? { completed: true } : {})
        });
      }
    };
    const completeReasoningItem = item => {
      if (!item || item.type !== 'reasoning' || !Array.isArray(item.summary)) return;
      item.summary.forEach((part, index) => {
        const text = typeof part === 'string' ? part : part && part.text;
        emitReasoningSummary(text, item.id, index, true);
      });
    };
    const timeoutMs = options.timeoutMs == null
      ? this.turnTimeoutMs
      : normalizeTurnTimeoutMs(options.timeoutMs);
    let cleanupDone = () => {};
    let rejectDone = () => {};
    let closeHandler = null;
    let terminationError = null;

    const interruptTurn = () => {
      if (!turnId) return Promise.resolve(false);
      return this.request('turn/interrupt', {
        threadId: session.threadId,
        turnId
      }).then(() => true, () => false);
    };

    const done = new Promise((resolve, reject) => {
      rejectDone = reject;
      let cleaned = false;
      const requestTermination = error => {
        if (terminationError) return;
        terminationError = error;
        interruptTurn().catch(() => {});
      };
      const timer = timeoutMs > 0
        ? setTimeout(() => {
            requestTermination(new Error(`Codex App Server Timeout nach ${timeoutMs} ms`));
          }, timeoutMs)
        : null;

      const abortHandler = () => {
        requestTermination(createAbortError());
      };

      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        clearTimeout(timer);
        releaseWorkspaceToolHandler();
        this.notificationHandlers.delete(handler);
        if (closeHandler) this.turnCloseHandlers.delete(closeHandler);
        if (signal && typeof signal.removeEventListener === 'function') {
          signal.removeEventListener('abort', abortHandler);
        }
      };
      cleanupDone = cleanup;

      closeHandler = err => {
        cleanup();
        reject(err);
      };

      const handler = message => {
        if (!message || !message.method) return;
        const params = message.params || {};
        if (turnId && params.turnId && params.turnId !== turnId) return;
        if (params.threadId && params.threadId !== session.threadId) return;
        if (!turnId && params.turnId) turnId = String(params.turnId);

        if (message.method === 'item/agentMessage/delta') {
          const delta = typeof params.delta === 'string' ? params.delta : '';
          if (delta) {
            contentChunks.push(delta);
            if (/\S/.test(delta)) contentHasNonWhitespace = true;
            if (typeof options.onToken === 'function') options.onToken(delta);
          }
          return;
        }

        if (message.method === 'item/reasoning/summaryTextDelta') {
          const delta = typeof params.delta === 'string' ? params.delta : '';
          if (delta) emitReasoningSummary(delta, params.itemId,
            Number.isFinite(Number(params.summaryIndex)) ? Number(params.summaryIndex) : 0);
          return;
        }

        // These notifications describe executed tools; they grant no access or
        // approvals. Workspace and console tools already have dedicated events.
        if ((message.method === 'item/started' || message.method === 'item/completed') && params.item &&
            ['mcpToolCall', 'dynamicToolCall', 'imageView'].includes(params.item.type)) {
          const item = params.item;
          if (![CODEX_IDE_WORKSPACE_TOOL_NAME, CODEX_IDE_TERMINAL_TOOL_NAME].includes(item.tool) &&
              typeof options.onToolEvent === 'function') {
            const output = item.result == null ? '' : typeof item.result === 'string' ? item.result : JSON.stringify(item.result);
            const error = item.error == null ? '' : typeof item.error === 'string' ? item.error : JSON.stringify(item.error);
            options.onToolEvent({
              itemId: String(item.id || ''), threadId: session.threadId, turnId: String(params.turnId || turnId),
              source: 'app-server', name: String(item.tool || item.type),
              target: String(item.server || item.path || ''),
              status: message.method === 'item/started' ? 'running'
                : error || item.success === false || item.status === 'failed' ? 'failed' : 'completed',
              output, error
            });
          }
          return;
        }

        if (message.method === 'item/commandExecution/outputDelta') {
          const delta = typeof params.delta === 'string' ? params.delta : '';
          if (delta && typeof options.onTerminalOutput === 'function') {
            options.onTerminalOutput(delta, {
              itemId: String(params.itemId || ''),
              threadId: session.threadId,
              turnId: String(params.turnId || turnId || '')
            });
          }
          return;
        }

        if (message.method === 'item/commandExecution/terminalInteraction') {
          const input = typeof params.stdin === 'string' ? params.stdin : '';
          if (input && typeof options.onTerminalInput === 'function') {
            options.onTerminalInput(input, {
              itemId: String(params.itemId || ''),
              threadId: session.threadId,
              processId: String(params.processId || ''),
              turnId: String(params.turnId || turnId || '')
            });
          }
          return;
        }

        if ((message.method === 'item/started' || message.method === 'item/completed') &&
            params.item && params.item.type === 'commandExecution') {
          const callback = message.method === 'item/started'
            ? options.onTerminalStart
            : options.onTerminalComplete;
          if (typeof callback === 'function') callback({ ...params.item,
            itemId: params.item.id, threadId: session.threadId, turnId: String(params.turnId || turnId) });
          return;
        }

        if (message.method === 'item/completed' && params.item && params.item.type === 'fileChange') {
          if (typeof options.onWorkspaceChange === 'function') options.onWorkspaceChange(params.item);
          return;
        }

        if ((message.method === 'item/started' || message.method === 'item/completed') &&
            params.item && params.item.type === 'webSearch') {
          if (options.disableWebSearch === true) {
            requestTermination(new Error('Codex App Server Policy-Verstoss: Websuche ist im lokalen IDE-Workspace deaktiviert'));
            return;
          }
          const callback = message.method === 'item/started'
            ? options.onWebSearchStart
            : options.onWebSearchComplete;
          if (typeof callback === 'function') callback({ ...params.item,
            itemId: params.item.id, threadId: session.threadId, turnId: String(params.turnId || turnId) });
          return;
        }

        if (message.method === 'item/completed' &&
            params.item && params.item.type === 'agentMessage' &&
            typeof params.item.text === 'string') {
          completedAgentItems.push(params.item);
          return;
        }

        if (message.method === 'item/completed' && params.item && params.item.type === 'reasoning') {
          completeReasoningItem(params.item);
          return;
        }

        if (message.method === 'turn/completed') {
          const turn = params.turn || {};
          if (turnId && turn.id && turn.id !== turnId) return;
          if (Array.isArray(turn.items)) turn.items.forEach(completeReasoningItem);
          finalTurn = turn;
          cleanup();
          if (terminationError) {
            reject(terminationError);
            return;
          }
          if (turn.status === 'failed') {
            const reason = turn.error && turn.error.message
              ? turn.error.message
              : 'Codex App Server Turn fehlgeschlagen';
            reject(new Error(reason));
            return;
          }
          if (turn.status === 'interrupted') {
            reject(new Error('Codex App Server Turn wurde unerwartet unterbrochen'));
            return;
          }
          if (!contentHasNonWhitespace) {
            const fallbackContent = extractAgentTextFromTurn(turn) ||
              extractAgentTextFromTurn({ items: completedAgentItems });
            contentChunks = fallbackContent ? [fallbackContent] : [];
          }
          resolve({
            content: contentChunks.join('').trim(),
            threadId: session.threadId,
            turnId: turn.id || turnId,
            turn
          });
        }
      };

      this.notificationHandlers.add(handler);
      this.turnCloseHandlers.add(closeHandler);
      if (signal && typeof signal.addEventListener === 'function') {
        signal.addEventListener('abort', abortHandler, { once: true });
      }
    });
    done.catch(() => {});

    let turnResponse;
    try {
      turnResponse = await this.request('turn/start', {
        threadId: session.threadId,
        input: [{
          type: 'text',
          text: String(text),
          text_elements: []
        }],
        cwd: workdir,
        runtimeWorkspaceRoots: [workdir],
        approvalPolicy: 'never',
        permissions: MODEL_HOME_PERMISSIONS,
        model: options.model || null,
        effort: options.reasoningEffort || null,
        outputSchema: options.outputSchema || null,
        // Concise native summaries expose the model's current task-level work
        // without disclosing private chain-of-thought.
        summary: 'concise'
      }, this.requestTimeoutMs);
    } catch (err) {
      cleanupDone();
      rejectDone(err);
      await done.catch(() => {});
      throw err;
    }
    turnId = turnResponse && turnResponse.turn && turnResponse.turn.id
      ? turnResponse.turn.id
      : '';
    session.activeTurnId = turnId;
    session.lastStatus = 'inProgress';
    session.updatedAt = new Date().toISOString();
    if (typeof options.onSessionMetadata === 'function') {
      options.onSessionMetadata({
        sessionId: session.sessionId,
        threadId: session.threadId,
        workspaceToolVersion: MODEL_HOME_TOOL_VERSION,
        turnId
      });
    }
    if (terminationError) await interruptTurn();

    try {
      return await done;
    } finally {
      session.activeTurnId = '';
      session.turnCount = (session.turnCount || 0) + 1;
      session.updatedAt = new Date().toISOString();
      if (finalTurn && finalTurn.status) {
        session.lastStatus = finalTurn.status;
      } else if (terminationError) {
        session.lastStatus = terminationError.name === 'AbortError' ? 'interrupted' : 'failed';
      }
    }
  }

  async _ensureThread(options) {
    await this.initialize();
    const sessionId = String(options.sessionId || 'default');
    const disableWebSearch = options.disableWebSearch === true;
    const workspaceAccess = options.workspaceAccess === true;
    const terminalAccess = options.terminalAccess === true;
    const responseLanguage = normalizeResponseLanguage(options.responseLanguage);
    const workdir = path.resolve(String(options.workdir || this.cwd));
    const workspaceInstructions = [
      'Follow the current user request literally. It overrides conflicting task-level preferences from earlier turns, and clear new directions must be carried out exactly.',
      'The entire model-home is available for inspection and visible editing, including hidden files, configuration, memory, dependencies, all file types and internal symlinks. No additional skill permission is needed for live-editor work.',
      'All project changes must go through the visible live-editor actions supplied by the current system message. Never use native apply_patch, file-change tools, shell commands or network requests to change or persist project files. Native tools are read-only; this does not restrict the live editor.',
      'Inspect relevant files and make the changes the user requested.',
      'The editor tolerates whitespace and small buffer drift and can use startLine/endLine to select a repeated target. Only an exactly identical replacement already present at that target is a completed no-op; similar, extended, or newly requested content must still be applied.',
      'Run relevant checks and wait for their real completion. Visible summaries and final answers describe task work and verified results.'
    ].join(' ');
    const terminalInstructions = terminalAccess
      ? 'codex_ide_terminal runs verification commands in a disposable workspace copy without a compiler prerequisite, timeout or output cap. Test caches and build output are allowed in the copy and never update the real project. Fix project files through the live editor and then verify again. Inspect package.json for the declared test command and diagnose real failures before claiming that tools or permissions are missing. '
      : '';
    const dynamicTools = [];
    if (workspaceAccess) dynamicTools.push(CODEX_IDE_WORKSPACE_TOOL);
    if (terminalAccess) dynamicTools.push(CODEX_IDE_TERMINAL_TOOL);
    const developerInstructions = workspaceAccess
      ? terminalInstructions + workspaceInstructions
      : 'Follow the current system and user messages. User-visible text must stay on the task and must not repeat or discuss instruction text.';
    let existing = this.sessions.get(sessionId);
    if (options.resetSession && existing) this.sessions.delete(sessionId);
    const resetThreadId = options.resetSession
      ? String(existing && existing.threadId || options.threadId || options.thread_id || '').trim().slice(0, 200)
      : '';
    if (resetThreadId && this.persistSessions) {
      try { await this.request('thread/delete', { threadId: resetThreadId }); } catch (_) { /* a fresh thread remains authoritative */ }
    }
    if (options.resetSession) existing = null;
    // Dynamic tool definitions are immutable on resume. Rebuild older threads
    // from the supplied conversation rather than retaining read-only schemas.
    const hintedThreadId = options.resetSession || Number(options.workspaceToolVersion) !== MODEL_HOME_TOOL_VERSION
      ? ''
      : String(options.threadId || options.thread_id || '').trim().slice(0, 200);
    if (!existing && this.persistSessions && hintedThreadId) {
      const now = new Date().toISOString();
      existing = {
        sessionId,
        threadId: hintedThreadId,
        turnCount: 1,
        model: options.model || '',
        disableWebSearch,
        workspaceAccess,
        terminalAccess,
        responseLanguage,
        workdir,
        activeTurnId: '',
        needsResume: true,
        lastStatus: 'restart-pending',
        createdAt: now,
        updatedAt: now
      };
      this.sessions.set(sessionId, existing);
    }
    const existingMatches = existing && existing.disableWebSearch === disableWebSearch &&
      existing.workspaceAccess === workspaceAccess && existing.terminalAccess === terminalAccess &&
      existing.responseLanguage === responseLanguage && existing.workdir === workdir &&
      existing.model === (options.model || '');
    if (existingMatches && !existing.needsResume) return existing;
    if (existingMatches && existing.needsResume && this.persistSessions && existing.threadId) {
      try {
        await this.request('thread/resume', {
          threadId: existing.threadId,
          cwd: workdir,
          runtimeWorkspaceRoots: [workdir],
          model: options.model || null,
          approvalPolicy: 'never',
          config: disableWebSearch ? { web_search: 'disabled' } : null,
          developerInstructions,
          permissions: MODEL_HOME_PERMISSIONS
        }, this.requestTimeoutMs);
        existing.needsResume = false;
        existing.lastStatus = 'resumed';
        existing.updatedAt = new Date().toISOString();
        return existing;
      } catch (_) {
        this.sessions.delete(sessionId);
      }
    } else if (existing) {
      this.sessions.delete(sessionId);
      if (this.persistSessions && existing.threadId) {
        try { await this.request('thread/delete', { threadId: existing.threadId }); } catch (_) { /* replacement still starts cleanly */ }
      }
    }

    const response = await this.request('thread/start', {
      cwd: workdir,
      runtimeWorkspaceRoots: [workdir],
      model: options.model || null,
      dynamicTools: dynamicTools.length > 0 ? dynamicTools : null,
      approvalPolicy: 'never',
      config: disableWebSearch ? { web_search: 'disabled' } : null,
      developerInstructions,
      permissions: MODEL_HOME_PERMISSIONS,
      serviceName: 'codex-ide-gateway',
      ephemeral: !this.persistSessions
    }, this.requestTimeoutMs);
    const threadId = response && response.thread && response.thread.id
      ? response.thread.id
      : '';
    if (!threadId) throw new Error('Codex App Server lieferte keine Thread-ID');

    const now = new Date().toISOString();
    const session = {
      sessionId,
      threadId,
      turnCount: 0,
      model: options.model || '',
      disableWebSearch,
      workspaceAccess,
      terminalAccess,
      responseLanguage,
      workdir,
      activeTurnId: '',
      needsResume: false,
      createdAt: now,
      updatedAt: now
    };
    this.sessions.set(sessionId, session);
    return session;
  }

  _requestRaw(method, params, timeoutMs) {
    if (this.closed) {
      return Promise.reject(new Error('Codex App Server ist geschlossen'));
    }
    this.start();
    const id = `codex-ide-${this.nextId++}`;
    const message = { method, id };
    if (params !== undefined) message.params = params;

    return new Promise((resolve, reject) => {
      const timer = timeoutMs > 0 ? setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex App Server Request Timeout (${method}) nach ${timeoutMs} ms`));
      }, timeoutMs) : null;
      this.pending.set(id, {
        method,
        resolve: value => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: err => {
          clearTimeout(timer);
          reject(err);
        }
      });

      try {
        this._write(message);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  _write(message) {
    if (!this.child || !this.child.stdin || this.closed) {
      throw new Error('Codex App Server stdin ist nicht verfuegbar');
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  _handleStdout(chunk) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    this.stdoutBuffer += this.stdoutDecoder.write(bytes);
    let index;
    while ((index = this.stdoutBuffer.indexOf('\n')) !== -1) {
      const line = this.stdoutBuffer.slice(0, index).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(index + 1);
      if (!line) continue;
      this._handleLine(line);
    }
  }

  _handleStderr(chunk) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    this.stderrTail += this.stderrDecoder.write(bytes);
    if (this.stderrTail.length > 4000) {
      this.stderrTail = this.stderrTail.slice(-4000);
    }
  }

  _handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch (_) {
      this._handleStderr(`${line}\n`);
      return;
    }

    if (Object.prototype.hasOwnProperty.call(message, 'id') &&
        (Object.prototype.hasOwnProperty.call(message, 'result') ||
          Object.prototype.hasOwnProperty.call(message, 'error'))) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (Object.prototype.hasOwnProperty.call(message, 'id') && message.method) {
      this._handleServerRequest(message);
      return;
    }

    if (message.method) {
      for (const handler of Array.from(this.notificationHandlers)) {
        try {
          handler(message);
        } catch (_) {
          // Notification handlers are per-turn observers; one failing observer
          // must not break the shared app-server connection.
        }
      }
    }
  }

  _handleServerRequest(message) {
    const method = message.method;
    const id = message.id;
    if (method === 'item/tool/call') {
      const params = message.params || {};
      const threadId = String(params.threadId || '');
      const isWorkspaceTool = params.tool === CODEX_IDE_WORKSPACE_TOOL_NAME;
      const isTerminalTool = params.tool === CODEX_IDE_TERMINAL_TOOL_NAME;
      const handler = isWorkspaceTool
        ? this.workspaceToolHandlers.get(threadId)
        : isTerminalTool ? this.terminalToolHandlers.get(threadId) : null;
      if (!handler || (!isWorkspaceTool && !isTerminalTool)) {
        this._write({
          id,
          result: {
            success: false,
            contentItems: [{ type: 'inputText', text: 'Das angeforderte Codex-IDE-Werkzeug ist für diesen Turn nicht verfügbar.' }]
          }
        });
        return;
      }
      Promise.resolve()
        .then(() => handler(params))
        .then(result => {
          const value = result && typeof result === 'object' ? result : {};
          const text = typeof value.text === 'string' ? value.text : '';
          this._write({
            id,
            result: {
              success: value.success !== false,
              contentItems: [{
                type: 'inputText',
                text: text || (isTerminalTool ? 'Konsolenlauf ohne Ausgabe.' : 'Workspace-Zugriff ohne Ergebnis.')
              }]
            }
          });
        })
        .catch(error => {
          this._write({
            id,
            result: {
              success: false,
              contentItems: [{
                type: 'inputText',
                text: (isTerminalTool ? 'Konsolenlauf' : 'Workspace-Zugriff') + ' fehlgeschlagen: ' + asErrorMessage(error).slice(0, 300)
              }]
            }
          });
        });
      return;
    }
    if (method === 'currentTime/read') {
      this._write({ id, result: { currentTimeAt: Math.floor(Date.now() / 1000) } });
      return;
    }
    if (method === 'item/commandExecution/requestApproval') {
      this._write({ id, result: { decision: 'cancel' } });
      return;
    }
    if (method === 'item/fileChange/requestApproval') {
      this._write({ id, result: { decision: 'decline' } });
      return;
    }
    if (method === 'applyPatchApproval' || method === 'execCommandApproval') {
      this._write({ id, result: { decision: 'denied' } });
      return;
    }
    if (method === 'item/tool/requestUserInput') {
      this._write({ id, result: { answers: {} } });
      return;
    }
    if (method === 'mcpServer/elicitation/request') {
      this._write({ id, result: { action: 'cancel', content: null, _meta: null } });
      return;
    }
    this._write(createJsonRpcError(id, -32601, `Codex IDE Gateway unterstuetzt Server-Request ${method} nicht`));
  }

  _handleClose(err) {
    if (this.closed && !this.child) return;
    this.closed = true;
    this.child = null;
    this.stdoutBuffer = '';
    this.stdoutDecoder = new StringDecoder('utf8');
    this.stderrDecoder = new StringDecoder('utf8');
    this.initialized = false;
    this.initializing = null;
    if (this.persistSessions) {
      const now = new Date().toISOString();
      for (const session of this.sessions.values()) {
        session.activeTurnId = '';
        session.needsResume = !!session.threadId;
        session.lastStatus = 'failed';
        session.updatedAt = now;
      }
    } else {
      this.sessions.clear();
    }
    this.workspaceToolHandlers.clear();
    this.terminalToolHandlers.clear();
    const error = err instanceof Error ? err : new Error(asErrorMessage(err));
    for (const handler of Array.from(this.turnCloseHandlers)) {
      try {
        handler(error);
      } catch (_) {
        // Reject every active turn even if one observer unexpectedly fails.
      }
    }
    this.turnCloseHandlers.clear();
    this.notificationHandlers.clear();
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}

module.exports = {
  CodexAppServerClient,
  CODEX_IDE_TERMINAL_TOOL,
  CODEX_IDE_TERMINAL_TOOL_NAME,
  CODEX_IDE_WORKSPACE_TOOL,
  CODEX_IDE_WORKSPACE_TOOL_NAME,
  extractAgentTextFromTurn
};

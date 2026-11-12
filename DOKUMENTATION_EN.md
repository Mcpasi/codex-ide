# Codex IDE: architecture and operations

## Overview

Codex IDE ships as one browser application. `index.html` loads the IDE, its settings, and four backend profiles directly. The local gateway serves the static application shell, model-home policy, Codex App Server and Antigravity CLI from the same loopback origin.

## Interface and visual identity

The header carries the localized line **Your agent at work — every change, live.** The dark interface uses crimson and coral for brand and interaction accents, while success, activity, warning, and error states retain supporting copy, state markers, and distinct status colors. The three-column desktop layout becomes two columns at 1050 pixels and a single mobile flow at 700 pixels. Below 420 pixels, the wordmark, slogan, and editor metadata become more compact without hiding editor or agent features.

```text
Browser IDE
  editor + settings + backend dispatch + skills
        |
        | localhost HTTP / SSE
        v
Codex IDE Gateway
  static allowlist + workspace policy + Codex App Server
        |
        v
model-home/
```

## Commands

Every project command starts with the Codex IDE CLI:

```bash
codex-ide start
codex-ide gateway
codex-ide clean
codex-ide version
codex-ide update
codex-ide update --yes
codex-ide codex login
codex-ide codex status
codex-ide antigravity login
codex-ide antigravity status
codex-ide skill validate <directory>
codex-ide skill pack <directory> [output.codexskill]
```

`start` runs the gateway and opens the browser. `gateway` keeps the browser closed unless `--open` is supplied. The default bind is `127.0.0.1:8787`.

The local `./codex-ide` launcher remains available for source-directory development. Under **Settings → Codex auth bridge**, `/codex/usage` reads `account/rateLimits/read` from the local App Server and renders remaining daily/short-window and weekly allowances as two blue percentage bars. At 20 percent or less a bar becomes red and also carries a low text label; periods omitted by Codex stay visibly unavailable instead of being estimated. The browser receives normalized percentages, never CLI auth files or tokens. The published npm package uses a positive `files` allowlist plus a nested `model-home/.npmignore` for the runnable shell, bridge, gateway, skills, skill packages, translations, documentation, and only `model-home/.gitkeep`; dependencies, tests, build sources, internal agent files, and all other workspace contents are excluded. Keep `.gitkeep` and `.npmignore` during manual workspace cleanup; npm does not publish the ignore file itself.

`codex-ide version` prints the installed semantic version. `codex-ide update` reads the npm `latest` dist-tag directly, waits up to 20 seconds for slower registry responses, prompts before installing it globally, and supports `--yes`. An interactive globally installed `codex-ide start` offers a newer stable version before gateway startup. `--no-update-check` and `CODEX_IDE_NO_UPDATE_CHECK=1` skip only that startup check. Source checkouts and local dependency installations are never self-updated.

Source checkouts use `<project>/model-home`. npm installations use the current user's persistent data directory: `$XDG_DATA_HOME/codex-ide/model-home` or `~/.local/share/codex-ide/model-home` on Linux/Termux, `~/Library/Application Support/codex-ide/model-home` on macOS, and `%LOCALAPPDATA%/codex-ide/model-home` on Windows. Existing package-local data is copied once through a temporary directory; the original remains intact, copied files and directories gain owner write permissions, and internal absolute symlinks are relocated. An existing user workspace is kept on later starts. Explicit model-home configuration retains its path. The gateway prints the active path and uses it consistently for reads, previews, user consoles and visible editor persistence.

The active user workspace lives outside the npm package and survives its replacement. Before npm replaces the package, the CLI additionally backs up the legacy package-local `model-home` and hashes its files, directories, and symlink targets. After either npm success or failure, it reconstructs that legacy directory at the same project path and verifies the digest again. The temporary copy is deleted only after a confirmed match and is retained for recovery if restoration fails.

## Backend dispatch

`backendProfile.js` supports four values:

- `local`: calls `window.CodexIdeLocalModel`.
- `api`: calls a configured OpenAI-compatible chat-completions endpoint.
- `codex`: calls the local gateway with session, editor, language, model, and reasoning metadata.
- `antigravity`: calls `/antigravity/v1/chat/completions` using the same editor, SSE, recovery and persistence pipeline. Configuration and conversation IDs remain independent of Codex.

All modes share the agent loop, control blocks, skill registry, and editor callbacks. Only their transport and model-side workspace read mechanism differ.

### Antigravity CLI

`scripts/backends/antigravity.js` owns authentication probes, model discovery and persistent process management through the [official NDJSON protocol](https://antigravity.google/docs/cli/headless/). It launches `agy` (or `ANTIGRAVITY_BIN`) and leaves credentials and provider communication inside the official CLI. Login delegates to `agy acp --login`; the status probe uses `--print /usage --output-format json` without generating a model response. See the [official authentication guide](https://antigravity.google/docs/ide/extensions/acp).

One process stays open per session across planner, editor, audit and follow-up steps. Each `result` event completes its turn without waiting for process exit. Cancellation, reset and gateway shutdown stop the relevant processes. Model or effort changes resume the same conversation in a new process; aborted or failed processes start fresh. Incremental UTF-8/NDJSON parsing preserves fragmented Unicode and avoids repeatedly scanning a growing line. Final response envelopes do not duplicate already streamed text.

Session-only `--settings` deny native writes, shell commands, MCP and network tools according to the [official permission format](https://antigravity.google/docs/settings?tab=cli). The visible editor retains full workspace editing and automatic saving. Internal `codex_ide_workspace_request` blocks connect reads, listings and verification commands to the existing workspace handlers and live console events. Verification runs on disposable workspace copies. External browser skills retain their explicit permissions.

The routes `/antigravity/status`, `/antigravity/v1/models`, `/antigravity/v1/chat/completions`, `/antigravity/sessions` and `/antigravity/session/reset` use the existing host/origin checks and bypass service worker caches. Shared file routes remain under `/codex-ide/*`.

For the local model, a per-call token budget applies only to that generation and never changes the saved user limit. In the Codex profile, `low`, `medium`, `high`, `xhigh`, `max`, and `ultra` survive model-catalog transport; the IDE offers only the selected model's advertised `supported_reasoning_efforts`.

## Workspace policy

The default root is `<project>/model-home` in source checkouts and the user's data directory in npm installations, as described above. Workspace file tools normalize relative or absolute paths and require resolved paths and symlink targets to remain inside the active root. All file types, hidden configuration, dependencies and memory are accessible. Internal symlinks can point to not-yet-created targets. Model prompts refer to the workspace as `model-home`.

Without an explicit origin allowlist, the HTTP boundary accepts only `localhost` or IP literals as browser hosts, blocking DNS-rebinding requests that pair an attacker-controlled hostname with the same Origin. JSON bodies use stateful UTF-8 decoding so multibyte characters survive transport chunk boundaries. Static allowlisted files are served only when their resolved real path remains inside the application-shell root.

The visible editor reads and persists through `/codex-ide/ide-files` with `X-Codex-IDE-Workspace: model-home`. Agent persistence also carries a validated `operation`: `write` atomically requires a free path, while `edit` atomically requires an existing target. This bounded channel is implicit for validated editor actions and does not claim an optional skill event. Generic extended-file access remains separately permission-gated.

When the active buffer is a saved `.html` file, a small play button appears in the editor header and opens `GET /codex-ide/preview/<relative-path>` in a new browser tab. Other file types and unnamed new buffers do not show it. The route serves only approved web asset types read-only from `model-home`, supports relative classic CSS/JavaScript and media resources, and uses `Cache-Control: no-store`. Path normalization, protected-directory, reserved-target, and symlink boundaries remain active. HTML responses run in a CSP sandbox with scripts enabled but without `allow-same-origin`, preventing preview code from accessing IDE storage or treating IDE endpoints as same-origin. The preview does not broaden editor, skill, or write permissions.

The direct user console is a separate local channel. The browser intercepts the exact `/console start` and `/console close` directives before backend selection, model invocation, or session persistence. A new command is sent as `POST /codex-ide/console` with `X-Codex-IDE-Workspace: model-home` and `X-Codex-IDE-Console: user`; both browser and server permit at most one user command at a time. The route streams start, stdout/stderr, and completion as `codexIde.terminal_event` records into the same visible console card with a **User** source label. While the process runs, the prompt, **Send input**, and **Stop** remain available together. Every subsequent line, including a blank line, is posted with the run ID to `/codex-ide/console/input` and forwarded to that process’s active PTY; mismatched or completed run IDs receive HTTP 409. **Stop** terminates the process, while `/console close` exits the mode and hides the card without deleting its visible run record. Completion closes the input channel, removes the run binding, invalidates the workspace snapshot, and refreshes the file tree.

This separate explicit user channel runs in the real `model-home`. Its shell defines `rm` with recursive behavior by default only for this channel, so `rm folder` removes a normal nested directory tree while explicit options remain available. The runner connects the user process’s stdin, stdout, and stderr to a real PTY, with `PYTHONUNBUFFERED=1` retained as an additional safeguard. Python and terminal-aware libraries therefore detect an interactive console. Output from statements already executed appears before the corresponding `input()` in normal program order, the process waits only at that input call, and it can consume any number of subsequent entries. `scripts/codex-readonly-runner.c` still emulates and validates every mutating or deleting filesystem operation separately: write, delete, rename, and link targets are allowed only within the configured workspace root, while `.git`, `node_modules`, `.env*`, reserved `memory.md`, targets outside the workspace, and new, escaping, or dangling symlinks remain blocked. Non-Unix network sockets and privilege paths remain disabled. The separate user channel does not change the model’s exclusive live-editor write channel.

Existing files use visible `edit` requests; `write` remains restricted to new files. The runtime diffs the current buffer against the completed edit request and animates each changed location separately. Unchanged lines and words inside `oldText` remain visible even with full-file context or single-line files. Deletion is red and insertion green, and the caret stays at the last actual change through persistence. Local textarea changes use `setRangeText`. Edits have no artificial character, line, or affected-share rejection. Persistence waits for the existing adaptive Unicode animation; new files continue streaming during generation.

Short changes appear as individual keystrokes and backspaces at a 16 ms cadence. Larger backlogs raise the rate for each deletion or insertion phase, up to 64 Unicode units per step, with faster deletion and no increasingly slow tail. Each step waits for the visible syntax layer, and the final state gets another presentation frame before saving. An inconsistent final buffer is discarded instead of silently replaced or saved. Stop and AbortSignal restore the previous buffer immediately, including while rendering is pending.

The runtime resolves an edit against the latest visible browser buffer. It prefers exact matches, accepts whitespace-equivalent text, and can rebase slightly stale `oldText` onto the most similar line range. Optional one-based `startLine` and `endLine` fields disambiguate repeated or drifting ranges. The complete edit JSON must arrive before animation so options after `newText` are honored and incomplete replacements never erase context. This applies equally to `.md`, `.js`, `.css`, `.html`, and `.py`. `replaceAll:true` is reserved for intentional replacement of all matches. Discarding a draft restores content, dirty state, selection, and viewport.

In Codex mode, the App Server can only list or read workspace files through `codex_ide_workspace`. The normalized response language is part of the persistent thread identity, so changing between German, English, and French automatically creates a matching thread for the next turn instead of inheriting the previous thread’s summary language. Lists are shallow by default and may be scoped with `path` and `depth`. Reads with `purpose:"inspect"` provide dependency context without opening a tab, while retaining the exact content as the authoritative base for a later edit; only `purpose:"edit"` opens and focuses the file immediately. Editing a previously inspected file promotes that snapshot into a visible buffer. If no snapshot is available, the editor runtime rereads the target through the bounded IDE read channel and activates the buffer before applying the change. After every confirmed open or change, the browser returns the actually visible buffer as the turn-local authoritative state for all follow-up, audit, and recovery passes. When the target path is already active in the visible editor, that active DOM buffer outranks stale tab caches and previous workspace reads; unsaved active content is not replaced by a new read. It supersedes older App Server reads for the same path, so recovery never injects both versions. Slightly stale `oldText` is first rebased directly onto this current buffer without another model pass. Only an unresolved mismatch turns the unchanged buffer into the immediate repair base and starts the next Codex pass in a fresh App Server thread. This feedback path only reports visible editor state and grants no alternate write route. Tool lifecycle, partial indexes, files, concise model-authored work summaries, and native command events are streamed as `codexIde` SSE metadata. The model console remains completely hidden until a real command starts, then appears inside the visible agent/reasoning area between work notes and the final answer. It maps command start, stdout/stderr deltas, follow-up model stdin, and completion into one visible run with status, exit code, and duration. Private workspace prefixes are displayed as `model-home`; output is not truncated. The summaries state what is currently being inspected, changed, or verified and why without exposing private chain-of-thought, internal paths, or raw contents. Previously visible native and structured work notes are retained within the turn and supplied to follow-up passes under a no-repetition rule. The UI suppresses identical or strongly overlapping large notes and reuses one live card for generic phase text. Localized edits and new-file writes remain structured visible editor actions.

Named agent sessions can be created, switched, renamed, and selectively deleted in the agent header. The UI restores each complete transcript. IndexedDB stores the stable session identity, full history, last turn state, and App Server thread ID without an application-imposed message or character cap. Serialized writes are synchronously mirrored to a revisioned `localStorage` crash fallback until the newest database commit succeeds. A turn is persisted as running before the model request and finalized as completed, stopped, or failed; browser startup deterministically closes a leftover running record as interrupted. Follow-up prompts continue the same non-ephemeral thread, creating a session does not reset existing ones, and `thread/resume` continues its stored ID after an App Server or gateway restart. Explicitly remembered long-term information in `memory.md` is additionally available across sessions without application-side truncation.

Before the first model token of every new user prompt, the IDE writes the visible DOM content back to its tab buffer and supplies every open browser buffer as an authoritative initial snapshot. A follow-up therefore receives updated background tabs while the persistent App Server session and conversation continuity remain intact.

The workspace is synchronized at startup and after file operations. Policy version 21 reports `ideSandbox: read-only-native-live-editor` and `terminalExecution: verification-copy-live`. Tool-protocol version 3 renews older threads that exposed direct write tools from the supplied conversation. Missing or older policy metadata does not block a turn. The live editor supports every text file, hidden configuration and memory without an optional file-skill grant.

The App Server selects `codex-ide-live-editor` for thread start, resume and turn start. Native tools inspect the project; every project modification and persistence goes through visible live-editor actions. Legacy exec also uses a native read-only sandbox. `codex_ide_workspace` offers only list/read, including Base64 binary inspection. Direct write/mkdir/move/remove calls cannot persist project edits through that tool. Internal symlinks and scoped listings without fixed depth or entry caps remain available.

`codex_ide_terminal` verifies a disposable workspace copy with internal symlinks rebased into it. Cache and build output are allowed without turning an otherwise successful check into an error. The copy is discarded after completion or Stop and is never copied back. Model turns execute through App Server `command/exec`, with writes confined to the verification root and network access disabled; there is no unrestricted model-shell fallback. Commands set `disableTimeout` and `disableOutputCap`; no C compiler is required. Workspace memory requests also use the visible editor.

Codex inspects package.json and uses the declared test script. Caches and build artifacts are allowed in the verification copy. Project fixes go through the live editor before verification is repeated.

A `list` scoped with `path` starts directly at the requested directory and traverses only the requested depth. Another project branch therefore cannot slow the scoped scan or hide requested entries. App Server JSONL and console streams use stateful UTF-8 decoding; a process restart discards incomplete bytes and lines from the old stdout stream. Long model and terminal deltas are accumulated linearly. The browser appends only new terminal text, and a completion event does not retransmit an aggregate that was already streamed while preserving it as a fallback when no delta arrived.

## Agent loop

The protocol uses `codex_ide_thought`, `codex_ide_skill_request`, `codex_ide_editor_request`, `codex_ide_workspace_complete`, and `codex_ide_final`. Editor requests support `open`, localized `edit`, new-file `write`, and `mkdir`; editor actions are emitted directly. Workspace turns do not request or display additional thought blocks. Native App Server summaries appear as unnumbered work notes without synthetic phases, counters, truncation, or similarity filtering. Thread, turn, item, and summary index identify each part. Completion fills missing parts or corrects existing text, and updates preserve the surrounding DOM nodes. API, Codex, and structured local workspace turns have no retry, action, or runtime ceiling. Malformed blocks, invalid JSON or structured audit output, unsafe targets, unresolved edit targets, and technical editor failures receive a concrete diagnosis. Repeated editor or audit-schema stalls refresh the workspace and rebuild the model session while keeping the same turn and visible editor channel active. Completion or an explicit user stop ends the loop. Local text output is still normalized to `codex_ide_final` so smaller browser models remain usable.

## Skills

The settings dialog manages built-in and installed skills for `local`, `api`, and `codex`. It covers installation, removal, activation, profiles, permissions, setup, and runtime checks. HTTPS and local packages require explicit trust. The registry validates schema, IDs, versions, entrypoints, profiles, permissions, setup, agent parameters, and permission rules before installation.

## Localization and PWA

German, English, and French files expose the same UI keys. The header exposes them as flag buttons. The saved language is applied when the settings runtime starts, even if the main IDE runtime finishes language initialization afterward. Language changes update the IDE and settings without a reload. The service worker caches only the standalone shell as `codex-ide-v48` and always bypasses gateway routes. Its own update check bypasses the HTTP cache; after user confirmation, shell requests use reload semantics and the page reloads once when the new worker takes control. If an already loaded legacy client does not yet advertise its own reload listener, the new worker navigates that client once after the confirmed activation. The explicit clean URL unregisters workers and clears Cache Storage while preserving settings, skills, and workspace data. npm package replacement and PWA activation remain separate confirmed steps.

## Verification

Jest excludes `model-home/`: tests stored there are user workspace data, not part of the Codex IDE release suite.

```bash
npm run verify:syntax
npm run pwa:validate
npm test -- --runInBand
npm pack --dry-run --ignore-scripts
node --test skill_packages/GitHub_Repo_Skill/runtime-checks.js
```

See [agents.md](agents.md) for the complete project rules and verification matrix.

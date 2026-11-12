# Changelog

## Unreleased - Antigravity CLI backend

- Add a modular Antigravity CLI adapter using the existing official sign-in and persistent JSON streaming. Keep provider configuration and conversation IDs independent, expose login/status commands, model selection and settings, and include the adapter in npm packages.
- Reuse the visible editor, paint-before-save persistence, workspace readers, verification copies and recovery/audit pipeline. Extend delayed-stream, follow-up, Unicode, read-only-installation, HTTP, cancellation and performance reproductions to Antigravity. Advance the PWA shell cache/assets to `codex-ide-v49` and keep Antigravity API routes uncached.

## 1.3.2 - Consistent editor previews and saves

- Keep the streaming preview bound to the first editor request in each model response, matching final dispatch. Additional blocks can no longer close an unsaved new file, rewrite its preview or force it to be animated again before saving. Add delayed-stream reproductions with real temporary-file persistence for repeated same-file blocks, different file targets and a later user turn editing the saved file. Preserve visible animation and paint-before-save checks; advance the PWA shell cache/assets to `codex-ide-v48`.

- Set the npm package and lockfile metadata to `1.3.2`.

## 1.3.1 - Writable workspaces across platforms

- Fix EACCES on editor saves from system-wide npm installations by storing the active workspace in the current user's persistent data directory. Copy legacy package-local data once without modifying it, make the copy editable, relocate internal absolute symlinks and publish only complete migrations. Keep source-checkout and explicit workspace paths. Cover Linux, Android/Termux, macOS and Windows path selection with native POSIX/Windows path rules; validate Windows AppData fallbacks and preserve directory links as junctions. Add a real read-only-installation reproduction, migration/restart checks, manual HTTP saves and paint-before-save Codex write/edit regressions. Platform-policy simulations do not substitute for native OS testing.

- Set the npm package and lockfile metadata to `1.3.1` and advance the PWA shell cache and all versioned shell assets to `codex-ide-v47`.

## 1.3.0 - Live editing, chat activity and streaming performance

- Move accepted user messages into the chat immediately and clear the composer before generation. Preserve drafts written during a turn, grow the input with its content, and retain Enter/Shift+Enter and IME behavior. Render native App Server summaries, workspace access, editor actions, console checks and native tools as accessible disclosure cards with stable identities, status, targets, results and errors. Persist cards with each turn, restore interrupted work without running indicators, and follow new output only when the reader is at the bottom. Add chat, transport, persistence and real Chromium regressions for desktop and narrow layouts. Keep all project writes exclusive to the live editor.

- Add repeatable streaming and editor performance budgets with `npm run test:performance`. Decode growing editor JSON strings incrementally, search SSE delimiters only in new chunks, and update confirmed file-tree entries locally instead of blocking every save on a full workspace scan. Preserve Unicode boundaries, visible animation and paint-before-save ordering, the completeness audit, native read-only permissions and disposable verification sandboxes. Cover the full multi-response planner/editor/persistence path.

- Keep the syntax layer's code font identical to the textarea. Browser-default code fonts expanded line boxes and left the visible work site hundreds of pixels away from the followed caret in long files. Match the syntax viewport to the textarea's actual client size so native scrollbars cannot displace it near file edges, including after resize. Add real Chromium regressions that check rendered text bounds through deletion, insertion, distant and horizontal edits, saving, mobile layouts and large fonts.

- Make short live edits look like keystrokes and backspaces at a 16 ms cadence. Accelerate large backlogs at a steady per-phase rate, up to 64 Unicode units per step, with faster deletion and no slow tail. Wait for every syntax paint and a final presentation frame before saving; reject a final buffer that was not displayed. Abort restores the view even while rendering is stalled. Cover pacing, streaming bursts, CRLF, persistence ordering and native-write bypass attempts.

- Follow each live-edit work site immediately with measured caret geometry, horizontal and vertical scrolling, focusable read-only textareas and coalesced syntax paints. Keep the active work site visible across separate edits and persistence, and restore the original viewport after Stop. Cover delayed paints, long lines, large fonts and editor-panel navigation.

- Keep full model-home reads and visible editing for every text file, hidden configuration, dependencies, memory and internal symlinks. Project writes stay exclusive to the live editor; native tools use a read-only profile and the workspace tool exposes only list/read.
- Run verification commands against disposable copies with writes sandboxed to the copy, no compiler prerequisite, and no runtime/output cap. Preserve optional-memory error recovery and non-blocking gateway policy behavior. Renew stale write-capable tool schemas.

- Replace generated thought cards and progress counters with the native App Server summary stream. Preserve separate summary parts, completed-only text, corrections, and thread/turn identity without client-side truncation or similarity filtering.
- Diff completed edit requests into local changes and animate each work site separately, keeping unchanged context visible even for full-file and single-line input. Apply textarea range changes and preserve the final caret through persistence. New files still stream while being generated.
- Read trailing replaceAll and line hints before starting edits, preserve split Unicode escapes, and release animation waiters for superseded turns. No new runtime timeouts or fail-closed gates.
- Add editor-frame, large-file, Unicode, cancellation, stream-routing, and native-summary regressions.
- Set the npm package and lockfile metadata to `1.3.0` and align the PWA shell cache and versioned assets at `codex-ide-v46`.

## 1.2.9 - Long-turn resilience and model capability

- Made the user-console `rm` command recursive by default, allowing `rm folder` to remove a normal nested directory tree while the seccomp runner continues to validate every delete target and protect reserved, external, and symlink paths.
- Added a guarded per-run `POST /codex-ide/console/input` route and a real PTY for the user process’s stdin, stdout, and stderr. Python and terminal-aware programs now detect an interactive console, preserve normal output ordering around `input()`, accept arbitrary lines including blank input, and reject mismatched or completed run IDs.
- Made App Server JSONL and both console streams statefully UTF-8-safe across transport chunk boundaries, discarded incomplete old-process prefixes on restart, and accumulated long response and console output in linear chunks.
- Changed the browser console to append only new text instead of replacing the entire rendered output for every delta. Completion events no longer retransmit an aggregate already delivered as deltas, while preserving the aggregate fallback for non-streamed output.
- Made scoped `codex_ide_workspace` listings start at the requested directory, so unrelated large branches cannot consume the target branch's 1,000-entry cap or add a whole-workspace scan to a long agent turn.
- Kept internal local-model token budgets per call instead of overwriting the saved user limit, and preserved the live Codex reasoning catalog through `xhigh`, `max`, and `ultra` with model-specific UI options.
- Added transport, restart, large-workspace, token-budget, reasoning-catalog, and incremental-rendering regressions; advanced the workspace handshake to version 19 with `workspaceTraversal: direct-scoped-bounded`, the standalone shell cache/assets to `codex-ide-v35`, and the npm package to `1.2.9`.

## 1.2.8 - User-controlled live console

- Added locally intercepted `/console start` and `/console close` directives. While active, the shared prompt executes direct user commands without invoking a backend model or adding the directives or commands to an agent session; output is streamed into the existing live console with an explicit User/Model source label, Stop support, exit metadata, and a post-run workspace refresh.
- Added the guarded `POST /codex-ide/console` SSE route and a real-workspace seccomp execution mode. Users can run their own Python files and modify or delete normal `model-home` files, while writes outside the workspace, protected targets, symlink targets, non-Unix networking, and privilege paths remain blocked.
- Preserved the existing model console as a separate read-only path, retained every editor and agent function, added focused browser/gateway/runner/localization tests, advanced the standalone shell cache and assets to `codex-ide-v32`, and released the npm package as `1.2.8`.

## 1.2.6 - Character-paced real-time editing

- Replaced token-chunk buffer swaps with an accelerated character-paced live editor state machine: existing ranges backspace in red, streamed replacements and new files type in green, and caret, viewport, and syntax overlay follow every visible intermediate state. Adaptive batches keep the 16 ms cadence, scale up to a bounded 256 Unicode code points per animated target range and frame for large backlogs, and still keep deletion and insertion in separate visual phases. Final persistence waits until the streamed target is fully visible.
- Closed the remaining whole-file rewrite exception for short and single-line existing files; the same localized-edit threshold now applies regardless of buffer size.
- Added an atomic gateway intent contract so agent `write` can only create a missing file and agent `edit` can only persist an existing file. A stale or truncated browser index can no longer allow a full write over existing code.

- Persist complete visible session transcripts, per-turn running/completed/stopped/failed state, and App Server thread IDs with serialized IndexedDB commits plus a synchronous revisioned crash fallback. Browser startup closes leftover running records as interrupted, and gateway restarts resume the stored non-ephemeral thread.
- Keep a stopped browser request attached to the native App Server turn until its authoritative completion notification, preventing the next queued prompt from overlapping an interrupted turn.
- Decline native patch approvals without aborting the shared turn and explicitly route all workspace changes through visible editor actions, preventing repeated native CSS patch attempts from killing or restarting the loop.
- Send only workspace context data and the current task in the browser user message. Language, tool, and editor contracts remain in one system layer, preventing instruction fragments such as language-only replies from displacing the actual task.
- Map requested work semantically to the existing project layer instead of using a mobile/CSS keyword detector or forcing a file type. Layout stays in the discovered markup/style structure and behavior stays in program logic.
- Keep the visible phase timer monotonic across planner, audit, recovery, and finalization passes, and stream model-authored work notes immediately instead of buffering them behind arbitrary length or closing-tag thresholds.
- Drop exact instruction-echo assistant history and recover an exact language-rule echo in a fresh minimal action pass without replacing legitimate work notes or final output locally.
- Removed the structured-audit retry ceiling, disabled gateway HTTP request/socket timeouts for day-long turns, advanced the workspace handshake to version 18, advanced the PWA shell cache/assets to `codex-ide-v31`, and released the npm package as `1.2.6`.

## 1.2.4 - Resilient high-throughput live editing

- Removed the artificial editor character and line ceilings, including the previous 120,000-character cap, from patch parsing, live buffers, recovery snapshots, Codex prompts, workspace reads, persistence, the IDE transport body, custom-skill results, and extended-file writes. A contiguous work region can be arbitrarily large.
- Existing files can no longer be recreated by replacing their entire or practically entire buffer. Unchanged text must remain outside `oldText`, while separate work sites use separate visible edits.
- Added buffer-drift-tolerant patch placement: exact and whitespace-equivalent matches are preferred, repeated matches can be selected by one-based line hints, and slightly stale ranges are safely rebased against the latest visible browser buffer instead of forcing a model repair loop.
- Changed streamed replacement rendering into two visible phases at the real work site: deletion appears first with a red editor edge, then insertion grows there with a green edge and a collapsed trailing caret.
- Narrowed edit idempotency to the exact same replacement at the same target. Similar or extended content and CSS explicitly requested in a later prompt are applied normally instead of being misclassified as duplicates.
- After every successful Codex editor change, the loop now enters the structured completion check directly instead of asking the planner for another action and risking emission of the same CSS block again.
- Added named persistent sessions to the agent header with create, switch, rename, and selective delete controls. Every session keeps its stable App Server identity and complete untrimmed history in IndexedDB across prompts and browser restarts; long-term `memory.md` context remains available across sessions without application-side truncation.
- Made the current explicit user request authoritative over conflicting task preferences in older turns, so a later request to use CSS is not treated as user ambiguity.
- Prevented internal editor-protocol, request-format, runtime-ledger, recovery, and audit narration from leaking into visible work notes or final answers.
- Preserved the security boundary: every change still flows through the visible browser editor and the model-home-scoped IDE persistence endpoint; native model filesystem writes remain unavailable.
- Kept the workspace handshake at version 16 and raised the standalone shell cache and asset generation to `codex-ide-v26`. The npm package remains unchanged at `1.2.4`.

## 1.2.1 - Settings localization and update check fixes

- Fixed settings localization on startup when English or French was already saved before the settings runtime initialized, and made the header settings button use the localized `settingsBtn` label.
- Added missing English and French settings overrides for local model/API labels and the URL install action.
- Moved language switching out of settings into the main interface as flag-backed DE/EN/FR buttons with active and disabled states.
- Made every follow-up prompt start with authoritative snapshots of all open browser buffers, including updated background tabs, while preserving the persistent App Server session. Visible buffers also outrank stale tab caches and previous workspace reads during recovery; conflicting older reads are removed and the first stale Codex edit moves directly to a fresh thread without adding action or runtime limits.
- Made `codex-ide update` read the npm `latest` dist-tag directly, raised the npm check timeout to 20 seconds, and cleaned raw `Command failed` wrappers from update-check errors.
- Advanced the standalone shell cache and versioned assets to `codex-ide-v22`; service-worker and shell downloads now bypass stale HTTP caches, accepted updates reload both current and already loaded legacy clients, and `codex-ide clean` actively unregisters workers and clears Cache Storage. The npm package remains `1.2.1`.

## 1.2.0 - Codex usage limits

- Added localized daily/short-window and weekly remaining-usage bars to the Codex auth settings, with blue progress, a red plus textual low state at 20 percent or less, accessible percentage values, and explicit unavailable states for limits Codex does not return.
- Added the no-store `/codex/usage` gateway route backed by the official local App Server `account/rateLimits/read` method; only normalized remaining percentages reach the browser and CLI credentials remain local.
- Kept arbitrary user tests under `model-home/` outside the npm release Jest suite so workspace data is neither treated as Codex IDE test code nor changed to satisfy packaging checks.
- Advanced the standalone shell cache and versioned assets to `codex-ide-v17` and released the npm package as `1.2.0`.

## 1.1.0 - npm distribution and safe updates

- Prepared the public `codex-ide` npm package with a runtime allowlist, global `codex-ide` binary, Node engine metadata, release verification, and exclusion of tests, internal agent files, build sources, dependencies, and every `model-home` entry except `.gitkeep`.
- Added `codex-ide version` and `codex-ide update`, stable npm version discovery, semantic comparison, interactive confirmation, `--yes`, and an optional interactive update offer before globally installed IDE startup.
- Kept the only default workspace at `<project>/model-home`; self-update now verifies a neutrally named temporary backup before npm replacement, restores the exact same workspace path after success or failure, verifies it again, and retains the backup if recovery cannot be confirmed.
- Refused self-update for source checkouts and local dependency installations, preserved every existing CLI, gateway, backend, editor, skill, sandbox, and PWA route, converted installed command guidance to `codex-ide`, and advanced the shell cache to `codex-ide-v16`.

- Reworked the dark interface around a warm crimson-and-coral identity, introduced the localized slogan “Your agent at work — every change, live.”, refreshed the SVG and PWA icons, added a narrow-mobile refinement and visual-contract tests, and advanced the shell cache to `codex-ide-v15`.
- Added a contextual play button for active saved `.html` files and a read-only `model-home` preview route with relative web assets, no-store responses, path/symlink enforcement, CSP origin isolation, localized labels, focused tests, and the `codex-ide-v13` shell cache.
- Hardened the gateway against DNS rebinding and static-file symlink escapes, preserved UTF-8 across request chunk boundaries, blocked absolute/control-character workspace paths consistently, prevented dangling-symlink writes for generated Markdown and skill packages, and removed custom absolute model-home paths from model prompts.
- Replaced streamed full-file rewrites for existing files with localized `edit` actions that show deletion and replacement at the actual edit location, and removed the stale bridge prompt that still instructed full-file writes.
- Added exact-match, ambiguity, size, line-count, replacement-count, and touched-file-share validation; existing-file `write` rejection; localized caret/viewport following; and full draft rollback.
- Made Codex workspace discovery shallow and scopeable, with `purpose:"inspect"` reads that avoid tabs and `purpose:"edit"` reads that focus only files being actively edited.
- Removed the redundant pre-turn workspace rescan and moved the per-turn policy preflight to `/gateway/status`, avoiding a Codex CLI login-status process before generation.
- Raised the IDE workspace policy handshake to version 11 and refreshed the PWA shell cache.
- Replaced repetitive editor-repair phases with diagnosed, unbounded workspace/session recovery that keeps one live repair card current instead of stacking identical fallback thoughts.
- Enabled concise model-authored work summaries for IDE turns and made the native Codex process read-only so every workspace change must still pass through the visible live-editor channel.
- Raised the IDE workspace policy handshake to version 12 and refreshed the PWA shell cache, now at `codex-ide-v7`.
- Bound persistent App Server threads to the normalized response language so German, English, and French switches also change the language of concise model-authored work summaries.
- Added turn-local visible-work-note memory, follow-up prompt guards, UI phase-card reuse, and near-duplicate suppression so large recurring “I …” reasoning blocks are not appended repeatedly.
- Fixed the real inspect-to-edit buffer handoff: no-tab workspace reads now retain an authoritative content snapshot, the first edit promotes it into the visible editor, missing snapshots are recovered through the bounded IDE read channel, and rollback no longer confuses existing files with previously open tabs.
- Refreshed the PWA shell cache to `codex-ide-v8` for the editor runtime fix.
- Added `.md` as a first-class visible editor target across structured parsing, live streaming, browser buffers, scoped reads, and automatic persistence; Markdown no longer requires an optional code-file permission or falls back to HTML, while `memory.md` remains reserved.
- Raised the workspace policy handshake to version 13 with `editorFileTypes: code-markdown` and refreshed the PWA shell cache to `codex-ide-v9`.
- Added the native App Server live console for model-run syntax checks, tests, linters, type checks, builds, streamed stdout/stderr and stdin, with real exit metadata and no artificial runtime, action, or output ceiling.
- Kept console execution inside the network-disabled read-only sandbox, preserved all workspace writes through the visible editor channel, raised the policy handshake to version 14, and refreshed the PWA shell cache to `codex-ide-v11` with versioned asset URLs so an older worker cannot hide the console with stale JavaScript.
- Added the App-Server-registered `codex_ide_terminal` compatibility path for Termux/PRoot, backed by a discarded workspace copy, isolated writable Jest/npm temp area, manifest-based mutation detection, and a locally built `no_new_privs`/seccomp runner that blocks non-Unix network sockets and privilege paths without `dangerFullAccess`.
- Moved the console into the visible agent/reasoning timeline, kept it hidden until the first real terminal event, added automatic reveal/follow behavior, standardized project-aware Jest execution without command probing, and refreshed the PWA shell cache to `codex-ide-v12`.
- Reconnected follow-up and recovery passes to the exact visible browser buffer after every open or edit, made that buffer override stale App Server reads, returned the unchanged current state with stale-edit failures, and refreshed the PWA shell cache to `codex-ide-v14` without adding any write path around the editor.

## 1.0.0 - Standalone Codex IDE

- Made `index.html` the direct and only Codex IDE application shell.
- Integrated settings for the `local`, `api`, and `codex` backends.
- Integrated German, English, and French language switching into the IDE.
- Integrated complete skill installation, profiles, permissions, setup, runtime checks, and removal.
- Kept the multi-buffer editor, workspace tree, live streaming, structured editor actions, completeness audit, stop flow, Codex model catalog, reasoning levels, and persistent App Server sessions.
- Added automatic editor follow-scroll for live model writes, including caret/highlight synchronization and viewport restoration on draft rollback.
- Moved the bounded workspace root to `model-home/`.
- Added the IDE-scoped `/codex-ide/ide-files` read, write, and directory channel for every backend.
- Standardized protocol tags, storage keys, events, headers, routes, SSE metadata, CLI, logs, PWA assets, and package extensions under the Codex IDE namespace.
- Replaced the former launch flow with `codex-ide start`; retained the local `./codex-ide` development launcher plus gateway-only, clean, Codex login/status, and skill package commands.
- Removed unused application-shell, loader, writer, conversation-store, long-term-memory, duplicate IDE document, and duplicate skill-source files.
- Rebuilt `.codexskill` packages from the standalone sources.
- Reworked project documentation and verification around the standalone IDE.

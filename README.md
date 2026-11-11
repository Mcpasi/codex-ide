# Codex IDE

**Your agent at work — every change, live.**

Codex IDE is a standalone agentic browser development environment. It combines a safe local workspace, multi-buffer code editor, live agent activity, three model backends, and a fully integrated skill system. Its dark application shell uses a warm crimson-and-coral visual system and remains fully responsive from desktop down to narrow mobile screens.

[YouTube Demo Video](https://youtu.be/o9aAy9NVCOA?is=0xDMwUE6E3fh8jmN)

## Quick start

Node.js and npm are required. The Codex backend additionally requires the official Codex CLI.

```bash
npm install -g codex-ide
codex-ide start
```

The IDE opens at `http://localhost:8787/`. There is no separate landing application: `index.html` is the IDE.

For local development from the source directory, `npm install` and `./codex-ide start` remain available.

## Backends

- **Local (`local`)**: a Transformers.js text model running in the browser; internal one-shot calls use their own token budget without changing the saved user limit.
- **API (`api`)**: an OpenAI-compatible endpoint such as OpenAI, OpenRouter, Ollama, or LM Studio.
- **Codex auth bridge (`codex`)**: official local Codex CLI sign-in with a persistent Codex App Server, streaming, model catalog, reasoning level, and remaining usage limits.

The reasoning selector follows the live model catalog. Supported levels through `xhigh`, `max`, and `ultra` are preserved and shown only for models that advertise them.

Accepted messages appear in the chat immediately, freeing the growing composer for the next draft. Enter sends; Shift+Enter inserts a line. Native App Server reasoning summaries and actual tool, editor and verification actions appear in expandable cards with status and details. Cards stay in the saved conversation, including stopped and interrupted turns. New output follows the bottom of the chat while older messages remain readable without forced scrolling.

All configuration is part of the IDE. The backend can be switched from both the header and settings; language is switched directly in the header through flag buttons.

Codex sign-in:

```bash
codex-ide codex login
codex-ide codex login --device-auth
codex-ide codex status
```

The same commands can be copied under **Settings → Codex auth bridge**. Two bars show the remaining daily/short-window and weekly allowance reported by the Codex CLI. Available values are blue; at 20 percent or less a bar turns red and is also labeled low. A period not returned by Codex remains visibly unavailable rather than being estimated. **Check status** refreshes gateway, sign-in, and usage, while **Test gateway** sends a short real Codex request.

## Features

- safe workspace under `model-home/`
- file tree, folders, tabs, dirty state, and syntax rendering
- contextual play button for saved `.html` files with an isolated browser preview
- automatic IDE persistence with gateway confirmation
- character-paced local differences preserve unchanged code even when a request includes full-file context; changed characters delete in red and insert in green with a trailing caret, without artificial edit-size limits
- short changes appear as individual keystrokes and backspaces; larger changes catch up at a steady, bounded rate, and saving waits for the final visible syntax frame
- native App Server summaries stream directly as unnumbered work notes, preserving all parts without synthetic thought cards or progress counters
- demand-driven project reads; a scoped directory is traversed directly instead of after a global scan, and only files actively being edited open tabs automatically
- fast turn startup without a second full workspace scan or CLI login check
- incremental streaming decoding and immediate file-tree updates after confirmed editor saves, without a full workspace round trip per change
- autonomous multi-file editor actions with a completeness audit
- on-demand model live console inside the agent/reasoning area for syntax checks, project tests, linters, type checks, and builds on a disposable verification copy with untruncated, UTF-8-safe, incrementally rendered stdout/stderr, model stdin, and exit status
- a user console activated locally with `/console start`: `rm folder` recursively removes normal directory trees, and running Python scripts that use `input()` receive subsequent prompt entries through a real PTY; `/console close` exits the mode without contacting the model
- named, locally persistent agent sessions with a visible complete transcript, crash-safe turn state, App Server thread resume, switching, renaming, and deletion
- German, English, and French UI
- installable PWA with controlled updates
- npm version checks and confirmed self-updates with an unchanged `model-home`
- integrated skill installation, profiles, permissions, setup, tests, and uninstall
- local `.codexskill` packages

## Skills

Open **Settings → Skills** to configure built-in and installed skills for `local`, `api`, and `codex`. External entrypoints run JavaScript inside the app and therefore require an explicit trust confirmation.

```bash
codex-ide skill validate skill_packages/PDF_Skill
codex-ide skill pack skill_packages/PDF_Skill
```

See [SKILL_DEVELOPMENT_EN.md](SKILL_DEVELOPMENT_EN.md) for development guidance.

## Security

The gateway binds to loopback by default and rejects foreign browser hostnames without an explicit origin allowlist. Codex can inspect the entire `model-home/` and edit every text file through the visible live editor, including hidden configuration, memory and dependencies. No optional file-skill permission, extension whitelist or protected-name rule restricts this editor channel. The App Server selects `codex-ide-live-editor` at thread start, resume and turn start: native tools can inspect the project but cannot persist changes. `codex_ide_workspace` exposes only list/read operations, including Base64 inspection of binary files. All project edits are animated in the browser and persisted only after the visible editor reaches the requested final state.

`codex_ide_terminal` runs verification commands against a disposable workspace copy. Caches and build output are allowed in that copy and never update the actual project. In model turns, the App Server command sandbox restricts writes to the verification root and disables command network access. There is no fallback to an unrestricted model shell. The console needs no C compiler, introduces no runtime/output limit, and reports real execution failures without a gateway-version preflight. Workspace memory requests also use the live editor instead of silently saving before the model turn. Optional memory read errors do not stop workspace work.

Existing threads with older tool schemas are renewed from the supplied conversation. PWA cache v47 delivers the chat cards and current editor contract through the existing update flow. Requests retain no default timeout, action, retry or output cap. User Stop still cancels work. Static files remain inside the application-shell root, and the uncached HTML preview runs in a CSP sandbox without access to the IDE origin. Codex CLI browser credentials are neither requested nor stored.

App Server JSONL and console streams use stateful UTF-8 decoders, so an umlaut or emoji split between chunks cannot corrupt an active turn. A restarted App Server discards incomplete bytes and lines from the old process. Long response and console deltas are accumulated linearly; the browser appends only new output and completion does not retransmit an aggregate that was already streamed.

The separate user console is controlled only by the locally intercepted `/console start` and `/console close` directives; neither those directives, entered commands, nor subsequent program input are sent to a model turn or stored in the agent session. It intentionally operates in the real `model-home` so the user can modify or delete normal workspace files and run their own programs. While a command is running, the still-active prompt sends arbitrary lines, including a blank line, to that process through its PTY; **Stop** terminates it. Only in this user channel, `rm` enables recursive deletion by default, so `rm folder` removes a normal directory tree. The runner exposes stdin, stdout, and stderr through a real PTY. Python therefore detects an interactive console: output from statements already executed is visible before the corresponding `input()`, only that input call waits, and submitted input resumes the script in normal program order. The seccomp runner still checks every file path and blocks network and privilege paths, write or delete targets outside `model-home`, protected targets such as `.git`, `node_modules`, `.env*`, and `memory.md`, and symlink targets. The separate user console does not change the model’s exclusive live-editor write channel.

## npm updates

Source checkouts use `<project>/model-home`. npm installations use a persistent workspace owned by the current user:

| Gateway platform | Default workspace |
| --- | --- |
| Linux | `$XDG_DATA_HOME/codex-ide/model-home`, otherwise `~/.local/share/codex-ide/model-home` |
| Android with Termux | `$HOME/.local/share/codex-ide/model-home` in the Termux home; an absolute `XDG_DATA_HOME` overrides the data directory |
| macOS | `~/Library/Application Support/codex-ide/model-home` |
| Windows | `%LOCALAPPDATA%/codex-ide/model-home`; fallback to absolute `%APPDATA%`, then `<user home>/AppData/Local` |

These paths refer to the device running the gateway. A browser on another device uses that gateway's workspace. On first use, existing package-local workspace data is copied there without modifying the original. Read-only package files become editable in the copy; internal symlinks stay inside the new workspace. Windows directory links are recreated as junctions with absolute targets inside the new workspace. Later starts keep the user's current files. Explicit `CODEX_IDE_MODEL_HOME` and legacy bridge path overrides retain their configured paths. The gateway prints the active model-home path at startup.

A globally installed interactive `codex-ide start` checks for a newer stable npm version by reading the npm `latest` dist-tag directly and waits up to 20 seconds for slower registries. Use `--no-update-check` or `CODEX_IDE_NO_UPDATE_CHECK=1` to skip that check.

```bash
codex-ide version
codex-ide update
codex-ide update --yes
```

The active user workspace lives outside the npm package and survives package replacement. Before npm replaces the package, `codex-ide update` also copies the legacy package-local `model-home` into a neutrally named temporary backup and verifies it with SHA-256. After either a successful npm update or an npm failure, the updater restores that legacy directory at the exact same project path and verifies it again. The temporary backup is removed only after verification succeeds. Self-update is intentionally restricted to a global npm installation and never overwrites a local source checkout. Keep `.gitkeep` and `.npmignore` during manual package-local `model-home` cleanup; the nested ignore file prevents any other workspace content from entering the package and is not published itself.

## More commands

```bash
codex-ide start --no-open
codex-ide gateway
codex-ide gateway --open
codex-ide clean
npm run pwa:validate
npm test -- --runInBand
```

Technical documentation: [DOKUMENTATION_EN.md](DOKUMENTATION_EN.md).

## Tests

Run `npm ci` and `npm test` from the source directory. The Jest suite lives in
[`test/`](test/README.md) and covers workspace protection, the gateway and CLI,
App Server streaming, update backups, skill packages, and browser modules.
Tests use temporary workspaces and simulated backends; HTTP integration tests
require a local loopback port. Use `npm run test:coverage` for a coverage report.
Run `npm run test:performance` for streaming and editor latency budgets with
JSON measurements; see [performance methodology and results](test/PERFORMANCE.md).

## License

MIT, see [LICENSE](LICENSE).

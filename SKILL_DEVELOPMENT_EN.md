# Developing and publishing skills

Codex IDE installs additional skills from a manifest URL, a portable `.codexskill` package, or local development files in **Settings → Skills**. A future hub can catalog reviewed manifest URLs and offline packages; installation, permissions, and runtime orchestration stay in the app.

The bundled `internet.research`, `workspace.extended-files`, and `learning.codex-ide` skills are protected standard skills. They can be disabled and configured, but cannot be uninstalled or replaced by an external manifest.

## Security model

A skill entrypoint is JavaScript running in the same browser context as Codex IDE. Manifest permissions gate the agent loop and the data passed to `run()`; they are **not a JavaScript sandbox**. Users must explicitly trust the source before installing it.

- Manifest and entrypoint require HTTPS. HTTP is accepted only on the same origin or on `localhost`, `127.0.0.1`, and `[::1]`.
- Optional Subresource Integrity, for example `"integrity": "sha384-…"`, protects the entrypoint from unnoticed changes.
- Cross-origin manifests require an appropriate CORS header.
- Never put secrets in manifests, source code, translations, or hub metadata. Setup values stay in the browser.
- Uninstall removes the manifest, configuration, permissions, runtime registration, and script element. JavaScript side effects that already ran cannot be reliably undone, so reloading after uninstall is sensible.
- External origins are not added to the PWA app shell. Hosted skills should send suitable HTTP cache headers. A locally installed `.codexskill` package works without hosting, but is currently unsigned and needs the same trust confirmation as URL installation.

## Manifest and runtime contract

Manifest schema version 1 requires `id`, `name`, a semantic `version`, `entrypoint`, `profiles`, `permissions`, and an `agent` contract for external skills. Relative entrypoints resolve against the manifest URL. Published agent skills may target any subset of the shared agentic profiles `local`, `api`, `codex`, and `antigravity`.

User-facing values can be either a string or an object containing `de`, `en`, and `fr`. This applies to display names, descriptions, permission/setup labels, parameter descriptions, and `agent.description`/`agent.instructions`. Published skills should supply all three languages.

The `agent.parameters` array declares every accepted request value. Types are `string`, `number`, and `boolean`; strings may set `maxLength`, and parameters may define `enum`. Optional `agent.permissionRules` map a parameter condition such as `{ "parameter": "operation", "equals": "read", "permission": "readFile" }` to a manifest permission. A matching request is blocked before runtime starts while that permission is denied. Undeclared keys, wrong types, missing required values, and unknown skill IDs are rejected before runtime execution.

External skills are always installed disabled and with every permission denied, regardless of manifest defaults. Explicit UI grants are required before the agent loop can use them. The entrypoint is loaded during installation and future app starts so it can register its runtime; the source-trust confirmation is therefore the code-execution trust boundary.

The entrypoint synchronously registers its exact manifest ID:

```js
window.CodexIdeSkillSystem.registerRuntime('example.community-notes', {
  async run(request, context) {
    const response = await fetch(
      context.config.endpoint + '?topic=' + encodeURIComponent(request.topic),
      { signal: context.signal }
    );
    if (!response.ok) throw new Error('Notes service unavailable');
    const data = await response.json();
    const notes = Array.isArray(data.notes) ? data.notes.slice(0, 10) : [];
    return {
      context: notes.length ? notes.join('\n') : 'No matching notes found.'
    };
  }
});
```

`request` contains only validated declared parameters. `context` contains `language`, `profile`, permission-filtered `config`, `permissions`, and `signal`. Return `{ context }`; a skill declaring `agent.resultType: "sources"` also returns `resultCount`, exactly matching the number of sources included in its context. The returned context is limited to 120,000 characters.

For `sources`, `resultCount` must technically be a finite non-negative integer. `null`, numeric strings, negative values, and decimals are rejected as invalid runtime output.

Binary model-home files are unavailable through the general file endpoint. The reserved `GET|POST /codex-ide/pdf-files` endpoint supports the separately installable `workspace.pdf` skill: it requires `X-Codex-IDE-Skill: workspace.pdf`, `X-Codex-IDE-Permission: readPdf` or `writePdf` according to the method, relative `.pdf` paths, and Base64 data limited to 5 MiB by default. These headers belong to the trust-based JavaScript boundary and are not a sandbox; the runtime must also inspect `context.permissions`. A complete offline example lives under `skill_packages/PDF_Skill`.

For a complete localized manifest example and field-by-field reference, see the German canonical guide in [`SKILL_DEVELOPMENT.md`](SKILL_DEVELOPMENT.md); its JSON example contains DE/EN/FR values and is language-independent.

## Develop and test offline

A development folder contains at least `manifest.json` and its relatively declared JavaScript entrypoint. Validate and package it with:

```bash
codex-ide skill validate ./my-skill
codex-ide skill pack ./my-skill
```

`validate` covers the manifest shapes rejected by the browser registry. `pack` accepts only a `.codexskill` output file and never follows an entrypoint symlink outside the skill directory. If runtime registration fails during an update, the installed predecessor continues with its previous manifest, permission, and profile state intact.

`pack` creates `<id>-<version>.codexskill` in the skill folder by default. It is JSON with `packageVersion: 1`, the complete `manifest`, and `entrypointSource`. The entrypoint must be a relative, traversal-free `.js` path without a URL, query, or fragment. Packages support one entrypoint up to 500,000 characters; additional relative imports are not embedded. If the manifest contains `integrity`, its digest is also verified before local execution.

For a fast edit-install-test cycle, select `manifest.json` and its declared `.js` entrypoint together instead of packing. Confirm trust, enable the skill, select the profile and permissions, then choose **Check readiness**. This checks runtime registration and agent visibility without calling `run()` and therefore does not fabricate a step-2 access. Use a semantically relevant chat request to test the complete generative agent loop.

## Install and publish

1. Host `manifest.json` and the entrypoint on a trusted HTTPS origin or create a `.codexskill` package.
2. Paste the manifest URL or select the local package under **Settings → Skills**.
3. Confirm trust, install, enable the skill, select profiles, grant only necessary permissions, and save setup.
4. Test a request that semantically needs the skill.

Reinstalling the same ID updates it. External manifests and offline entrypoint source are stored in `codexIdeInstalledSkillManifestsV1`; state and setup are stored in `codexIdeSkillStatesV1`. Uninstall removes both records for that ID.

Every genuine execution flows through `1. Reasoning`, `2. Skill access`, and `3. Final answer`. Step 2 comes only from runtime events. Blocked calls are “not started”; thrown runtime errors are technical failures. Source skills propagate their exact current-turn source count into the final model step, including the zero-source prohibition on citations.

A future hub record should include manifest URL, ID, version, author, license, supported languages, checksum/signature, requested permissions, and review status. A hub must never auto-grant permissions or bypass the user's trust confirmation.

Every runtime that uses `fetch` or another network channel must declare the required manifest permission with the stable ID `network`. Such skills remain visible to the agent and executable in the local Codex IDE workspace after installation, enablement, profile selection, and explicit user permission. Every executed or blocked request is reported visibly; a blocked request must not be silently discarded or retried. Codex-native web search remains separately disabled there. Network skills must never locate or replace already-local workspace content.

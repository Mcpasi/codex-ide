'use strict';

// Native tools inspect the workspace. The browser's live editor applies and
// persists project changes, with full access to every model-home file type.
const MODEL_HOME_PERMISSIONS = 'codex-ide-live-editor';
const MODEL_HOME_TOOL_VERSION = 3;
const MODEL_HOME_PERMISSION_PROFILE = {
  filesystem: {
    ':root': 'read',
    ':workspace_roots': { '.': 'read' },
    ':tmpdir': 'write',
    ':slash_tmp': 'write'
  },
  network: { enabled: false }
};

function modelHomeConfigArgs() {
  const inlineTable = value => typeof value === 'object'
    ? '{' + Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}=${inlineTable(item)}`).join(',') + '}'
    : JSON.stringify(value);
  return [
    '-c', `default_permissions="${MODEL_HOME_PERMISSIONS}"`,
    '-c', `permissions.${MODEL_HOME_PERMISSIONS}=${inlineTable(MODEL_HOME_PERMISSION_PROFILE)}`,
    '-c', 'approval_policy="never"'
  ];
}

module.exports = { MODEL_HOME_PERMISSIONS, MODEL_HOME_TOOL_VERSION, MODEL_HOME_PERMISSION_PROFILE, modelHomeConfigArgs };

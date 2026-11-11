'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// All write, delete, symlink and update tests operate in a disposable workspace.
function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-ide-test-'));
  const home = path.join(root, 'model-home');
  fs.mkdirSync(home);
  return {
    root,
    home,
    write(relativePath, content, base = home) {
      const target = path.join(base, relativePath);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
      return target;
    },
    read(relativePath, base = home) {
      return fs.readFileSync(path.join(base, relativePath), 'utf8');
    },
    dispose() {
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
}

module.exports = { createFixture };

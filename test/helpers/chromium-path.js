'use strict';

const fs = require('fs');
const path = require('path');

const chromium = process.env.CODEX_IDE_TEST_BROWSER || [
  ...String(process.env.PATH || '').split(path.delimiter).flatMap(directory =>
    ['chromium', 'chromium-browser', 'google-chrome'].map(name => path.join(directory, name))),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
].find(candidate => fs.existsSync(candidate));

module.exports = { chromium };

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const vm = require('vm');

function files(folder) {
  return fs.readdirSync(folder, { withFileTypes: true }).flatMap(entry => {
    const name = path.join(folder, entry.name);
    return entry.isDirectory() ? files(name) : [name];
  });
}

const sources = ['app.js', 'api.js', ...['lib', 'drivers', 'settings', 'scripts', 'tests'].flatMap(files)];
let count = 0;
for (const file of sources) {
  if (file.endsWith('.js')) {
    const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
    if (result.status !== 0) process.exit(result.status || 1);
    count++;
  }
  if (file.endsWith('.html')) {
    const html = fs.readFileSync(file, 'utf8');
    for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
      new vm.Script(match[1], { filename: file });
    }
  }
}
for (const file of [...files('.homeycompose'), ...files('locales'), ...sources, 'package.json', 'package-lock.json', 'app.json']) {
  if (file.endsWith('.json')) JSON.parse(fs.readFileSync(file, 'utf8'));
}
console.log(`Syntax checked ${count} JavaScript files, embedded scripts and JSON definitions.`);

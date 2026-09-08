'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const vm = require('vm');

test('settings callback signals ready before DOM initialization and uses backend for tests/save', () => {
  const source = fs.readFileSync('settings/settings.js', 'utf8');
  const elements = {}, events = [], callbacks = [];
  let domReady, ready = false;
  const document = {
    readyState: 'loading',
    addEventListener(name, callback) { assert.equal(name, 'DOMContentLoaded'); domReady = callback; },
    getElementById(id) {
      assert(ready);
      if (!elements[id]) elements[id] = { addEventListener(name, callback) { this[name] = callback; } };
      return elements[id];
    }
  };
  const context = { document, window: {} };
  vm.createContext(context); vm.runInContext(source, context);
  const Homey = {
    ready() { ready = true; },
    get(key, callback) { callbacks.push(() => callback(null, key === 'enigma2_ip' ? '192.0.2.1' : null)); },
    alert: (...args) => events.push(['alert', ...args]), __: key => key,
    api(method, path, data, callback) { events.push([method, path, data]); callback(null); }
  };
  context.window.onHomeyReady(Homey);
  assert(ready); assert.equal(Object.keys(elements).length, 0);
  domReady(); assert(elements.save.disabled); callbacks.forEach(callback => callback());
  assert.equal(elements.save.disabled, false);
  assert.equal(elements.enigma2_protocol.value, 'http');
  elements.test.click(); assert.equal(events[0][0], 'POST'); assert.equal(events[0][1], '/test_connection');
  elements.save.click(); assert(events.some(event => event[1] === '/connection'));
});

test('pairing waits for settings acknowledgment and shows backend validation errors', () => {
  const html = fs.readFileSync('drivers/enigma2/pair/start.html', 'utf8');
  const source = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const calls = [], elements = {};
  let acknowledgment;
  const context = {
    __: key => key,
    document: { getElementById(id) { if (!elements[id]) elements[id] = { value: '', checked: true }; return elements[id]; } },
    Homey: {
      setTitle() {}, emit(name, data, callback) { calls.push([name, data]); acknowledgment = callback; },
      showView(name) { calls.push(['view', name]); }, alert(message) { calls.push(['alert', message]); }
    }
  };
  vm.createContext(context); vm.runInContext(source, context);
  context.saveSettings(); assert.equal(calls.length, 1);
  acknowledgment(new Error('Invalid port')); assert.equal(calls[1][0], 'alert');
  context.saveSettings(); acknowledgment(null); assert.equal(calls.at(-1)[0], 'view');
});

test('all UI translation references exist and settings page has no external script dependency', () => {
  const pairing = fs.readFileSync('drivers/enigma2/pair/start.html', 'utf8');
  const settings = fs.readFileSync('settings/index.html', 'utf8');
  assert(!/<script[^>]+src="https?:/i.test(settings));
  const keys = [...(pairing + settings).matchAll(/data-i18n="([^"]+)"/g)].map(match => match[1]);
  for (const locale of ['en', 'de', 'nl']) {
    const json = JSON.parse(fs.readFileSync(`locales/${locale}.json`, 'utf8'));
    for (const key of keys) assert.equal(typeof key.split('.').reduce((obj, part) => obj && obj[part], json), 'string', `${locale}: ${key}`);
  }
});

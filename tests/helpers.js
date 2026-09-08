'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');

function load(relative, overrides = {}, globals = {}) {
  const filename = path.resolve(__dirname, '..', relative);
  const localRequire = createRequire(filename);
  const context = {
    module: { exports: {} }, exports: {}, Buffer, TextDecoder, URL, URLSearchParams,
    setTimeout, clearTimeout, console,
    require: name => Object.prototype.hasOwnProperty.call(overrides, name) ? overrides[name] : localRequire(name),
    ...globals
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  return context.module.exports;
}

const settings = { IPAddress: '192.0.2.1', Port: 80, PollInterval: 5, Username: '', Password: '' };
const power = standby => `<e2powerstate><e2instandby>${standby}</e2instandby></e2powerstate>`;
const volume = (value = 50, muted = false) => `<e2volume><e2result>True</e2result><e2current>${value}</e2current><e2ismuted>${muted}</e2ismuted></e2volume>`;
const current = (duration = 100, remaining = 50, title = 'News') => `<e2currentserviceinformation><e2service><e2servicename>TV</e2servicename></e2service><e2eventlist><e2event><e2eventtitle>${title}</e2eventtitle><e2eventduration>${duration}</e2eventduration><e2eventremaining>${remaining}</e2eventremaining></e2event></e2eventlist></e2currentserviceinformation>`;
const info = '<e2deviceinfo><e2devicename>Test receiver</e2devicename></e2deviceinfo>';
const remote = '<e2remotecontrol><e2result>True</e2result></e2remotecontrol>';

function homeyMock() {
  const actions = new Map(), conditions = new Map(), triggers = [];
  function card(map, id) {
    if (!map.has(id)) map.set(id, { registrations: 0, registerRunListener(fn) { this.run = fn; this.registrations++; } });
    return map.get(id);
  }
  const store = {};
  return {
    actions, conditions, triggers, store,
    settings: { get: key => store[key], set: (key, value) => { store[key] = value; } },
    images: { async createImage() { return { setStream(fn) { this.stream = fn; }, async update() {}, async unregister() { this.unregistered = true; } }; } },
    flow: {
      getActionCard: id => card(actions, id), getConditionCard: id => card(conditions, id),
      getDeviceTriggerCard: id => ({ async trigger(device) { triggers.push([id, device]); } })
    }
  };
}

class HomeyDevice {
  constructor() { this.caps = {}; this.listeners = {}; this.available = true; this.logs = []; this.homey = homeyMock(); }
  getSettings() { return this.settings || settings; }
  hasCapability() { return true; }
  getCapabilityValue(key) { return this.caps[key]; }
  async setCapabilityValue(key, value) { this.caps[key] = value; }
  registerCapabilityListener(key, fn) { this.listeners[key] = fn; }
  getAvailable() { return this.available; }
  async setAvailable() { this.available = true; }
  async setUnavailable() { this.available = false; }
  async setAlbumArtImage(image) { this.image = image; }
  log(...args) { this.logs.push(args); }
  error(...args) { this.logs.push(args); }
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

module.exports = { load, settings, power, volume, current, info, remote, homeyMock, HomeyDevice, deferred };

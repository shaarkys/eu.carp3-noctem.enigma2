'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const lib = require('../lib/enigma2');
const { load, settings, power, volume, current, info, remote, homeyMock, HomeyDevice, deferred } = require('./helpers');

function setup(handler = async spec => ({ deviceinfo: info, powerstate: power(false), vol: volume(), getcurrent: current(), remotecontrol: remote }[spec.split('?')[0]])) {
  const clients = [], timers = new Map();
  let timerId = 0;
  class Client extends lib.Enigma2Client {
    constructor(value) { super(value); clients.push(this); this.calls = []; }
    async call(spec) {
      if (this.closed) throw lib.cancelled();
      this.calls.push(spec);
      const response = await handler(spec, this);
      if (this.closed) throw lib.cancelled();
      return lib.validateResponse(response, spec.split('?')[0]);
    }
    async request() { throw new Error('Unexpected network attempt'); }
  }
  const shared = { ...lib, Enigma2Client: Client };
  const Device = load('drivers/enigma2/device.js', { homey: { Device: HomeyDevice }, '../../lib/enigma2': shared }, {
    setTimeout: (callback, delay) => { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout: id => timers.delete(id)
  });
  const App = load('app.js', { homey: { App: HomeyDevice }, './lib/enigma2': shared });
  const Driver = load('drivers/enigma2/driver.js', { homey: { Driver: HomeyDevice }, '../../lib/enigma2': shared });
  return { Device, App, Driver, clients, timers };
}

test('all declared Flow actions/conditions register once and selected devices receive commands', async () => {
  const { App, Device } = setup();
  const app = new App(); await app.onInit();
  const a = new Device(), b = new Device(); a.homey = b.homey = app.homey;
  a.updateSettings(settings); b.updateSettings({ ...settings, IPAddress: '192.0.2.2' });
  a.registerFlowCards(); b.registerFlowCards(); await b.onAdded();
  await app.homey.actions.get('powerstate_reboot_device').run({ device: a });
  assert.equal(a.client.calls.at(-1), 'powerstate?newstate=2');
  assert.equal(b.client.calls.length, 0);
  assert.equal(await app.homey.conditions.get('is_standby_on_device').run({ device: a }), false);
  const manifest = JSON.parse(fs.readFileSync('app.json', 'utf8'));
  for (const card of manifest.flow.actions) assert.equal(app.homey.actions.get(card.id).registrations, 1, card.id);
  for (const card of manifest.flow.conditions) assert.equal(app.homey.conditions.get(card.id).registrations, 1, card.id);
  await a.onDeleted(); await b.onDeleted(); await app.onUninit();
});

test('legacy Flow target stays app-wide and saved settings apply without restart', async () => {
  const { App, Device } = setup(); const app = new App(); await app.onInit();
  Object.assign(app.homey.store, { enigma2_ip: '192.0.2.10', enigma2_port: 80 });
  const d = new Device(); d.homey = app.homey; d.registerFlowCards();
  await app.homey.actions.get('vol_set').run({ volume: 20 });
  const previous = app.legacyClient;
  assert.equal(previous.settings.IPAddress, '192.0.2.10');
  app.homey.store.enigma2_ip = '192.0.2.11';
  await app.homey.actions.get('vol_set').run({ volume: 30 });
  assert(previous.closed); assert.equal(app.legacyClient.settings.IPAddress, '192.0.2.11');
  await app.onUninit();
});

test('legacy Flow and wake-for-play propagate receiver failures', async () => {
  const { App, Device } = setup(async spec => {
    if (spec === 'powerstate') return power(true);
    throw new Error('Enigma2 request failed (ECONNREFUSED)');
  });
  const app = new App(); await app.onInit(); app.homey.store.enigma2_ip = '192.0.2.1';
  await assert.rejects(app.homey.actions.get('powerstate_on').run({}), /ECONNREFUSED/);
  const device = new Device(); device.updateSettings(settings);
  await assert.rejects(device.onSpeakerPlayingChanged(true), /ECONNREFUSED/);
  await app.onUninit(); await device.onDeleted();
});

test('onInit returns and listeners register before a pending device-info request finishes', async () => {
  const pending = deferred();
  const { Device } = setup(async spec => spec === 'deviceinfo' ? pending.promise : spec === 'powerstate' ? power(true) : volume());
  const device = new Device(); await device.onInit();
  assert.equal(typeof device.listeners.onoff, 'function');
  pending.resolve(info); await device.queue;
  await device.onDeleted();
});

test('reinitialization and poll restarts leave only one timer and close old resources', async () => {
  const { Device, timers } = setup(); const device = new Device();
  await device.onInit(); await device.queue; await Promise.resolve();
  const oldClient = device.client, oldImage = device.albumArtImage;
  await device.onInit(); await device.queue; await Promise.resolve();
  assert(oldClient.closed); assert(oldImage.unregistered);
  device.startPolling(); device.startPolling(); await device.queue; await Promise.resolve();
  assert.equal(timers.size, 1);
  await device.onDeleted(); assert.equal(timers.size, 0);
});

test('existing out-of-range polling settings retain the old runtime clamp without changing stored data', async () => {
  const { Device } = setup(); const device = new Device();
  device.settings = { ...settings, PollInterval: 120 };
  await device.onInit(); await device.queue;
  assert.equal(device.pollingIntervalMs, 60000); assert.equal(device.settings.PollInterval, 120);
  await device.onDeleted();
});

test('metadata polling does not undo a successful pause request on the same service', async () => {
  const { Device } = setup(); const device = new Device(); device.updateSettings(settings);
  await device.updateCurrentPlayingInfo();
  await device.onSpeakerPlayingChanged(false); device.caps.speaker_playing = false;
  await device.updateCurrentPlayingInfo(); assert.equal(device.caps.speaker_playing, false);
  await device.onSpeakerPlayingChanged(true); await device.updateCurrentPlayingInfo();
  assert.equal(device.caps.speaker_playing, true);
  await device.onDeleted();
});

test('polling and commands serialize instead of overlapping slow requests', async () => {
  const pending = deferred(); let hold = false, active = 0, peak = 0;
  const { Device, timers } = setup(async spec => {
    peak = Math.max(peak, ++active);
    if (hold && spec === 'powerstate') await pending.promise;
    active--;
    return spec === 'deviceinfo' ? info : spec.startsWith('powerstate') ? power(true) : remote;
  });
  const device = new Device(); await device.onInit(); await device.queue; await Promise.resolve();
  const timer = [...timers.values()][0]; timers.clear(); hold = true;
  const polling = timer.callback();
  const command = device.executeEnigma2Command('remotecontrol?command=1');
  await Promise.resolve(); assert.equal(timers.size, 0);
  pending.resolve(); await Promise.all([polling, command]);
  assert.equal(peak, 1); assert.equal(timers.size, 1);
  await device.onDeleted();
});

test('settings changes cancel old work and reject stale updates, while invalid settings preserve connection', async () => {
  const pending = deferred();
  const { Device } = setup(async (spec, client) => client.settings.IPAddress === settings.IPAddress ? pending.promise : power(true));
  const device = new Device(); device.updateSettings(settings);
  const oldClient = device.client;
  const oldPoll = device.pollPowerState(); await Promise.resolve();
  const oldResult = assert.rejects(oldPoll, { code: 'ERR_CANCELED' });
  await assert.rejects(device.onSettings({ newSettings: { ...settings, Port: 70000 } }));
  assert.equal(device.client, oldClient); assert.equal(oldClient.closed, false);
  await device.onSettings({ newSettings: { ...settings, IPAddress: '192.0.2.2' } });
  pending.resolve(power(false)); await oldResult; await device.queue;
  assert(oldClient.closed); assert.equal(device.caps.onoff, false);
  await device.onDeleted();
});

test('standby/wake restores unchanged programme and volume compares actual capability state', async () => {
  let standby = false;
  const { Device } = setup(async spec => spec === 'powerstate' ? power(standby) : spec === 'vol' ? volume() : current());
  const device = new Device(); device.updateSettings(settings);
  await device.pollPowerState(); await device.updateCurrentPlayingInfo();
  assert.equal(device.caps.speaker_track, 'News');
  standby = true; await device.pollPowerState();
  assert.equal(device.caps.speaker_track, '');
  standby = false; await device.pollPowerState(); await device.updateCurrentPlayingInfo();
  assert.equal(device.caps.speaker_track, 'News'); assert.equal(device.caps.speaker_playing, true);
  await device.pollVolumeState(); device.caps.volume_set = 0.2; await device.pollVolumeState();
  assert.equal(device.caps.volume_set, 0.5);
  await device.onDeleted();
});

test('zero/negative EPG timing is bounded and missing current EPG never takes the next event', async () => {
  let xml = current(0, 0);
  const { Device } = setup(async () => xml); const device = new Device(); device.updateSettings(settings);
  await device.updateCurrentPlayingInfo(); assert.equal(device.caps.speaker_artist, 'TV (0%)');
  xml = current(100, -20); await device.updateCurrentPlayingInfo(); assert.equal(device.caps.speaker_artist, 'TV (100%)');
  xml = current().replace('<e2eventtitle>News</e2eventtitle>', '').replace('</e2eventlist>', '<e2event><e2eventtitle>Next show</e2eventtitle></e2event></e2eventlist>');
  await device.updateCurrentPlayingInfo(); assert.equal(device.caps.speaker_track, '');
  await device.onDeleted();
});

test('availability triggers only on confirmed transitions, with no startup or per-endpoint flapping', async () => {
  let fail = true;
  const { Device, timers } = setup(async spec => {
    if (spec === 'vol' && fail) throw new Error('Invalid volume');
    return { deviceinfo: info, powerstate: power(false), vol: volume(), getcurrent: current() }[spec];
  });
  const device = new Device(); await device.onInit(); await device.queue; await Promise.resolve();
  assert.equal(device.available, false); assert.equal(device.homey.triggers.length, 0);
  const tick = async () => { const timer = [...timers.values()][0]; timers.clear(); await timer.callback(); };
  await tick(); assert.equal(device.homey.triggers.length, 0);
  fail = false; await tick(); assert.equal(device.homey.triggers[0][0], 'device_available');
  fail = true; await tick(); assert.equal(device.homey.triggers[1][0], 'device_unavailable');
  await tick(); assert.equal(device.homey.triggers.length, 2);
  await device.onDeleted();
});

test('pairing sessions keep separate settings, normalize numbers and never log secrets', async () => {
  const { Driver, clients } = setup(); const driver = new Driver();
  function session() { const handlers = {}; return { handlers, setHandler: (key, value) => { handlers[key] = value; } }; }
  const a = session(), b = session(); await driver.onPair(a); await driver.onPair(b);
  await a.handlers.get_devices({ ...settings, Port: '443', PollInterval: '5', Password: 'SECRET' });
  await b.handlers.get_devices({ ...settings, IPAddress: '192.0.2.2' });
  await b.handlers.test_connection({ ...settings, IPAddress: '192.0.2.3' });
  const aa = await a.handlers.list_devices(), bb = await b.handlers.list_devices();
  assert.equal(aa[0].data.id, '192.0.2.1'); assert.equal(bb[0].data.id, '192.0.2.2');
  assert.equal(typeof aa[0].settings.Port, 'number');
  assert.equal(typeof aa[0].settings.PollInterval, 'number');
  assert.equal(JSON.stringify(driver.logs).includes('SECRET'), false);
  assert(clients.every(client => client.closed));
});

test('pairing rejects HTML responses and disconnect closes pending clients', async () => {
  const pending = deferred(); let hold = false;
  const { Driver, clients } = setup(async () => hold ? pending.promise : '<html>Login</html>');
  const driver = new Driver(), handlers = {};
  await driver.onPair({ setHandler: (key, value) => { handlers[key] = value; } });
  await assert.rejects(handlers.test_connection(settings), /Invalid Enigma2/);
  hold = true; const connection = handlers.test_connection(settings);
  handlers.disconnect(); assert(clients.every(client => client.closed));
  pending.resolve(info); await assert.rejects(connection);
});

test('app settings API validates before saving and does not expose credentials in results', async () => {
  const api = require('../api'); const homey = homeyMock();
  homey.app = { testConnection: async () => true };
  assert.equal(await api.testConnection({ homey, body: settings }), true);
  await assert.rejects(api.saveConnection({ homey, body: { ...settings, Port: 0 } }));
  assert.equal(Object.keys(homey.store).length, 0);
  assert.equal(await api.saveConnection({ homey, body: { ...settings, Password: 'SECRET' } }), true);
  assert.equal(homey.store.enigma2_password, 'SECRET'); assert.equal(homey.store.enigma2_port, 80);
});

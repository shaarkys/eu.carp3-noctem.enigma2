'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const { Readable, Writable } = require('stream');
const lib = require('../lib/enigma2');
const { decodeEnigma2Response } = require('../lib/encoding');
const { load, settings, info, power, volume, remote } = require('./helpers');

test('normalize numeric settings, preserve protocol defaults and support custom HTTPS/IPv6', () => {
  const value = lib.normalizeSettings({ ...settings, Port: '443', PollInterval: '10' });
  assert.equal(value.Port, 443);
  assert.equal(value.PollInterval, 10);
  assert.equal(lib.connectionDetails(value).protocol, 'https');
  assert.equal(value.AllowSelfSigned, true);
  assert.equal(lib.connectionDetails(lib.normalizeSettings({ ...settings, Port: 8443, Protocol: 'https' })).protocol, 'https');
  assert.equal(lib.connectionDetails(lib.normalizeSettings({ ...settings, IPAddress: '::1' })).host, '[::1]:80');
  for (const change of [{ IPAddress: '999.1.2.3' }, { IPAddress: 'x/y' }, { IPAddress: 'http://x' }, { Port: 'NaN' }, { Port: 65536 }, { PollInterval: 4 }, { Protocol: 'ftp' }]) {
    assert.throws(() => lib.normalizeSettings({ ...settings, ...change }));
  }
});

test('response validation rejects HTML, incomplete states and receiver rejection', () => {
  for (const endpoint of ['powerstate', 'vol', 'deviceinfo', 'getcurrent', 'message', 'remotecontrol']) {
    assert.throws(() => lib.validateResponse('<html>Login</html>', endpoint));
  }
  assert.throws(() => lib.validateResponse('<e2powerstate></e2powerstate>', 'powerstate'));
  assert.throws(() => lib.validateResponse(remote.replace('True', 'False'), 'remotecontrol'), /rejected/);
  assert.throws(() => lib.validateResponse(volume(101), 'vol'));
  assert.equal(lib.validateResponse(info, 'deviceinfo'), info);
  assert.equal(lib.booleanTag(power('TRUE'), 'e2instandby'), true);
});

test('messages preserve special characters and pipes; zero timeout remains zero', () => {
  const spec = lib.commandFor('message_send', { msg_text_full: '1|0|A&B # č | tail' });
  const params = new URL(`http://example.invalid/web/${spec}`).searchParams;
  assert.equal(params.get('text'), 'A&B # č | tail');
  assert.equal(params.get('type'), '1');
  assert.equal(params.get('timeout'), '0');
  assert.throws(() => lib.commandFor('message_send', { msg_text_full: 'hello' }));
  assert.throws(() => lib.commandFor('command_send', { command: '1&foo=x' }));
});

test('XML entities and CDATA are decoded without reinterpreting CDATA entities', () => {
  assert.equal(lib.xmlText('<x>A &amp; B &#x10d; &#269;</x>', 'x'), 'A & B č č');
  assert.equal(lib.xmlText('<x><![CDATA[A &amp; B]]></x>', 'x'), 'A &amp; B');
});

test('retain UTF-8, declared central-European encoding and existing ISO-6937 accent handling', () => {
  assert.equal(decodeEnigma2Response(Buffer.from('Příliš žluťoučký'), 'text/xml; charset=UTF-8'), 'Příliš žluťoučký');
  assert.equal(decodeEnigma2Response(Buffer.from([0xe8]), 'text/xml; charset=windows-1250'), 'č');
  assert.equal(decodeEnigma2Response(Buffer.from('Âa Ďc Ęu')), 'á č ů');
});

function transport(handler, globals) {
  const mock = Object.assign(handler, { CancelToken: axios.CancelToken, isCancel: axios.isCancel });
  return load('lib/enigma2.js', { axios: mock }, globals);
}

test('transport sets limits, no redirects, empty-password auth and certificate verification', async () => {
  let config;
  const { Enigma2Client } = transport(async value => { config = value; return { data: Buffer.from(info), headers: {} }; });
  const client = new Enigma2Client({ ...settings, Username: 'root', Password: '', Protocol: 'https', AllowSelfSigned: false });
  assert.equal(await client.call('deviceinfo'), info);
  assert.equal(config.timeout, 10000);
  assert.equal(config.maxRedirects, 0);
  assert.equal(config.auth.password, '');
  assert.equal(config.httpsAgent.options.rejectUnauthorized, true);
  assert(config.maxContentLength > 0);
  client.close();
});

test('transport errors never retain credentials, raw response, config or cause', async () => {
  const { Enigma2Client } = transport(async () => {
    const error = new Error('SECRET in URL');
    error.config = { auth: { password: 'SECRET' } }; error.response = { status: 401, data: 'SECRET' };
    throw error;
  });
  const client = new Enigma2Client(settings);
  await assert.rejects(client.call('deviceinfo'), error => {
    assert.equal(error.message, 'Enigma2 request failed (HTTP 401)');
    assert.equal(error.config, undefined); assert.equal(error.cause, undefined);
    return true;
  });
  client.close();
});

test('deadline cancels a pending request and clears timer', async () => {
  let deadline, cleared = 0;
  const { Enigma2Client } = transport(config => new Promise((_resolve, reject) => config.cancelToken.promise.then(reject)), {
    setTimeout: callback => { deadline = callback; return 1; }, clearTimeout: () => { cleared++; }
  });
  const client = new Enigma2Client(settings);
  const request = client.call('deviceinfo');
  deadline();
  await assert.rejects(request, /timed out/);
  assert.equal(cleared, 1); assert.equal(client.pending.size, 0);
  client.close();
});

test('close cancels in-flight requests and refuses future calls', async () => {
  const { Enigma2Client } = transport(config => new Promise((_resolve, reject) => config.cancelToken.promise.then(reject)));
  const client = new Enigma2Client(settings);
  const request = client.call('deviceinfo'); client.close();
  await assert.rejects(request, { code: 'ERR_CANCELED' });
  await assert.rejects(client.call('deviceinfo'), { code: 'ERR_CANCELED' });
});

test('mute requests serialize, are idempotent, and recover after a rejected request', async () => {
  const client = new lib.Enigma2Client(settings);
  let muted = false, toggles = 0;
  client.call = async spec => {
    if (spec === 'vol?set=mute') { toggles++; muted = !muted; }
    return volume(50, muted);
  };
  await Promise.all([client.setMuted(true), client.setMuted(true)]);
  assert.equal(toggles, 1); assert.equal(muted, true);
  await Promise.all([client.setMuted(false), client.setMuted(false)]);
  assert.equal(toggles, 2); assert.equal(muted, false);
  await assert.rejects(client.setMuted('false'));
  await client.setMuted(true); assert.equal(muted, true);
  client.close();
});

test('image streaming awaits completion and rejects source errors and oversized images', async () => {
  let source;
  const { Enigma2Client } = transport(async () => ({ data: source, headers: {} }));
  const client = new Enigma2Client(settings);
  let output = '';
  source = Readable.from(['abc', 'def']);
  await client.request('/picon/test.png', new Writable({ write(chunk, _encoding, done) { output += chunk; done(); } }));
  assert.equal(output, 'abcdef');
  source = new Readable({ read() { this.destroy(new Error('source failed')); } });
  await assert.rejects(client.request('/picon/test.png', new Writable({ write(_chunk, _encoding, done) { done(); } })));
  source = Readable.from([Buffer.alloc(lib.MAX_RESPONSE_BYTES + 1)]);
  await assert.rejects(client.request('/picon/test.png', new Writable({ write(_chunk, _encoding, done) { done(); } })));
  client.close();
});

test('deadline also bounds a stalled image destination after response headers', async () => {
  let deadline;
  const { Enigma2Client } = transport(async () => ({ data: Readable.from(['image']), headers: {} }), {
    setTimeout: callback => { deadline = callback; return 1; }, clearTimeout() {}
  });
  const client = new Enigma2Client(settings);
  const output = new Writable({ write() { /* Deliberately never acknowledge this chunk. */ } });
  const request = client.request('/picon/test.png', output);
  await new Promise(resolve => setImmediate(resolve));
  deadline();
  await assert.rejects(request, /timed out/);
  assert(output.destroyed); client.close();
});

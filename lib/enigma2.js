'use strict';

const axios = require('axios');
const https = require('https');
const net = require('net');
const { Transform, pipeline } = require('stream');
const { promisify } = require('util');
const { decodeEnigma2Response } = require('./encoding');

const pipe = promisify(pipeline);
const REQUEST_TIMEOUT = 10000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

function integer(value, min, max, label) {
  if (!/^-?\d+$/.test(String(value).trim())) throw new Error(`Invalid ${label}`);
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < min || result > max) throw new Error(`Invalid ${label}`);
  return result;
}

function normalizeSettings(settings) {
  if (!settings || typeof settings !== 'object') throw new Error('Receiver settings are required');
  const ip = String(settings.IPAddress || '').trim();
  // Only an address/hostname is accepted, never a URL, credentials or a path.
  const hostname = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/i;
  if (!net.isIP(ip) && (!hostname.test(ip) || /^[\d.]+$/.test(ip))) throw new Error('Invalid receiver address');
  const port = settings.Port === '' || settings.Port == null ? 443 : integer(settings.Port, 1, 65535, 'port');
  const poll = settings.PollInterval == null || settings.PollInterval === '' ? 5 : integer(settings.PollInterval, 5, 60, 'poll interval');
  const protocol = settings.Protocol || 'auto';
  if (!['auto', 'http', 'https'].includes(protocol)) throw new Error('Invalid protocol');
  if (settings.AllowSelfSigned != null && typeof settings.AllowSelfSigned !== 'boolean') throw new Error('Invalid certificate setting');
  return {
    IPAddress: ip, Port: port, PollInterval: poll, Protocol: protocol,
    // Retain compatibility with receivers using self-signed certificates.
    AllowSelfSigned: settings.AllowSelfSigned !== false,
    Username: String(settings.Username || ''), Password: String(settings.Password || '')
  };
}

function connectionDetails(settings) {
  const protocol = settings.Protocol === 'auto' ? (settings.Port === 443 ? 'https' : 'http') : settings.Protocol;
  const address = net.isIP(settings.IPAddress) === 6 ? `[${settings.IPAddress}]` : settings.IPAddress;
  return { protocol, host: `${address}:${settings.Port}`, isHttps: protocol === 'https' };
}

function xmlText(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  if (!match) return null;
  return match[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>|&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (all, cdata, entity) => {
    if (cdata !== undefined) return cdata;
    const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    if (entity[0] !== '#') return named[entity.toLowerCase()];
    const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '\uFFFD';
  }).trim();
}

function booleanTag(xml, tag) {
  const value = xmlText(xml, tag);
  if (value === null || !/^(true|false)$/i.test(value)) throw new Error(`Invalid Enigma2 response: ${tag}`);
  return value.toLowerCase() === 'true';
}

function validateResponse(xml, endpoint) {
  const roots = { deviceinfo: 'e2deviceinfo', powerstate: 'e2powerstate', vol: 'e2volume', getcurrent: 'e2currentserviceinformation', remotecontrol: 'e2remotecontrol', message: 'e2simplexmlresult' };
  const root = roots[endpoint];
  const document = xml.replace(/^\uFEFF/, '').replace(/^\s*<\?xml[^?]*\?>/, '').trim();
  if (!root || !new RegExp(`^<${root}\\b[^>]*>[\\s\\S]*<\\/${root}>$`, 'i').test(document)) throw new Error(`Invalid Enigma2 ${endpoint} response`);
  const resultTag = endpoint === 'message' ? 'e2state' : 'e2result';
  if ((endpoint === 'remotecontrol' || endpoint === 'message' || endpoint === 'vol') && !booleanTag(xml, resultTag)) throw new Error(`Enigma2 rejected ${endpoint} command`);
  if (endpoint === 'powerstate') booleanTag(xml, 'e2instandby');
  if (endpoint === 'vol') parseVolume(xml);
  if (endpoint === 'deviceinfo' && !['e2devicename', 'e2enigmaversion', 'e2webifversion'].some(tag => xmlText(xml, tag))) throw new Error('Invalid Enigma2 device information');
  return xml;
}

function parseVolume(xml) {
  const volume = integer(xmlText(xml, 'e2current'), 0, 100, 'volume response');
  return { volume, isMuted: booleanTag(xml, 'e2ismuted') };
}

function messageCommand(value) {
  const parts = String(value).split('|');
  if (parts.length < 3) throw new Error('Use message format: type|timeout|text');
  const type = integer(parts.shift(), 0, 3, 'message type');
  const timeout = integer(parts.shift(), 0, 2147483647, 'message timeout');
  return `message?${new URLSearchParams({ text: parts.join('|'), type: String(type), timeout: String(timeout) })}`;
}

function commandFor(action, args = {}) {
  const power = { powerstate_deepstandby: 1, powerstate_reboot: 2, powerstate_restart_enigma2: 3, powerstate_on: 4, powerstate_off: 5 };
  if (Object.prototype.hasOwnProperty.call(power, action)) return `powerstate?newstate=${power[action]}`;
  if (action === 'command_send') return `remotecontrol?command=${integer(args.command, 0, 65535, 'command ID')}`;
  if (action === 'message_send') return messageCommand(args.msg_text_full);
  if (action === 'vol_set') return `vol?set=set${integer(args.volume, 0, 100, 'volume')}`;
  throw new Error('Unsupported Enigma2 action');
}

function cancelled() {
  const error = new Error('Enigma2 operation cancelled');
  error.code = 'ERR_CANCELED';
  return error;
}

class Enigma2Client {
  constructor(settings) {
    this.settings = normalizeSettings(settings);
    const { protocol, host } = connectionDetails(this.settings);
    this.baseUrl = `${protocol}://${host}`;
    this.agent = new https.Agent({ rejectUnauthorized: !this.settings.AllowSelfSigned });
    this.pending = new Set();
    this.closed = false;
    this.muteQueue = Promise.resolve();
  }

  async request(path, stream) {
    if (this.closed) throw cancelled();
    const source = axios.CancelToken.source();
    let responseStream;
    const cancel = () => {
      source.cancel();
      if (responseStream) {
        responseStream.destroy(cancelled());
        stream.destroy(cancelled());
      }
    };
    this.pending.add(cancel);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; cancel(); }, REQUEST_TIMEOUT);
    const config = {
      method: 'get', url: this.baseUrl + path, timeout: REQUEST_TIMEOUT,
      cancelToken: source.token, maxRedirects: 0, maxContentLength: MAX_RESPONSE_BYTES,
      responseType: stream ? 'stream' : 'arraybuffer', transformResponse: data => data,
      httpsAgent: this.agent
    };
    if (this.settings.Username) config.auth = { username: this.settings.Username, password: this.settings.Password };
    try {
      const response = await axios(config);
      if (this.closed) {
        if (stream) response.data.destroy();
        throw cancelled();
      }
      if (stream) {
        responseStream = response.data;
        let bytes = 0;
        const limit = new Transform({ transform(chunk, encoding, callback) {
          bytes += chunk.length;
          callback(bytes > MAX_RESPONSE_BYTES ? new Error('Image exceeds size limit') : null, chunk);
        } });
        await pipe(response.data, limit, stream);
        return;
      }
      return decodeEnigma2Response(Buffer.from(response.data), response.headers['content-type']);
    } catch (error) {
      // Axios errors retain auth and full URLs. Expose only status/code, never their config or cause.
      if (this.closed || (!timedOut && axios.isCancel(error))) throw cancelled();
      const status = error.response && error.response.status;
      const code = error.code && /^[A-Z0-9_]+$/.test(error.code) ? error.code : 'REQUEST_FAILED';
      throw new Error(timedOut ? 'Enigma2 request timed out' : `Enigma2 request failed (${status ? `HTTP ${status}` : code})`);
    } finally {
      clearTimeout(timer);
      this.pending.delete(cancel);
    }
  }

  async call(spec) {
    const endpoint = spec.split('?')[0];
    const xml = await this.request(`/web/${spec}`);
    return validateResponse(xml, endpoint);
  }

  setMuted(value) {
    if (typeof value !== 'boolean') return Promise.reject(new Error('Invalid mute state'));
    const run = this.muteQueue.then(async () => {
      let xml = await this.call('vol');
      if (parseVolume(xml).isMuted !== value) xml = await this.call('vol?set=mute');
      if (parseVolume(xml).isMuted !== value) throw new Error('Receiver did not apply the requested mute state');
      return xml;
    });
    this.muteQueue = run.catch(() => {});
    return run;
  }

  close() {
    this.closed = true;
    for (const cancel of this.pending) cancel();
    this.agent.destroy();
  }
}

module.exports = { Enigma2Client, normalizeSettings, connectionDetails, xmlText, booleanTag, parseVolume, validateResponse, commandFor, cancelled, REQUEST_TIMEOUT, MAX_RESPONSE_BYTES };

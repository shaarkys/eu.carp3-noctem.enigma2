'use strict';

const { normalizeSettings } = require('./lib/enigma2');

module.exports = {
  async testConnection({ homey, body }) {
    return homey.app.testConnection(normalizeSettings(body));
  },
  async saveConnection({ homey, body }) {
    const settings = normalizeSettings(body);
    const values = {
      ip: settings.IPAddress, port: settings.Port,
      username: settings.Username, password: settings.Password,
      protocol: settings.Protocol, allow_self_signed: settings.AllowSelfSigned
    };
    for (const [key, value] of Object.entries(values)) homey.settings.set(`enigma2_${key}`, value);
    return true;
  }
};

'use strict';

const Homey = require('homey');
const { Enigma2Client, normalizeSettings } = require('../../lib/enigma2');

class Enigma2Driver extends Homey.Driver {
  async onInit() {
    this.log('Enigma2Driver initialized');
  }

  async onPair(session) {
    let deviceData;
    let disconnected = false;
    const clients = new Set();
    const test = async settings => {
      if (disconnected) throw new Error('Pairing session ended');
      const client = new Enigma2Client(settings);
      clients.add(client);
      try {
        await client.call('deviceinfo');
        if (disconnected) throw new Error('Pairing session ended');
        return true;
      } finally {
        clients.delete(client);
        client.close();
      }
    };
    session.setHandler('get_devices', async data => {
      deviceData = normalizeSettings(data);
      return true;
    });
    session.setHandler('list_devices', async () => {
      if (!deviceData) throw new Error('No device data provided');
      const settings = { ...deviceData };
      await test(settings);
      return [{
        name: `Enigma2 Receiver IP.${settings.IPAddress.split('.').pop()}`,
        // Retain the existing pairing ID contract.
        data: { id: settings.IPAddress },
        settings
      }];
    });
    session.setHandler('test_connection', data => test(normalizeSettings(data)));
    session.setHandler('disconnect', () => {
      disconnected = true;
      deviceData = null;
      for (const client of clients) client.close();
      this.log('Pairing finished');
    });
  }
}

module.exports = Enigma2Driver;

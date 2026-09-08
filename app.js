'use strict';

const Homey = require('homey');
const { Enigma2Client, normalizeSettings, commandFor, booleanTag } = require('./lib/enigma2');

class Enigma2 extends Homey.App {
  async onInit() {
    this.log('enigma2 app started successfully');
    this.legacyQueue = Promise.resolve();
    this.stopped = false;
    this.testClients = new Set();
    this.registerFlowCards();
  }

  legacySettings() {
    const get = key => this.homey.settings.get(`enigma2_${key}`);
    return normalizeSettings({
      IPAddress: get('ip'), Port: get('port') || 80,
      Username: get('username'), Password: get('password'),
      // Legacy app-wide connections were HTTP regardless of port.
      Protocol: get('protocol') || 'http', AllowSelfSigned: get('allow_self_signed') !== false
    });
  }

  withLegacyClient(operation) {
    const run = (this.legacyQueue || Promise.resolve()).then(async () => {
      if (this.stopped) throw new Error('App is stopping');
      const settings = this.legacySettings();
      if (!this.legacyClient || JSON.stringify(settings) !== JSON.stringify(this.legacyClient.settings)) {
        if (this.legacyClient) this.legacyClient.close();
        this.legacyClient = new Enigma2Client(settings);
      }
      return operation(this.legacyClient);
    });
    this.legacyQueue = run.catch(() => {});
    return run;
  }

  callEnigma2(spec) {
    return this.withLegacyClient(client => client.call(spec));
  }

  checkStandbyState() {
    return this.withLegacyClient(async client => booleanTag(await client.call('powerstate'), 'e2instandby'));
  }

  async testConnection(settings) {
    if (this.stopped) throw new Error('App is stopping');
    const client = new Enigma2Client(settings);
    this.testClients.add(client);
    try {
      await client.call('deviceinfo');
      return true;
    } finally {
      this.testClients.delete(client);
      client.close();
    }
  }

  registerFlowCards() {
    const actions = ['command_send', 'message_send', 'powerstate_deepstandby', 'powerstate_reboot', 'powerstate_restart_enigma2', 'powerstate_on', 'powerstate_off'];
    for (const action of actions) {
      this.homey.flow.getActionCard(action).registerRunListener(async args => {
        await this.callEnigma2(commandFor(action, args));
        return true;
      });
      this.homey.flow.getActionCard(`${action}_device`).registerRunListener(async args => {
        if (!args.device) throw new Error('Select an Enigma2 receiver');
        await args.device.executeEnigma2Command(commandFor(action, args));
        return true;
      });
    }
    this.homey.flow.getActionCard('vol_set').registerRunListener(async args => {
      await this.callEnigma2(commandFor('vol_set', args));
      return true;
    });
    for (const [id, muted] of [['vol_mute', true], ['vol_unmute', false]]) {
      this.homey.flow.getActionCard(id).registerRunListener(async () => {
        await this.withLegacyClient(client => client.setMuted(muted));
        return true;
      });
    }
    this.homey.flow.getConditionCard('is_standby_on').registerRunListener(() => this.checkStandbyState());
    this.homey.flow.getConditionCard('is_standby_on_device').registerRunListener(args => {
      if (!args.device) throw new Error('Select an Enigma2 receiver');
      return args.device.checkStandbyState();
    });
  }

  async onUninit() {
    this.stopped = true;
    if (this.legacyClient) this.legacyClient.close();
    for (const client of this.testClients || []) client.close();
    if (this.legacyQueue) await this.legacyQueue;
  }
}

module.exports = Enigma2;

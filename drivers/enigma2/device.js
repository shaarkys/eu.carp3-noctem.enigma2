'use strict';

const { Device } = require('homey');
const { Enigma2Client, normalizeSettings, connectionDetails, xmlText, booleanTag, parseVolume, cancelled } = require('../../lib/enigma2');

class Enigma2Device extends Device {
  async onInit() {
    if (this.client) await this.onUninit();
    this.stopped = false;
    this.queue = Promise.resolve();
    this.availabilityInitialized = false;
    const settings = this.getSettings();
    const poll = Number(settings.PollInterval);
    // Older versions accepted out-of-range stored intervals and clamped them at runtime.
    this.updateSettings({ ...settings, PollInterval: Number.isInteger(poll) ? Math.min(60, Math.max(5, poll)) : 5 });
    this.registerFlowCards();
    if (!this.listenersRegistered) {
      this.registerCapabilityListener('onoff', this.onCapabilityOnOff.bind(this));
      this.registerCapabilityListener('volume_set', value => {
        if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error('Invalid volume');
        return this.executeEnigma2Command(`vol?set=set${Math.round(value * 100)}`);
      });
      this.registerCapabilityListener('volume_mute', value => this.setMuted(value));
      this.registerCapabilityListener('volume_up', this.onVolumeUp.bind(this));
      this.registerCapabilityListener('volume_down', this.onVolumeDown.bind(this));
      this.registerCapabilityListener('channel_up', this.onChannelUp.bind(this));
      this.registerCapabilityListener('channel_down', this.onChannelDown.bind(this));
      this.registerCapabilityListener('speaker_next', this.onSpeakerNext.bind(this));
      this.registerCapabilityListener('speaker_prev', this.onSpeakerPrev.bind(this));
      this.registerCapabilityListener('speaker_playing', this.onSpeakerPlayingChanged.bind(this));
      this.listenersRegistered = true;
    }
    try {
      this.albumArtImage = await this.homey.images.createImage();
    } catch (error) {
      this.error('Could not create album art image:', error.message);
    }
    // Device information is diagnostic; it must not hold up capability registration or onInit.
    this.enqueue(async context => {
      const xml = await context.client.call('deviceinfo');
      this.assertCurrent(context);
      this.log('Device info:', {
        deviceName: xmlText(xml, 'e2devicename'),
        enigmaVersion: xmlText(xml, 'e2enigmaversion'),
        webifVersion: xmlText(xml, 'e2webifversion')
      });
    }).catch(error => this.logOperationError('Device information', error));
    this.startPolling();
  }

  enqueue(operation) {
    const context = { client: this.client, revision: this.revision };
    const run = (this.queue || Promise.resolve()).then(async () => {
      this.assertCurrent(context);
      return operation(context);
    });
    this.queue = run.catch(() => {});
    return run;
  }

  assertCurrent(context) {
    if (this.stopped || context.revision !== this.revision || context.client.closed) throw cancelled();
  }

  async setValue(context, capability, value) {
    this.assertCurrent(context);
    if (this.hasCapability(capability) && this.getCapabilityValue(capability) !== value) {
      await this.setCapabilityValue(capability, value);
    }
  }

  logOperationError(operation, error) {
    if (error.code !== 'ERR_CANCELED') this.error(`${operation} failed:`, error.message);
  }

  updateSettings(settings) {
    const normalized = normalizeSettings(settings);
    this.stopPolling();
    if (this.client) this.client.close();
    this.revision = (this.revision || 0) + 1;
    this.connectionSettings = normalized;
    this.pollingIntervalMs = normalized.PollInterval * 1000;
    this.client = new Enigma2Client(normalized);
    this.previousStates = { serviceReference: null };
    this.playbackOverride = null;
    this.playbackService = null;
  }

  async onSettings({ newSettings }) {
    // Validate before cancelling work or changing the live connection.
    normalizeSettings(newSettings);
    this.updateSettings(newSettings);
    this.startPolling();
    this.log('Receiver connection settings updated');
  }

  async onAdded() {
    this.log('Enigma2 device added');
  }

  async onRenamed() {
    this.log('Enigma2 device renamed');
  }

  stopPolling() {
    this.pollGeneration = (this.pollGeneration || 0) + 1;
    if (this.pollingTimer) clearTimeout(this.pollingTimer);
    this.pollingTimer = null;
  }

  startPolling() {
    this.stopPolling();
    const generation = this.pollGeneration;
    const poll = async () => {
      if (this.stopped || generation !== this.pollGeneration) return;
      try {
        await this.enqueue(async context => {
          try {
            const isOn = await this.pollPowerState(context);
            if (isOn) {
              await this.pollVolumeState(context);
              await this.updateCurrentPlayingInfo(context);
            }
            this.assertCurrent(context);
            await this.updateAvailability(true);
          } catch (error) {
            this.assertCurrent(context);
            await this.updateAvailability(false);
            throw error;
          }
        });
      } catch (error) {
        this.logOperationError('Polling', error);
      } finally {
        if (!this.stopped && generation === this.pollGeneration) {
          this.pollingTimer = setTimeout(poll, this.pollingIntervalMs);
        }
      }
    };
    void poll();
  }

  async pollPowerState(context) {
    if (!context) return this.enqueue(current => this.pollPowerState(current));
    const isOn = !booleanTag(await context.client.call('powerstate'), 'e2instandby');
    await this.setValue(context, 'onoff', isOn);
    if (!isOn) {
      this.playbackOverride = null;
      await this.clearPlayingInfo(context);
      this.previousStates.serviceReference = null;
    }
    return isOn;
  }

  async pollVolumeState(context) {
    if (!context) return this.enqueue(current => this.pollVolumeState(current));
    await this.applyVolume(context, await context.client.call('vol'));
  }

  async applyVolume(context, xml) {
    const state = parseVolume(xml);
    await this.setValue(context, 'volume_set', state.volume / 100);
    await this.setValue(context, 'volume_mute', state.isMuted);
  }

  async clearPlayingInfo(context) {
    for (const [capability, value] of Object.entries({ speaker_artist: '', speaker_track: '', speaker_playing: false, speaker_position: 0, speaker_duration: 0 })) {
      await this.setValue(context, capability, value);
    }
  }

  async updateCurrentPlayingInfo(context) {
    if (!context) return this.enqueue(current => this.updateCurrentPlayingInfo(current));
    const xml = await context.client.call('getcurrent');
    this.assertCurrent(context);
    const serviceName = xmlText(xml, 'e2servicename') || '';
    const reference = xmlText(xml, 'e2servicereference');
    const service = reference || serviceName;
    if (this.playbackService !== service) this.playbackOverride = null;
    this.playbackService = service;
    // Restrict EPG fields to the first event, so absent current data cannot select the next show.
    const eventMatch = xml.match(/<e2event\b[^>]*>([\s\S]*?)<\/e2event>/i);
    const event = eventMatch ? eventMatch[1] : '';
    const title = xmlText(event, 'e2eventtitle') || '';
    const rawDuration = Number(xmlText(event, 'e2eventduration'));
    const duration = Number.isFinite(rawDuration) && rawDuration > 0 ? rawDuration : 0;
    const remainingText = xmlText(event, 'e2eventremaining');
    const remaining = Number(remainingText);
    const elapsed = duration && remainingText !== null && Number.isFinite(remaining) ? Math.min(duration, Math.max(0, duration - remaining)) : 0;
    const percent = duration ? Math.round(elapsed / duration * 100) : 0;
    await this.setValue(context, 'speaker_artist', serviceName ? `${serviceName} (${percent}%)` : '');
    await this.setValue(context, 'speaker_track', title);
    await this.setValue(context, 'speaker_playing', Boolean(serviceName) && this.playbackOverride !== false);
    // Preserve the integration's existing minute-based display contract.
    await this.setValue(context, 'speaker_duration', Number((duration / 60).toFixed(1)));
    await this.setValue(context, 'speaker_position', Number((elapsed / 60).toFixed(1)));
    if (reference && this.albumArtImage && reference !== this.previousStates.serviceReference) {
      const filename = encodeURIComponent(reference.replace(/:/g, '_').replace(/_$/, ''));
      try {
        this.albumArtImage.setStream(async stream => {
          try {
            this.assertCurrent(context);
            await context.client.request(`/picon/${filename}.png`, stream);
          } catch (error) {
            this.logOperationError('Album art download', error);
            throw error;
          }
        });
        await this.setAlbumArtImage(this.albumArtImage);
        await this.albumArtImage.update();
        this.assertCurrent(context);
        this.previousStates.serviceReference = reference;
      } catch (error) {
        this.logOperationError('Album art update', error);
      }
    }
  }

  registerFlowCards() {
    // Action/condition listeners are registered once by the app and dispatch through args.device.
    this.deviceUnavailableTrigger = this.homey.flow.getDeviceTriggerCard('device_unavailable');
    this.deviceAvailableTrigger = this.homey.flow.getDeviceTriggerCard('device_available');
  }

  async updateAvailability(isAvailable) {
    const wasAvailable = this.getAvailable();
    const initialized = this.availabilityInitialized;
    if (isAvailable !== wasAvailable) {
      if (isAvailable) await this.setAvailable();
      else await this.setUnavailable();
    }
    this.availabilityInitialized = true;
    if (initialized && isAvailable !== wasAvailable) {
      const trigger = isAvailable ? this.deviceAvailableTrigger : this.deviceUnavailableTrigger;
      try {
        if (trigger) await trigger.trigger(this, {}, {});
      } catch (error) {
        this.logOperationError('Availability Flow trigger', error);
      }
    }
  }

  async executeEnigma2Command(spec) {
    return this.enqueue(async context => {
      const xml = await context.client.call(spec);
      this.assertCurrent(context);
      if (spec.split('?')[0] === 'vol') await this.applyVolume(context, xml);
      this.log('Enigma2 command accepted:', spec.split('?')[0]);
      return xml;
    });
  }

  callEnigma2(spec) {
    return this.enqueue(context => context.client.call(spec));
  }

  getConnectionDetails() {
    return connectionDetails(this.connectionSettings);
  }

  checkStandbyState() {
    return this.enqueue(async context => booleanTag(await context.client.call('powerstate'), 'e2instandby'));
  }

  setMuted(value) {
    return this.enqueue(async context => {
      await this.applyVolume(context, await context.client.setMuted(value));
      return true;
    });
  }

  // Retain the explicit toggle helper for callers that intentionally request a toggle.
  handleMuteToggle() {
    return this.executeEnigma2Command('vol?set=mute');
  }

  onCapabilityOnOff(value) {
    return this.executeEnigma2Command(`powerstate?newstate=${value ? 4 : 5}`);
  }

  onVolumeUp() { return this.executeEnigma2Command('vol?set=up'); }
  onVolumeDown() { return this.executeEnigma2Command('vol?set=down'); }

  changeChannel(command, requireOn) {
    return this.enqueue(async context => {
      if (requireOn && booleanTag(await context.client.call('powerstate'), 'e2instandby')) throw new Error('Receiver is in standby');
      const result = await context.client.call(`remotecontrol?command=${command}`);
      this.assertCurrent(context);
      this.playbackOverride = null;
      await this.updateCurrentPlayingInfo(context);
      return result;
    });
  }

  onChannelUp() { return this.changeChannel(402, false); }
  onChannelDown() { return this.changeChannel(403, false); }
  onSpeakerNext() { return this.changeChannel(402, true); }
  onSpeakerPrev() { return this.changeChannel(403, true); }

  onSpeakerPlayingChanged(playing) {
    return this.enqueue(async context => {
      const standby = booleanTag(await context.client.call('powerstate'), 'e2instandby');
      if (standby && playing) await context.client.call('powerstate?newstate=4');
      else if (!standby) await context.client.call(`remotecontrol?command=${playing ? 207 : 119}`);
      this.assertCurrent(context);
      this.playbackOverride = playing;
      return true;
    });
  }

  async onUninit() {
    this.stopped = true;
    this.stopPolling();
    this.revision = (this.revision || 0) + 1;
    if (this.client) this.client.close();
    if (this.queue) await this.queue;
    if (this.albumArtImage) {
      try { await this.albumArtImage.unregister(); }
      catch (error) { this.logOperationError('Album art cleanup', error); }
      this.albumArtImage = null;
    }
  }

  async onDeleted() {
    await this.onUninit();
    this.log('Enigma2 device deleted');
  }
}

module.exports = Enigma2Device;

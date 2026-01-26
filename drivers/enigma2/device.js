'use strict';

const { Device } = require('homey');
const { Image, ManagerImages } = require('homey');
const axios = require('axios');
const https = require('https');

const DEFAULT_TEXT_ENCODING = 'utf-8';
const FALLBACK_TEXT_ENCODINGS = ['utf-8', 'windows-1250', 'iso-8859-2', 'latin1'];

function normalizeEncodingName(encoding) {
  if (!encoding || typeof encoding !== 'string') {
    return null;
  }
  const normalized = encoding.trim().toLowerCase();
  if (normalized === 'utf8') return 'utf-8';
  if (normalized === 'latin-1') return 'latin1';
  if (normalized === 'cp1250' || normalized === 'windows1250') return 'windows-1250';
  if (normalized === 'latin2') return 'iso-8859-2';
  return normalized;
}

function extractXmlEncoding(text) {
  if (!text) return null;
  const match = text.match(/<\?xml[^>]*encoding=['"]([^'"]+)['"][^>]*\?>/i);
  return match ? match[1] : null;
}

function extractCharset(contentType) {
  if (!contentType || typeof contentType !== 'string') return null;
  const match = contentType.match(/charset=([^;]+)/i);
  return match ? match[1] : null;
}

function decodeBuffer(buffer, encoding) {
  const normalized = normalizeEncodingName(encoding);
  if (!normalized) return null;
  if (normalized === 'utf-8') return buffer.toString('utf8');
  if (normalized === 'latin1') return buffer.toString('latin1');
  if (typeof TextDecoder !== 'function') return null;
  try {
    return new TextDecoder(normalized).decode(buffer);
  } catch (error) {
    return null;
  }
}

function looksMojibake(text) {
  if (!text) return false;
  return /[\u00C2\u00C3]/.test(text) || text.includes('\uFFFD');
}

function decodeEnigma2Response(buffer, contentType, preferredEncoding) {
  if (!Buffer.isBuffer(buffer)) {
    return buffer;
  }

  const asciiText = buffer.toString('latin1');
  const xmlEncoding = normalizeEncodingName(extractXmlEncoding(asciiText));
  const headerEncoding = normalizeEncodingName(extractCharset(contentType));
  const normalizedPreferred = normalizeEncodingName(preferredEncoding);
  const triedEncodings = new Set();
  const encodingCandidates = [];

  if (normalizedPreferred && normalizedPreferred !== 'auto') {
    const decodedPreferred = decodeBuffer(buffer, normalizedPreferred);
    if (decodedPreferred) {
      return decodedPreferred;
    }
  }

  if (xmlEncoding) encodingCandidates.push(xmlEncoding);
  if (headerEncoding) encodingCandidates.push(headerEncoding);
  FALLBACK_TEXT_ENCODINGS.forEach((encoding) => encodingCandidates.push(encoding));

  let fallbackDecoded = null;
  for (const encoding of encodingCandidates) {
    if (!encoding || triedEncodings.has(encoding)) continue;
    triedEncodings.add(encoding);
    const decoded = decodeBuffer(buffer, encoding);
    if (!decoded) continue;
    if (!fallbackDecoded) {
      fallbackDecoded = decoded;
    }
    if (!looksMojibake(decoded)) {
      return decoded;
    }
  }

  return fallbackDecoded || buffer.toString(DEFAULT_TEXT_ENCODING);
}

function decodeEnigma2Payload(payload, contentType, preferredEncoding) {
  if (Buffer.isBuffer(payload)) {
    return decodeEnigma2Response(payload, contentType, preferredEncoding);
  }

  if (typeof payload !== 'string') {
    return payload;
  }

  const normalizedPreferred = normalizeEncodingName(preferredEncoding);
  if (normalizedPreferred && normalizedPreferred !== 'auto') {
    const buffer = Buffer.from(payload, 'latin1');
    const decoded = decodeBuffer(buffer, normalizedPreferred);
    return decoded || payload;
  }

  if (!looksMojibake(payload)) {
    return payload;
  }

  const buffer = Buffer.from(payload, 'latin1');
  return decodeEnigma2Response(buffer, contentType, preferredEncoding);
}

function parseDeviceInfo(xml) {
  const getValue = (tag) => {
    const openTag = `<${tag}>`;
    const closeTag = `</${tag}>`;
    const start = xml.indexOf(openTag) + openTag.length;
    const end = xml.indexOf(closeTag);
    return start < openTag.length || end === -1 ? null : xml.substring(start, end);
  };

  return {
    oeVersion: getValue('e2oeversion'),
    enigmaVersion: getValue('e2enigmaversion'),
    distroVersion: getValue('e2distroversion'),
    imageVersion: getValue('e2imageversion'),
    driverDate: getValue('e2driverdate'),
    webifVersion: getValue('e2webifversion'),
    fpVersion: getValue('e2fpversion'),
    deviceName: getValue('e2devicename'),
    // Additional fields can be parsed in a similar manner...
  };
}

class enigma2_device extends Device {

  async onInit() {
    this.log('--enigma2 device --');

    this.availabilityInitialized = false;
    this.deviceUnavailableTrigger = null;
    this.deviceAvailableTrigger = null;

    this.albumArtImage = await this.homey.images.createImage();

    // Initialize device settings
    const settings = this.getSettings();
    this.updateSettings(settings);

    // Initialize previous states cache
    this.previousStates = {
      volume: null,
      isMuted: null,
      serviceName: null,
      eventTitle: null,
      serviceReference: null
    };

    // get device info on init
    try {
      const deviceInfoXml = await this.callEnigma2('deviceinfo');
      const deviceInfo = parseDeviceInfo(deviceInfoXml);
      this.log('Device Info:', deviceInfo);
    } catch (error) {
      this.error('Failed to get device info:', error);
    }

    // Register flow cards
    this.registerFlowCards();

    // Register capability listeners
    this.registerCapabilityListener('onoff', this.onCapabilityOnOff.bind(this));

    // Capability listener for setting volume
    this.registerCapabilityListener('volume_set', async (value) => {
      const callSpec = `vol?set=set${Math.round(value * 100)}`; // Assuming volume value is between 0 and 1
      return this.executeEnigma2Command(callSpec);
    });
    // Capability listener for muting/unmuting volume
    this.registerCapabilityListener('volume_mute', async (value) => {
      if (value) {
        // Check if currently unmuted before sending mute command
        await this.handleMuteToggle();
      } else {
        // Check if currently muted before sending mute command
        await this.handleMuteToggle();
      }
    });

    // Register capability listeners for volume up and down
    this.registerCapabilityListener('volume_up', this.onVolumeUp.bind(this));
    this.registerCapabilityListener('volume_down', this.onVolumeDown.bind(this));

    // Register capability listeners for channel up and down
    this.registerCapabilityListener('channel_up', this.onChannelUp.bind(this));
    this.registerCapabilityListener('channel_down', this.onChannelDown.bind(this));

    this.registerCapabilityListener('speaker_next', this.onSpeakerNext.bind(this));
    this.registerCapabilityListener('speaker_prev', this.onSpeakerPrev.bind(this));

    await this.updateAvailability(false); // Initially mark the device as unavailable

    // Add listener for speaker_playing
    this.registerCapabilityListener('speaker_playing', this.onSpeakerPlayingChanged.bind(this));


    // Start polling
    this.startPolling();

  }
  async pollPowerState() {
    try {
      const isStandby = await this.checkStandbyState();
      const isOn = !isStandby;

      await this.updateAvailability(true); // Device is back online

      await this.setCapabilityValue('onoff', isOn);

      if (isOn) {
        await this.updateCurrentPlayingInfo();
      } else {
        // Set the speaker labels to "off" and other related states when the device is off
        await this.setCapabilityValue('speaker_artist', '');
        await this.setCapabilityValue('speaker_track', '');
        await this.setCapabilityValue('speaker_playing', false);
        await this.setCapabilityValue('speaker_position', 0); // Set position to 0
        await this.setCapabilityValue('speaker_duration', 0); // Set duration to 0
        this.log('Device is off. Resetting speaker info.');
      }
      return isOn;
    } catch (error) {
      await this.updateAvailability(false); // Set unavailable if there's an error
      this.error('Device is offline:', error);
      return false;
    }
  }

  startPolling() {
    this.pollingInterval = setInterval(async () => {
      try {
        const isDeviceOn = await this.pollPowerState(); // Check power state
        if (isDeviceOn) {
          await this.pollVolumeState(); // Poll volume state only if device is on
        }
      } catch (error) {
        this.error('Error during polling:', error);
      }
    }, this.pollingIntervalMs || 5000); // Poll every 5 seconds by default
  }

  async pollVolumeState() {
    try {
      // Check if the device is marked as available before attempting to poll
      if (this.getAvailable()) {
        const volumeData = await this.callEnigma2('vol');

        // Parse the volume data
        const volume = parseInt(volumeData.match(/<e2current>(\d+)<\/e2current>/)[1], 10);
        const isMuted = volumeData.match(/<e2ismuted>(.*?)<\/e2ismuted>/)[1].trim() === 'True';

        // Update the volume_set and volume_mute capabilities if there's a change
        if (this.previousStates.volume !== volume || this.previousStates.isMuted !== isMuted) {
          await this.setCapabilityValue('volume_set', volume / 100);
          await this.setCapabilityValue('volume_mute', isMuted);

          // Update the cached state
          this.previousStates.volume = volume;
          this.previousStates.isMuted = isMuted;
        }
      }
    } catch (error) {
      // If an error occurs (e.g., network issue), mark the device as unavailable
      await this.updateAvailability(false).catch(this.error);
      this.error('Error polling volume state:', error);
    }
  }



  /**
   * onAdded is called when the user adds the device, called just after pairing.
   */
  async onAdded() {
    this.log('enigma2 device has been added');
    // Retrieve device-specific settings
    const settings = this.getSettings();
    this.updateSettings(settings);

    this.registerFlowCards();

  }

  updateSettings(settings) {
    const portValue = settings.Port !== undefined && settings.Port !== null ? String(settings.Port).trim() : '';
    const portNumber = portValue ? Number(portValue) : null;
    const port = Number.isInteger(portNumber) && portNumber > 0 ? portNumber : null;
    const pollValue = settings.PollInterval !== undefined && settings.PollInterval !== null ? String(settings.PollInterval).trim() : '';
    const pollNumber = pollValue ? Number(pollValue) : null;
    const pollSeconds = Number.isInteger(pollNumber) ? Math.min(Math.max(pollNumber, 5), 60) : 5;
    this.pollingIntervalMs = pollSeconds * 1000;
    const encodingValue = settings.TextEncoding !== undefined && settings.TextEncoding !== null
      ? String(settings.TextEncoding).trim()
      : '';
    const normalizedEncoding = normalizeEncodingName(encodingValue);
    this.textEncoding = normalizedEncoding && normalizedEncoding !== 'auto' ? normalizedEncoding : null;

    this.deviceData = {
      ipAddress: settings.IPAddress,
      port: port,
      username: settings.Username,
      password: settings.Password
    };
  }

  async onSettings({ oldSettings, newSettings, changedKeys }) {
    this.log('enigma2 device settings were changed');
    if (changedKeys.some(key => ['IPAddress', 'Port', 'Username', 'Password', 'PollInterval', 'TextEncoding'].includes(key))) {
      this.updateSettings(newSettings);
      // Add any additional logic needed when settings change
    }
    if (changedKeys.includes('PollInterval')) {
      clearInterval(this.pollingInterval);
      this.startPolling();
    }

  }

  /**
   * onRenamed is called when the user updates the device's name.
   * This method can be used this to synchronise the name to the device.
   * @param {string} name The new name
   */
  async onRenamed(name) {
    this.log('enigma2 device was renamed');
  }

  /**
   * onDeleted is called when the user deleted the device.
   */
  async onDeleted() {
    clearInterval(this.pollingInterval); // Stop the interval
    this.log('enigma2 device has been deleted');
  }

  // Helper method to execute Enigma2 command
  async executeEnigma2Command(callSpec) {
    try {
      const response = await this.callEnigma2(callSpec);
      this.log(`Enigma2 command executed: ${callSpec}`);
      return response; // Return full response
    } catch (error) {
      this.error(`Failed to execute Enigma2 command: ${error.message}`);
      return false;
    }
  }

  getConnectionDetails() {
    const port = this.deviceData && this.deviceData.port ? this.deviceData.port : null;
    const isHttps = !port || port === 443;
    const protocol = isHttps ? 'https' : 'http';
    const host = port ? `${this.deviceData.ipAddress}:${port}` : this.deviceData.ipAddress;
    return { protocol, host, isHttps };
  }

  async callEnigma2(call_spec) {
    try {
      //DEBUG
      //this.log("Calling Enigma2 API with: " + call_spec);
      const { protocol, host, isHttps } = this.getConnectionDetails();
      const url = `${protocol}://${host}/web/${call_spec}`;
      const config = {
        method: 'get',
        url: url,
        auth: this.deviceData.username && this.deviceData.password ? {
          username: this.deviceData.username,
          password: this.deviceData.password
        } : undefined
      };
      if (isHttps) {
        config.httpsAgent = new https.Agent({
          rejectUnauthorized: false  // Bypass SSL certificate errors
        });
      }
      config.responseType = 'arraybuffer';
      config.transformResponse = (data) => data;
      //DEBUG
      //this.log("Calling Enigma2 API with: " + JSON.stringify(config));
      const response = await axios(config);
      this.log(`Call sent to: ${url}`);
      // DEBUG
      //   this.log("API Response:", response.data); // Log the API response
      return decodeEnigma2Payload(
        response.data,
        response.headers && response.headers['content-type'],
        this.textEncoding
      );

    } catch (error) {
      this.error(`Call to Enigma2 failed: ${error.message}`);
      throw error;
    }
  }

  registerFlowCards() {
    // Command Send Action
    this.registerFlowCardAction('command_send_device', (args) => `remotecontrol?command=${args.command}`);

    // Message Send Action
    this.registerFlowCardAction('message_send_device', (args) => {
      const message_complete = args.msg_text_full;
      const message_split = message_complete.split("|");
      const msg_type = message_split[0];
      const timeout = message_split[1];
      const msg_txt = message_split[2];
      const msg_timeout = timeout === 0 ? "" : timeout;
      return `message?text=${msg_txt}&type=${msg_type}&timeout=${msg_timeout}`;
    });

    // Powerstate Deep Standby Action
    this.registerFlowCardAction('powerstate_deepstandby_device', () => 'powerstate?newstate=1');

    // Powerstate Reboot Action
    this.registerFlowCardAction('powerstate_reboot_device', () => 'powerstate?newstate=2');

    // Restart Enigma2 Action
    this.registerFlowCardAction('powerstate_restart_enigma2_device', () => 'powerstate?newstate=3');

    // Powerstate On Action
    this.registerFlowCardAction('powerstate_on_device', () => 'powerstate?newstate=4');

    // Powerstate Off Action
    this.registerFlowCardAction('powerstate_off_device', () => 'powerstate?newstate=5');

    // Volume Set Action
    this.registerFlowCardAction('vol_set', (args) => `vol?set=set${args.volume}`);

    // Volume Mute Flow Card Action
    this.registerFlowCardAction('vol_mute', async () => {
      await this.handleMuteToggle();
      return true; // Indicate successful execution of the flow card action
    });

    // Volume Unmute Flow Card Action
    this.registerFlowCardAction('vol_unmute', async () => {
      await this.handleMuteToggle();
      return true; // Indicate successful execution of the flow card action
    });

    // Checking state of Enigma2
    this.registerConditionFlowCard('is_standby_on');

    this.deviceUnavailableTrigger = this.homey.flow.getDeviceTriggerCard('device_unavailable');
    this.deviceAvailableTrigger = this.homey.flow.getDeviceTriggerCard('device_available');
  }

  registerFlowCardAction(cardName, getCallSpec) {
    const actionCard = this.homey.flow.getActionCard(cardName);
    actionCard.registerRunListener(async (args) => {
      const callSpec = await getCallSpec(args);
      if (typeof callSpec !== 'string') {
        return callSpec;
      }
      return this.executeEnigma2Command(callSpec);
    });
  }

  async checkStandbyState() {
    try {
      const response = await this.callEnigma2('powerstate');
      //DEBUG
      //this.log('Response from Enigma2:', response);

      if (!response) {
        this.error('Invalid response from Enigma2 or no response found');
        return false;
      }

      // Directly use `response` to match the regular expression
      const match = response.match(/<e2instandby>\s*(true|false)\s*<\/e2instandby>/);
      const isStandby = match ? match[1].trim() === 'true' : false;

      this.log(isStandby ? 'Enigma2 is currently in standby mode.' : 'Enigma2 is currently active (not in standby mode).');
      return isStandby;
    } catch (error) {
      throw new Error('Device might be offline'); // Throw to be caught in pollPowerState
    }
  }

  registerConditionFlowCard(cardName) {
    const conditionCard = this.homey.flow.getConditionCard(cardName);
    conditionCard.registerRunListener(async (args) => {
      const isStandby = await this.checkStandbyState();
      return (cardName === 'is_standby_on') ? isStandby : !isStandby;
    });
  }

  async updateAvailability(isAvailable) {
    const wasAvailable = this.getAvailable();

    if (!this.availabilityInitialized) {
      this.availabilityInitialized = true;
      if (isAvailable) {
        if (!wasAvailable) {
          await this.setAvailable();
        }
      } else if (wasAvailable) {
        await this.setUnavailable();
      }
      return;
    }

    if (isAvailable) {
      if (!wasAvailable) {
        await this.setAvailable();
        if (this.deviceAvailableTrigger) {
          await this.deviceAvailableTrigger.trigger(this, {}, {});
        }
      }
      return;
    }

    if (wasAvailable) {
      await this.setUnavailable();
      if (this.deviceUnavailableTrigger) {
        await this.deviceUnavailableTrigger.trigger(this, {}, {});
      }
    }
  }

  // Implement the onCapabilityOnOff method using the helper
  async onCapabilityOnOff(value, opts) {
    const newState = value ? 4 : 5; // 4 for on, 5 for off
    const callSpec = `powerstate?newstate=${newState}`;
    return this.executeEnigma2Command(callSpec);
  }


  async onVolumeUp() {
    const volumeIncreaseCommand = 'vol?set=up';
    const response = await this.callEnigma2(volumeIncreaseCommand);
    if (response) {
      const match = response.match(/<e2current>(\d+)<\/e2current>/);
      if (match && match[1]) {
        const newVolume = parseInt(match[1], 10);
        this.log(`Volume up result: ${newVolume}`);
        await this.setCapabilityValue('volume_set', newVolume / 100);
      }
    }
  }

  async onVolumeDown() {
    const volumeDecreaseCommand = 'vol?set=down';
    const response = await this.callEnigma2(volumeDecreaseCommand);
    if (response) {
      const match = response.match(/<e2current>(\d+)<\/e2current>/);
      if (match && match[1]) {
        const newVolume = parseInt(match[1], 10);
        this.log(`Volume down result: ${newVolume}`);
        await this.setCapabilityValue('volume_set', newVolume / 100);
      }
    }
  }

  async onChannelUp() {
    const channelUpCommand = 'remotecontrol?command=402'; // Command for channel up
    const result = await this.executeEnigma2Command(channelUpCommand);
    if (result) {
      await this.updateCurrentPlayingInfo();
    }
    return result;
  }

  async onChannelDown() {
    const channelDownCommand = 'remotecontrol?command=403'; // Command for channel down
    const result = await this.executeEnigma2Command(channelDownCommand);
    if (result) {
      await this.updateCurrentPlayingInfo();
    }
    return result;
  }

  async onSpeakerNext() {
    // Check if the device is currently off
    const isDeviceOff = !await this.getCapabilityValue('onoff');
    if (isDeviceOff) {
      this.log('Device is off. Skipping next channel command.');
      return false; // Indicate that the operation was not performed
    }

    // If the device is on, proceed with the next channel command
    const nextCommand = 'remotecontrol?command=402'; // Command for channel up
    const result = await this.executeEnigma2Command(nextCommand);
    if (result) {
      await this.updateCurrentPlayingInfo();
    }
    return result;
  }

  async onSpeakerPrev() {
    // Check if the device is currently off
    const isDeviceOff = !await this.getCapabilityValue('onoff');
    if (isDeviceOff) {
      this.log('Device is off. Skipping previous channel command.');
      return false; // Indicate that the operation was not performed
    }

    // If the device is on, proceed with the previous channel command
    const prevCommand = 'remotecontrol?command=403'; // Command for channel down
    const result = await this.executeEnigma2Command(prevCommand);
    if (result) {
      await this.updateCurrentPlayingInfo();
    }
    return result;
  }


  async updateCurrentPlayingInfo() {
    try {
      const response = await this.callEnigma2('getcurrent');
      // Parse the XML response to get service name, event title, and service reference
      const serviceNameMatch = response.match(/<e2servicename>(.*?)<\/e2servicename>/);
      const eventTitleMatch = response.match(/<e2eventtitle>(.*?)<\/e2eventtitle>/);
      const serviceReferenceMatch = response.match(/<e2servicereference>(.*?)<\/e2servicereference>/);
      const durationMatch = response.match(/<e2eventduration>(\d+)<\/e2eventduration>/);
      const remainingMatch = response.match(/<e2eventremaining>(\d+)<\/e2eventremaining>/);

      if (durationMatch) {
        const totalDuration = parseInt(durationMatch[1], 10);
        const durationTime = parseFloat((totalDuration / 60).toFixed(1)); // Convert seconds to minutes and round to 1 decimal place
        await this.setCapabilityValue("speaker_duration", durationTime);
      }

      let serviceName, eventTitle, serviceReference;
      let totalDuration = 0;
      let remainingTime = 0;
      let percentageCompleted = 0;
      let isPlaying = false;

      if (remainingMatch && durationMatch) {
        totalDuration = parseInt(durationMatch[1], 10);
        remainingTime = parseInt(remainingMatch[1], 10);
        percentageCompleted = ((totalDuration - remainingTime) / totalDuration) * 100;
        const currentPosition = parseFloat(((totalDuration - remainingTime) / 60).toFixed(1)); // Convert seconds to minutes and round to 1 decimal place
        await this.setCapabilityValue("speaker_position", currentPosition);
      }


      if (serviceNameMatch && eventTitleMatch) {
        serviceName = `${serviceNameMatch[1]} (${percentageCompleted.toFixed(0)}%)`;
        eventTitle = eventTitleMatch[1];
        isPlaying = eventTitle != null; // Playing if eventTitle is not null

        // Update capabilities if there's a change
        if (this.previousStates.serviceName !== serviceName ||
          this.previousStates.eventTitle !== eventTitle) {
          this.log('TV channel :', serviceName);
          this.log('Show:', eventTitle);
          await this.setCapabilityValue('speaker_artist', serviceName);
          await this.setCapabilityValue('speaker_track', eventTitle);

          // Update speaker_playing capability
          await this.setCapabilityValue('speaker_playing', isPlaying);

          // Update cache
          this.previousStates.serviceName = serviceName;
          this.previousStates.eventTitle = eventTitle;
        }
      }

      if (serviceReferenceMatch) {
        serviceReference = serviceReferenceMatch[1].replace(/:/g, '_').replace(/_$/, '');
        if (this.previousStates.serviceReference !== serviceReference) {
          const { protocol, host, isHttps } = this.getConnectionDetails();
          const albumArtUrl = `${protocol}://${host}/picon/${serviceReference}.png`;

          try {
            // Set the album art using a stream
            this.albumArtImage.setStream(async (stream) => {
              const instanceConfig = {};
              if (isHttps) {
                instanceConfig.httpsAgent = new https.Agent({
                  rejectUnauthorized: false // Bypass SSL certificate errors
                });
              }
              const instance = axios.create(instanceConfig);

              if (this.deviceData.username && this.deviceData.password) {
                instance.defaults.auth = {
                  username: this.deviceData.username,
                  password: this.deviceData.password
                };
              }

              const response = await instance.get(albumArtUrl, {
                responseType: 'stream'
              });
              response.data.pipe(stream);
            });

            this.setAlbumArtImage(this.albumArtImage);
            await this.albumArtImage.update();
            this.log('Album art image updated:', albumArtUrl);

            // Update cache
            this.previousStates.serviceReference = serviceReference;
          } catch (error) {
            this.error('Failed to update album art:', error);
          }
        }
      }
    } catch (error) {
      this.error('Failed to update current playing info:', error);
    }
  }



  // Mute toggle handling
  async handleMuteToggle() {
    const response = await this.executeEnigma2Command('vol?set=mute');
    if (response) {
      const isMutedMatch = response.match(/<e2ismuted>(.*?)<\/e2ismuted>/);
      if (isMutedMatch) {
        const isMuted = isMutedMatch[1].trim() === 'True';
        this.log(`Mute state is now: ${isMuted}`);
        await this.setCapabilityValue('volume_mute', isMuted);
      }
    }
  }

  async onSpeakerPlayingChanged(playing) {
    // Check if the device is currently off
    const isDeviceOff = !await this.getCapabilityValue('onoff');

    if (isDeviceOff && playing) {
      // Device is off and needs to be turned on for playing
      this.log('Device is off. Turning on the device.');
      await this.executeEnigma2Command('powerstate?newstate=4'); // Command to turn on the device
      // No need to send the play command as the device starts playing automatically when turned on
      return true; // Return true indicating successful execution
    } else if (!isDeviceOff) {
      // Device is already on, send the appropriate play or pause command
      let command = playing ? 207 : 119; // 207 for play, 119 for pause
      this.log(`Sending command ${command} to device.`);
      return this.executeEnigma2Command(`remotecontrol?command=${command}`);
    }
  }


}

module.exports = enigma2_device;

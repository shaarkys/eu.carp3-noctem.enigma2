'use strict';

const { Device } = require('homey');
const { Image, ManagerImages } = require('homey');
const axios = require('axios');
const https = require('https');
const fetch = require("node-fetch");

class enigma2_device extends Device {

  /**
   * onInit is called when the device is initialized.
   */
  async onInit() {
    this.log('enigma2 device has been initialized');

    this.albumArtImage = await this.homey.images.createImage();
    // await this.setAlbumArtImage(this.albumArtImage);


    // Initialize device settings
    const settings = this.getSettings();
    this.deviceData = {
      ipAddress: settings.IPAddress,
      port: settings.Port,
      username: settings.Username,
      password: settings.Password
    };

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

    // Start polling
    this.startPolling();


  }

  async pollPowerState() {
    const isStandby = await this.checkStandbyState();
    const isOn = !isStandby;

    await this.setCapabilityValue('onoff', isOn);

    if (isOn) {
      await this.updateCurrentPlayingInfo();
    } else {
      // Additional logic for the device being off
      await this.setCapabilityValue('speaker_artist', "");
      await this.setCapabilityValue('speaker_track', "");
    }
    return isOn; // Return the power state
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
    }, 5000); // Poll every 5 seconds
  }
  async pollVolumeState() {
    const volumeData = await this.callEnigma2('vol');
    const volume = parseInt(volumeData.match(/<e2current>(\d+)<\/e2current>/)[1], 10);
    const isMuted = volumeData.match(/<e2ismuted>(.*?)<\/e2ismuted>/)[1].trim() === 'True';

    await this.setCapabilityValue('volume_set', volume / 100);
    await this.setCapabilityValue('volume_mute', isMuted);
  }

  /**
   * onAdded is called when the user adds the device, called just after pairing.
   */
  async onAdded() {
    this.log('enigma2 device has been added');
    // Retrieve device-specific settings
    const settings = this.getSettings();
    this.enigma2_ip = settings.enigma2_ip;
    this.enigma2_port = settings.enigma2_port;
    this.enigma2_username = settings.enigma2_username;
    this.enigma2_password = settings.enigma2_password;
    this.enigma2_host = `${this.enigma2_ip}:${this.enigma2_port}`;

    this.registerFlowCards();
  }

  updateSettings(settings) {
    this.enigma2_ip = settings.enigma2_ip;
    this.enigma2_port = settings.enigma2_port;
    this.enigma2_username = settings.enigma2_username;
    this.enigma2_password = settings.enigma2_password;
    this.enigma2_host = `${this.enigma2_ip}:${this.enigma2_port}`;
  }

  async onSettings({ oldSettings, newSettings, changedKeys }) {
    this.log('enigma2 device settings were changed');
    if (changedKeys.some(key => ['enigma2_ip', 'enigma2_port', 'enigma2_username', 'enigma2_password'].includes(key))) {
      this.updateSettings(newSettings);
      // Add any additional logic needed when settings change
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

  async callEnigma2(call_spec) {
    try {
      //DEBUG
      //this.log("Calling Enigma2 API with: " + call_spec);
      const url = `https://${this.deviceData.ipAddress}/web/${call_spec}`;
      const config = {
        method: 'get',
        url: url,
        auth: this.deviceData.username && this.deviceData.password ? {
          username: this.deviceData.username,
          password: this.deviceData.password
        } : undefined,
        httpsAgent: new https.Agent({
          rejectUnauthorized: false  // Bypass SSL certificate errors
        })
      };
      //DEBUG
      //this.log("Calling Enigma2 API with: " + JSON.stringify(config));
      const response = await axios(config);
      this.log(`Call sent to: ${url}`);
      // DEBUG
      //   this.log("API Response:", response.data); // Log the API response
      return response.data; // Returning the raw XML response

    } catch (error) {
      this.error(`Call to Enigma2 failed: ${error.message}`);
      throw error;
    }
  }



  registerFlowCards() {
    // Command Send Action
    this.registerFlowCardAction('command_send', (args) => `remotecontrol?command=${args.command}`);

    // Message Send Action
    this.registerFlowCardAction('message_send', (args) => {
      const message_complete = args.msg_text_full;
      const message_split = message_complete.split("|");
      const msg_type = message_split[0];
      const timeout = message_split[1];
      const msg_txt = message_split[2];
      const msg_timeout = timeout === 0 ? "" : timeout;
      return `message?text=${msg_txt}&type=${msg_type}&timeout=${msg_timeout}`;
    });

    // Powerstate Deep Standby Action
    this.registerFlowCardAction('powerstate_deepstandby', () => 'powerstate?newstate=1');

    // Powerstate Reboot Action
    this.registerFlowCardAction('powerstate_reboot', () => 'powerstate?newstate=2');

    // Restart Enigma2 Action
    this.registerFlowCardAction('powerstate_restart_enigma2', () => 'powerstate?newstate=3');

    // Powerstate On Action
    this.registerFlowCardAction('powerstate_on', () => 'powerstate?newstate=4');

    // Powerstate Off Action
    this.registerFlowCardAction('powerstate_off', () => 'powerstate?newstate=5');

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
  }

  registerFlowCardAction(cardName, getCallSpec) {
    const actionCard = this.homey.flow.getActionCard(cardName);
    actionCard.registerRunListener(async (args) => {
      const call_spec = getCallSpec(args);
      await this.callEnigma2(call_spec);
      return true;
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
      this.error('Error checking standby state:', error);
      return false;
    }
  }




  registerConditionFlowCard(cardName) {
    const conditionCard = this.homey.flow.getConditionCard(cardName);
    conditionCard.registerRunListener(async (args) => {
      const isStandby = await this.checkStandbyState();
      return (cardName === 'is_standby_on') ? isStandby : !isStandby;
    });
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
    // Channel up command
    const nextCommand = 'remotecontrol?command=402';
    const result = await this.executeEnigma2Command(nextCommand);
    if (result) {
      await this.updateCurrentPlayingInfo();
    }
    return result;
  }

  async onSpeakerPrev() {
    // Channel down command
    const prevCommand = 'remotecontrol?command=403';
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

      if (serviceNameMatch && eventTitleMatch) {
        const serviceName = serviceNameMatch[1];
        const eventTitle = eventTitleMatch[1];

        this.log('TV Channel Name:', serviceName);
        this.log('Event:', eventTitle);

        // Update capabilities
        await this.setCapabilityValue('speaker_artist', serviceName);
        await this.setCapabilityValue('speaker_track', eventTitle);
      }

      if (serviceReferenceMatch) {
        let serviceReference = serviceReferenceMatch[1].replace(/:/g, '_').replace(/_$/, '');
        const albumArtUrl = `https://${this.deviceData.ipAddress}/picon/${serviceReference}.png`;

        // Set the album art using a stream
        this.albumArtImage.setStream(async (stream) => {
          const res = await fetch(albumArtUrl);

          if (!res.ok) {
            throw new Error("Failed to fetch image");
          }

          return res.body.pipe(stream);
        });

        await this.albumArtImage.update();
        this.log('Album art image updated:', albumArtUrl);
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



}

module.exports = enigma2_device;

'use strict';

const Homey = require('homey');
const axios = require('axios');
const https = require('https');

class Enigma2Driver extends Homey.Driver {

  async onInit() {
    this.log('Enigma2Driver has been initialized');
  }

  async onPair(session) {

    // Handle the get_devices event
    session.setHandler('get_devices', async (data) => {
      this.log("Received get_devices data: " + JSON.stringify(data));
      this.deviceData = data; // Store the received data for later use
      // Extract the last part of the IP address
      const lastSegmentOfIP = data.IPAddress.split('.').pop();
      const devices = [{
        name: 'Enigma2 Receiver IP.' + lastSegmentOfIP,
        data: { id: data.IPAddress }, // Use IP address as unique ID
        settings: {
          IPAddress: data.IPAddress,
          port: data.Port,
          username: data.Username,
          password: data.Password
        }
      }];
      session.emit('continue', null); // Proceed to the next step
    });

    // Handle device listing
    session.setHandler('list_devices', async () => {
      if (!this.deviceData || !this.deviceData.IPAddress) {
        throw new Error('No device data provided');
      }
      // Extract the last part of the IP address
      const lastSegmentOfIP = this.deviceData.IPAddress.split('.').pop();

      // Use this.deviceData for device discovery
      try {
        await this.callEnigma2('deviceinfo');
        const devices = [{
          name: 'Enigma2 Receiver IP.' + lastSegmentOfIP,
          data: { id: this.deviceData.IPAddress },
          settings: this.deviceData
        }];
        this.log("List_devices data: " + JSON.stringify(devices));
        return devices;
      } catch (error) {
        throw new Error('Failed to connect to device');
      }
    });

    session.setHandler('test_connection', async (data, callback) => {
      try {
        // Temporarily set deviceData for the test
        this.deviceData = data;

        // Call Enigma2 API for testing
        await this.callEnigma2('deviceinfo');

      } catch (error) {
        throw new Error('Test connection failed');

      }
    });


    // Add a disconnect handler if needed
    session.setHandler('disconnect', () => {
      this.log("Pairing is finished (done or aborted)");
    });

  }

  // Method for calling the Enigma2 device
  async callEnigma2(call_spec) {
    try {
      this.log("Calling Enigma2 API with: " + call_spec);
      const url = `https://${this.deviceData.IPAddress}/web/${call_spec}`;
      const config = {
        method: 'get',
        url: url,
        auth: this.deviceData.Username && this.deviceData.Password ? {
          username: this.deviceData.Username,
          password: this.deviceData.Password
        } : undefined,
        httpsAgent: new https.Agent({
          rejectUnauthorized: false, // Bypass SSL certificate errors
        })
      };
      this.log("Calling Enigma2 API with: " + JSON.stringify(config));
      const response = await axios(config);
      this.log(`Call sent to: ${url}`);
      return response.data; // Returning the raw XML response
    } catch (error) {
      this.error(`Call to Enigma2 failed: ${error.message}`);
      throw error;
    }
  }




  // Additional methods as needed...
}

module.exports = Enigma2Driver;

'use strict';
const Homey = require('homey');
const axios = require('axios');

class Enigma2 extends Homey.App {
    async onInit() {
        this.log("enigma2 app started successfully");

        this.enigma2_ip = await this.homey.settings.get('enigma2_ip');
        this.enigma2_port = await this.homey.settings.get('enigma2_port');
        this.enigma2_username = await this.homey.settings.get('enigma2_username');
        this.enigma2_password = await this.homey.settings.get('enigma2_password');
        this.enigma2_host = `${this.enigma2_ip}:${this.enigma2_port}`;

        this.registerFlowCards();
    }

    async callEnigma2(call_spec) {
        try {
            const config = {
                url: `http://${this.enigma2_host}/web/${call_spec}`,
                method: 'get'
            };

            // Add authentication if username and password are provided
            if (this.enigma2_username && this.enigma2_password) {
                config.auth = {
                    username: this.enigma2_username,
                    password: this.enigma2_password
                };
            }

            const response = await axios(config);
            this.log('Following Call was send: ' + response.config.url + ' to ' + this.enigma2_host);
            this.log('Previous Call was made successfully.');
        } catch (error) {
            this.error('Previous Call Failed! Maybe wrong Configuration?');
            this.error(error);
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

        // Volume Mute Action
        this.registerFlowCardAction('vol_mute', () => 'vol?set=mute');

        // Volume Unmute Action
        this.registerFlowCardAction('vol_unmute', () => 'vol?set=unmute');
    }

    registerFlowCardAction(cardName, getCallSpec) {
        const actionCard = this.homey.flow.getActionCard(cardName);
        actionCard.registerRunListener(async (args) => {
            const call_spec = getCallSpec(args);
            await this.callEnigma2(call_spec);
            return true;
        });
    }
}

module.exports = Enigma2;

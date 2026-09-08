'use strict';

window.onHomeyReady = function onHomeyReady(Homey) {
  Homey.ready();
  function initialize() {
    const fields = ['ip', 'port', 'username', 'password', 'protocol', 'allow_self_signed'];
    const defaults = { ip: '', port: 80, username: '', password: '', protocol: 'http', allow_self_signed: true };
    const save = document.getElementById('save');
    const test = document.getElementById('test');
    save.disabled = true;
    test.disabled = true;
    let pending = fields.length;
    let failed = false;
    fields.forEach(key => {
      const element = document.getElementById(`enigma2_${key}`);
      Homey.get(`enigma2_${key}`, (err, value) => {
        if (err) { failed = true; Homey.alert(err); }
        else element[key === 'allow_self_signed' ? 'checked' : 'value'] = value == null ? defaults[key] : value;
        if (--pending === 0 && !failed) { save.disabled = false; test.disabled = false; }
      });
    });
    function data() {
      const value = key => document.getElementById(`enigma2_${key}`).value;
      return {
        IPAddress: value('ip'), Port: value('port'), Username: value('username'), Password: value('password'),
        Protocol: value('protocol'), AllowSelfSigned: document.getElementById('enigma2_allow_self_signed').checked
      };
    }
    function request(path, successKey) {
      save.disabled = true;
      test.disabled = true;
      Homey.api('POST', path, data(), err => {
        save.disabled = false;
        test.disabled = false;
        Homey.alert(err ? (err.message || String(err)) : Homey.__(successKey), err ? 'error' : 'info');
      });
    }
    save.addEventListener('click', () => request('/connection', 'settings.saved'));
    test.addEventListener('click', () => request('/test_connection', 'pair.start.connection_success'));
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
  else initialize();
};

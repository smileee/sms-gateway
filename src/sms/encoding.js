// src/sms/encoding.js
const config = require('../config');
const { log } = require('../utils/logger');
const atManager = require('../modem/commands');
const serialManager = require('../modem/serial');

class SMSEncoder {
  constructor() {
    this.atManager = atManager;
    this.serialManager = serialManager;
  }

  toUCS2Hex(str) {
    const b = Buffer.from(str, 'ucs2');
    for (let i = 0; i < b.length; i += 2) [b[i], b[i + 1]] = [b[i + 1], b[i]];
    return b.toString('hex').toUpperCase();
  }

  needsUCS2(txt) {
    return [...txt].some((ch) => ch.codePointAt(0) > 0x7f);
  }

  async setUcs2() {
    await this.atManager.send('AT+CSCS="UCS2"');
    await this.atManager.send('AT+CSMP=17,167,0,8'); // DCS 0x08 (UCS‑2)
  }

  async setGsm7() {
    await this.atManager.send('AT+CSCS="GSM"');
    await this.atManager.send('AT+CSMP=17,167,0,0'); // DCS 0x00 (7‑bit default)
  }

  async sendSMS(number, message) {
    if (!number || !message) throw new Error('Missing parameters');

    const { port, parser } = await this.serialManager.initialize();
    await this.atManager.ensureModemReady();
    await this.atManager.send('AT+CMEE=2');
    await this.atManager.send('AT+CMGF=1');

    const useU = this.needsUCS2(message);

    if (useU) {
      // ---------- UCS‑2 ----------
      await this.setUcs2();

      const numHex = this.toUCS2Hex(number);
      const msgHex = this.toUCS2Hex(message);
      if (msgHex.length / 4 > 70) throw new Error('UCS2 > 70 chars');

      port.write(`AT+CMGS="${numHex}",145\r`);
      await this.atManager.waitForPrompt();

      await new Promise((resolve, reject) => {
        let buf = '';
        const timer = setTimeout(() => done(new Error('SMS timeout')), config.timeouts.sms);
        const handler = (d) => {
          buf += d;
          if (/\+CMGS|\bOK\b/.test(buf)) return done();
          if (/(\+CMS ERROR:.*|ERROR)/.test(buf)) return done(new Error(buf.trim()));
        };
        function done(err) {
          clearTimeout(timer);
          parser.off('data', handler);
          err ? reject(err) : resolve();
        }
        parser.on('data', handler);
        log(`[SEND SMS] ${number} (UCS2)`);
        port.write(msgHex);
        port.drain(() => port.write(Buffer.from([26])));
      });
    } else {
      // ---------- GSM‑7 ----------
      if (message.length > 160) throw new Error('SMS > 160 chars');

      await this.setGsm7();

      port.write(`AT+CMGS="${number}"\r`);
      await this.atManager.waitForPrompt();

      await new Promise((resolve, reject) => {
        let buf = '';
        const timer = setTimeout(() => done(new Error('SMS timeout')), config.timeouts.sms);
        const handler = (d) => {
          buf += d;
          if (/\+CMGS|\bOK\b/.test(buf)) return done();
          if (/(\+CMS ERROR:.*|ERROR)/.test(buf)) return done(new Error(buf.trim()));
        };
        function done(err) {
          clearTimeout(timer);
          parser.off('data', handler);
          err ? reject(err) : resolve();
        }
        parser.on('data', handler);
        log(`[SEND SMS] ${number}`);
        port.write(message);
        port.drain(() => port.write(Buffer.from([26])));
      });
    }

    // Clean up memory (async)
    this.atManager.send('AT+CMGD=1,4', 'OK', 3000)
      .catch((e) => log('[WARN CMGD]', e.message));
  }
}

module.exports = new SMSEncoder(); 
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
    // Check for emojis and non-GSM characters
    return [...txt].some((ch) => {
      const code = ch.codePointAt(0);
      return code > 0x7f || code === 0x20AC; // Euro symbol
    });
  }

  async setUcs2() {
    await this.atManager.send('AT+CSCS="UCS2"');
    await this.atManager.send('AT+CSMP=17,167,0,8'); // DCS 0x08 (UCS‑2)
    await this.serialManager.delay(500); // Give modem time to process
  }

  async setGsm7() {
    await this.atManager.send('AT+CSCS="GSM"');
    await this.atManager.send('AT+CSMP=17,167,0,0'); // DCS 0x00 (7‑bit default)
    await this.serialManager.delay(500); // Give modem time to process
  }

  async sendSMS(number, message) {
    if (!number || !message) throw new Error('Missing parameters');

    const { port, parser } = await this.serialManager.initialize();
    
    // Reset modem to a known state
    log('Initializing modem...');
    await this.atManager.send('ATZ'); // Reset to default settings
    await this.serialManager.delay(1000);
    
    await this.atManager.send('AT+CMEE=2'); // Enable detailed error reporting
    await this.atManager.send('AT+CMGF=1'); // Set text mode
    await this.atManager.send('AT+CSMP=17,167,0,0'); // Set default text mode parameters
    await this.serialManager.delay(500);

    const useU = this.needsUCS2(message);

    if (useU) {
      // ---------- UCS‑2 ----------
      await this.setUcs2();

      const numHex = this.toUCS2Hex(number);
      const msgHex = this.toUCS2Hex(message);
      if (msgHex.length / 4 > 70) throw new Error('UCS2 > 70 chars');

      // Send command and wait for prompt
      log(`[SEND SMS] ${number} (UCS2)`);
      port.write(`AT+CMGS="${numHex}",145\r`);
      
      // Wait for prompt
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Timeout waiting for prompt')), config.timeouts.prompt);
        
        const handler = (data) => {
          const str = data.toString().trim();
          log('[DEBUG] Received:', str);
          
          if (str.includes('>')) {
            clearTimeout(timer);
            parser.off('data', handler);
            resolve();
          } else if (str.includes('ERROR')) {
            clearTimeout(timer);
            parser.off('data', handler);
            reject(new Error(str));
          }
        };
        
        parser.on('data', handler);
      });

      // Send message and CTRL+Z
      port.write(msgHex);
      port.drain(() => {
        port.write(Buffer.from([26])); // CTRL+Z
        port.drain(() => {});
      });

      // Wait for final response
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('SMS timeout')), config.timeouts.sms);
        let response = '';
        
        const handler = (data) => {
          const str = data.toString().trim();
          log('[DEBUG] Received:', str);
          response += str + '\n';
          
          if (str.includes('+CMGS:')) {
            clearTimeout(timer);
            parser.off('data', handler);
            resolve(response);
          } else if (str.includes('ERROR')) {
            clearTimeout(timer);
            parser.off('data', handler);
            reject(new Error(str));
          }
        };
        
        parser.on('data', handler);
      });

    } else {
      // ---------- GSM‑7 ----------
      if (message.length > 160) throw new Error('SMS > 160 chars');

      await this.setGsm7();

      // Send command and wait for prompt
      log(`[SEND SMS] ${number}`);
      port.write(`AT+CMGS="${number}"\r`);
      
      // Wait for prompt
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Timeout waiting for prompt')), config.timeouts.prompt);
        
        const handler = (data) => {
          const str = data.toString().trim();
          log('[DEBUG] Received:', str);
          
          if (str.includes('>')) {
            clearTimeout(timer);
            parser.off('data', handler);
            resolve();
          } else if (str.includes('ERROR')) {
            clearTimeout(timer);
            parser.off('data', handler);
            reject(new Error(str));
          }
        };
        
        parser.on('data', handler);
      });

      // Send message and CTRL+Z
      port.write(message);
      port.drain(() => {
        port.write(Buffer.from([26])); // CTRL+Z
        port.drain(() => {});
      });

      // Wait for final response
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('SMS timeout')), config.timeouts.sms);
        let response = '';
        
        const handler = (data) => {
          const str = data.toString().trim();
          log('[DEBUG] Received:', str);
          response += str + '\n';
          
          if (str.includes('+CMGS:')) {
            clearTimeout(timer);
            parser.off('data', handler);
            resolve(response);
          } else if (str.includes('ERROR')) {
            clearTimeout(timer);
            parser.off('data', handler);
            reject(new Error(str));
          }
        };
        
        parser.on('data', handler);
      });
    }

    // Clean up memory (async)
    this.atManager.send('AT+CMGD=1,4', 'OK', 3000)
      .catch((e) => log('[WARN CMGD]', e.message));
  }
}

module.exports = new SMSEncoder(); 
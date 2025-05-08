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

  async sendSMS(number, message, retryCount = 0) {
    if (!number || !message) throw new Error('Missing parameters');
    if (retryCount > 1) throw new Error('Max retries exceeded');

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

    try {
      if (useU) {
        // ---------- UCS‑2 ----------
        await this.setUcs2();

        const numHex = this.toUCS2Hex(number);
        const msgHex = this.toUCS2Hex(message);
        if (msgHex.length / 4 > 70) throw new Error('UCS2 > 70 chars');

        // Send command and wait a bit
        log(`[SEND SMS] ${number} (UCS2)`);
        port.write(`AT+CMGS="${numHex}",145\r`);
        await this.serialManager.delay(2000); // Wait 2 seconds for prompt

        // Send message and CTRL+Z
        port.write(msgHex);
        port.drain(() => {
          port.write(Buffer.from([26])); // CTRL+Z
          port.drain(() => {});
        });

        // Wait for final response
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            log('[DEBUG] Response buffer before timeout:', response);
            reject(new Error('SMS timeout'));
          }, config.timeouts.sms);
          
          let response = '';
          
          const handler = (data) => {
            const str = data.toString().trim();
            log('[DEBUG] Received:', str);
            response += str + '\n';
            
            // Check for success response
            if (str.includes('+CMGS:')) {
              log('[DEBUG] Got CMGS response:', str);
              clearTimeout(timer);
              parser.off('data', handler);
              resolve(response);
            }
            // Check for error response
            else if (str.includes('ERROR') || str.includes('+CMS ERROR:')) {
              log('[DEBUG] Got error response:', str);
              clearTimeout(timer);
              parser.off('data', handler);
              reject(new Error(str));
            }
            // Check for OK after CMGS
            else if (str === 'OK' && response.includes('+CMGS:')) {
              log('[DEBUG] Got final OK');
              clearTimeout(timer);
              parser.off('data', handler);
              resolve(response);
            }
          };
          
          parser.on('data', handler);
        });

      } else {
        // ---------- GSM‑7 ----------
        if (message.length > 160) throw new Error('SMS > 160 chars');

        await this.setGsm7();

        // Send command and wait a bit
        log(`[SEND SMS] ${number}`);
        port.write(`AT+CMGS="${number}"\r`);
        await this.serialManager.delay(2000); // Wait 2 seconds for prompt

        // Send message and CTRL+Z
        port.write(message);
        port.drain(() => {
          port.write(Buffer.from([26])); // CTRL+Z
          port.drain(() => {});
        });

        // Wait for final response
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            log('[DEBUG] Response buffer before timeout:', response);
            reject(new Error('SMS timeout'));
          }, config.timeouts.sms);
          
          let response = '';
          
          const handler = (data) => {
            const str = data.toString().trim();
            log('[DEBUG] Received:', str);
            response += str + '\n';
            
            // Check for success response
            if (str.includes('+CMGS:')) {
              log('[DEBUG] Got CMGS response:', str);
              clearTimeout(timer);
              parser.off('data', handler);
              resolve(response);
            }
            // Check for error response
            else if (str.includes('ERROR') || str.includes('+CMS ERROR:')) {
              log('[DEBUG] Got error response:', str);
              clearTimeout(timer);
              parser.off('data', handler);
              reject(new Error(str));
            }
            // Check for OK after CMGS
            else if (str === 'OK' && response.includes('+CMGS:')) {
              log('[DEBUG] Got final OK');
              clearTimeout(timer);
              parser.off('data', handler);
              resolve(response);
            }
          };
          
          parser.on('data', handler);
        });
      }

      // Clean up memory (async)
      this.atManager.send('AT+CMGD=1,4', 'OK', 3000)
        .catch((e) => log('[WARN CMGD]', e.message));

    } catch (error) {
      log(`[ERROR] SMS send failed (attempt ${retryCount + 1}):`, error.message);
      
      // If it's a timeout and we haven't retried yet, try again
      if (error.message.includes('timeout') && retryCount === 0) {
        log('[INFO] Retrying SMS send...');
        await this.serialManager.delay(2000); // Wait before retry
        return this.sendSMS(number, message, retryCount + 1);
      }
      
      throw error; // Re-throw if it's not a timeout or we've already retried
    }
  }
}

module.exports = new SMSEncoder(); 
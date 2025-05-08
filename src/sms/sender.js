// src/sms/sender.js
const config = require('../config');
const { log } = require('../utils/logger');
const atManager = require('../modem/commands');
const serialManager = require('../modem/serial');
const smsEncoder = require('./encoding');

class SMSSender {
  constructor() {
    this.atManager = atManager;
    this.serialManager = serialManager;
  }

  async sendSMS(number, message) {
    const { port, parser } = await this.serialManager.initialize();
    const { useUCS2 } = smsEncoder.getEncodingType(message);
    const encoded = smsEncoder.encodeMessage(message, useUCS2);
    
    log(`[SEND SMS] ${number} (${useUCS2 ? 'UCS2' : 'GSM-7'})`);
    
    // Reset modem state
    await this.atManager.send('ATZ');
    await this.serialManager.delay(1000);
    
    // Configure modem
    await this.atManager.send('AT+CMEE=2');
    await this.atManager.send('AT+CMGF=1');
    await this.atManager.send('AT+CSMP=17,167,0,0');
    
    if (useUCS2) {
      await this.atManager.send('AT+CSCS="UCS2"');
      await this.atManager.send('AT+CSMP=17,167,0,8');
    }
    
    // Send SMS
    const command = `AT+CMGS="${number}"`;
    await this.atManager.send(command);
    
    // Wait a bit for the prompt
    await this.serialManager.delay(2000);
    
    // Send message and CTRL+Z
    port.write(encoded + '\x1A');
    
    // Wait for response
    let buffer = '';
    let gotResponse = false;
    
    const timeout = setTimeout(() => {
      log('[DEBUG] Response buffer before timeout:', buffer);
      throw new Error('SMS timeout');
    }, config.timeouts.sms);
    
    parser.on('data', (data) => {
      log('[DEBUG] Received:', data);
      buffer += data;
      
      // Check for success response
      if (buffer.includes('+CMGS:')) {
        gotResponse = true;
        clearTimeout(timeout);
        parser.removeAllListeners('data');
      }
      
      // Check for error response
      if (buffer.includes('ERROR') || buffer.includes('CMS ERROR')) {
        clearTimeout(timeout);
        parser.removeAllListeners('data');
        throw new Error('SMS send failed: ' + buffer.trim());
      }
    });
    
    // Wait for response or timeout
    await new Promise((resolve, reject) => {
      timeout.on('timeout', () => {
        if (!gotResponse) {
          reject(new Error('SMS timeout'));
        } else {
          resolve();
        }
      });
    });
    
    // Cleanup
    parser.removeAllListeners('data');
    clearTimeout(timeout);
    
    return true;
  }
}

module.exports = new SMSSender(); 
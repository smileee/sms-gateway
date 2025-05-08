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
    
    // Send SMS (expecting prompt '>')
    const dest = useUCS2 ? smsEncoder.toUCS2Hex(number) : number;
    const command = `AT+CMGS="${dest}"`;
    await this.atManager.send(command, '>');
    
    // Pequeno atraso por segurança (o prompt já foi detectado pelo atManager)
    await this.serialManager.delay(200);
    
    // Send message and CTRL+Z
    port.write(encoded + '\x1A');
    
    // Wait for response
    let buffer = '';
    const response = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        log('[DEBUG] Response buffer before timeout:', buffer);
        parser.off('data', onData);
        reject(new Error('SMS timeout'));
      }, config.timeouts.sms);

      const onData = (data) => {
        log('[DEBUG] Received:', data);
        buffer += data;

        if (buffer.includes('+CMGS:')) {
          clearTimeout(timer);
          parser.off('data', onData);
          return resolve(buffer);
        }

        if (buffer.includes('ERROR') || buffer.includes('CMS ERROR')) {
          clearTimeout(timer);
          parser.off('data', onData);
          return reject(new Error(buffer.trim()));
        }
      };

      parser.on('data', onData);
    });

    log('[DEBUG] Final modem response:', response.trim());
    
    return true;
  }
}

module.exports = new SMSSender(); 
// src/sms/outboundProcessor.js
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
    await this.atManager.send('AT+CMEE=2'); // Enable error messages
    await this.atManager.send('AT+CMGF=1'); // Set message format to text
    await this.atManager.send('AT+CSMP=17,167,0,0'); // Set message type to text
    
    if (useUCS2) {
      await this.atManager.send('AT+CSCS="UCS2"'); // Set character set to UCS2
      await this.atManager.send('AT+CSMP=17,167,0,8'); // Set message type to UCS2
    }
    
    // Send SMS (expecting prompt '>')
    const dest = useUCS2 ? smsEncoder.toUCS2Hex(number) : number;
    const command = `AT+CMGS="${dest}"`; // Send SMS command
    await this.atManager.send(command, '>'); // Send command and expect prompt
    
    // Pequeno atraso por segurança (o prompt já foi detectado pelo atManager)
    await this.serialManager.delay(200);
    
    // Send message and CTRL+Z, then guarantee data flushed
    await new Promise((resolve, reject) => {
      port.write(encoded, 'ascii', (err) => {
        if (err) return reject(err);
        port.write(Buffer.from([26]), (err2) => {
          if (err2) return reject(err2);
          port.drain(resolve);
        });
      });
    });
    
    // Wait for response
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // Nenhum erro recebido dentro do período → assumimos sucesso
        port.off('data', onData);
        resolve();
      }, config.timeouts.sms);

      const onData = (chunk) => {
        const str = chunk.toString('ascii');
        log('[DEBUG] Raw chunk:', str.replace(/\r|\n/g, '␍'));

        if (/\+CMS ERROR/.test(str) || str.includes('ERROR')) {
          clearTimeout(timer);
          port.off('data', onData);
          return reject(new Error(str.trim()));
        }
        // Não precisamos capturar +CMGS, apenas monitorar erros.
      };

      port.on('data', onData);
    });

    return true;
  }
}

module.exports = new SMSSender(); 
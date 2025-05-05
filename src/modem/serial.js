const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');
const config = require('../config');
const { log, error } = require('../utils/logger');

class SerialManager {
  constructor() {
    this.port = null;
    this.parser = null;
  }

  async initialize() {
    if (this.port && this.port.isOpen && this.parser) {
      return { port: this.port, parser: this.parser };
    }

    this.port = new SerialPort({
      path: config.serial.port,
      baudRate: config.serial.baudRate,
      autoOpen: false,
      dataBits: 8,
      stopBits: 1,
      parity: 'none',
      rtscts: true,
    });

    this.port.on('error', (err) => {
      error('[PORT ERROR]', err.message);
      this.parser = null;
    });

    await new Promise((resolve, reject) => {
      this.port.open((err) => (err ? reject(err) : resolve()));
    });
    log('Serial port opened:', config.serial.port);
    log('Waiting for modem to initialize...');
    await this.delay(config.timeouts.modemBoot);

    this.parser = this.port.pipe(new ReadlineParser({ 
      delimiter: '\r\n', 
      encoding: 'ascii',
      includeDelimiter: true
    }));
    return { port: this.port, parser: this.parser };
  }

  delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  close() {
    if (this.port && this.port.isOpen) {
      this.port.close();
      this.port = null;
      this.parser = null;
    }
  }
}

module.exports = new SerialManager(); 
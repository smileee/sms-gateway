// src/modem/commands.js
const config = require('../config');
const { log, error, warn } = require('../utils/logger');
const serialManager = require('./serial');

class ATCommandManager {
  constructor() {
    this.queue = Promise.resolve();
  }

  enqueue(task) {
    const run = this.queue.then(task).catch(() => {});
    this.queue = run.then(() => {}, () => {});
    return run;
  }

  async send(command, expect = 'OK', timeout = config.timeouts.atCommand) {
    return this.enqueue(() => this._send(command, expect, timeout));
  }

  async _send(command, expect, timeout) {
    const { port, parser } = await serialManager.initialize();
    
    return new Promise((resolve, reject) => {
      if (!parser) return reject(new Error('Parser not ready'));

      let buf = '';
      const handler = (data) => {
        buf += data;
        log('[RECV]', data);
        if (buf.includes('ERROR')) return cleanup(new Error(`ERROR on ${command}`));
        if (buf.includes(expect)) return cleanup();
      };

      function cleanup(err) {
        clearTimeout(timer);
        parser.off('data', handler);
        err ? reject(err) : resolve(buf);
      }

      const timer = setTimeout(() => cleanup(new Error(`Timeout ${command}`)), timeout);
      parser.on('data', handler);

      setTimeout(() => {
        log('[SEND]', command);
        port.write(command + '\r');
        port.drain(() => {});
      }, 200);
    });
  }

  async waitForPrompt(timeout = config.timeouts.prompt) {
    const { port, parser } = await serialManager.initialize();
    
    return new Promise((resolve, reject) => {
      let asciiBuf = '';
      const timer = setTimeout(() => {
        cleanup(new Error('Timeout waiting for prompt'));
      }, timeout);

      function onData(chunk) {
        if (!chunk) return;

        if (chunk.includes(0x3e)) return cleanup();
        const chunkStr = chunk.toString('ascii');
        asciiBuf += chunkStr;
        
        if (/(\+CMS ERROR:\s*\d+)/.test(asciiBuf))
          return cleanup(new Error(RegExp.$1.trim()));
        if (asciiBuf.includes('ERROR'))
          return cleanup(new Error('Modem ERROR before prompt'));

        if (asciiBuf.length > 256) asciiBuf = asciiBuf.slice(-256);
      }

      function cleanup(err) {
        clearTimeout(timer);
        port.off('data', onData);
        err ? reject(err) : resolve();
      }

      port.on('data', onData);
    });
  }

  async ensureModemReady(attempts = config.modem.atAttempts) {
    const { port, parser } = await serialManager.initialize();
    
    try {
      log('Ensuring modem is in command mode...');
      if (port.isOpen) port.write('\x1B');
      await serialManager.delay(300);
      if (port.isOpen) port.write(String.fromCharCode(26));
      await serialManager.delay(500);
      if (port.isOpen) port.write('+++');
      await serialManager.delay(1100);
      port.write('\r');
      await serialManager.delay(300);
    } catch (err) {
      warn('Error during modem initialization:', err.message);
    }

    parser.removeAllListeners('data');

    for (let i = 0; i < attempts; i++) {
      try {
        await this.send('AT', 'OK', 1500);
        log('Modem responded to AT - ready.');
        return;
      } catch (e) {
        warn(`[WARN] AT attempt ${i + 1} failed`, e.message);
        await serialManager.delay(config.modem.atDelay);
      }
    }
    throw new Error('Modem not responding');
  }
}

module.exports = new ATCommandManager(); 
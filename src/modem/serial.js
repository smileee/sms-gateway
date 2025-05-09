// src/modem/serial.js
const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');
const config = require('../config');
const { log, error } = require('../utils/logger');
const atManager = require('./commands'); // Precisaremos do atManager para enviar AT+CNMI

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
      rtscts: false, // Desabilita RTS/CTS - Serve para evitar problemas de handshake que são comuns em alguns modems e fazem com que o modem não responda
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

    // Se inbound estiver habilitado, configurar modem para notificações e escutar URCs
    if (config.inbound.enabled) {
      try {
        log('[INBOUND] Enabling SMS notifications (AT+CNMI)...');
        // Usar o atManager para enviar o comando AT+CNMI pode criar uma dependência cíclica
        // ou problema de lock se o atManager também estiver inicializando.
        // Para simplificar e garantir que o comando seja enviado após a porta estar pronta,
        // vamos escrevê-lo diretamente aqui, mas idealmente isso seria enfileirado pelo atManager.
        // Ou, o atManager precisa ser inicializado de forma que possa ser usado aqui.
        // Por agora, envio direto com um pequeno delay:
        await this.delay(500); // Pequeno delay para garantir que a porta está realmente pronta
        this.port.write('AT+CNMI=2,1,0,0,0\r', (err) => {
          if (err) error('[INBOUND] Error sending AT+CNMI:', err.message);
          else log('[INBOUND] AT+CNMI command sent.');
        });
        this.port.drain();

        this.parser.on('data', (data) => {
          const line = data.toString('ascii').trim();
          if (line.startsWith('+CMTI:')) {
            log(`[INBOUND] URC Received: ${line}`);
            const parts = line.split(',');
            if (parts.length >= 2) {
              const memory = parts[0].split(':')[1]?.trim().replace(/"/g, '');
              const index = parseInt(parts[1], 10);
              if (memory && !isNaN(index)) {
                log(`[INBOUND] New SMS at index ${index} in ${memory} memory.`);
                // Chamar a função para processar o SMS recebido
                // Ex: require('../config/queue').handleIncomingSMS(index, memory);
                // Por enquanto, apenas logamos. A chamada será integrada depois.
                const smsQueue = require('../config/queue'); // Lazy require para evitar ciclos na inicialização
                smsQueue.handleIncomingSMSEvent(index, memory).catch(e => error('[INBOUND] Error handling SMS event:', e));
              } else {
                error('[INBOUND] Could not parse +CMTI URC:', line);
              }
            }
          }
        });

      } catch (e) {
        error('[INBOUND] Error setting up inbound SMS notifications:', e.message);
      }
    }

    // Add raw data listener for debugging
    this.port.on('data', (data) => {
      const str = data.toString();
      log('[DEBUG] Raw data from port:', str);
    });

    // Add parser data listener for debugging
    this.parser.on('data', (data) => {
      log('[DEBUG] Parser data:', data);
    });

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
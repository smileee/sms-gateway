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

        const chunkStr = chunk.toString('ascii');
        asciiBuf += chunkStr;
        
        // Check for prompt character (">")
        if (chunkStr.includes('>')) {
          return cleanup();
        }
        
        // Check for errors
        if (/(\+CMS ERROR:\s*\d+)/.test(asciiBuf)) {
          return cleanup(new Error(RegExp.$1.trim()));
        }
        if (asciiBuf.includes('ERROR')) {
          return cleanup(new Error('Modem ERROR before prompt'));
        }

        // Prevent buffer from growing too large
        if (asciiBuf.length > 256) {
          asciiBuf = asciiBuf.slice(-256);
        }
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

  /**
   * Lê uma mensagem SMS do modem.
   * @param {number} index - O índice da mensagem a ser lida.
   * @param {string} [expectedPromptAfterCmgr] - O que esperar após o corpo da mensagem (normalmente OK).
   * @returns {Promise<string>} A resposta completa do modem para AT+CMGR.
   */
  async readSMS(index, expectedPromptAfterCmgr = 'OK') {
    // Garante que o modem esteja no modo texto para facilitar o parse
    // Esta linha pode ser redundante se o modem já estiver configurado globalmente
    // await this.send('AT+CMGF=1'); 
    // O sender.js já configura AT+CMGF=1, então geralmente é seguro assumir.

    // MODIFICAÇÃO: Garantir AT+CMGF=1 antes de ler
    await this.send('AT+CMGF=1');
    log(`[COMMANDS] Ensured modem is in text mode (AT+CMGF=1) for reading.`);

    const command = `AT+CMGR=${index}`;
    // A resposta de AT+CMGR é multi-linha. O _send padrão espera uma única linha de "expect".
    // Precisamos de uma lógica que capture múltiplas linhas até o "OK" final ou um erro.
    // Para simplificar, vamos modificar temporariamente _send ou criar um _sendMultiLine.
    // Por ora, vamos tentar com o _send e ver como ele lida, e se o 'OK' é o terminador.
    // A resposta típica é: 
    // +CMGR: "STATUS","OA/DA","","TP-SCTS"
    // <data>
    // OK
    // Ou: ERROR
    // O _send atual pode funcionar se o 'OK' for a última coisa após os dados.
    // O problema é que o 'OK' pode vir depois de um CR LF e dados. O parser atual do _send
    // pode não capturar tudo. 
    // Uma solução mais robusta seria ter uma função _sendCommandAndWaitForPattern que acumula
    // dados até um padrão final, ignorando os delimitadores de linha do parser para o 'expect'.
    log(`[COMMANDS] Reading SMS at index: ${index}`);
    return this.enqueue(() => this._send(command, expectedPromptAfterCmgr, config.timeouts.sms)); 
    // Aumentei o timeout para SMS, pois a leitura pode levar mais tempo.
  }

  /**
   * Deleta uma mensagem SMS do modem.
   * @param {number} index - O índice da mensagem a ser deletada.
   * @param {boolean} [deleteAll=false] - Se true, deleta todas as mensagens (usando flag diferente no AT+CMGD).
   * @returns {Promise<string>} A resposta do modem (normalmente "OK").
   */
  async deleteSMS(index, deleteAll = false) {
    // AT+CMGD=<index>[,<delflag>]  <delflag> 0 (default) ou 1,2,3,4
    // Para deletar uma mensagem específica, delflag não é estritamente necessário ou pode ser 0.
    const command = deleteAll ? 'AT+CMGD=1,4' : `AT+CMGD=${index}`;
    log(`[COMMANDS] Deleting SMS at index: ${index}, deleteAll: ${deleteAll}`);
    return this.enqueue(() => this._send(command, 'OK', config.timeouts.atCommand));
  }

  /**
   * Disca um número de telefone.
   * ATENÇÃO: A resposta de ATD é complexa e pode não ser simplesmente 'OK'.
   * Esta é uma implementação básica. Para produção, monitorar URCs como CONNECT, NO CARRIER é essencial.
   * @param {string} number - O número de telefone a ser discado.
   * @returns {Promise<string>} A resposta inicial do modem ao comando ATD.
   */
  async dial(number) {
    const command = `ATD${number};`; // O ponto e vírgula é importante para chamadas de voz
    log(`[COMMANDS] Dialing: ${command}`);
    // Esperar 'OK' pode não ser o ideal aqui. Alguns modems retornam OK e depois URCs.
    // Outros podem não retornar OK até a chamada terminar ou falhar.
    // Para um teste inicial, vamos usar um timeout maior e esperar por OK, mas isso precisa ser revisto.
    return this.enqueue(() => this._send(command, 'OK', config.timeouts.sms * 2)); // Timeout maior para discagem
  }

  /**
   * Desliga a chamada ativa.
   * @returns {Promise<string>} A resposta do modem (normalmente "OK").
   */
  async hangup() {
    const command = 'ATH';
    log(`[COMMANDS] Hanging up call: ${command}`);
    return this.enqueue(() => this._send(command, 'OK', config.timeouts.atCommand));
  }
}

module.exports = new ATCommandManager(); 
// src/sms/queue.js
const config = require('../config');
const { log } = require('../utils/logger');
const smsEncoder = require('./encoding');
const serialManager = require('../modem/serial');
const db = require('../db');

/**
 * Classe responsável pelo gerenciamento da fila de mensagens SMS
 * Implementa um sistema de fila persistente usando lowdb para armazenamento
 * e processamento sequencial de mensagens com retry em caso de falha
 * Suporta filas prioritárias para mensagens diretas vs. bulk
 */
class SMSQueue {
  constructor() {
    this.processing = false;
    this.currentBulkIndex = 0; // Tracks current position in bulk queue
  }

  /**
   * Adiciona uma mensagem à fila de envio prioritária (SMS direto)
   * @param {string} number - Número do destinatário no formato internacional
   * @param {string} message - Texto da mensagem a ser enviada
   * @returns {string} ID único da mensagem na fila
   */
  add(number, message) {
    const id = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const messageData = { 
      number, 
      message, 
      id, 
      status: 'pending', 
      createdAt: new Date().toISOString(),
      priority: 'high' // Marca como mensagem prioritária
    };
    
    db.get('queue')
      .push(messageData)
      .write();
    
    log(`[QUEUE] Added priority message ${id} -> ${number}`);
    this.process();
    return id;
  }

  /**
   * Adiciona múltiplas mensagens à fila de envio não-prioritária (bulk)
   * @param {Array<Object>} messages - Lista de mensagens para envio
   * @param {string} messages[].number - Número do destinatário
   * @param {string} messages[].message - Texto da mensagem
   * @returns {number} Quantidade de mensagens válidas adicionadas à fila
   */
  addBulk(messages) {
    let added = 0;
    const validMessages = messages.filter(m => {
      if (!m?.number || !m?.message) return false;
      const useU = smsEncoder.needsUCS2(m.message);
      if ((useU && m.message.length > 70) || (!useU && m.message.length > 160)) {
        log(`[QUEUE] Skip message: too long`);
        return false;
      }
      return true;
    });

    const messagesToAdd = validMessages.map((m, i) => ({
      number: m.number,
      message: m.message,
      id: `msg-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 6)}`,
      status: 'pending',
      createdAt: new Date().toISOString(),
      priority: 'low', // Marca como mensagem bulk
      bulkIndex: i // Mantém o índice original na fila bulk
    }));

    db.get('queue')
      .push(...messagesToAdd)
      .write();

    added = messagesToAdd.length;
    log(`[QUEUE] Added ${added} bulk messages`);
    this.process();
    return added;
  }

  /**
   * Processa a fila de mensagens pendentes
   * Executa o envio sequencial de mensagens com tratamento de erros
   * e delays configuráveis entre tentativas
   * Prioriza mensagens diretas sobre mensagens bulk
   * @private
   */
  async process() {
    if (this.processing) return;
    this.processing = true;

    while (true) {
      // Primeiro procura por mensagens prioritárias
      let message = db.get('queue')
        .find({ status: 'pending', priority: 'high' })
        .value();

      // Se não houver mensagens prioritárias, continua com a fila bulk
      if (!message) {
        message = db.get('queue')
          .find({ status: 'pending', priority: 'low', bulkIndex: this.currentBulkIndex })
          .value();
      }

      if (!message) {
        // Se não encontrou mensagem no índice atual, reinicia o índice
        if (this.currentBulkIndex > 0) {
          this.currentBulkIndex = 0;
          continue;
        }
        this.processing = false;
        break;
      }

      const { number, message: text, id, priority, bulkIndex } = message;
      log(`[QUEUE] Processing ${id} -> ${number} (${priority} priority)`);

      let ok = false;
      try {
        await smsEncoder.sendSMS(number, text);
        log(`[QUEUE] Sent ${id} OK`);
        ok = true;

        // Move to sent messages
        db.get('queue')
          .remove({ id })
          .write();

        db.get('sent')
          .push({
            ...message,
            status: 'sent',
            sentAt: new Date().toISOString()
          })
          .write();

        // Atualiza o índice da fila bulk se necessário
        if (priority === 'low' && bulkIndex !== undefined) {
          this.currentBulkIndex = bulkIndex + 1;
        }
      } catch (err) {
        log(`[QUEUE] Fail ${id}:`, err.message);
        
        // Update status to failed
        db.get('queue')
          .find({ id })
          .assign({ status: 'failed', error: err.message })
          .write();
      }

      await serialManager.delay(ok ? config.timeouts.successDelay : config.timeouts.failureDelay);
    }
  }

  /**
   * Retorna todas as mensagens na fila de envio
   * @returns {Array<Object>} Lista de mensagens pendentes
   */
  getQueue() {
    return db.get('queue').value();
  }

  /**
   * Retorna o histórico de mensagens enviadas
   * @returns {Array<Object>} Lista de mensagens já enviadas
   */
  getSent() {
    return db.get('sent').value();
  }

  /**
   * Limpa a fila de mensagens pendentes
   * @returns {boolean} true se a operação foi bem sucedida
   */
  clearQueue() {
    db.set('queue', []).write();
    this.currentBulkIndex = 0;
    return true;
  }

  /**
   * Limpa o histórico de mensagens enviadas
   * @returns {boolean} true se a operação foi bem sucedida
   */
  clearSent() {
    db.set('sent', []).write();
    return true;
  }
}

module.exports = new SMSQueue(); 
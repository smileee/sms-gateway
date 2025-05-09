const config = require('../config');
const { log, error } = require('../utils/logger');
const outboundProcessor = require('../sms/outboundProcessor');
const smsEncoder = require('../sms/encoding');
const serialManager = require('../modem/serial');
const atManager = require('../modem/commands');
const inboundProcessor = require('../sms/inboundProcessor');
const voiceCallProcessor = require('../sms/voiceCallProcessor');
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
      priority: config.priorities.OUTBOUND_MEDIUM // Atualizado para prioridade média
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
    const validMessages = messages.filter((m) => {
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
      priority: config.priorities.OUTBOUND_LOW, // Atualizado para prioridade baixa
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
   * Adiciona uma chamada de voz à fila de prioridade
   * @param {string} number - Número do destinatário no formato internacional
   * @param {string} text - Texto a ser convertido em áudio TTS
   * @returns {string} ID único da chamada na fila
   */
  addVoiceCall(number, text) {
    const id = `call-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const callData = {
      id,
      number,
      text,
      type: 'voice-tts',
      status: 'pending',
      createdAt: new Date().toISOString(),
      priority: config.priorities.CALL
    };

    db.get('queue')
      .push(callData)
      .write();

    log(`[QUEUE] Added voice call ${id} -> ${number}`);
    this.process();
    return id;
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
      // Procurar mensagens inbound aguardando processamento (status 'received_raw')
      let message = db
        .get('queue')
        .find({ priority: config.priorities.INBOUND_HIGH, type: 'inbound', status: 'received_raw' })
        .value();

      // Se não houver inbound aguardando, procura por outras mensagens inbound pendentes (fallback)
      if (!message) {
        message = db
          .get('queue')
          .find({ priority: config.priorities.INBOUND_HIGH, status: 'pending' }) // Este 'pending' deve ser para inbound que falhou no webhook e está para retry
          .value();
      }
      
      // Se não houver inbound, procura por chamadas de voz (prioridade intermediária)
      if (!message) {
        message = db.get('queue').find({ status: 'pending', priority: config.priorities.CALL }).value();
      }
      
      // Se não houver chamada de voz, procura por outbound medium
      if (!message) {
        message = db.get('queue').find({ status: 'pending', priority: config.priorities.OUTBOUND_MEDIUM }).value();
      }
      
      // Se não houver outbound medium, continua com a fila bulk (outbound low)
      if (!message) {
        message = db
          .get('queue')
          .find({ status: 'pending', priority: config.priorities.OUTBOUND_LOW, bulkIndex: this.currentBulkIndex })
          .value();
      }

      if (!message) {
        // Se não encontrou mensagem no índice atual, reinicia o índice para bulk
        if (this.currentBulkIndex > 0 && 
            !db.get('queue').find({ status: 'pending', priority: config.priorities.OUTBOUND_LOW }).value()) {
          this.currentBulkIndex = 0;
          // continue; // Removido para evitar loop infinito se só houver bulk e o índice for resetado
        }
        this.processing = false;
        break;
      }

      const { number, message: text, id, priority, bulkIndex, retries = 0, type, rawData } = message;
      log(`[QUEUE] Processing ${id} (Priority: ${priority}, Type: ${type || 'outbound'}, Attempt: ${retries + 1})`);

      let ok = false;
      try {
        if (type === 'inbound' && message.status === 'received_raw') {
          log(`[QUEUE] Delegating inbound SMS ${id} to InboundProcessor.`);
          await inboundProcessor.processReceivedSMS(message);
          ok = true; 
        } else if (type === 'inbound' && message.status === 'webhook_send_failed') {
          // Lógica para retry de webhook para inbound, se houver falha anterior
          log(`[QUEUE] Retrying webhook for inbound SMS ${id}.`);
          await inboundProcessor.processReceivedSMS(message); // O processador lida com retries e status final
          ok = true; 
        } else if (type === 'voice-tts') {
          // Processar chamada de voz TTS
          log(`[QUEUE] Processing voice call ${id} with TTS`);
          await voiceCallProcessor.processVoiceCall(message);
          
          // Move para sent collection
          db.get('queue').remove({ id }).write();
          db.get('sent')
            .push({
              ...message,
              status: 'completed',
              completedAt: new Date().toISOString()
            })
            .write();
            
          ok = true;
        } else if (type === 'inbound') {
          // Mensagem inbound já processada (ex: webhook_sent_ok) ou em estado inesperado, ignorar.
          log(`[QUEUE] Skipping already processed or unexpected inbound state for ${id}: ${message.status}`);
          ok = true; // Considerar ok para não bloquear a fila
        } else { // Processamento de mensagens outbound (lógica existente)
          // Assegurar que 'text' e 'number' existam para outbound, pois inbound não as terá diretamente no objeto message principal
          if (!text || !number) {
            error(`[QUEUE] Outbound message ${id} is missing number or text field. Skipping.`);
            // Remover da fila para evitar bloqueio
            db.get('queue').remove({ id }).write();
            // this.processing = false; // Não resetar aqui, o loop while vai continuar
            // this.process(); // Remover chamada recursiva
            // return; // Remover return, deixar o loop continuar para a próxima mensagem
            ok = true; // Considerar como "processado" para o delay e para continuar o loop
            continue; // Pula para a próxima iteração do while loop
          }
          smsEncoder.validateMessage(text);

          // Send the message
          await outboundProcessor.sendSMS(number, text);
          log(`[QUEUE] Sent ${id} OK`);
          ok = true;

          // Move to sent messages
          db.get('queue').remove({ id }).write();
          db.get('sent')
            .push({
              ...message,
              status: 'sent',
              sentAt: new Date().toISOString()
            })
            .write();

          // Atualiza o índice da fila bulk se necessário
          if (priority === config.priorities.OUTBOUND_LOW && bulkIndex !== undefined) {
            this.currentBulkIndex = bulkIndex + 1;
          }
        }
      } catch (err) {
        log(`[QUEUE] Fail ${id}:`, err.message);

        // Marcar como falhou sem retries
        db.get('queue')
          .find({ id })
          .assign({
            status: 'failed',
            error: err.message,
            retries: retries + 1,
            lastError: err.message,
            failedAt: new Date().toISOString()
          })
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

  /**
   * Manipula um evento de SMS recebido detectado pelo SerialManager.
   * Lê a mensagem, adiciona à fila e a deleta do modem.
   * @param {number} index - O índice da mensagem no modem.
   * @param {string} memory - A memória onde a mensagem foi recebida (ex: "SM").
   */
  async handleIncomingSMSEvent(index, memory) {
    log(`[QUEUE INBOUND] Handling incoming SMS event: index ${index}, memory '${memory}'`);
    try {
      const rawMessageData = await atManager.readSMS(index);
      log(`[QUEUE INBOUND] SMS raw data at index ${index}:`, rawMessageData);

      await atManager.deleteSMS(index);
      log(`[QUEUE INBOUND] Deleted SMS from modem at index ${index}`);

      const id = `in-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const inboundMessage = {
        id,
        type: 'inbound',
        originalIndex: index,
        modemMemory: memory,
        rawData: rawMessageData,
        status: 'received_raw',
        priority: config.priorities.INBOUND_HIGH,
        createdAt: new Date().toISOString(),
        retries: 0
      };

      db.get('queue').push(inboundMessage).write();
      log(`[QUEUE INBOUND] Added inbound SMS ${id} to queue. Raw data stored.`);

      this.process(); // Aciona o processamento da fila

    } catch (e) {
      error(`[QUEUE INBOUND] Error processing incoming SMS event for index ${index}:`, e.message, e.stack);
      // O que fazer se a leitura ou deleção falhar? A mensagem pode ficar presa no SIM.
      // Poderíamos tentar adicionar à fila com um status de erro para retry manual/inspeção?
    }
  }
}

module.exports = new SMSQueue(); 
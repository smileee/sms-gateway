const axios = require('axios');
const db = require('../db');
const config = require('../config');
const { log, error, warn } = require('../utils/logger');

/**
 * Parseia a string bruta retornada pelo comando AT+CMGR.
 * Exemplo de entrada:
 * +CMGR: "REC UNREAD","+1234567890","","23/10/27,12:35:10+08"
 * Este é o texto do SMS.
 * OK
 * @param {string} rawData - A string bruta da resposta do AT+CMGR.
 * @returns {object|null} Objeto com { sender, timestamp, text } ou null se o parse falhar.
 */
function parseRawSMSData(rawData) {
  if (!rawData || typeof rawData !== 'string') {
    return null;
  }

  // Helper para decodificar UCS-2 Hex para String
  function decodeUCS2Hex(hexStr) {
    if (!hexStr || typeof hexStr !== 'string' || !/^[0-9a-fA-F]+$/.test(hexStr) || hexStr.length % 4 !== 0) {
      // Se não for uma string UCS-2 hexadecimal válida, retorna como está (ou poderia lançar erro/logar)
      // Alguns modems podem retornar texto normal para o remetente mesmo se a msg for UCS2
      warn('[INBOUND_PROCESSOR] decodeUCS2Hex: Input is not a valid UCS-2 hex string, returning as is:', hexStr);
      return hexStr; 
    }
    let str = '';
    for (let i = 0; i < hexStr.length; i += 4) {
      const charCode = parseInt(hexStr.substring(i, i + 4), 16);
      str += String.fromCharCode(charCode);
    }
    return str;
  }

  const lines = rawData.trim().split(/\r\n|\n|\r/);
  let sender = null;
  let timestamp = null;
  let text = '';
  let headerFound = false;

  for (const line of lines) {
    if (line.startsWith('+CMGR:')) {
      const parts = line.split(',');
      if (parts.length >= 4) {
        sender = parts[1].replace(/"/g, '');
        // O timestamp do modem pode vir em formatos diferentes. Ex: "yy/MM/dd,HH:mm:ss±zz"
        // zz é a timezone em quartos de hora.
        timestamp = parts[3].replace(/"/g, '');
        if (parts.length > 4) { // Se houver mais partes após o timestamp (geralmente não deveria para +CMGR)
            timestamp += "," + parts.slice(4).join(",").replace(/"/g, '');
        }
        // Decodificar sender se estiver em UCS-2
        if (sender.match(/^[0-9a-fA-F]{4,}$/i) && sender.length % 4 === 0) {
            log('[INBOUND_PROCESSOR] Decoding UCS-2 sender:', sender);
            sender = decodeUCS2Hex(sender);
        }
      }
      headerFound = true;
    } else if (headerFound && !line.match(/^OK$/i) && !line.match(/^ERROR$/i) && line.trim() !== '') {
      // Acumula linhas que não são o cabeçalho, OK ou ERROR como parte do texto
      // Se o texto tiver múltiplas linhas, elas serão concatenadas aqui.
      // Poderia ser melhorado para preservar newlines se o webhook suportar.
      text += (text.length > 0 ? ' ' : '') + line.trim(); 
    }
  }
  
  // Após acumular todo o texto, verificar se ele é UCS-2 e decodificá-lo
  if (text.match(/^[0-9a-fA-F]{4,}$/i) && text.length % 4 === 0 && text.indexOf(' ') === -1) {
    log('[INBOUND_PROCESSOR] Decoding UCS-2 text content:', text);
    text = decodeUCS2Hex(text);
  }

  if (sender && text) { // Timestamp pode ser opcional dependendo do modem/config
    return { sender, timestamp, text };
  }  
  warn('[INBOUND_PROCESSOR] Failed to parse raw SMS data. Header found:', headerFound, 'Raw:', rawData);
  return null;
}

/**
 * Processa uma mensagem SMS inbound que foi lida do modem e está na fila.
 * Formata a mensagem e a envia para o webhook configurado.
 * @param {object} message - O objeto da mensagem do LowDB.
 */
async function processReceivedSMS(message) {
  log(`[INBOUND_PROCESSOR] Processing inbound SMS ID: ${message.id}, Raw data: ${message.rawData.substring(0,100)}...`);

  const parsedData = parseRawSMSData(message.rawData);

  if (!parsedData) {
    error(`[INBOUND_PROCESSOR] Failed to parse raw SMS data for ${message.id}. Moving to failed.`);
    db.get('queue').remove({ id: message.id }).write();
    db.get('failed_inbound') // Nova coleção para falhas de parse
      .push({
        ...message,
        status: 'parse_failed',
        error: 'Failed to parse raw AT+CMGR data',
        processedAt: new Date().toISOString(),
      })
      .write();
    // Assegura que failed_inbound exista
    db.defaults({ failed_inbound: [] }).write(); 
    return;
  }

  const payload = {
    id: message.id,
    from: parsedData.sender,
    text: parsedData.text,
    modemTimestamp: parsedData.timestamp,
    gatewayReceivedAt: message.createdAt, // Quando o gateway registrou o evento +CMTI
    originalIndex: message.originalIndex,
    modemMemory: message.modemMemory,
    imei: config.modem.imei
  };

  log(`[INBOUND_PROCESSOR] Sending to webhook for ${message.id}:`, payload);

  try {
    const response = await axios.post(config.inbound.webhookUrl, payload, {
      timeout: 10000, // Timeout de 10 segundos para a requisição do webhook
    });

    log(`[INBOUND_PROCESSOR] Webhook response for ${message.id}: ${response.status}`);

    if (response.status >= 200 && response.status < 300) {
      db.get('queue').remove({ id: message.id }).write();
      db.get('sent') // Reutilizando a coleção 'sent' para inbound processado
        .push({
          ...message,
          ...payload, // Adiciona os dados parseados
          status: 'webhook_sent_ok',
          webhookStatus: response.status,
          processedAt: new Date().toISOString(),
        })
        .write();
      log(`[INBOUND_PROCESSOR] Successfully sent SMS ${message.id} to webhook and moved to sent.`);
    } else {
      throw new Error(`Webhook responded with status ${response.status}`);
    }
  } catch (e) {
    error(`[INBOUND_PROCESSOR] Error sending SMS ${message.id} to webhook:`, e.message);
    // Lógica de retry pode ser adicionada aqui se necessário.
    // Por enquanto, move para uma coleção de falhas de webhook ou atualiza na fila.
    const retries = (message.retries || 0) + 1;
    if (retries > (config.inbound.maxWebhookRetries || 3)) { // Adicionar maxWebhookRetries ao config se quiser
        warn(`[INBOUND_PROCESSOR] Max retries reached for ${message.id}. Moving to failed_webhook.`);
        db.get('queue').remove({ id: message.id }).write();
        db.get('failed_inbound')
            .push({ ...message, status: 'webhook_max_retries', error: e.message, retries, processedAt: new Date().toISOString() })
            .write();
        db.defaults({ failed_inbound: [] }).write();
    } else {
        db.get('queue')
            .find({ id: message.id })
            .assign({ 
                status: 'webhook_send_failed', 
                error: e.message, 
                retries, 
                lastAttemptAt: new Date().toISOString() 
            })
            .write();
        log(`[INBOUND_PROCESSOR] SMS ${message.id} failed to send to webhook, will retry. Attempt: ${retries}`);
    }
  }
}

module.exports = {
  processReceivedSMS,
  parseRawSMSData // Exportar para testes se necessário
}; 
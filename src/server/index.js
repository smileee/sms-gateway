// src/server/index.js
const express = require('express');
const config = require('../config');
const { log, error } = require('../utils/logger');
const smsQueue = require('../sms/queue');
const smsEncoder = require('../sms/encoding');

const app = express();
app.use(express.json());

/**
 * Endpoint para envio de SMS único
 * @route POST /sms
 * @param {Object} req.body - Corpo da requisição
 * @param {string} req.body.number - Número do destinatário no formato internacional (ex: +5511999999999)
 * @param {string} req.body.message - Mensagem a ser enviada
 * @returns {Object} Resposta com status da operação
 * @returns {boolean} res.ok - Indica se a operação foi bem sucedida
 * @returns {string} [res.id] - ID da mensagem na fila (se ok=true)
 * @returns {string} [res.error] - Mensagem de erro (se ok=false)
 */
app.post('/sms', async (req, res) => {
  try {
    const { number, message } = req.body;
    if (!number || !message)
      return res.status(400).json({ ok: false, error: 'number/message required' });

    const useU = smsEncoder.needsUCS2(message);
    if ((useU && message.length > 70) || (!useU && message.length > 160))
      return res.status(400).json({ ok: false, error: 'Message too long' });

    const id = smsQueue.add(number, message);
    res.json({ ok: true, id });
  } catch (e) {
    error('[ERROR]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * Endpoint para envio em massa de SMS
 * @route POST /bulk-sms
 * @param {Object} req.body - Corpo da requisição
 * @param {Array<Object>} req.body.messages - Lista de mensagens para envio
 * @param {string} req.body.messages[].number - Número do destinatário
 * @param {string} req.body.messages[].message - Mensagem a ser enviada
 * @returns {Object} Resposta com status da operação
 * @returns {boolean} res.ok - Indica se a operação foi bem sucedida
 * @returns {number} [res.queued] - Número de mensagens enfileiradas (se ok=true)
 * @returns {string} [res.error] - Mensagem de erro (se ok=false)
 */
app.post('/bulk-sms', async (req, res) => {
  try {
    const { messages } = req.body;
    if (!Array.isArray(messages) || !messages.length)
      return res.status(400).json({ ok: false, error: 'messages[] required' });

    const added = smsQueue.addBulk(messages);
    if (!added)
      return res.status(400).json({ ok: false, error: 'No valid messages found' });

    res.json({ ok: true, queued: added });
  } catch (e) {
    error('[ERROR]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * Endpoint para consulta da fila de mensagens
 * @route GET /queue
 * @returns {Object} Resposta com status da operação
 * @returns {boolean} res.ok - Indica se a operação foi bem sucedida
 * @returns {Array} [res.queue] - Lista de mensagens na fila (se ok=true)
 * @returns {string} [res.error] - Mensagem de erro (se ok=false)
 */
app.get('/queue', (req, res) => {
  try {
    const queue = smsQueue.getQueue();
    res.json({ ok: true, queue });
  } catch (e) {
    error('[ERROR]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * Endpoint para consulta de mensagens enviadas
 * @route GET /sent
 * @returns {Object} Resposta com status da operação
 * @returns {boolean} res.ok - Indica se a operação foi bem sucedida
 * @returns {Array} [res.sent] - Lista de mensagens enviadas (se ok=true)
 * @returns {string} [res.error] - Mensagem de erro (se ok=false)
 */
app.get('/sent', (req, res) => {
  try {
    const sent = smsQueue.getSent();
    res.json({ ok: true, sent });
  } catch (e) {
    error('[ERROR]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * Endpoint para limpar a fila de mensagens
 * @route DELETE /queue
 * @returns {Object} Resposta com status da operação
 * @returns {boolean} res.ok - Indica se a operação foi bem sucedida
 * @returns {string} [res.error] - Mensagem de erro (se ok=false)
 */
app.delete('/queue', (req, res) => {
  try {
    smsQueue.clearQueue();
    res.json({ ok: true });
  } catch (e) {
    error('[ERROR]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * Endpoint para limpar o histórico de mensagens enviadas
 * @route DELETE /sent
 * @returns {Object} Resposta com status da operação
 * @returns {boolean} res.ok - Indica se a operação foi bem sucedida
 * @returns {string} [res.error] - Mensagem de erro (se ok=false)
 */
app.delete('/sent', (req, res) => {
  try {
    smsQueue.clearSent();
    res.json({ ok: true });
  } catch (e) {
    error('[ERROR]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  error('[SERVER ERROR]', err);
  res.status(500).json({ ok: false, error: 'Internal server error' });
});

// Start server
app.listen(config.server.port, () => {
  log(`SMS API server running on port ${config.server.port}`);
}); 
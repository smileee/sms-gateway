// src/server/index.js
const express = require('express');
const cors = require('cors');
const config = require('../config');
const { log, error } = require('../utils/logger');
const smsQueue = require('../config/queue');
const smsEncoder = require('../sms/encoding');
const serialManager = require('../modem/serial');
const atManager = require('../modem/commands');
const multer = require('multer');
const upload = multer({ dest: 'tmp/' });

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Token authentication middleware
const AUTH_TOKEN = process.env.AUTH_TOKEN || 'sendeasy-sms-token-2024';
const authMiddleware = (req, res, next) => {
  const token = req.headers['x-auth-token'];
  if (!token || token !== AUTH_TOKEN) {
    return res.status(401).json({ ok: false, error: 'Invalid or missing token' });
  }
  next();
};

// Apply auth middleware to all routes
app.use(authMiddleware);

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
 * Endpoint para realizar chamadas com TTS (Text-to-Speech)
 * @route POST /voice-tts
 * @param {Object} req.body - Corpo da requisição
 * @param {string} req.body.number - Número do destinatário no formato internacional (ex: +5511999999999)
 * @param {string} req.body.text - Texto a ser convertido em fala
 * @returns {Object} Resposta com status da operação
 * @returns {boolean} res.ok - Indica se a operação foi bem sucedida
 * @returns {string} [res.id] - ID da chamada na fila (se ok=true)
 * @returns {string} [res.error] - Mensagem de erro (se ok=false)
 */
app.post('/voice-tts', async (req, res) => {
  try {
    const { number, text, voice } = req.body;
    if (!number || !text)
      return res.status(400).json({ ok: false, error: 'number/text required' });

    if (!config.openai.apiKey) {
      return res.status(500).json({ ok: false, error: 'OpenAI API key not configured' });
    }

    if (text.length > 1000) {
      return res.status(400).json({ ok: false, error: 'Text too long (max 1000 chars)' });
    }

    const id = smsQueue.addVoiceCall(number, text, voice);
    res.json({ ok: true, id });
  } catch (e) {
    error('[ERROR]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * Endpoint para realizar chamadas com TTS em tempo real (Realtime API)
 * @route POST /voice-realtime
 * @param {Object} req.body - Corpo da requisição
 * @param {string} req.body.number - Número do destinatário no formato internacional
 * @param {string} req.body.instructions - Instruções ou prompt inicial para o agente
 * @param {string} [req.body.voice] - Voz desejada
 */
app.post('/voice-realtime', async (req, res) => {
  try {
    const { number, instructions, voice } = req.body;
    if (!number || !instructions) {
      return res.status(400).json({ ok: false, error: 'number/instructions required' });
    }

    if (!config.openai.apiKey) {
      return res.status(500).json({ ok: false, error: 'OpenAI API key not configured' });
    }

    const id = smsQueue.addVoiceRealtime(number, instructions, voice);
    res.json({ ok: true, id });
  } catch (e) {
    error('[ERROR]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * Endpoint para realizar chamadas usando um arquivo de áudio já existente ou upload
 * @route POST /voice-file
 * @param {string} number - Número do destinatário no formato internacional (ex: +5511999999999)
 * @param {string} [fileUrl] - URL pública do arquivo de áudio (wav/mp3)
 * @param {file} [file] - Arquivo de áudio enviado via upload (multipart/form-data)
 * @param {string} [voice] - Nome da voz (opcional, para logging)
 * @returns {Object} Resposta com status da operação
 * @returns {boolean} res.ok - Indica se a operação foi bem sucedida
 * @returns {string} [res.id] - ID da chamada na fila (se ok=true)
 * @returns {string} [res.error] - Mensagem de erro (se ok=false)
 *
 * Exemplo curl para upload:
 * curl -X POST http://localhost:3000/voice-file \
 *   -H "x-auth-token: sendeasy-sms-token-2024" \
 *   -F "number=+5511999999999" \
 *   -F "file=@/caminho/para/seu/audio.mp3"
 *
 * Exemplo curl para fileUrl:
 * curl -X POST http://localhost:3000/voice-file \
 *   -H "Content-Type: application/json" \
 *   -H "x-auth-token: sendeasy-sms-token-2024" \
 *   -d '{ "number": "+5511999999999", "fileUrl": "https://.../audio.mp3" }'
 */
app.post('/voice-file', upload.single('file'), async (req, res) => {
  try {
    const { number, fileUrl, voice } = req.body;
    const file = req.file;
    if (!number) {
      return res.status(400).json({ ok: false, error: 'number required' });
    }
    if (!fileUrl && !file) {
      return res.status(400).json({ ok: false, error: 'fileUrl or file required' });
    }
    if (fileUrl && file) {
      return res.status(400).json({ ok: false, error: 'Use only fileUrl OR file, not both' });
    }
    let id;
    if (file) {
      // File uploaded: pass local path to queue
      id = smsQueue.addVoiceFileCall(number, null, voice, file.path);
    } else {
      // fileUrl provided: pass as before
      id = smsQueue.addVoiceFileCall(number, fileUrl, voice);
    }
    res.json({ ok: true, id });
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

/**
 * Endpoint para obter informações do modem
 * @route GET /info
 * @returns {Object} Resposta com informações do modem
 */
app.get('/info', async (req, res) => {
  try {
    const info = await atManager.getInfo();
    res.json({ ok: true, info });
  } catch (e) {
    error('[ERROR /info]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * Endpoint para resetar o modem
 * @route POST /reset
 * @returns {Object} Resposta com status da operação
 */
app.post('/reset', async (req, res) => {
  try {
    const resp = await atManager.resetModem();
    res.json({ ok: true, response: resp });
  } catch (e) {
    error('[ERROR /reset]', e.message);
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
  if (config.inbound?.enabled) {
    serialManager.initialize()
      .then(() => log('[INBOUND] Serial port initialized for inbound listening'))
      .catch((e) => error('[INBOUND] Failed to initialize serial port on startup:', e.message));
  }
}); 
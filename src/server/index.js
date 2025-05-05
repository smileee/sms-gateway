const express = require('express');
const config = require('../config');
const { log, error } = require('../utils/logger');
const smsQueue = require('../sms/queue');
const smsEncoder = require('../sms/encoding');

const app = express();
app.use(express.json());

// Routes
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

// New queue management endpoints
app.get('/queue', (req, res) => {
  try {
    const queue = smsQueue.getQueue();
    res.json({ ok: true, queue });
  } catch (e) {
    error('[ERROR]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/sent', (req, res) => {
  try {
    const sent = smsQueue.getSent();
    res.json({ ok: true, sent });
  } catch (e) {
    error('[ERROR]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.delete('/queue', (req, res) => {
  try {
    smsQueue.clearQueue();
    res.json({ ok: true });
  } catch (e) {
    error('[ERROR]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.delete('/sent', (req, res) => {
  try {
    smsQueue.clearSent();
    res.json({ ok: true });
  } catch (e) {
    error('[ERROR]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Error handling
app.use((err, req, res, next) => {
  error('[SERVER ERROR]', err);
  res.status(500).json({ ok: false, error: 'Internal server error' });
});

// Start server
app.listen(config.server.port, () => {
  log(`SMS API server running on port ${config.server.port}`);
}); 
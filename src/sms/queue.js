const config = require('../config');
const { log } = require('../utils/logger');
const smsEncoder = require('./encoding');
const serialManager = require('../modem/serial');
const db = require('../db');

class SMSQueue {
  constructor() {
    this.processing = false;
  }

  add(number, message) {
    const id = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const messageData = { number, message, id, status: 'pending', createdAt: new Date().toISOString() };
    
    db.get('queue')
      .push(messageData)
      .write();
    
    log(`[QUEUE] Added ${id} -> ${number}`);
    this.process();
    return id;
  }

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
      createdAt: new Date().toISOString()
    }));

    db.get('queue')
      .push(...messagesToAdd)
      .write();

    added = messagesToAdd.length;
    log(`[QUEUE] Added ${added} messages`);
    this.process();
    return added;
  }

  async process() {
    if (this.processing) return;
    this.processing = true;

    while (true) {
      const message = db.get('queue')
        .find({ status: 'pending' })
        .value();

      if (!message) {
        this.processing = false;
        break;
      }

      const { number, message: text, id } = message;
      log(`[QUEUE] Processing ${id} -> ${number}`);

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

  // New methods for queue management
  getQueue() {
    return db.get('queue').value();
  }

  getSent() {
    return db.get('sent').value();
  }

  clearQueue() {
    db.set('queue', []).write();
    return true;
  }

  clearSent() {
    db.set('sent', []).write();
    return true;
  }
}

module.exports = new SMSQueue(); 
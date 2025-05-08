// src/sms/encoding.js
const { log } = require('../utils/logger');

class SMSEncoder {
  toUCS2Hex(str) {
    const b = Buffer.from(str, 'ucs2');
    for (let i = 0; i < b.length; i += 2) [b[i], b[i + 1]] = [b[i + 1], b[i]];
    return b.toString('hex').toUpperCase();
  }

  needsUCS2(txt) {
    // Check for emojis and non-GSM characters
    return [...txt].some((ch) => {
      const code = ch.codePointAt(0);
      return code > 0x7f || code === 0x20AC; // Euro symbol
    });
  }

  encodeMessage(message, useUCS2 = false) {
    if (useUCS2) {
      return this.toUCS2Hex(message);
    }
    return message;
  }

  getEncodingType(message) {
    const useU = this.needsUCS2(message);
    return {
      useUCS2: useU,
      maxLength: useU ? 70 : 160
    };
  }

  validateMessage(message) {
    const { useUCS2, maxLength } = this.getEncodingType(message);
    if (message.length > maxLength) {
      throw new Error(`Message too long for ${useUCS2 ? 'UCS2' : 'GSM-7'} encoding (max ${maxLength} chars)`);
    }
    return true;
  }
}

module.exports = new SMSEncoder(); 
// src/server.js
const PROMPT_TIMEOUT = 10000;   // increased from 3500ms to 10000ms

function waitForPromptRaw(serial, timeout = PROMPT_TIMEOUT) {
  return new Promise((resolve, reject) => {
    let asciiBuf = '';

    const timer = setTimeout(() => {
      cleanup(new Error('Timeout waiting for prompt'));
    }, timeout);

    function onData(chunk) {
      if (!chunk) return;

      // Convert chunk to string for easier matching
      const chunkStr = chunk.toString('ascii');
      asciiBuf += chunkStr;

      // Check for various prompt formats
      if (chunkStr.includes('>') || chunkStr.includes('\r\n>') || chunkStr.includes('\n>')) {
        return cleanup();
      }

      // Check for errors
      if (/(\+CMS ERROR:\s*\d+)/.test(asciiBuf)) {
        return cleanup(new Error(RegExp.$1.trim()));
      }
      if (asciiBuf.includes('ERROR')) {
        return cleanup(new Error('Modem ERROR before prompt'));
      }

      // Prevent buffer overflow
      if (asciiBuf.length > 256) {
        asciiBuf = asciiBuf.slice(-256);
      }
    }

    function cleanup(err) {
      clearTimeout(timer);
      serial.off('data', onData);
      err ? reject(err) : resolve();
    }

    serial.on('data', onData);
  });
} 
// src/server.js – timeout de prompt 3,5 s + detecção de +CMS ERROR + correção CSCS/CSMP
const express            = require('express');
const { SerialPort }     = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');
require('dotenv').config();

const PORT        = process.env.PORT || 3000;
const SERIAL_PORT = '/dev/ttyUSB3';          // porta do modem
const BAUD_RATE   = parseInt(process.env.BAUD_RATE, 10) || 115200;

// —— Settings ——
const PROMPT_TIMEOUT = 3500;   // espera pelo char '>'  (ou erro)
const SUCCESS_DELAY  = 1500;   // intervalo após envio OK
const FAILURE_DELAY  = 10000;  // intervalo após falha

const app = express();
app.use(express.json());

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

// -----------------------------------------------------------------------------
// inicialização de porta única
// -----------------------------------------------------------------------------
let port, parser;
async function initializeModem() {
  if (port && port.isOpen && parser) return { port, parser };

  port = new SerialPort({
    path: SERIAL_PORT,
    baudRate: BAUD_RATE,
    autoOpen: false,
    dataBits: 8,
    stopBits: 1,
    parity: 'none',
    rtscts: true,
  });

  port.on('error', (err) => {
    log('[PORT ERROR]', err.message);
    parser = null;
  });

  await new Promise((resolve, reject) => {
    port.open((err) => (err ? reject(err) : resolve()));
  });
  log('Serial port opened:', SERIAL_PORT);
  log('Waiting for modem to initialize...');
  await delay(5000); // boot do modem

  parser = port.pipe(new ReadlineParser({ delimiter: '\r\n', encoding: 'ascii' }));
  parser.on('data', globalParserHandler);

  return { port, parser };
}

// -----------------------------------------------------------------------------
// mutex de comandos AT
// -----------------------------------------------------------------------------
let atQueue = Promise.resolve();
function enqueueAT(task) {
  const run = atQueue.then(task).catch(() => {});
  atQueue = run.then(() => {}, () => {});
  return run;
}

async function sendAT(port, parser, command, expect = 'OK', timeout = 15000) {
  return enqueueAT(() => coreSendAT(port, parser, command, expect, timeout));
}

function coreSendAT(port, parser, command, expect, timeout) {
  return new Promise((resolve, reject) => {
    if (!parser) return reject(new Error('Parser not ready'));

    let buf = '';
    const handler = (data) => {
      buf += data;
      log('[RECV]', data);
      if (buf.includes('ERROR'))      return cleanup(new Error(`ERROR on ${command}`));
      if (buf.includes(expect))       return cleanup();
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

// -----------------------------------------------------------------------------
// utilidades
// -----------------------------------------------------------------------------
const delay = (ms) => new Promise((res) => setTimeout(res, ms));

/**
 * Espera pelo prompt '>' **ou** captura imediatamente qualquer
 * '+CMS ERROR:' ou 'ERROR'.  Rejeita com mensagem detalhada.
 */
function waitForPromptRaw(serial, timeout = PROMPT_TIMEOUT) {
  return new Promise((resolve, reject) => {
    let asciiBuf = '';

    const timer = setTimeout(() => {
      cleanup(new Error('Timeout waiting for prompt'));
    }, timeout);

    function onData(chunk) {
      if (!chunk) return;

      // prompt (Buffer contém 0x3E)
      if (chunk.includes(0x3e)) return cleanup();

      // analisa string ASCII para erros
      asciiBuf += chunk.toString('ascii');
      if (/(\+CMS ERROR:\s*\d+)/.test(asciiBuf))
        return cleanup(new Error(RegExp.$1.trim()));
      if (asciiBuf.includes('ERROR'))
        return cleanup(new Error('Modem ERROR before prompt'));

      // evita buffer infinito
      if (asciiBuf.length > 256) asciiBuf = asciiBuf.slice(-256);
    }

    function cleanup(err) {
      clearTimeout(timer);
      serial.off('data', onData);
      err ? reject(err) : resolve();
    }
    serial.on('data', onData);
  });
}

async function ensureModemReady(port, parser, attempts = 2) {
  try {
    log('Ensuring modem is in command mode...');
    if (port.isOpen) port.write('\x1B');
    await delay(300);
    if (port.isOpen) port.write(String.fromCharCode(26));
    await delay(500);
    if (port.isOpen) port.write('+++');
    await delay(1100);
    port.write('\r');
    await delay(300);
  } catch {}

  parser.removeAllListeners('data');

  for (let i = 0; i < attempts; i++) {
    try {
      await sendAT(port, parser, 'AT', 'OK', 1500);
      log('Modem responded to AT - ready.');
      return;
    } catch (e) {
      log(`[WARN] AT attempt ${i + 1} failed`, e.message);
      await delay(3000);
    }
  }
  throw new Error('Modem not responding');
}

// -----------------------------------------------------------------------------
// helpers de charset/DCS
// -----------------------------------------------------------------------------
async function setUcs2() {
  await sendAT(port, parser, 'AT+CSCS="UCS2"');
  await sendAT(port, parser, 'AT+CSMP=17,167,0,8'); // DCS 0x08 (UCS‑2)
}

async function setGsm7() {
  await sendAT(port, parser, 'AT+CSCS="GSM"');
  await sendAT(port, parser, 'AT+CSMP=17,167,0,0'); // DCS 0x00 (7‑bit default)
}

// -----------------------------------------------------------------------------
// fila de envio
// -----------------------------------------------------------------------------
let sendQueue = [];
let processingQueue = false;

async function processSendQueue() {
  if (processingQueue) return;
  processingQueue = true;

  while (sendQueue.length) {
    const { number, message, id } = sendQueue.shift();
    log(`[QUEUE] Processing ${id} -> ${number}`);

    let ok = false;
    try {
      await sendSMS(number, message);
      log(`[QUEUE] Sent ${id} OK`);
      ok = true;
    } catch (err) {
      log(`[QUEUE] Fail ${id}:`, err.message);
    }

    await delay(ok ? SUCCESS_DELAY : FAILURE_DELAY);
  }
  processingQueue = false;
}

// -----------------------------------------------------------------------------
// conversões
// -----------------------------------------------------------------------------
const toUCS2Hex = (str) => {
  const b = Buffer.from(str, 'ucs2');
  for (let i = 0; i < b.length; i += 2) [b[i], b[i + 1]] = [b[i + 1], b[i]];
  return b.toString('hex').toUpperCase();
};
const needsUCS2 = (txt) => [...txt].some((ch) => ch.codePointAt(0) > 0x7f);

// handler global p/ debug
function globalParserHandler(d) {
  log('[PROMPT DEBUG]', JSON.stringify(d));
}

// -----------------------------------------------------------------------------
// envio principal
// -----------------------------------------------------------------------------
async function sendSMS(number, message) {
  if (!number || !message) throw new Error('Missing parameters');

  const { port: p, parser: pa } = await initializeModem();
  port = p;
  parser = pa;

  await ensureModemReady(port, parser);
  await sendAT(port, parser, 'AT+CMEE=2');
  await sendAT(port, parser, 'AT+CMGF=1');

  const useU = needsUCS2(message);

  if (useU) {
    // ---------- UCS‑2 ----------
    await setUcs2();

    const numHex = toUCS2Hex(number);
    const msgHex = toUCS2Hex(message);
    if (msgHex.length / 4 > 70) throw new Error('UCS2 > 70 chars');

    port.write(`AT+CMGS="${numHex}",145\r`);
    await waitForPromptRaw(port);

    await new Promise((res, rej) => {
      let buf = '';
      const timer = setTimeout(() => done(new Error('SMS timeout')), 60000);
      const handler = (d) => {
        buf += d;
        if (/\+CMGS|\bOK\b/.test(buf))          return done();
        if (/(\+CMS ERROR:.*|ERROR)/.test(buf)) return done(new Error(buf.trim()));
      };
      function done(err) {
        clearTimeout(timer);
        parser.off('data', handler);
        err ? rej(err) : res();
      }
      parser.on('data', handler);
      log(`[SEND SMS] ${number} (UCS2)`);
      port.write(msgHex);
      port.drain(() => port.write(Buffer.from([26])));
    });
  } else {
    // ---------- GSM‑7 ----------
    if (message.length > 160) throw new Error('SMS > 160 chars');

    await setGsm7();

    port.write(`AT+CMGS="${number}"\r`);
    await waitForPromptRaw(port);

    await new Promise((res, rej) => {
      let buf = '';
      const timer = setTimeout(() => done(new Error('SMS timeout')), 15000);
      const handler = (d) => {
        buf += d;
        if (/\+CMGS|\bOK\b/.test(buf))          return done();
        if (/(\+CMS ERROR:.*|ERROR)/.test(buf)) return done(new Error(buf.trim()));
      };
      function done(err) {
        clearTimeout(timer);
        parser.off('data', handler);
        err ? rej(err) : res();
      }
      parser.on('data', handler);
      log(`[SEND SMS] ${number}`);
      port.write(message);
      port.drain(() => port.write(Buffer.from([26])));
    });
  }

  // limpeza de memória (assíncrona)
  sendAT(port, parser, 'AT+CMGD=1,4', 'OK', 3000)
    .catch((e) => log('[WARN CMGD]', e.message));
}

// -----------------------------------------------------------------------------
// endpoints HTTP
// -----------------------------------------------------------------------------
app.post('/sms', async (req, res) => {
  try {
    const { number, message } = req.body;
    if (!number || !message)
      return res.status(400).json({ ok: false, error: 'number/message required' });

    const useU = needsUCS2(message);
    if ((useU && message.length > 70) || (!useU && message.length > 160))
      return res.status(400).json({ ok: false, error: 'Message too long' });

    const id = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    sendQueue.push({ number, message, id });
    log(`[QUEUE] Added ${id} -> ${number} (${useU ? 'UCS2' : 'GSM-7'})`);

    processSendQueue();
    res.json({ ok: true, id });
  } catch (e) {
    log('[ERROR]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/bulk-sms', async (req, res) => {
  try {
    const { messages } = req.body;
    if (!Array.isArray(messages) || !messages.length)
      throw new Error('messages[] required');

    let added = 0;
    messages.forEach((m, i) => {
      if (!m?.number || !m?.message) return;
      const useU = needsUCS2(m.message);
      if ((useU && m.message.length > 70) || (!useU && m.message.length > 160)) {
        log(`[QUEUE] Skip idx ${i}: muito longa`);
        return;
      }
      const id = `msg-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 6)}`;
      sendQueue.push({ number: m.number, message: m.message, id });
      added++;
      log(`[QUEUE] Added ${id} -> ${m.number}`);
    });

    if (!added)
      return res.status(400).json({ ok: false, error: 'nenhuma mensagem válida' });

    processSendQueue();
    res.json({ ok: true, queued: added });
  } catch (e) {
    log('[ERROR]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.listen(PORT, () => log(`SMS API server on ${PORT}`));

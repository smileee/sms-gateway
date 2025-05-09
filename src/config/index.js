// src/config/index.js
require('dotenv').config();

const config = {
  server: {
    port: parseInt(process.env.PORT, 10) || 3000,
  },
  serial: {
    port: process.env.SERIAL_PORT || '/dev/ttyUSB3',
    baudRate: parseInt(process.env.BAUD_RATE, 10) || 115200,
  },
  timeouts: {
    prompt: parseInt(process.env.PROMPT_TIMEOUT, 10) || 500,
    successDelay: parseInt(process.env.SUCCESS_DELAY, 10) || 500,
    failureDelay: parseInt(process.env.FAILURE_DELAY, 10) || 2000,
    modemBoot: parseInt(process.env.MODEM_BOOT_DELAY, 10) || 1000,
    atCommand: parseInt(process.env.AT_COMMAND_TIMEOUT, 10) || 500,
    sms: parseInt(process.env.SMS_TIMEOUT, 10) || 1500,
    retryDelay: parseInt(process.env.RETRY_DELAY, 10) || 1000,
  },
  modem: {
    atAttempts: parseInt(process.env.MODEM_AT_ATTEMPTS, 10) || 3,
    atDelay: parseInt(process.env.MODEM_AT_DELAY, 10) || 500,
    maxRetries: parseInt(process.env.MAX_RETRIES, 10) || 0,
  },
  inbound: {
    enabled: true,
    webhookUrl: 'https://webhook.site/6c55f566-c377-440c-8d75-bc4da7af0ef8',
    checkIntervalMs: 5000,
    priority: 'inbound-high',
  },
  priorities: {
    INBOUND_HIGH: 'inbound-high',
    CALL: 'call',
    OUTBOUND_MEDIUM: 'outbound-medium',
    OUTBOUND_LOW: 'outbound-low',
  },
  openai: {
    apiKey: process.env.OPENAI_API_KEY || '',
  },
};

module.exports = config; 
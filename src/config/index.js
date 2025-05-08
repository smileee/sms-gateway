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
    prompt: parseInt(process.env.PROMPT_TIMEOUT, 10) || 5000,
    successDelay: parseInt(process.env.SUCCESS_DELAY, 10) || 1000,
    failureDelay: parseInt(process.env.FAILURE_DELAY, 10) || 5000,
    modemBoot: parseInt(process.env.MODEM_BOOT_DELAY, 10) || 3000,
    atCommand: parseInt(process.env.AT_COMMAND_TIMEOUT, 10) || 5000,
    sms: parseInt(process.env.SMS_TIMEOUT, 10) || 15000,
    retryDelay: parseInt(process.env.RETRY_DELAY, 10) || 2000,
  },
  modem: {
    atAttempts: parseInt(process.env.MODEM_AT_ATTEMPTS, 10) || 3,
    atDelay: parseInt(process.env.MODEM_AT_DELAY, 10) || 1000,
    maxRetries: parseInt(process.env.MAX_RETRIES, 10) || 0,
  },
};

module.exports = config; 
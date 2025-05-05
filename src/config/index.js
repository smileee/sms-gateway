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
    prompt: parseInt(process.env.PROMPT_TIMEOUT, 10) || 3500,
    successDelay: parseInt(process.env.SUCCESS_DELAY, 10) || 1500,
    failureDelay: parseInt(process.env.FAILURE_DELAY, 10) || 10000,
    modemBoot: parseInt(process.env.MODEM_BOOT_DELAY, 10) || 5000,
    atCommand: parseInt(process.env.AT_COMMAND_TIMEOUT, 10) || 15000,
    sms: parseInt(process.env.SMS_TIMEOUT, 10) || 60000,
  },
  modem: {
    atAttempts: parseInt(process.env.MODEM_AT_ATTEMPTS, 10) || 2,
    atDelay: parseInt(process.env.MODEM_AT_DELAY, 10) || 3000,
  },
};

module.exports = config; 
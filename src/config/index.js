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
    VOICE_CALL_HIGH: 'voice-call-high',
    OUTBOUND_MEDIUM: 'outbound-medium',
    OUTBOUND_LOW: 'outbound-low',
  },
  openai: {
    apiKey: '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',
    ttsModel: 'gpt-4o-mini-tts',
    ttsVoice: 'coral',
    audioFormat: 'mp3',
  },
  audioPlayback: {
    device: 'plughw:3,0',
    tempAudioPath: './temp_audio',
    playbackTimeoutMs: 60000,
  }
};

module.exports = config; 
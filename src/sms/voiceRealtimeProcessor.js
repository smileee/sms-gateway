const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const config = require('../config');
const { log, error } = require('../utils/logger');
const atManager = require('../modem/commands');
const serialManager = require('../modem/serial');

// Diretório temporário para logs ou dumps, se necessário
const TMP_DIR = path.join(process.cwd(), 'tmp');
fs.existsSync(TMP_DIR) || fs.mkdirSync(TMP_DIR, { recursive: true });

class VoiceRealtimeProcessor {
  constructor() {
    this.inCall = false;
  }

  /**
   * Conecta ao WebSocket Realtime API e recebe eventos.
   * Por simplicidade, acumulamos o áudio em PCM 16k float32 e tocamos via aplay.
   * @param {string} prompt - Instruções ou mensagem inicial.
   * @param {string} voice - Voz desejada (opcional)
   * @returns {Promise<string>} Caminho do arquivo PCM gerado (fallback)
   */
  async getRealtimeAudio(prompt, voice = 'alloy') {
    return new Promise((resolve, reject) => {
      const model = config.openai.realtimeModel || 'gpt-4o-realtime-preview-2024-12-17';
      const url = `wss://api.openai.com/v1/realtime?model=${model}`;

      const ws = new WebSocket(url, {
        headers: {
          Authorization: `Bearer ${config.openai.apiKey}`,
          'OpenAI-Beta': 'realtime=v1'
        }
      });

      const pcmBuffers = [];

      ws.on('open', () => {
        log('[VOICE-RT] WebSocket aberto. Enviando evento user_message');
        const userEvent = {
          type: 'user_message',
          data: {
            content: prompt
          }
        };
        ws.send(JSON.stringify(userEvent));
      });

      ws.on('message', (data) => {
        let evt;
        try {
          evt = JSON.parse(data.toString());
        } catch (_) {
          return;
        }

        switch (evt.type) {
          case 'audio': {
            // Chunks base64 em evt.data.audio
            if (evt.data && evt.data.audio) {
              const buff = Buffer.from(evt.data.audio, 'base64');
              pcmBuffers.push(buff);
            }
            break;
          }
          // "audio_end" (ou "assistant_speech_stop") sinaliza fim definitivo do stream de áudio.
          case 'audio_end':
          case 'assistant_speech_stop': {
            ws.close();
            break;
          }
          // Ignorar outros tipos ou apenas logar se necessário
          default:
            break;
        }
      });

      ws.on('close', () => {
        const pcmPath = path.join(TMP_DIR, `rt-${Date.now()}.pcm`);
        fs.writeFileSync(pcmPath, Buffer.concat(pcmBuffers));
        log(`[VOICE-RT] Sessão encerrada. PCM salvo em ${pcmPath}`);
        resolve(pcmPath);
      });

      ws.on('error', (err) => {
        error('[VOICE-RT] WebSocket error', err.message);
        reject(err);
      });
    });
  }

  /**
   * Processa a chamada em realtime
   */
  async processVoiceCall(message) {
    const { id, number, instructions, voice } = message;
    log(`[VOICE-RT] Processando chamada realtime ${id}`);

    if (this.inCall) {
      error('[VOICE-RT] Já existe uma chamada em andamento. Adiando.');
      return false;
    }
    this.inCall = true;

    try {
      // Passo 1: gerar/streamar o áudio (para simplificação, gera antes)
      const pcmPath = await this.getRealtimeAudio(instructions, voice);

      // Converter PCM para WAV temporário via sox (reutiliza pipeline existente)
      const wavPath = pcmPath.replace(/\.pcm$/, '.wav');
      await new Promise((resolve, reject) => {
        const sox = spawn('sox', [
          '-t', 'f32', // tipo input raw float32
          '-r', '16000', // sample rate
          '-c', '1', // mono
          pcmPath,
          wavPath
        ]);
        sox.on('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`sox exited ${code}`));
        });
      });

      // Passo 2: fazer ligação
      const voiceCallProcessor = require('./voiceCallProcessor');
      await voiceCallProcessor.makeCall(number);
      log('[VOICE-RT] Aguardando 750ms após atendimento...');
      await serialManager.delay(750);

      // Passo 3: tocar wav
      await voiceCallProcessor.playAudio(wavPath);

      // Cleanup
      fs.unlinkSync(pcmPath);
      fs.unlinkSync(wavPath);

      return true;
    } catch (e) {
      error(`[VOICE-RT] Erro: ${e.message}`);
      throw e;
    } finally {
      this.inCall = false;
    }
  }
}

module.exports = new VoiceRealtimeProcessor(); 
const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { log, error } = require('../utils/logger');

const openai = new OpenAI({
  apiKey: config.openai.apiKey,
});

/**
 * Garante que o diretório para áudios temporários exista.
 */
async function ensureTempAudioPathExists() {
  const dirPath = path.resolve(config.audioPlayback.tempAudioPath);
  try {
    await fs.promises.access(dirPath);
  } catch (e) {
    if (e.code === 'ENOENT') {
      log(`[TTS] Temporary audio directory ${dirPath} does not exist, creating...`);
      await fs.promises.mkdir(dirPath, { recursive: true });
    } else {
      throw e;
    }
  }
}

/**
 * Gera áudio a partir do texto usando a API da OpenAI e salva em um arquivo temporário.
 * @param {string} text - O texto a ser convertido em fala.
 * @param {string} taskId - ID da tarefa para nomear o arquivo de forma única.
 * @returns {Promise<string>} O caminho completo para o arquivo de áudio gerado.
 * @throws {Error} Se a geração do áudio ou o salvamento do arquivo falhar.
 */
async function generateSpeech(text, taskId) {
  await ensureTempAudioPathExists();
  const speechFileName = `${taskId}_speech.${config.openai.audioFormat}`;
  const speechFilePath = path.resolve(config.audioPlayback.tempAudioPath, speechFileName);

  log(`[TTS] Generating speech for task ${taskId}, text: "${text.substring(0, 50)}..."`);

  try {
    const mp3 = await openai.audio.speech.create({
      model: config.openai.ttsModel,
      voice: config.openai.ttsVoice,
      input: text,
      response_format: config.openai.audioFormat,
      // instructions: "Speak in a clear and neutral tone." // Opcional
    });

    const buffer = Buffer.from(await mp3.arrayBuffer());
    await fs.promises.writeFile(speechFilePath, buffer);
    log(`[TTS] Speech file saved for task ${taskId} at: ${speechFilePath}`);
    return speechFilePath;
  } catch (e) {
    error(`[TTS] Error generating speech for task ${taskId}:`, e.message, e.stack);
    // Tentar limpar arquivo parcialmente escrito, se existir
    try { await fs.promises.unlink(speechFilePath); } catch (unlinkError) { /* ignore */ }
    throw e; // Re-lança o erro para ser tratado pelo chamador
  }
}

module.exports = {
  generateSpeech,
}; 
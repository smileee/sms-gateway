const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');
const OpenAI = require('openai');
const config = require('../config');
const { log, error } = require('../utils/logger');
const atManager = require('../modem/commands');
const serialManager = require('../modem/serial');
const axios = require('axios');

const execPromise = promisify(exec);
const mkdir = promisify(fs.mkdir);
const writeFile = promisify(fs.writeFile);
const unlink = promisify(fs.unlink);

// Criação do diretório temporário para os arquivos de áudio
const TMP_DIR = path.join(process.cwd(), 'tmp');
fs.existsSync(TMP_DIR) || fs.mkdirSync(TMP_DIR, { recursive: true });

class VoiceCallProcessor {
  constructor() {
    this.inCall = false;
    this.openai = new OpenAI({
      apiKey: config.openai.apiKey,
    });
  }

  /**
   * Gera um arquivo de áudio a partir de texto usando a API de TTS da SendEasy (padrão) ou OpenAI
   * @param {string} text - O texto a ser convertido em fala
   * @param {string} outputPath - Caminho para salvar o arquivo de áudio
   * @param {string} voice - Voz a ser usada para gerar o áudio
   * @param {string} provider - 'sendeasy' (padrão) ou 'openai'
   * @returns {Promise<string>} Caminho do arquivo de áudio gerado
   */
  async generateSpeech(text, outputPath, voice = 'coral', provider = 'sendeasy') {
    provider = (provider || 'sendeasy').toLowerCase();
    if (provider === 'openai') {
      // --- OPENAI TTS (mantém como está, só move para dentro do if) ---
      const supportedVoices = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'];
      const normalizedVoice = voice.toLowerCase();
      if (!supportedVoices.includes(normalizedVoice)) {
        log(`[VOICE] Voz '${voice}' não suportada. Usando voz padrão 'alloy'.`);
        voice = 'alloy';
      } else {
        voice = normalizedVoice;
      }
      log(`[VOICE] [OpenAI] Gerando áudio TTS para: "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}" com voz: ${voice}`);
      try {
        const mp3Response = await this.openai.audio.speech.create({
          model: "gpt-4o-mini-tts",
          voice: voice,
          input: text,
          response_format: "wav", // Formato compatível com aplay
        });
        const buffer = Buffer.from(await mp3Response.arrayBuffer());
        await writeFile(outputPath, buffer);
        log(`[VOICE] [OpenAI] Áudio TTS gerado com sucesso em: ${outputPath}`);
        return outputPath;
      } catch (e) {
        error(`[VOICE] [OpenAI] Erro ao gerar áudio TTS: ${e.message}`);
        throw e;
      }
    } else {
      // --- SENDEASY TTS (padrão) ---
      // Configuração do endpoint base
      const baseUrl = config.sendeasyTTS?.baseUrl || 'http://localhost';
      const apiToken = config.sendeasyTTS?.apiToken;
      const headers = apiToken ? { 'x-api-token': apiToken } : {};
      const ttsUrl = `${baseUrl}/tts`;
      log(`[VOICE] [SendEasy] Gerando áudio TTS para: "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}" com voz: ${voice}`);
      try {
        // 1. Enfileira o texto para síntese
        const ttsRes = await axios.post(ttsUrl, {
          text,
          voice,
          format: 'wav',
          model: 'kokoro',
        }, { headers });
        const { id, status, download_url } = ttsRes.data;
        if (!id || !download_url) throw new Error('Resposta inválida do TTS: ' + JSON.stringify(ttsRes.data));
        // 2. Poll status até ficar 'done' (timeout de 30s)
        const statusUrl = `${baseUrl}/status/${id}`;
        let jobStatus = status;
        let filePath;
        const started = Date.now();
        while (jobStatus !== 'done') {
          if (Date.now() - started > 30000) throw new Error('Timeout aguardando TTS job');
          await new Promise(r => setTimeout(r, 500));
          const statusRes = await axios.get(statusUrl, { headers });
          jobStatus = statusRes.data.status;
          filePath = statusRes.data.filePath;
          if (jobStatus === 'error') throw new Error('Erro no TTS: ' + (statusRes.data.error || 'desconhecido'));
        }
        // 3. Baixa o arquivo de áudio
        const audioUrl = `${baseUrl}${filePath || download_url}`;
        const audioRes = await axios.get(audioUrl, { responseType: 'arraybuffer', headers });
        await writeFile(outputPath, Buffer.from(audioRes.data));
        log(`[VOICE] [SendEasy] Áudio TTS gerado com sucesso em: ${outputPath}`);
        return outputPath;
      } catch (e) {
        error(`[VOICE] [SendEasy] Erro ao gerar áudio TTS: ${e.message}`);
        throw e;
      }
    }
  }

  /**
   * Processa uma chamada de voz usando TTS
   * @param {Object} message - A mensagem da fila
   * @returns {Promise<boolean>} true se processado com sucesso
   */
  async processVoiceCall(message) {
    const { id, number, text, voice, ttsProvider } = message;
    log(`[VOICE] Processando chamada ${id} para ${number}`);
    
    if (this.inCall) {
      error(`[VOICE] Já existe uma chamada em andamento. Chamada ${id} será adiada.`);
      return false;
    }
    
    this.inCall = true;
    const audioPath = path.join(TMP_DIR, `tts-${id}.wav`);
    
    try {
      // Passo 1: Gerar o áudio TTS com a voz e provider especificados
      await this.generateSpeech(text, audioPath, voice, ttsProvider);
      
      // Passo 2: Fazer a chamada para o número
      log(`[VOICE] Discando para ${number}...`);
      await this.makeCall(number);
      
      // Aguardar 750ms após a chamada ser atendida antes de reproduzir
      log(`[VOICE] Aguardando 750ms após atendimento...`);
      await serialManager.delay(750);
      
      // Passo 3: Reproduzir o áudio quando a chamada for atendida
      log(`[VOICE] Reproduzindo áudio...`);
      await this.playAudio(audioPath);
      
      log(`[VOICE] Chamada ${id} concluída com sucesso.`);
      
      return true;
    } catch (e) {
      error(`[VOICE] Erro no processamento da chamada ${id}: ${e.message}`);
      // Se estiver em chamada, tenta desligar
      if (this.inCall) {
        try {
          await this.hangupCall();
        } catch (hangupErr) {
          error(`[VOICE] Erro ao desligar chamada: ${hangupErr.message}`);
        }
      }
      throw e;
    } finally {
      this.inCall = false;
      
      // Remover o arquivo de áudio temporário
      try {
        await unlink(audioPath);
        log(`[VOICE] Arquivo de áudio temporário removido: ${audioPath}`);
      } catch (unlinkErr) {
        error(`[VOICE] Erro ao remover arquivo temporário: ${unlinkErr.message}`);
      }
    }
  }

  /**
   * Realiza uma chamada telefônica e aguarda o atendimento
   * @param {string} number - Número a ser chamado
   * @returns {Promise<void>}
   */
  async makeCall(number) {
    try {
      const { port, parser } = await serialManager.initialize();
      
      // Limpar formatação do número: remover +, espaços, parênteses, traços etc.
      // Muitos modems não aceitam o caractere "+" no ATD; deve-se discar o número no formato
      // internacional sem o prefixo (+55 31 …) → 5531…
      const cleanedNumber = number.replace(/[^0-9]/g, '');
      
      // Fazer um flush no buffer para descartar dados pendentes que possam conter "NO CARRIER" residual
      await new Promise((resolve, reject) => {
        port.flush((err) => (err ? reject(err) : resolve()));
      });

      // Pequeno delay para garantir que o modem esteja pronto após o flush
      await serialManager.delay(200);
      
      // Enviar comando ATD (Dial) com o número - ESCRITA DIRETA NA PORTA
      // Nota: ATManager adiciona \r, mas vamos escrever diretamente para garantir \r
      const dialCommand = `ATD${cleanedNumber};\r`;
      log(`[VOICE] Enviando comando de discagem diretamente: ${dialCommand}`);
      
      // Escrever diretamente na porta serial ao invés de usar atManager
      await new Promise((resolve, reject) => {
        port.write(dialCommand, (err) => {
          if (err) reject(err);
          else {
            port.drain(resolve);
            log(`[VOICE] Comando de discagem enviado com sucesso`);
          }
        });
      });
      
      // Aguardar pelo início da chamada ou falha
      log(`[VOICE] Aguardando atendimento da chamada...`);
      await this.waitForCallStatus('BEGIN', 45000); // Aumentado para 45 segundos
      
      log(`[VOICE] Chamada atendida com sucesso.`);
    } catch (e) {
      error(`[VOICE] Erro ao realizar chamada: ${e.message}`);
      throw e;
    }
  }

  /**
   * Aguarda por um status específico da chamada (BEGIN, END)
   * @param {string} status - Status esperado (BEGIN ou END)
   * @param {number} timeout - Tempo máximo de espera em ms
   * @returns {Promise<void>}
   */
  waitForCallStatus(status, timeout = 30000) {
    const { parser } = serialManager;
    if (!parser) throw new Error('Parser não inicializado');
    
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Timeout aguardando CALL ${status}`));
      }, timeout);
      
      const handler = (data) => {
        const str = data.toString();
        log(`[VOICE] Data recebida: ${str.trim()}`);
        
        // Verificar falhas explícitas quando esperamos pelo início da chamada
        if (status === 'BEGIN' && (
            str.includes('NO CARRIER') || 
            str.includes('BUSY') || 
            str.includes('NO ANSWER') ||
            str.includes('ERROR')
        )) {
          cleanup();
          reject(new Error(`Chamada falhou: ${str.trim()}`));
          return;
        }
        
        // Verificar padrões diferentes que podem indicar início de chamada
        // Os modems podem retornar diferentes URCs para indicar o mesmo status
        if (status === 'BEGIN' && (
            str.includes('CALL BEGIN') || 
            str.includes('CONNECTED') ||
            str.includes('CONN') ||
            str.includes('CIEV: "CALL",1') ||
            str.includes('VOICE CALL: BEGIN') ||
            str.includes('VOICE CALL: BEGINESTABLISHED')
        )) {
          cleanup();
          resolve();
        } else if (status === 'END' && (
            str.includes('CALL END') || 
            str.includes('NO CARRIER') ||
            str.includes('BUSY') ||
            str.includes('CIEV: "CALL",0') ||
            str.includes('VOICE CALL: END')
        )) {
          cleanup();
          resolve();
        }
      };
      
      function cleanup() {
        clearTimeout(timer);
        parser.off('data', handler);
      }
      
      parser.on('data', handler);
    });
  }

  /**
   * Reproduz um arquivo de áudio usando aplay
   * @param {string} audioPath - Caminho do arquivo de áudio
   * @returns {Promise<void>}
   */
  async playAudio(audioPath) {
    try {
      // Verifica se o arquivo existe
      if (!fs.existsSync(audioPath)) {
        throw new Error(`Arquivo de áudio não encontrado: ${audioPath}`);
      }
      
      // Reproduz o áudio usando aplay na porta CM108 (3)
      log(`[VOICE] Reproduzindo áudio: ${audioPath}`);
      await execPromise(`aplay -D plughw:3,0 "${audioPath}"`, { timeout: 120000 });
      
      log(`[VOICE] Reprodução de áudio concluída`);
      
      // Aguarda um pequeno delay para garantir que o áudio foi completamente reproduzido
      await serialManager.delay(500);
      
      // Encerra a chamada imediatamente após a reprodução
      await this.hangupCall();
    } catch (e) {
      error(`[VOICE] Erro ao reproduzir áudio: ${e.message}`);
      throw e;
    }
  }

  /**
   * Encerra a chamada atual
   * @returns {Promise<void>}
   */
  async hangupCall() {
    try {
      // Enviar comando AT+CHUP (Hangup) - mais confiável que ATH
      log(`[VOICE] Desligando chamada...`);
      await atManager.send('AT+CHUP', 'OK');
      
      // Esperar realmente encerrar
      await this.waitForCallStatus('END', 5000).catch(() => {
        // Se timeout, continuamos - alguns modems não retornam uma confirmação explícita
      });
      
      log(`[VOICE] Chamada encerrada com sucesso.`);
    } catch (e) {
      error(`[VOICE] Erro ao desligar chamada: ${e.message}`);
      throw e;
    }
  }

  /**
   * Processa uma chamada de voz usando um arquivo de áudio existente
   * @param {Object} message - { id, number, fileUrl, voice }
   * @returns {Promise<boolean>} true se processado com sucesso
   */
  async processVoiceFileCall(message) {
    const { id, number, fileUrl, voice } = message;
    log(`[VOICE] [FILE] Processando chamada ${id} para ${number} com arquivo: ${fileUrl}`);
    if (this.inCall) {
      error(`[VOICE] [FILE] Já existe uma chamada em andamento. Chamada ${id} será adiada.`);
      return false;
    }
    this.inCall = true;
    // Detect extension
    const ext = (fileUrl.split('.').pop() || 'wav').toLowerCase();
    const audioPath = path.join(TMP_DIR, `voicefile-${id}.${ext}`);
    try {
      // Baixar o arquivo de áudio
      log(`[VOICE] [FILE] Baixando arquivo de áudio: ${fileUrl}`);
      const audioRes = await axios.get(fileUrl, { responseType: 'arraybuffer' });
      await writeFile(audioPath, Buffer.from(audioRes.data));
      log(`[VOICE] [FILE] Arquivo de áudio salvo em: ${audioPath}`);
      // Fazer a chamada
      log(`[VOICE] [FILE] Discando para ${number}...`);
      await this.makeCall(number);
      log(`[VOICE] [FILE] Aguardando 750ms após atendimento...`);
      await serialManager.delay(750);
      // Reproduzir o áudio
      log(`[VOICE] [FILE] Reproduzindo áudio...`);
      await this.playAudio(audioPath);
      log(`[VOICE] [FILE] Chamada ${id} concluída com sucesso.`);
      return true;
    } catch (e) {
      error(`[VOICE] [FILE] Erro no processamento da chamada ${id}: ${e.message}`);
      if (this.inCall) {
        try {
          await this.hangupCall();
        } catch (hangupErr) {
          error(`[VOICE] [FILE] Erro ao desligar chamada: ${hangupErr.message}`);
        }
      }
      throw e;
    } finally {
      this.inCall = false;
      // Remover o arquivo de áudio temporário
      try {
        await unlink(audioPath);
        log(`[VOICE] [FILE] Arquivo de áudio temporário removido: ${audioPath}`);
      } catch (unlinkErr) {
        error(`[VOICE] [FILE] Erro ao remover arquivo temporário: ${unlinkErr.message}`);
      }
    }
  }
}

module.exports = new VoiceCallProcessor(); 
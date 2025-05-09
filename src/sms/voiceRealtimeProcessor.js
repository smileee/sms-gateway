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

// Constantes para os comandos de áudio
const APLAY_DEVICE = 'plughw:3,0'; // Saída de áudio para a CM108
const ARECORD_DEVICE = 'plughw:3,0'; // Entrada de áudio da CM108
// Formato de áudio esperado pela OpenAI para input_audio_buffer.append (PCM 16-bit little-endian, 16kHz, mono)
// E formato que pediremos para a OpenAI nos enviar.
const AUDIO_FORMAT_PARAMS_APLAY = ['-t', 'raw', '-f', 'S16_LE', '-r', '16000', '-c', '1'];
const AUDIO_FORMAT_PARAMS_ARECORD = ['-t', 'raw', '-f', 'S16_LE', '-r', '16000', '-c', '1', '-D', ARECORD_DEVICE];

class VoiceRealtimeProcessor {
  constructor() {
    this.inCall = false;
    this.ws = null;
    this.aplayProcess = null;
    this.arecordProcess = null;
    this.callDetails = null; // Para armazenar { id, number, instructions, voice }
  }

  async makeCall(number) {
    log(`[VOICE-RT] Iniciando chamada para: ${number}`);
    const { port } = await serialManager.initialize();
    const cleanedNumber = number.replace(/[^0-9]/g, '');
    const dialCommand = `ATD${cleanedNumber};
`;

    await new Promise((resolve, reject) => port.flush(err => err ? reject(err) : resolve()));
    await serialManager.delay(200);

    log(`[VOICE-RT] Enviando comando de discagem: ${dialCommand}`);
    await new Promise((resolve, reject) => {
      port.write(dialCommand, (err) => {
        if (err) return reject(err);
        port.drain(resolve);
      });
    });
    log(`[VOICE-RT] Aguardando atendimento...`);
    try {
      await this.waitForCallStatus('BEGIN', 45000);
      log('[VOICE-RT] Chamada atendida.');
      this.inCall = true;
    } catch (e) {
      error('[VOICE-RT] Falha ao estabelecer chamada:', e.message);
      this.inCall = false;
      throw e;
    }
  }

  async hangupCall() {
    log('[VOICE-RT] Desligando chamada...');
    this.inCall = false; // Mesmo que falhe, consideramos que não está mais em chamada ativa
    try {
      await atManager.send('AT+CHUP', 'OK');
      await this.waitForCallStatus('END', 10000).catch(() => log('[VOICE-RT] Timeout esperando confirmação de desligamento, mas continuando.'));
      log('[VOICE-RT] Chamada desligada via AT+CHUP.');
    } catch (e) {
      error('[VOICE-RT] Erro ao desligar chamada com AT+CHUP:', e.message, 'Tentando ATH...');
      try {
        await atManager.send('ATH', 'OK'); // Fallback para ATH
        await this.waitForCallStatus('END', 10000).catch(() => log('[VOICE-RT] Timeout esperando confirmação de ATH.'));
        log('[VOICE-RT] Chamada desligada via ATH.');
      } catch (e2) {
        error('[VOICE-RT] Erro ao desligar chamada com ATH:', e2.message);
      }
    }
  }

  waitForCallStatus(statusToWaitFor, timeout = 30000) {
    const { parser } = serialManager;
    if (!parser) return Promise.reject(new Error('Parser serial não inicializado'));

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Timeout aguardando CALL ${statusToWaitFor}`));
      }, timeout);

      const handler = (data) => {
        const str = data.toString().trim();
        if (!str) return;
        log(`[VOICE-RT STATUS] Modem data: ${str}`);

        if (statusToWaitFor === 'BEGIN') {
          if (str.includes('VOICE CALL: BEGIN') || str.includes('CONNECT') || str.includes('CIEV: "CALL",1')) {
            cleanup();
            resolve();
          } else if (str.includes('NO CARRIER') || str.includes('BUSY') || str.includes('NO ANSWER') || str.includes('ERROR')) {
            cleanup();
            reject(new Error(`Falha na chamada: ${str}`));
          }
        } else if (statusToWaitFor === 'END') {
          if (str.includes('VOICE CALL: END') || str.includes('NO CARRIER') || str.includes('CIEV: "CALL",0')) {
            cleanup();
            resolve();
          }
        }
      };

      function cleanup() {
        clearTimeout(timer);
        parser.off('data', handler);
      }
      parser.on('data', handler);
    });
  }

  initializeWebSocket() {
    if (!this.callDetails) {
      error('[VOICE-RT] Detalhes da chamada não definidos para iniciar WebSocket.');
      return Promise.reject(new Error('Detalhes da chamada não definidos.'));
    }
    const { instructions } = this.callDetails;
    const model = config.openai.realtimeModel || 'gpt-4o-realtime-preview-2024-12-17';
    // Assegurar que a API Key está configurada
    if (!config.openai.apiKey) {
        error('[VOICE-RT] OpenAI API Key não configurada!');
        return Promise.reject(new Error('OpenAI API Key não configurada.'));
    }

    const url = `wss://api.openai.com/v1/realtime?model=${model}`;
    log(`[VOICE-RT] Conectando ao WebSocket: ${url}`);

    this.ws = new WebSocket(url, {
      headers: {
        Authorization: `Bearer ${config.openai.apiKey}`,
        'OpenAI-Beta': 'realtime=v1',
      },
    });

    this.ws.on('open', () => {
      log('[VOICE-RT] WebSocket conectado.');
      // Configurar a sessão para áudio input/output
      // Formato de áudio: PCM, 16kHz, 16-bit, mono (s16le)
      const sessionUpdateEvent = {
        type: 'session.update',
        session: {
          input_audio_format: { encoding: 'pcm', sample_rate: 16000, bit_depth: 16, num_channels: 1 },
          output_audio_format: { encoding: 'pcm', sample_rate: 16000, bit_depth: 16, num_channels: 1, container: 'none' }, // 'none' para raw PCM
          // Habilitar VAD, mas não criar respostas automaticamente para termos mais controle
          turn_detection: {
            create_response: false, // Nós enviaremos response.create
            interrupt_response: true, // Permitir que a fala do usuário interrompa a IA
          }
        },
      };
      this.ws.send(JSON.stringify(sessionUpdateEvent));
      log('[VOICE-RT] Evento session.update enviado para configurar formatos de áudio e VAD.');

      // Enviar mensagem inicial para a IA falar primeiro
      const initialMessageEvent = {
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user', // "user" aqui é o nosso sistema iniciando a conversa
          content: [{ type: 'input_text', text: instructions || 'Olá, como posso ajudar?' }],
        },
      };
      this.ws.send(JSON.stringify(initialMessageEvent));
      log(`[VOICE-RT] Evento conversation.item.create enviado com instrução: "${instructions || 'Olá, como posso ajudar?'}"`);

      const createResponseEvent = {
        type: 'response.create',
        response: {
          modalities: ['audio'], // Apenas áudio por enquanto
        },
      };
      this.ws.send(JSON.stringify(createResponseEvent));
      log('[VOICE-RT] Evento response.create enviado para IA começar a falar.');

      this.startAudioStreaming();
    });

    this.ws.on('message', (data) => {
      this.handleWebSocketMessage(data);
    });

    this.ws.on('close', (code, reason) => {
      log(`[VOICE-RT] WebSocket desconectado: ${code} - ${reason ? reason.toString() : 'Sem motivo'}`);
      this.stopAudioStreaming();
      // Não desligar a chamada aqui automaticamente, pode ser um problema temporário de rede.
      // O desligamento da chamada principal deve cuidar disso.
    });

    this.ws.on('error', (err) => {
      error('[VOICE-RT] Erro no WebSocket:', err.message);
      this.stopAudioStreaming();
      // Considerar desligar a chamada se o WS falhar catastroficamente.
      if (this.inCall) {
        this.cleanupAndHangup().catch(e => error('[VOICE-RT] Erro no cleanup após erro de WS:', e.message));
      }
    });
  }

  handleWebSocketMessage(data) {
    let event;
    try {
      event = JSON.parse(data.toString());
    } catch (e) {
      error('[VOICE-RT] Erro ao parsear mensagem WebSocket:', e.message, data.toString());
      return;
    }

    // log(`[VOICE-RT] Evento WS recebido: ${event.type}`);

    switch (event.type) {
      case 'session.created':
        log('[VOICE-RT] Evento session.created recebido.');
        break;
      case 'session.updated':
        log('[VOICE-RT] Evento session.updated recebido:', JSON.stringify(event.session));
        break;
      case 'response.audio.delta':
        if (event.delta && this.aplayProcess && this.aplayProcess.stdin.writable) {
          // log('[VOICE-RT] Recebendo audio.delta, enviando para aplay.');
          this.aplayProcess.stdin.write(Buffer.from(event.delta, 'base64'));
        }
        break;
      case 'response.audio.done':
        log('[VOICE-RT] Evento response.audio.done recebido.');
        // Poderíamos fechar o stdin do aplay aqui se soubéssemos que é o fim absoluto,
        // mas a IA pode decidir falar mais após uma pausa.
        // O VAD e o response.create manual nos dão mais controle.
        break;
      case 'response.done':
        log('[VOICE-RT] Evento response.done recebido.');
        // Aqui a IA terminou sua "rodada" de fala.
        // Se quisermos que a conversa continue, precisaríamos que o input_audio_buffer.append
        // do cliente (arecord) enviasse áudio, e então outro response.create.
        // Por enquanto, como a conversa é unilateral (IA fala), não fazemos nada aqui.
        // Em um sistema bidirecional, aqui poderíamos reavaliar e talvez enviar um novo response.create
        // se o VAD do lado do cliente (input_audio_buffer.speech_stopped) tivesse sido acionado.
        break;
      case 'input_audio_buffer.speech_started':
        log('[VOICE-RT] Evento input_audio_buffer.speech_started (cliente falando).');
        break;
      case 'input_audio_buffer.speech_stopped':
        log('[VOICE-RT] Evento input_audio_buffer.speech_stopped (cliente parou de falar).');
        // Agora que o usuário parou de falar, pedimos para a IA responder.
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            const createResponseEvent = {
                type: 'response.create',
                response: { modalities: ['audio'] },
            };
            this.ws.send(JSON.stringify(createResponseEvent));
            log('[VOICE-RT] speech_stopped: Enviado response.create para IA responder.');
        }
        break;
      case 'error':
        error(`[VOICE-RT] Erro da API Realtime: ${event.message} (Code: ${event.code}, Event ID: ${event.event_id}`);
        // Se for um erro fatal, podemos querer desligar.
        if (event.code && (event.code.includes('auth') || event.code.includes('limit'))) {
            this.cleanupAndHangup().catch(e => error('[VOICE-RT] Erro no cleanup após erro da API:', e.message));
        }
        break;
      // Outros eventos podem ser logados ou tratados conforme necessário
      default:
        // log(`[VOICE-RT] Evento WS não tratado: ${event.type}`);
        break;
    }
  }

  startAudioStreaming() {
    log('[VOICE-RT] Iniciando streaming de áudio bidirecional (aplay e arecord).');
    // Iniciar aplay para tocar o áudio da OpenAI
    if (this.aplayProcess) {
      this.aplayProcess.kill();
    }
    this.aplayProcess = spawn('aplay', ['-D', APLAY_DEVICE, ...AUDIO_FORMAT_PARAMS_APLAY]);
    this.aplayProcess.on('error', (err) => error('[VOICE-RT] Erro no processo aplay:', err.message));
    this.aplayProcess.on('exit', (code, signal) => log(`[VOICE-RT] Processo aplay encerrado: ${code}, sinal: ${signal}`));
    // Não precisamos de stdout/stderr do aplay por enquanto, mas poderiam ser logados.

    // Iniciar arecord para capturar o áudio do cliente e enviar para OpenAI
    if (this.arecordProcess) {
      this.arecordProcess.kill();
    }
    this.arecordProcess = spawn('arecord', AUDIO_FORMAT_PARAMS_ARECORD);
    this.arecordProcess.on('error', (err) => error('[VOICE-RT] Erro no processo arecord:', err.message));
    this.arecordProcess.on('exit', (code, signal) => log(`[VOICE-RT] Processo arecord encerrado: ${code}, sinal: ${signal}`));
    
    this.arecordProcess.stdout.on('data', (chunk) => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        // log('[VOICE-RT] Enviando chunk de áudio do arecord para OpenAI.');
        const base64Audio = chunk.toString('base64');
        const appendEvent = {
          type: 'input_audio_buffer.append',
          audio: base64Audio,
        };
        this.ws.send(JSON.stringify(appendEvent));
      }
    });
    this.arecordProcess.stderr.on('data', (data) => {
        error(`[VOICE-RT] arecord stderr: ${data.toString().trim()}`);
    });
  }

  stopAudioStreaming() {
    log('[VOICE-RT] Parando streaming de áudio (aplay e arecord).');
    if (this.aplayProcess) {
      if (this.aplayProcess.stdin && this.aplayProcess.stdin.writable) {
        this.aplayProcess.stdin.end();
      }
      this.aplayProcess.kill('SIGTERM'); // Tentar terminar graciosamente
      setTimeout(() => { // Forçar se não terminar
        if (this.aplayProcess && !this.aplayProcess.killed) {
          this.aplayProcess.kill('SIGKILL');
        }
      }, 500);
      this.aplayProcess = null;
    }
    if (this.arecordProcess) {
      this.arecordProcess.kill('SIGTERM');
       setTimeout(() => {
        if (this.arecordProcess && !this.arecordProcess.killed) {
          this.arecordProcess.kill('SIGKILL');
        }
      }, 500);
      this.arecordProcess = null;
    }
  }
  
  async cleanupAndHangup() {
    log('[VOICE-RT] Limpando recursos e desligando chamada...');
    this.stopAudioStreaming();

    if (this.ws) {
      this.ws.removeAllListeners(); // Remover listeners para evitar chamadas após close
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.close(1000, 'Encerramento normal da chamada');
      }
      this.ws = null;
    }

    if (this.inCall) { // Apenas desligar se realmente achamos que está em chamada
      await this.hangupCall().catch(e => error('[VOICE-RT] Erro ao desligar chamada durante cleanup:', e.message));
    }
    this.inCall = false;
    this.callDetails = null;
    log('[VOICE-RT] Cleanup finalizado.');
  }

  /**
   * Processa a chamada em realtime
   */
  async processVoiceCall(message) {
    const { id, number, instructions, voice } = message; // voice não é usado atualmente pela API realtime para input
    this.callDetails = { id, number, instructions, voice }; // Armazenar para uso no WebSocket

    log(`[VOICE-RT] Processando chamada realtime ${id} para ${number}`);

    if (this.inCall) {
      error('[VOICE-RT] Outra chamada realtime já está em andamento. Adiando esta.');
      // Não retornar false, pois a fila de mensagens já lida com isso.
      // Lançar um erro fará com que a mensagem seja marcada como falha.
      // O ideal é que a fila não pegue esta msg se this.inCall for true.
      // Por ora, vamos apenas logar e deixar a chamada atual terminar.
      // Isso pode ser melhorado com um lock mais robusto no nível da fila ou do processador.
      return; // Simplesmente não processa se já estiver em chamada.
    }

    try {
      // 1. Estabelecer a chamada telefônica
      await this.makeCall(number); // this.inCall será true se bem sucedido

      // 2. Se a chamada foi atendida, iniciar WebSocket e streaming de áudio
      if (this.inCall) {
        await this.initializeWebSocket(); // Inicia WS, que por sua vez inicia o streaming de áudio
        log('[VOICE-RT] Chamada e WebSocket inicializados. Conversa em andamento...');
        // A chamada agora está "viva". O encerramento será tratado por eventos
        // (ex: NO CARRIER do modem, erro no WS, ou um futuro comando para encerrar a chamada).
        // Precisamos de uma forma de manter o processo "processVoiceCall" vivo
        // ou ter um monitoramento externo para quando a chamada realmente terminar.

        // Monitorar 'NO CARRIER' ou outros sinais de fim de chamada do modem
        // que não sejam parte do waitForCallStatus('END') normal do hangupCall.
        const { parser } = serialManager;
        if (parser) {
            const modemHangupHandler = (data) => {
                const str = data.toString().trim();
                if (str.includes('NO CARRIER') || str.includes('VOICE CALL: END')) {
                    log(`[VOICE-RT] Detectado fim de chamada pelo modem (${str}). Iniciando cleanup.`);
                    parser.off('data', modemHangupHandler); // Remover este listener
                    this.cleanupAndHangup().catch(e => error('[VOICE-RT] Erro no cleanup após modem hangup:', e.message));
                }
            };
            parser.on('data', modemHangupHandler);
            // Guardar referência para remover depois
            this.currentModemHangupHandler = modemHangupHandler;
        }

      } else {
        log('[VOICE-RT] Chamada não foi atendida ou falhou ao iniciar. Não iniciando WebSocket.');
        // Não precisa de cleanup específico aqui pois makeCall já trata falhas iniciais.
      }
    } catch (e) {
      error(`[VOICE-RT] Erro principal no processamento da chamada realtime ${id}:`, e.message, e.stack);
      await this.cleanupAndHangup(); // Garantir limpeza em caso de erro
      throw e; // Re-lançar para a fila de mensagens saber que falhou
    }
    // Não há um 'return true' explícito aqui, pois a chamada é de longa duração.
    // O método 'processVoiceCall' inicia a chamada e configura os handlers.
    // A conclusão da chamada (e da mensagem da fila) será quando cleanupAndHangup for chamado.
    // A fila precisa ser ajustada para entender que este tipo de job não termina imediatamente.
  }

  // Método para remover o listener de desligamento do modem se a chamada for encerrada por outra via.
  clearModemHangupListener() {
    if (this.currentModemHangupHandler && serialManager.parser) {
        serialManager.parser.off('data', this.currentModemHangupHandler);
        this.currentModemHangupHandler = null;
        log('[VOICE-RT] Listener de desligamento do modem removido.');
    }
  }
}

// Modificar o cleanupAndHangup para também limpar o listener
VoiceRealtimeProcessor.prototype.originalCleanupAndHangup = VoiceRealtimeProcessor.prototype.cleanupAndHangup;
VoiceRealtimeProcessor.prototype.cleanupAndHangup = async function() {
    this.clearModemHangupListener();
    // Chamar o método original
    return await this.originalCleanupAndHangup();
};

module.exports = new VoiceRealtimeProcessor(); 
const db = require('../db');
const config = require('../config');
const { log, error, warn } = require('../utils/logger');
const ttsGenerator = require('./ttsGenerator');
const atManager = require('../modem/commands');
const fs = require('fs');
const util = require('util');
const exec = util.promisify(require('child_process').exec);

/**
 * Processa uma tarefa de chamada de voz com TTS.
 * Isso passará por vários estados: gerar TTS, discar, reproduzir, desligar.
 * @param {object} callTask - A tarefa da fila do LowDB.
 */
async function handleVoiceCall(callTask) {
  log(`[VOICE] Handling voice call task ${callTask.id} for ${callTask.numberToCall}, status: ${callTask.status}`);

  try {
    switch (callTask.status) {
      case 'pending_tts_generation':
        await generateTTSForCall(callTask);
        break;
      case 'pending_dial':
        await dialNumberForCall(callTask);
        break;
      case 'call_connected':
        await playAudioForCall(callTask);
        break;
      case 'playback_complete':
      case 'playback_failed': // Tenta desligar mesmo se a reprodução falhar
        await finalizeCall(callTask);
        break;
      default:
        warn(`[VOICE] Unknown status for voice call task ${callTask.id}: ${callTask.status}`);
        // Marcar como falha para evitar loop infinito
        db.get('queue').find({ id: callTask.id }).assign({ status: 'unknown_status_error', error: `Unknown status: ${callTask.status}` }).write();
    }
  } catch (e) {
    error(`[VOICE] Critical error handling voice call task ${callTask.id} (status ${callTask.status}):`, e.message, e.stack);
    // Atualizar para um status de erro genérico na tarefa se não foi tratado especificamente
    const currentTaskState = db.get('queue').find({ id: callTask.id }).value();
    if (currentTaskState && !currentTaskState.status.includes('_failed') && currentTaskState.status !== 'unknown_status_error') {
        db.get('queue').find({ id: callTask.id }).assign({ status: 'processor_error', error: e.message, retries: (callTask.retries || 0) + 1 }).write();
    }
  }
}

async function generateTTSForCall(callTask) {
  try {
    log(`[VOICE] Task ${callTask.id}: Generating TTS for text: "${callTask.textToSpeak.substring(0,30)}..."`);
    const audioFilePath = await ttsGenerator.generateSpeech(callTask.textToSpeak, callTask.id);
    db.get('queue').find({ id: callTask.id }).assign({ status: 'pending_dial', audioFilePath, ttsGeneratedAt: new Date().toISOString() }).write();
    log(`[VOICE] Task ${callTask.id}: TTS generated, path: ${audioFilePath}. Status updated to pending_dial.`);
    // Não chamar a fila.process() aqui, ela vai pegar no próximo ciclo.
  } catch (e) {
    error(`[VOICE] Task ${callTask.id}: TTS generation failed.`, e.message);
    const retries = (callTask.retries || 0) + 1;
    const nextStatus = retries >= (config.modem.maxRetries || 3) ? 'tts_permanent_failed' : 'pending_tts_generation'; // Tenta novamente ou falha permanentemente
    db.get('queue').find({ id: callTask.id }).assign({ status: nextStatus, error: e.message, retries, lastAttemptAt: new Date().toISOString() }).write();
    if (nextStatus === 'tts_permanent_failed') {
        // Mover para uma coleção de falhas ou limpar
        warn(`[VOICE] Task ${callTask.id}: TTS generation failed permanently after ${retries} retries.`);
        // db.get('queue').remove({id: callTask.id}).write();
        // db.get('failed_voice_calls').push({...callTask, status: 'tts_permanent_failed', error: e.message}).write();
    }
  }
}

async function dialNumberForCall(callTask) {
  log(`[VOICE] Task ${callTask.id}: Attempting to dial ${callTask.numberToCall}`);
  try {
    // ATENÇÃO: A lógica de `atManager.dial` e a detecção de chamada atendida ("CALL BEGIN") é crucial.
    // Por enquanto, esta é uma implementação SIMPLIFICADA.
    // O ideal seria o atManager.dial retornar um status ou o SerialManager emitir um evento
    // quando a chamada for realmente conectada ou falhar.
    await atManager.dial(callTask.numberToCall);
    log(`[VOICE] Task ${callTask.id}: ATD command sent to ${callTask.numberToCall}. Modem is dialing.`);
    
    // SIMPLIFICAÇÃO: Assumimos que o modem precisa de um tempo para conectar
    // e que o SerialManager (ou URCs) atualizaria o status para 'call_connected' ou 'dial_failed'.
    // Aqui, vamos apenas logar e esperar que a fila pegue a tarefa em outro estado se o SerialManager o atualizar.
    // Se não houver um listener de URC robusto, a tarefa pode ficar presa em 'pending_dial'.
    // Para teste inicial, poderíamos artificialmente mudar o status após um delay,
    // mas isso não é para produção.
    // db.get('queue').find({ id: callTask.id }).assign({ status: 'dial_attempted' }).write();
    // A FILA VAI PEGAR ESTE ITEM NOVAMENTE. PRECISAMOS DE UM EVENTO EXTERNO OU TIMEOUT PARA MUDAR O STATUS
    // PARA 'call_connected' ou 'dial_failed'.
    // Por ora, vamos deixar em pending_dial. A detecção de CALL BEGIN no SerialManager é o próximo passo.
    // **PARA TESTE INICIAL SEM URCs DE CHAMADA:**
    // Comente a linha abaixo em produção. Este é um STUB para simular a chamada conectando após X segundos.
    // setTimeout(() => {
    //   log(`[VOICE STUB] Task ${callTask.id}: Simulating call connected.`);
    //   db.get('queue').find({ id: callTask.id, status: 'pending_dial' }) // Verifica se ainda está pendente
    //     .assign({ status: 'call_connected', callConnectedAt: new Date().toISOString() })
    //     .write();
    // }, 15000); // Simula 15s para atender

  } catch (e) {
    error(`[VOICE] Task ${callTask.id}: Dialing failed for ${callTask.numberToCall}.`, e.message);
    const retries = (callTask.retries || 0) + 1;
    const nextStatus = retries >= (config.modem.maxRetries || 3) ? 'dial_permanent_failed' : 'pending_dial';
    db.get('queue').find({ id: callTask.id }).assign({ status: nextStatus, error: e.message, retries, lastAttemptAt: new Date().toISOString() }).write();
     if (nextStatus === 'dial_permanent_failed') {
        warn(`[VOICE] Task ${callTask.id}: Dialing failed permanently after ${retries} retries.`);
    }
  }
}

async function playAudioForCall(callTask) {
  log(`[VOICE] Task ${callTask.id}: Call connected to ${callTask.numberToCall}. Attempting to play ${callTask.audioFilePath}`);
  try {
    const command = `aplay -D "${config.audioPlayback.device}" "${callTask.audioFilePath}"`;
    log(`[VOICE] Task ${callTask.id}: Executing aplay: ${command}`);
    
    // Adicionar timeout para o aplay
    const { stdout, stderr } = await exec(command, { timeout: config.audioPlayback.playbackTimeoutMs });
    
    if (stderr) {
      warn(`[VOICE] Task ${callTask.id}: aplay stderr:`, stderr);
    }
    log(`[VOICE] Task ${callTask.id}: aplay stdout (playback finished):`, stdout);
    db.get('queue').find({ id: callTask.id }).assign({ status: 'playback_complete', playbackFinishedAt: new Date().toISOString() }).write();
  } catch (e) {
    error(`[VOICE] Task ${callTask.id}: Audio playback failed for ${callTask.audioFilePath}.`, e.message, e.code, e.signal);
    // Mesmo se aplay falhar, tentaremos desligar a chamada. Status mudado para playback_failed.
    db.get('queue').find({ id: callTask.id }).assign({ status: 'playback_failed', error: e.message, lastAttemptAt: new Date().toISOString() }).write();
  }
}

async function finalizeCall(callTask) {
  log(`[VOICE] Task ${callTask.id}: Finalizing call. Original status: ${callTask.status}. Audio file: ${callTask.audioFilePath}`);
  try {
    log(`[VOICE] Task ${callTask.id}: Attempting to hang up call.`);
    await atManager.hangup();
    log(`[VOICE] Task ${callTask.id}: ATH command sent (hang up).`);
  } catch (e) {
    error(`[VOICE] Task ${callTask.id}: Error during hangup.`, e.message);
    // Continua para limpeza do áudio mesmo se o hangup falhar
  }

  if (callTask.audioFilePath) {
    try {
      log(`[VOICE] Task ${callTask.id}: Deleting temporary audio file ${callTask.audioFilePath}`);
      await fs.promises.unlink(callTask.audioFilePath);
      log(`[VOICE] Task ${callTask.id}: Temporary audio file deleted.`);
    } catch (e) {
      error(`[VOICE] Task ${callTask.id}: Failed to delete audio file ${callTask.audioFilePath}.`, e.message);
    }
  }

  // Mover para completados
  db.get('queue').remove({ id: callTask.id }).write();
  db.get('completed_voice_calls') // Ou 'sent' se quiser unificar
    .push({ 
        ...callTask, 
        finalStatus: callTask.status, // Preserva o status antes de finalizar (ex: playback_complete)
        status: 'call_completed', 
        completedAt: new Date().toISOString() 
    })
    .write();
  db.defaults({ completed_voice_calls: [] }).write(); // Garante que a coleção exista
  log(`[VOICE] Task ${callTask.id}: Call finalized and moved to completed_voice_calls.`);
}


module.exports = {
  handleVoiceCall,
}; 
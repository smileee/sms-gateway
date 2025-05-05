// src/config/queue.js
const { Queue, Worker } = require('bullmq');
const Redis = require('ioredis');
const { logger } = require('../utils/logger');

// Verifica se o sistema deve usar fila
const useQueue = process.env.USE_QUEUE === 'true';

let queueConfig = null;
let redisConfig = null;

if (useQueue) {
  redisConfig = {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT, 10) || 6379,
    password: process.env.REDIS_PASSWORD,
    maxRetriesPerRequest: null,
    enableReadyCheck: false
  };

  queueConfig = {
    connection: new Redis(redisConfig),
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 1000
      },
      removeOnComplete: 100,
      removeOnFail: 1000
    }
  };
}

// Configuração de logging
const enableQueueLogging = process.env.QUEUE_LOGGING === 'true';

function createQueue(name) {
  if (!useQueue) {
    // Retorna uma implementação mock da fila quando USE_QUEUE=false
    return {
      add: async (data) => {
        logger.info(`[MOCK QUEUE] Job would be added to queue ${name}`, { data });
        return { id: `mock-${Date.now()}` };
      },
      close: async () => {
        logger.info(`[MOCK QUEUE] Queue ${name} would be closed`);
      }
    };
  }

  const queue = new Queue(name, queueConfig);

  if (enableQueueLogging) {
    queue.on('waiting', (job) => {
      logger.info(`Job ${job.id} is waiting`, { queue: name });
    });

    queue.on('active', (job) => {
      logger.info(`Job ${job.id} is active`, { queue: name });
    });

    queue.on('completed', (job) => {
      logger.info(`Job ${job.id} completed`, { queue: name });
    });

    queue.on('failed', (job, err) => {
      logger.error(`Job ${job.id} failed`, { queue: name, error: err.message });
    });

    queue.on('stalled', (job) => {
      logger.warn(`Job ${job.id} stalled`, { queue: name });
    });
  }

  return queue;
}

function createWorker(name, processor) {
  if (!useQueue) {
    // Retorna uma implementação mock do worker quando USE_QUEUE=false
    return {
      on: () => {},
      close: async () => {
        logger.info(`[MOCK WORKER] Worker ${name} would be closed`);
      }
    };
  }

  const worker = new Worker(name, processor, queueConfig);

  if (enableQueueLogging) {
    worker.on('completed', (job) => {
      logger.info(`Worker completed job ${job.id}`, { queue: name });
    });

    worker.on('failed', (job, err) => {
      logger.error(`Worker failed job ${job.id}`, { queue: name, error: err.message });
    });

    worker.on('stalled', (job) => {
      logger.warn(`Worker stalled on job ${job.id}`, { queue: name });
    });
  }

  return worker;
}

module.exports = {
  createQueue,
  createWorker,
  queueConfig,
  useQueue
}; 
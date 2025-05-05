// src/utils/logger.js
const winston = require('winston');
const { format } = winston;
const { combine, timestamp, printf, colorize } = format;

// Custom format for our logs
const logFormat = printf(({ level, message, timestamp, ...metadata }) => {
  let msg = `${timestamp} [${level}] ${message}`;
  if (Object.keys(metadata).length > 0) {
    msg += ` ${JSON.stringify(metadata)}`;
  }
  return msg;
});

// Create the logger instance
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: combine(
    timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
    colorize(),
    logFormat
  ),
  transports: [
    new winston.transports.Console({
      format: combine(
        colorize(),
        logFormat
      )
    }),
    new winston.transports.File({ 
      filename: 'logs/error.log', 
      level: 'error',
      format: combine(
        timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
        logFormat
      )
    }),
    new winston.transports.File({ 
      filename: 'logs/combined.log',
      format: combine(
        timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
        logFormat
      )
    })
  ]
});

// Helper functions for different log levels
const log = (...args) => logger.info(args.join(' '));
const error = (...args) => logger.error(args.join(' '));
const warn = (...args) => logger.warn(args.join(' '));
const debug = (...args) => logger.debug(args.join(' '));

module.exports = {
  log,
  error,
  warn,
  debug,
  logger
}; 
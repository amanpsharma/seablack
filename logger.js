// Single pino logger instance shared across the app and pino-http middleware.
// In development we use pino-pretty for human-readable output (requires
// `npm install -D pino-pretty`), otherwise pino emits JSON which is what
// Render / Datadog / CloudWatch expect.

const pino = require('pino');

const isDev = process.env.NODE_ENV !== 'production';

const logger = pino({
  level: process.env.LOG_LEVEL || (isDev ? 'debug' : 'info'),
  // Strip secrets from logs — never log Authorization headers or tokens.
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      '*.token',
      '*.password',
      '*.secret',
    ],
    censor: '[REDACTED]',
  },
});

module.exports = logger;

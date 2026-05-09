require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const pinoHttp = require('pino-http');
const logger = require('./logger');

const app = express();

// Trust the first proxy (Render terminates TLS upstream) so req.ip is the real client.
app.set('trust proxy', 1);

// CORS — allowlist only in production. ALLOWED_ORIGINS=comma,separated,list.
// In development we accept all origins so Expo Go / local dev tools work freely.
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const isProduction = process.env.NODE_ENV === 'production';
app.use(
  cors({
    origin: (origin, cb) => {
      // No origin header → mobile app / curl / native client → allow
      if (!origin) return cb(null, true);
      if (!isProduction) return cb(null, true);
      if (allowedOrigins.length === 0) return cb(null, true);
      if (allowedOrigins.includes(origin)) return cb(null, true);
      return cb(new Error('CORS: origin not allowed'));
    },
    credentials: false,
  }),
);

app.use(express.json({ limit: '5mb' }));

// Structured request logging — searchable in production, pretty in dev.
app.use(
  pinoHttp({
    logger,
    serializers: {
      req: (req) => ({ method: req.method, url: req.url, userId: req.userId }),
      res: (res) => ({ statusCode: res.statusCode }),
    },
    customLogLevel: (_req, res, err) => {
      if (err) return 'error';
      if (res.statusCode >= 500) return 'error';
      if (res.statusCode >= 400) return 'warn';
      return 'info';
    },
  }),
);

// Global rate limit: 120 requests / minute per IP. Blocks credential-stuffing,
// userId enumeration, and brute force without affecting normal mobile usage.
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again in a minute.' },
});
app.use('/api/', apiLimiter);

// Stricter limit on bulk insert (SMS sync) to prevent dump-style abuse.
const bulkLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Bulk sync rate exceeded. Wait a minute and retry.' },
});
app.use('/api/transactions/bulk', bulkLimiter);

app.use('/api/transactions', require('./routes/transactions'));

app.get('/health', (_, res) => res.json({ status: 'ok' }));

// Express 5 error handler — catches body-parser errors and any next(err) calls
app.use((err, req, res, _next) => {
  logger.error({ err: err.message, stack: err.stack }, 'unhandled express error');
  res.status(err.status || err.statusCode || 500).json({ error: err.message });
});

const PORT = process.env.PORT || 3001;
const MONGO_URI = process.env.MONGO_URI;

if (!MONGO_URI) {
  logger.fatal('MONGO_URI is not set in .env — server cannot start');
  process.exit(1);
}

// Prevent unhandled Mongoose connection errors from crashing the process
mongoose.connection.on('error', (err) => {
  logger.error({ err: err.message }, 'mongoose connection error');
});

let server;

async function syncIndexesSafely() {
  try {
    const Transaction = require('./models/Transaction');
    await Transaction.syncIndexes();
    logger.info('indexes synced');
  } catch (err) {
    // A stale unique index conflict shouldn't crash the server — log loudly and continue
    logger.error(
      { err: err.message, code: err.code, codeName: err.codeName },
      'index sync failed — continuing anyway',
    );
  }
}

mongoose
  .connect(MONGO_URI)
  .then(async () => {
    logger.info('MongoDB connected');
    await syncIndexesSafely();
    server = app.listen(PORT, () => logger.info({ port: PORT }, 'server listening'));
  })
  .catch((err) => {
    logger.fatal({ err: err.message }, 'MongoDB connection failed');
    process.exit(1);
  });

// Graceful shutdown: close HTTP server first (stop accepting new requests), then
// drain Mongo connection. Forced exit after 10s so a wedged connection can't
// keep the process alive on Render's restart cycle.
async function shutdown(signal) {
  logger.info({ signal }, 'received shutdown signal');
  const force = setTimeout(() => {
    logger.error('shutdown took too long — forcing exit');
    process.exit(1);
  }, 10_000);
  force.unref();

  try {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
      logger.info('http server closed');
    }
    await mongoose.connection.close(false);
    logger.info('mongo connection closed');
    clearTimeout(force);
    process.exit(0);
  } catch (err) {
    logger.error({ err: err.message }, 'error during shutdown');
    process.exit(1);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('uncaughtException', (err) => {
  logger.fatal({ err: err.message, stack: err.stack }, 'uncaughtException');
  shutdown('uncaughtException');
});
process.on('unhandledRejection', (reason) => {
  logger.error({ reason: String(reason) }, 'unhandledRejection');
});

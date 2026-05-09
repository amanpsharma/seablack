require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const app = express();

// Trust the first proxy (Render terminates TLS upstream) so req.ip is the real client.
app.set('trust proxy', 1);

// CORS — restrict to known origins in production. ALLOWED_ORIGINS=comma,separated,list.
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
app.use(
  cors({
    origin: allowedOrigins.length > 0 ? allowedOrigins : true,
    credentials: false,
  })
);

app.use(express.json({ limit: '5mb' }));

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
  console.error('[Express Error]', err.message);
  res.status(err.status || err.statusCode || 500).json({ error: err.message });
});

const PORT = process.env.PORT || 3001;
const MONGO_URI = process.env.MONGO_URI;

if (!MONGO_URI) {
  console.error('MONGO_URI is not set in .env');
  process.exit(1);
}

// Prevent unhandled Mongoose connection errors from crashing the process
mongoose.connection.on('error', (err) => {
  console.error('[Mongoose] connection error:', err.message);
});

mongoose
  .connect(MONGO_URI)
  .then(async () => {
    console.log('MongoDB connected');

    // Sync indexes: drops stale indexes from old schema, creates new ones
    try {
      const Transaction = require('./models/Transaction');
      await Transaction.syncIndexes();
      console.log('Indexes synced');
    } catch (err) {
      console.error('[Index sync]', err.message);
    }

    app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
  })
  .catch((err) => {
    console.error('MongoDB connection error:', err.message);
    process.exit(1);
  });

const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema(
  {
    amount: { type: Number, required: true },
    recipient: { type: String, required: true },
    upiId: { type: String, default: '' },
    note: { type: String, default: '' },
    category: {
      type: String,
      enum: ['Food', 'Transport', 'Shopping', 'Bills', 'Entertainment', 'Health', 'Other'],
      default: 'Other',
    },
    source: {
      type: String,
      enum: ['sms', 'manual'],
      default: 'manual',
    },
    type: {
      type: String,
      enum: ['sent', 'received'],
      default: 'sent',
    },
    transactionId: { type: String, default: '' },
    paidAt: { type: Date, default: Date.now },
    // Unique fingerprint used to deduplicate SMS syncs (no default — sparse index skips missing)
    dedupeKey: { type: String },
  },
  { timestamps: true }
);

// Only index non-empty dedupeKeys — partialFilterExpression cannot be combined with sparse
transactionSchema.index(
  { dedupeKey: 1 },
  { unique: true, partialFilterExpression: { dedupeKey: { $exists: true, $gt: '' } } }
);

module.exports = mongoose.model('Transaction', transactionSchema);

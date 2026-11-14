const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema(
  {
    amount: { type: Number, required: true },
    recipient: { type: String, required: true },
    upiId: { type: String, default: '' },
    bank: { type: String, default: '' },
    note: { type: String, default: '' },
    // Free text: built-in names plus any the user creates. Validated in schemas.js.
    category: { type: String, default: 'Other', trim: true, maxlength: 30 },
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
    // Clerk user ID — every transaction belongs to one user
    userId: { type: String, index: true },
  },
  { timestamps: true },
);

// Compound index for fast querying per user and ordering by date
transactionSchema.index({ userId: 1, paidAt: -1 });

// Deduplicate transactions for a specific user based on deduplicaton key
transactionSchema.index(
  { userId: 1, dedupeKey: 1 },
  {
    unique: true,
    partialFilterExpression: { dedupeKey: { $exists: true, $gt: '' } },
  },
);

// We drop the old global dedupeKey index if it exists so we can use the compound one instead
module.exports = mongoose.model('Transaction', transactionSchema);

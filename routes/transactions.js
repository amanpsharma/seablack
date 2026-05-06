const express = require('express');
const router = express.Router();
const Transaction = require('../models/Transaction');

// GET all transactions (with optional filters)
router.get('/', async (req, res) => {
  try {
    const { category, source, type, from, to, limit = 50 } = req.query;
    const filter = {};
    if (category) filter.category = category;
    if (source) filter.source = source;
    if (type === 'sent') {
      // Old documents have no type field — treat them as 'sent' (all were debits before the field existed)
      filter.$or = [{ type: 'sent' }, { type: { $exists: false } }];
    } else if (type) {
      filter.type = type;
    }
    if (from || to) {
      filter.paidAt = {};
      if (from) filter.paidAt.$gte = new Date(from);
      if (to) filter.paidAt.$lte = new Date(to);
    }
    const parsedLimit = Math.min(Number(limit) || 50, 10000); // Increased max limit
    const transactions = await Transaction.find(filter)
      .sort({ paidAt: -1 })
      .limit(parsedLimit);
    res.json(transactions);
  } catch (err) {
    console.error('[GET /transactions]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET daily spending trend (last N days, sent only)
router.get('/trend', async (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days) || 30, 90);
    const since = new Date();
    since.setDate(since.getDate() - days + 1);
    since.setHours(0, 0, 0, 0);

    const result = await Transaction.aggregate([
      { $match: { paidAt: { $gte: since }, $or: [{ type: 'sent' }, { type: { $exists: false } }] } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$paidAt' } },
          total: { $sum: '$amount' },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]);
    res.json(result.map((r) => ({ date: r._id, total: r.total, count: r.count })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET summary stats
router.get('/stats', async (req, res) => {
  try {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const [totalThisMonth, totalAllTime, byCategory] = await Promise.all([
      Transaction.aggregate([
        { $match: { paidAt: { $gte: startOfMonth } } },
        { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } },
      ]),
      Transaction.aggregate([
        { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } },
      ]),
      Transaction.aggregate([
        { $match: { paidAt: { $gte: startOfMonth } } },
        { $group: { _id: '$category', total: { $sum: '$amount' }, count: { $sum: 1 } } },
        { $sort: { total: -1 } },
      ]),
    ]);

    res.json({
      thisMonth: totalThisMonth[0] || { total: 0, count: 0 },
      allTime: totalAllTime[0] || { total: 0, count: 0 },
      byCategory,
    });
  } catch (err) {
    console.error('[GET /stats]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST create transaction
router.post('/', async (req, res) => {
  try {
    const tx = new Transaction(req.body);
    await tx.save();
    res.status(201).json(tx);
  } catch (err) {
    console.error('[POST /transactions]', err.message);
    res.status(400).json({ error: err.message });
  }
});

// POST bulk upsert (SMS import — dedupeKey prevents duplicates on re-sync)
router.post('/bulk', async (req, res) => {
  try {
    const { transactions } = req.body;
    if (!Array.isArray(transactions) || transactions.length === 0) {
      return res.status(400).json({ error: 'transactions array required' });
    }

    // Filter out any transaction without a valid dedupeKey
    const valid = transactions.filter((tx) => tx.dedupeKey && tx.dedupeKey.trim());
    if (valid.length === 0) {
      return res.status(400).json({ error: 'No transactions with valid dedupeKey' });
    }

    const ops = valid.map((tx) => ({
      updateOne: {
        filter: { dedupeKey: tx.dedupeKey },
        update: { $setOnInsert: tx },
        upsert: true,
      },
    }));

    const result = await Transaction.bulkWrite(ops, { ordered: false });
    res.status(201).json({ inserted: result.upsertedCount ?? 0 });
  } catch (err) {
    console.error('[POST /bulk]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET single transaction by id
router.get('/:id', async (req, res) => {
  try {
    const tx = await Transaction.findById(req.params.id);
    if (!tx) return res.status(404).json({ error: 'Not found' });
    res.json(tx);
  } catch (err) {
    console.error('[GET /:id]', err.message);
    res.status(400).json({ error: err.message });
  }
});

// PATCH update a transaction (category, note, amount, recipient)
router.patch('/:id', async (req, res) => {
  try {
    const allowed = ['category', 'note', 'amount', 'recipient'];
    const update = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) update[key] = req.body[key];
    }
    const tx = await Transaction.findByIdAndUpdate(req.params.id, update, { new: true });
    if (!tx) return res.status(404).json({ error: 'Not found' });
    res.json(tx);
  } catch (err) {
    console.error('[PATCH /:id]', err.message);
    res.status(400).json({ error: err.message });
  }
});

// POST clear all SMS-synced transactions
router.post('/clear-sms', async (req, res) => {
  try {
    const result = await Transaction.deleteMany({ source: 'sms' });
    res.json({ deleted: result.deletedCount });
  } catch (err) {
    console.error('[POST /clear-sms]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE a single transaction by id
router.delete('/:id', async (req, res) => {
  try {
    await Transaction.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (err) {
    console.error('[DELETE /:id]', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

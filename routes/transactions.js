const express = require("express");
const router = express.Router();
const Transaction = require("../models/Transaction");
const requireAuth = require("../middleware/auth");
const {
  createTransactionSchema,
  updateTransactionSchema,
  bulkSchema,
  listQuerySchema,
  statsQuerySchema,
  trendQuerySchema,
  idParamSchema,
  validate,
} = require("../schemas");

// Every route requires a valid Clerk session
router.use(requireAuth);

// In-memory stats cache: key = `${userId}:${month||'current'}` → { data, expiresAt }.
// 30s TTL is short enough that users see fresh data after a few seconds, but
// long enough to cut Mongo aggregation load for users opening multiple screens
// in quick succession (home → insights → activity all hit /stats).
const STATS_TTL_MS = 30 * 1000;
const statsCache = new Map();

function statsCacheKey(userId, month) {
  return `${userId}:${month || 'current'}`;
}

function getCachedStats(userId, month) {
  const entry = statsCache.get(statsCacheKey(userId, month));
  if (entry && entry.expiresAt > Date.now()) return entry.data;
  return null;
}

function setCachedStats(userId, month, data) {
  statsCache.set(statsCacheKey(userId, month), {
    data,
    expiresAt: Date.now() + STATS_TTL_MS,
  });
}

// Drop every cache entry for this user — call on any write that affects stats
function invalidateUserStats(userId) {
  for (const key of statsCache.keys()) {
    if (key.startsWith(`${userId}:`)) statsCache.delete(key);
  }
}

// GET all transactions (with optional filters + pagination)
router.get("/", validate(listQuerySchema, 'query'), async (req, res) => {
  try {
    const { category, source, type, from, to, limit, skip, search } = req.query;

    const andConditions = [{ userId: req.userId }];
    if (category) andConditions.push({ category });
    if (source) andConditions.push({ source });
    if (type === "sent") {
      andConditions.push({ $or: [{ type: "sent" }, { type: { $exists: false } }] });
    } else if (type) {
      andConditions.push({ type });
    }
    if (from || to) {
      const paidAt = {};
      if (from) paidAt.$gte = new Date(from);
      if (to) paidAt.$lte = new Date(to);
      andConditions.push({ paidAt });
    }
    if (search && search.trim()) {
      // Escape regex special chars to prevent ReDoS / injection
      const safe = search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const rx = { $regex: safe, $options: "i" };
      andConditions.push({ $or: [{ recipient: rx }, { upiId: rx }, { note: rx }] });
    }

    const transactions = await Transaction.find({ $and: andConditions })
      .sort({ paidAt: -1 })
      .skip(skip)
      .limit(limit);
    res.json(transactions);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET daily spending trend (last N days, sent only)
router.get("/trend", validate(trendQuerySchema, 'query'), async (req, res) => {
  try {
    const days = req.query.days;
    const since = new Date();
    since.setDate(since.getDate() - days + 1);
    since.setHours(0, 0, 0, 0);

    const result = await Transaction.aggregate([
      {
        $match: {
          userId: req.userId,
          paidAt: { $gte: since },
          $or: [{ type: "sent" }, { type: { $exists: false } }],
        },
      },
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m-%d", date: "$paidAt" } },
          total: { $sum: "$amount" },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]);
    res.json(
      result.map((r) => ({ date: r._id, total: r.total, count: r.count })),
    );
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET summary stats (optional ?month=YYYY-MM for historical months)
router.get("/stats", validate(statsQuerySchema, 'query'), async (req, res) => {
  try {
    // Serve from cache when fresh (cuts 5 parallel aggregations to zero work)
    const cached = getCachedStats(req.userId, req.query.month);
    if (cached) {
      res.set('X-Cache', 'HIT');
      return res.json(cached);
    }
    res.set('X-Cache', 'MISS');

    const now = new Date();
    let year = now.getFullYear();
    let month = now.getMonth(); // 0-based

    if (req.query.month) {
      const parts = req.query.month.split("-");
      year = parseInt(parts[0]);
      month = parseInt(parts[1]) - 1;
    }

    const startOfMonth = new Date(year, month, 1);
    const endOfMonth = new Date(year, month + 1, 1);
    const startOfLastMonth = new Date(year, month - 1, 1);

    const isSent = { $or: [{ type: "sent" }, { type: { $exists: false } }] };
    const uid = { userId: req.userId };

    const [sentThisMonth, receivedThisMonth, totalLastMonth, totalAllTime, byCategory] = await Promise.all([
      Transaction.aggregate([
        { $match: { $and: [uid, { paidAt: { $gte: startOfMonth, $lt: endOfMonth } }, isSent] } },
        { $group: { _id: null, total: { $sum: "$amount" }, count: { $sum: 1 } } },
      ]),
      Transaction.aggregate([
        { $match: { $and: [uid, { paidAt: { $gte: startOfMonth, $lt: endOfMonth }, type: "received" }] } },
        { $group: { _id: null, total: { $sum: "$amount" }, count: { $sum: 1 } } },
      ]),
      Transaction.aggregate([
        { $match: { $and: [uid, { paidAt: { $gte: startOfLastMonth, $lt: startOfMonth } }, isSent] } },
        { $group: { _id: null, total: { $sum: "$amount" }, count: { $sum: 1 } } },
      ]),
      Transaction.aggregate([
        { $match: uid },
        { $group: { _id: null, total: { $sum: "$amount" }, count: { $sum: 1 } } },
      ]),
      Transaction.aggregate([
        { $match: { $and: [uid, { paidAt: { $gte: startOfMonth, $lt: endOfMonth } }, isSent] } },
        { $group: { _id: "$category", total: { $sum: "$amount" }, count: { $sum: 1 } } },
        { $sort: { total: -1 } },
      ]),
    ]);

    const sent = sentThisMonth[0] || { total: 0, count: 0 };
    const received = receivedThisMonth[0] || { total: 0, count: 0 };

    const payload = {
      thisMonth: {
        total: sent.total,
        count: sent.count,
        sent: sent.total,
        received: received.total,
        sentCount: sent.count,
        receivedCount: received.count,
      },
      lastMonth: totalLastMonth[0] || { total: 0, count: 0 },
      allTime: totalAllTime[0] || { total: 0, count: 0 },
      byCategory,
    };
    setCachedStats(req.userId, req.query.month, payload);
    res.json(payload);
  } catch (err) {
    console.error("[GET /stats]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST create transaction
router.post("/", validate(createTransactionSchema), async (req, res) => {
  try {
    const tx = new Transaction({ ...req.body, userId: req.userId });
    await tx.save();
    invalidateUserStats(req.userId);
    res.status(201).json(tx);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST bulk upsert (SMS import — dedupeKey prevents duplicates on re-sync)
router.post("/bulk", validate(bulkSchema), async (req, res) => {
  try {
    const { transactions } = req.body;

    const valid = transactions.filter(
      (tx) => tx.dedupeKey && tx.dedupeKey.trim(),
    );
    if (valid.length === 0) {
      return res.status(400).json({ error: "No transactions with valid dedupeKey" });
    }

    // Step 1: Claim orphaned transactions (synced before auth was added — no userId)
    const claimOps = valid.map((tx) => ({
      updateOne: {
        filter: { dedupeKey: tx.dedupeKey, userId: { $exists: false } },
        update: { $set: { userId: req.userId } },
      },
    }));
    const claimResult = await Transaction.bulkWrite(claimOps, { ordered: false });
    const claimedCount = claimResult.modifiedCount ?? 0;

    // Step 2: Upsert genuinely new transactions with this user's ID
    const insertOps = valid.map((tx) => ({
      updateOne: {
        filter: { dedupeKey: tx.dedupeKey, userId: req.userId },
        update: { $setOnInsert: { ...tx, userId: req.userId } },
        upsert: true,
      },
    }));

    const result = await Transaction.bulkWrite(insertOps, { ordered: false });
    const inserted = claimedCount + (result.upsertedCount ?? 0);
    if (inserted > 0) invalidateUserStats(req.userId);
    // Include claimed count so the client knows data became visible even when upsertedCount is 0
    res.status(201).json({ inserted });
  } catch (err) {
    console.error("[POST /bulk]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET total transaction count (current user only)
router.get("/count", async (req, res) => {
  try {
    const count = await Transaction.countDocuments({ userId: req.userId });
    res.json({ count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET monthly summary for last 12 months
router.get("/monthly", async (req, res) => {
  try {
    const now = new Date();
    const since = new Date(now.getFullYear(), now.getMonth() - 11, 1);
    const uid = { userId: req.userId };

    const [spending, receiving, topCats] = await Promise.all([
      Transaction.aggregate([
        { $match: { $and: [uid, { paidAt: { $gte: since } }, { $or: [{ type: "sent" }, { type: { $exists: false } }] }] } },
        { $group: {
          _id: { $dateToString: { format: "%Y-%m", date: "$paidAt" } },
          spent: { $sum: "$amount" },
          count: { $sum: 1 },
        }},
      ]),
      Transaction.aggregate([
        { $match: { $and: [uid, { paidAt: { $gte: since }, type: "received" }] } },
        { $group: {
          _id: { $dateToString: { format: "%Y-%m", date: "$paidAt" } },
          received: { $sum: "$amount" },
        }},
      ]),
      Transaction.aggregate([
        { $match: { $and: [uid, { paidAt: { $gte: since } }, { $or: [{ type: "sent" }, { type: { $exists: false } }] }] } },
        { $group: {
          _id: { month: { $dateToString: { format: "%Y-%m", date: "$paidAt" } }, category: "$category" },
          total: { $sum: "$amount" },
        }},
        { $sort: { total: -1 } },
        { $group: { _id: "$_id.month", topCategory: { $first: "$_id.category" } } },
      ]),
    ]);

    const spendMap = {};
    spending.forEach((s) => { spendMap[s._id] = { spent: s.spent, count: s.count }; });
    const receiveMap = {};
    receiving.forEach((r) => { receiveMap[r._id] = r.received; });
    const catMap = {};
    topCats.forEach((c) => { catMap[c._id] = c.topCategory; });

    const result = [];
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      result.push({
        month: key,
        spent: spendMap[key]?.spent ?? 0,
        received: receiveMap[key] ?? 0,
        count: spendMap[key]?.count ?? 0,
        topCategory: catMap[key] ?? null,
      });
    }
    res.json(result);
  } catch (err) {
    console.error("[GET /monthly]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET single transaction by id (must belong to this user)
router.get("/:id", validate(idParamSchema, 'params'), async (req, res) => {
  try {
    const tx = await Transaction.findOne({ _id: req.params.id, userId: req.userId });
    if (!tx) return res.status(404).json({ error: "Not found" });
    res.json(tx);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// PATCH update a transaction (must belong to this user)
router.patch(
  "/:id",
  validate(idParamSchema, 'params'),
  validate(updateTransactionSchema),
  async (req, res) => {
    try {
      const tx = await Transaction.findOneAndUpdate(
        { _id: req.params.id, userId: req.userId },
        req.body,
        { new: true },
      );
      if (!tx) return res.status(404).json({ error: "Not found" });
      invalidateUserStats(req.userId);
      res.json(tx);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  },
);

// POST clear all SMS-synced transactions for this user
router.post("/clear-sms", async (req, res) => {
  try {
    const result = await Transaction.deleteMany({ userId: req.userId, source: "sms" });
    if (result.deletedCount > 0) invalidateUserStats(req.userId);
    res.json({ deleted: result.deletedCount });
  } catch (err) {
    console.error("[POST /clear-sms]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE a single transaction (must belong to this user)
router.delete("/:id", validate(idParamSchema, 'params'), async (req, res) => {
  try {
    const tx = await Transaction.findOneAndDelete({ _id: req.params.id, userId: req.userId });
    if (!tx) return res.status(404).json({ error: "Not found" });
    invalidateUserStats(req.userId);
    res.json({ success: true });
  } catch (err) {
    console.error("[DELETE /:id]", err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

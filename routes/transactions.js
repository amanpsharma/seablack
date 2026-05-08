const express = require("express");
const router = express.Router();
const Transaction = require("../models/Transaction");
const requireAuth = require("../middleware/auth");

// Every route requires a valid Clerk session
router.use(requireAuth);

// GET all transactions (with optional filters + pagination)
router.get("/", async (req, res) => {
  try {
    const { category, source, type, from, to, limit = 50, skip = 0, search } = req.query;

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
      const rx = { $regex: search.trim(), $options: "i" };
      andConditions.push({ $or: [{ recipient: rx }, { upiId: rx }, { note: rx }] });
    }

    const filter = { $and: andConditions };
    const parsedLimit = Math.min(Number(limit) || 50, 200);
    const parsedSkip = Math.max(Number(skip) || 0, 0);

    const transactions = await Transaction.find(filter)
      .sort({ paidAt: -1 })
      .skip(parsedSkip)
      .limit(parsedLimit);
    res.json(transactions);
  } catch (err) {
    console.error("[GET /transactions]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET daily spending trend (last N days, sent only)
router.get("/trend", async (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days) || 30, 90);
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
router.get("/stats", async (req, res) => {
  try {
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

    res.json({
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
    });
  } catch (err) {
    console.error("[GET /stats]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST create transaction
router.post("/", async (req, res) => {
  try {
    const tx = new Transaction({ ...req.body, userId: req.userId });
    await tx.save();
    res.status(201).json(tx);
  } catch (err) {
    console.error("[POST /transactions]", err.message);
    res.status(400).json({ error: err.message });
  }
});

// POST bulk upsert (SMS import — dedupeKey prevents duplicates on re-sync)
router.post("/bulk", async (req, res) => {
  try {
    const { transactions } = req.body;
    if (!Array.isArray(transactions) || transactions.length === 0) {
      return res.status(400).json({ error: "transactions array required" });
    }

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
    // Include claimed count so the client knows data became visible even when upsertedCount is 0
    res.status(201).json({ inserted: claimedCount + (result.upsertedCount ?? 0) });
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
router.get("/:id", async (req, res) => {
  try {
    const tx = await Transaction.findOne({ _id: req.params.id, userId: req.userId });
    if (!tx) return res.status(404).json({ error: "Not found" });
    res.json(tx);
  } catch (err) {
    console.error("[GET /:id]", err.message);
    res.status(400).json({ error: err.message });
  }
});

// PATCH update a transaction (must belong to this user)
router.patch("/:id", async (req, res) => {
  try {
    const allowed = ["category", "note", "amount", "recipient"];
    const update = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) update[key] = req.body[key];
    }
    const tx = await Transaction.findOneAndUpdate(
      { _id: req.params.id, userId: req.userId },
      update,
      { new: true }
    );
    if (!tx) return res.status(404).json({ error: "Not found" });
    res.json(tx);
  } catch (err) {
    console.error("[PATCH /:id]", err.message);
    res.status(400).json({ error: err.message });
  }
});

// POST clear all SMS-synced transactions for this user
router.post("/clear-sms", async (req, res) => {
  try {
    const result = await Transaction.deleteMany({ userId: req.userId, source: "sms" });
    res.json({ deleted: result.deletedCount });
  } catch (err) {
    console.error("[POST /clear-sms]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE a single transaction (must belong to this user)
router.delete("/:id", async (req, res) => {
  try {
    const tx = await Transaction.findOneAndDelete({ _id: req.params.id, userId: req.userId });
    if (!tx) return res.status(404).json({ error: "Not found" });
    res.json({ success: true });
  } catch (err) {
    console.error("[DELETE /:id]", err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

// Zod schemas for request validation. Reject malformed bodies BEFORE they hit
// Mongoose (faster, clearer error messages, prevents prototype-pollution surface).

const { z } = require("zod");

const CATEGORIES = [
  "Food",
  "Transport",
  "Shopping",
  "Bills",
  "Entertainment",
  "Health",
  "Other",
];

const transactionBase = {
  amount: z.number().finite().positive().max(10_000_000), // 1 crore cap — sanity bound
  recipient: z.string().trim().min(1).max(200),
  upiId: z.string().trim().max(200).optional().default(""),
  bank: z.string().trim().max(50).optional().default(""),
  note: z.string().trim().max(2000).optional().default(""),
  category: z.enum(CATEGORIES).optional().default("Other"),
  source: z.enum(["sms", "manual"]).optional().default("manual"),
  type: z.enum(["sent", "received"]).optional().default("sent"),
  transactionId: z.string().trim().max(200).optional().default(""),
  paidAt: z.string().datetime().or(z.coerce.date()),
  dedupeKey: z.string().trim().max(500).optional(),
};

const createTransactionSchema = z.object(transactionBase).strict();

const updateTransactionSchema = z
  .object({
    amount: transactionBase.amount.optional(),
    recipient: transactionBase.recipient.optional(),
    upiId: transactionBase.upiId,
    bank: transactionBase.bank,
    type: transactionBase.type,
    note: transactionBase.note,
    category: transactionBase.category,
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, {
    message: "At least one field required",
  });

const bulkSchema = z.object({
  transactions: z.array(z.object(transactionBase).strict()).min(1).max(2000),
});

// Query string validators
const listQuerySchema = z.object({
  category: z.enum(CATEGORIES).optional(),
  source: z.enum(["sms", "manual"]).optional(),
  type: z.enum(["sent", "received"]).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(20000).optional().default(50),
  skip: z.coerce.number().int().min(0).optional().default(0),
  search: z.string().trim().max(200).optional(),
});

const statsQuerySchema = z.object({
  month: z
    .string()
    .regex(/^\d{4}-\d{2}$/, "month must be YYYY-MM")
    .optional(),
});

const trendQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).optional().default(30),
});

const idParamSchema = z.object({
  id: z.string().regex(/^[0-9a-fA-F]{24}$/, "invalid id"),
});

// Express middleware factory: validates a key on req (body|query|params) using
// the given schema and replaces it with the parsed/coerced result.
function validate(schema, key = "body") {
  return (req, res, next) => {
    const result = schema.safeParse(req[key]);
    if (!result.success) {
      const issue = result.error.issues[0];
      const path = issue.path.join(".") || key;
      return res
        .status(400)
        .json({ error: `Validation failed: ${path} — ${issue.message}` });
    }
    req[key] = result.data;
    next();
  };
}

module.exports = {
  createTransactionSchema,
  updateTransactionSchema,
  bulkSchema,
  listQuerySchema,
  statsQuerySchema,
  trendQuerySchema,
  idParamSchema,
  validate,
};

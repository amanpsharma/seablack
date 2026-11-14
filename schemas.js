// Zod schemas for request validation. Reject malformed bodies BEFORE they hit
// Mongoose (faster, clearer error messages, prevents prototype-pollution surface).

const { z } = require('zod');

// Categories are free text so users can create their own ("Rent", "Groceries").
// Letters, digits, spaces and a few joiners only — the value is shown in the UI
// and used as a grouping key.
const categoryName = z
  .string()
  .trim()
  .min(1)
  .max(30)
  .regex(/^[\p{L}\p{N}][\p{L}\p{M}\p{N} &\-/]*$/u, 'invalid category name');

const transactionBase = {
  amount: z.number().finite().positive().max(10_000_000), // 1 crore cap — sanity bound
  recipient: z.string().trim().min(1).max(200),
  upiId: z.string().trim().max(200).optional().default(''),
  bank: z.string().trim().max(50).optional().default(''),
  note: z.string().trim().max(2000).optional().default(''),
  category: categoryName.optional().default('Other'),
  source: z.enum(['sms', 'manual']).optional().default('manual'),
  type: z.enum(['sent', 'received']).optional().default('sent'),
  transactionId: z.string().trim().max(200).optional().default(''),
  paidAt: z.string().datetime().or(z.coerce.date()),
  dedupeKey: z.string().trim().max(500).optional(),
};

const createTransactionSchema = z.object(transactionBase).strict();

// PATCH only touches the fields the client actually sent. These are declared
// WITHOUT the create-time defaults above — reusing those made a PATCH of just
// { category } also reset note/bank/upiId to '' and type to 'sent'.
const updateTransactionSchema = z
  .object({
    amount: z.number().finite().positive().max(10_000_000).optional(),
    recipient: z.string().trim().min(1).max(200).optional(),
    upiId: z.string().trim().max(200).optional(),
    bank: z.string().trim().max(50).optional(),
    note: z.string().trim().max(2000).optional(),
    category: categoryName.optional(),
    type: z.enum(['sent', 'received']).optional(),
  })
  .strict()
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: 'At least one field required',
  });

const bulkSchema = z.object({
  transactions: z.array(z.object(transactionBase).strict()).min(1).max(2000),
});

// Move many transactions to one category at once: either everything paid to a
// given payee ("always categorise X as Y"), or an explicit list of ids.
const recategorizeSchema = z
  .object({
    category: categoryName,
    recipient: z.string().trim().min(1).max(200).optional(),
    ids: z
      .array(z.string().regex(/^[0-9a-fA-F]{24}$/, 'invalid id'))
      .min(1)
      .max(1000)
      .optional(),
  })
  .strict()
  .refine((v) => !!v.recipient !== !!v.ids, { message: 'Send either recipient or ids' });

// Query string validators
const listQuerySchema = z.object({
  category: categoryName.optional(),
  source: z.enum(['sms', 'manual']).optional(),
  type: z.enum(['sent', 'received']).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(20000).optional().default(50),
  skip: z.coerce.number().int().min(0).optional().default(0),
  search: z.string().trim().max(200).optional(),
});

const statsQuerySchema = z.object({
  month: z
    .string()
    .regex(/^\d{4}-\d{2}$/, 'month must be YYYY-MM')
    .optional(),
});

const trendQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).optional().default(30),
});

const idParamSchema = z.object({
  id: z.string().regex(/^[0-9a-fA-F]{24}$/, 'invalid id'),
});

// Express middleware factory: validates a key on req (body|query|params) using
// the given schema and replaces it with the parsed/coerced result.
function validate(schema, key = 'body') {
  return (req, res, next) => {
    const result = schema.safeParse(req[key]);
    if (!result.success) {
      const issue = result.error.issues[0];
      const path = issue.path.join('.') || key;
      return res.status(400).json({ error: `Validation failed: ${path} — ${issue.message}` });
    }
    req[key] = result.data;
    next();
  };
}

module.exports = {
  createTransactionSchema,
  updateTransactionSchema,
  bulkSchema,
  recategorizeSchema,
  listQuerySchema,
  statsQuerySchema,
  trendQuerySchema,
  idParamSchema,
  validate,
};

// Run with: npm test   (node's built-in runner — no extra dependencies)
process.env.CLERK_ISSUER = 'https://example.clerk.accounts.dev';
process.env.APP_TIMEZONE = 'Asia/Kolkata';
process.env.LOG_LEVEL = 'silent';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  updateTransactionSchema,
  createTransactionSchema,
  recategorizeSchema,
} = require('../schemas');
const { zonedMidnight, zonedToday } = require('../timezone');
const requireAuth = require('../middleware/auth');

test('PATCH schema only returns the fields that were sent', () => {
  const r = updateTransactionSchema.safeParse({ category: 'Food' });
  assert.deepEqual(r.data, { category: 'Food' });
});

test('PATCH schema rejects an empty body and unknown fields', () => {
  assert.equal(updateTransactionSchema.safeParse({}).success, false);
  assert.equal(updateTransactionSchema.safeParse({ userId: 'someone-else' }).success, false);
});

test('create schema still applies defaults', () => {
  const r = createTransactionSchema.safeParse({
    amount: 10,
    recipient: 'A',
    paidAt: '2026-11-10T09:15:00.000Z',
  });
  assert.equal(r.data.category, 'Other');
  assert.equal(r.data.type, 'sent');
});

test('categories are free text but restricted to safe characters', () => {
  const ok = (category) => updateTransactionSchema.safeParse({ category }).success;
  assert.equal(ok('Rent'), true);
  assert.equal(ok('Kids & School'), true);
  assert.equal(ok('किराया'), true);
  assert.equal(ok(''), false);
  assert.equal(ok('$where'), false);
  assert.equal(ok('x'.repeat(31)), false);
});

test('recategorize needs exactly one of recipient or ids', () => {
  const id = 'a'.repeat(24);
  const ok = (body) => recategorizeSchema.safeParse(body).success;
  assert.equal(ok({ category: 'Food', recipient: 'Swiggy' }), true);
  assert.equal(ok({ category: 'Food', ids: [id] }), true);
  assert.equal(ok({ category: 'Food' }), false);
  assert.equal(ok({ category: 'Food', recipient: 'Swiggy', ids: [id] }), false);
  assert.equal(ok({ category: 'Food', ids: ['not-an-id'] }), false);
});

test('month boundaries are IST midnight, not UTC', () => {
  assert.equal(zonedMidnight(2026, 10, 1).toISOString(), '2026-10-31T18:30:00.000Z');
  // month overflow / underflow roll the year
  assert.equal(zonedMidnight(2026, 12, 1).toISOString(), '2026-12-31T18:30:00.000Z');
  assert.equal(zonedMidnight(2026, -1, 1).toISOString(), '2025-11-30T18:30:00.000Z');
});

test('"today" follows IST: 20:00 UTC on 31 Oct is already 1 Nov', () => {
  assert.deepEqual(zonedToday(new Date('2026-10-31T20:00:00Z')), { year: 2026, month: 10, day: 1 });
});

function callAuth(token) {
  return new Promise((resolve) => {
    const req = { headers: token ? { authorization: `Bearer ${token}` } : {} };
    const res = { status: (code) => ({ json: (body) => resolve({ code, body }) }) };
    requireAuth(req, res, () => resolve({ code: 200, userId: req.userId }));
  });
}
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

test('auth rejects a token from an issuer that merely looks like Clerk', async () => {
  // Would previously have made the server fetch signing keys from the attacker
  const forged = `${b64({ alg: 'RS256', kid: 'k' })}.${b64({
    iss: 'https://clerk.attacker.example',
    sub: 'user_victim',
    exp: 9e9,
  })}.sig`;
  const r = await callAuth(forged);
  assert.equal(r.code, 401);
  assert.deepEqual(r.body, { error: 'Unauthorized' }); // no internal reason leaked
});

test('auth rejects missing and malformed tokens', async () => {
  assert.equal((await callAuth(null)).code, 401);
  assert.equal((await callAuth('not-a-jwt')).code, 401);
});

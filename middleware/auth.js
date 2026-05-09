// Auth middleware. Cryptographically verifies the Clerk JWT signature using
// Clerk's public JWKs (fetched on first call, cached internally by @clerk/backend).
// X-User-Id is no longer accepted — only signed JWTs prevent userId spoofing.

const { verifyToken } = require('@clerk/backend');

const SECRET_KEY = process.env.CLERK_SECRET_KEY;
if (!SECRET_KEY) {
  console.error('[Auth] CLERK_SECRET_KEY is not set — all requests will be rejected.');
}

module.exports = async function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization || req.headers.Authorization;
    if (
      !authHeader ||
      typeof authHeader !== 'string' ||
      !authHeader.toLowerCase().startsWith('bearer ')
    ) {
      return res.status(401).json({ error: 'Unauthorized: Missing Bearer token' });
    }

    const token = authHeader.substring(7).trim();
    if (!token) {
      return res.status(401).json({ error: 'Unauthorized: Empty token' });
    }

    // Verify signature against Clerk's JWKs and validate exp/nbf
    const payload = await verifyToken(token, { secretKey: SECRET_KEY });

    if (!payload?.sub) {
      return res.status(401).json({ error: 'Unauthorized: Token missing sub claim' });
    }

    req.userId = payload.sub;
    next();
  } catch (err) {
    console.error('[Auth] verifyToken failed:', err?.message ?? err);
    return res.status(401).json({ error: 'Unauthorized: Invalid or expired token' });
  }
};

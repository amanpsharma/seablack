// Auth middleware. Cryptographically verifies the Clerk JWT signature.
// X-User-Id is no longer accepted — only signed JWTs prevent userId spoofing.
//
// JWKs resolution priority:
//   1. CLERK_JWT_KEY (PEM public key) — offline verification, no network call
//   2. CLERK_SECRET_KEY + CLERK_PUBLISHABLE_KEY — standard SDK flow with JWKs fetch

const { verifyToken } = require('@clerk/backend');

const SECRET_KEY = process.env.CLERK_SECRET_KEY;
const PUBLISHABLE_KEY = process.env.CLERK_PUBLISHABLE_KEY;
const JWT_KEY = process.env.CLERK_JWT_KEY; // Optional PEM public key

if (!SECRET_KEY && !JWT_KEY) {
  console.error(
    '[Auth] Neither CLERK_SECRET_KEY nor CLERK_JWT_KEY is set — all requests will be rejected.',
  );
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

    // Verify signature and validate exp/nbf.
    // jwtKey (if provided) skips the JWKs network fetch entirely.
    // Otherwise we fall back to fetching JWKs via secretKey + publishableKey.
    const payload = await verifyToken(token, {
      ...(JWT_KEY ? { jwtKey: JWT_KEY } : {}),
      ...(SECRET_KEY ? { secretKey: SECRET_KEY } : {}),
      ...(PUBLISHABLE_KEY ? { publishableKey: PUBLISHABLE_KEY } : {}),
      clockSkewInMs: 10_000,
    });

    if (!payload?.sub) {
      return res.status(401).json({ error: 'Unauthorized: Token missing sub claim' });
    }

    req.userId = payload.sub;
    next();
  } catch (err) {
    // Detailed logging so we can diagnose verification failures from Render logs
    console.error(
      '[Auth] verifyToken failed:',
      'reason=', err?.reason ?? 'unknown',
      'message=', err?.message ?? String(err),
    );
    // Surface the specific reason to the client so they know if it's expired vs invalid
    const reason = err?.reason || err?.message || 'invalid';
    return res
      .status(401)
      .json({ error: `Unauthorized: ${reason}` });
  }
};

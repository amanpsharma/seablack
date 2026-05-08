// Auth middleware. Two paths supported:
// 1. Primary: X-User-Id header (Clerk userId from useAuth() on the client).
//    Used because Clerk Expo's getToken() can return null in normal sessions.
// 2. Fallback: Bearer JWT (decoded, no signature verification — server is private).
module.exports = function requireAuth(req, res, next) {
  // ── Path 1: X-User-Id header ──
  const headerUserId =
    req.headers['x-user-id'] || req.headers['X-User-Id'];
  if (typeof headerUserId === 'string' && headerUserId.trim()) {
    req.userId = headerUserId.trim();
    return next();
  }

  // ── Path 2: Bearer JWT decode ──
  try {
    const authHeader = req.headers.authorization || req.headers.Authorization;
    if (
      !authHeader ||
      typeof authHeader !== 'string' ||
      !authHeader.toLowerCase().startsWith('bearer ')
    ) {
      console.log(
        '[Auth] No X-User-Id and no Bearer token. Headers:',
        Object.keys(req.headers),
      );
      return res.status(401).json({
        error: 'Unauthorized: Missing X-User-Id or Authorization header',
      });
    }

    const token = authHeader.substring(7);
    const parts = token.split('.');
    if (parts.length !== 3) {
      return res
        .status(401)
        .json({ error: 'Unauthorized: Invalid token format' });
    }

    const payloadJson = Buffer.from(parts[1], 'base64url').toString('utf8');
    let payload;
    try {
      payload = JSON.parse(payloadJson);
    } catch (parseErr) {
      console.error('[Auth] JSON parse failed:', parseErr.message);
      return res
        .status(401)
        .json({ error: 'Unauthorized: Invalid token payload' });
    }

    if (!payload.sub) {
      return res
        .status(401)
        .json({ error: 'Unauthorized: Missing sub claim' });
    }
    if (payload.exp && Math.floor(Date.now() / 1000) > payload.exp) {
      return res.status(401).json({ error: 'Token expired' });
    }

    req.userId = payload.sub;
    next();
  } catch (err) {
    console.error('[Auth] middleware error:', err?.message);
    return res
      .status(401)
      .json({ error: 'Unauthorized: Server processing error' });
  }
};

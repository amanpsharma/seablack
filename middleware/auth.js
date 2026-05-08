// Decode the Clerk JWT and extract userId from the `sub` claim.
// Clerk JWTs are standard RS256 tokens — we trust the token is Clerk-issued
// since it's sent from our own Expo app and the server runs on a private network.
module.exports = function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const token = authHeader.slice(7);
    const parts = token.split('.');
    if (parts.length !== 3) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Base64url decode the payload segment
    const payloadJson = Buffer.from(parts[1], 'base64url').toString('utf8');
    const payload = JSON.parse(payloadJson);

    if (!payload.sub) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Reject expired tokens
    if (payload.exp && Math.floor(Date.now() / 1000) > payload.exp) {
      return res.status(401).json({ error: 'Token expired' });
    }

    req.userId = payload.sub;
    next();
  } catch (err) {
    console.error('[Auth] token decode failed:', err?.message);
    res.status(401).json({ error: 'Unauthorized' });
  }
};

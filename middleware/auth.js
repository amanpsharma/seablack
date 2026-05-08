const { verifyToken } = require('@clerk/backend');

const SECRET_KEY = process.env.CLERK_SECRET_KEY;

module.exports = async function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const token = authHeader.slice(7);
    const payload = await verifyToken(token, { secretKey: SECRET_KEY });
    req.userId = payload.sub;
    next();
  } catch (err) {
    console.error('[Auth] verifyToken failed:', err?.message ?? err);
    res.status(401).json({ error: 'Unauthorized' });
  }
};

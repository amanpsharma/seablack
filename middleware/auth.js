const { createClerkClient } = require('@clerk/backend');

const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });

module.exports = async function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const token = authHeader.slice(7);
    const payload = await clerk.verifyToken(token);
    req.userId = payload.sub;
    next();
  } catch {
    res.status(401).json({ error: 'Unauthorized' });
  }
};

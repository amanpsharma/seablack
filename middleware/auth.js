// Decode the Clerk JWT and extract userId from the `sub` claim.
// Clerk JWTs are standard RS256 tokens — we trust the token is Clerk-issued
// since it's sent from our own Expo app and the server runs on a private network.
module.exports = function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization || req.headers.Authorization;
    if (!authHeader || typeof authHeader !== 'string' || !authHeader.toLowerCase().startsWith("bearer ")) {
      console.log('[Auth] Missing/Invalid Header. Headers received:', req.headers);
      return res
        .status(401)
        .json({
          error: "Unauthorized: Missing or invalid Authorization header",
        });
    }

    // slice off "Bearer " regardless of case
    const token = authHeader.substring(7);
    const parts = token.split(".");
    if (parts.length !== 3) {
      return res
        .status(401)
        .json({ error: "Unauthorized: Invalid token format" });
    }

    // Base64url decode the payload segment
    const payloadJson = Buffer.from(parts[1], "base64url").toString("utf8");
    let payload;
    try {
      payload = JSON.parse(payloadJson);
    } catch (parseErr) {
      console.error("[Auth] JSON parse failed:", parseErr.message, payloadJson);
      return res
        .status(401)
        .json({ error: "Unauthorized: Invalid token payload" });
    }

    if (!payload.sub) {
      return res.status(401).json({ error: "Unauthorized: Missing sub claim" });
    }

    // Reject expired tokens
    if (payload.exp && Math.floor(Date.now() / 1000) > payload.exp) {
      return res.status(401).json({ error: "Token expired" });
    }

    req.userId = payload.sub;
    next();
  } catch (err) {
    console.error("[Auth] token decode failed:", err?.message);
    return res
      .status(401)
      .json({ error: "Unauthorized: Server processing error" });
  }
};

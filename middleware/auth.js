// Auth middleware. Verifies the Clerk JWT signature manually using Node's
// built-in crypto module. We fetch JWKs directly from the issuer URL embedded
// in the token rather than relying on @clerk/backend (which has been observed
// to throw "jwk-failed-to-resolve" without explicit env-var setup).
//
// Cryptographically secure: spoofed userIds are rejected because the signature
// must verify against Clerk's published public key.
//
// The issuer is PINNED to CLERK_ISSUER. We must never fetch keys from whatever
// URL the token itself names — anyone can host a JWKS and sign their own tokens.

const crypto = require('crypto');
const logger = require('../logger');

// Comma-separated so a dev and a production Clerk instance can both be trusted
// during a migration. Compared exactly (trailing slash ignored).
const normalizeIssuer = (s) => s.trim().replace(/\/+$/, '');
const TRUSTED_ISSUERS = new Set(
  (process.env.CLERK_ISSUER || '').split(',').map(normalizeIssuer).filter(Boolean),
);

// In-memory JWKs cache: { issuer: { keys: { kid: publicKey }, expiresAt } }
const jwksCache = new Map();
const JWKS_TTL_MS = 60 * 60 * 1000; // 1 hour

function b64urlDecode(s) {
  return Buffer.from(s, 'base64url');
}

function parseToken(token) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('malformed-token');
  const header = JSON.parse(b64urlDecode(parts[0]).toString('utf8'));
  const payload = JSON.parse(b64urlDecode(parts[1]).toString('utf8'));
  const signingInput = `${parts[0]}.${parts[1]}`;
  const signature = b64urlDecode(parts[2]);
  return { header, payload, signingInput, signature };
}

async function fetchJwks(issuer) {
  const cached = jwksCache.get(issuer);
  if (cached && cached.expiresAt > Date.now()) return cached.keys;

  const url = `${issuer}/.well-known/jwks.json`;
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) {
    throw new Error(`jwks-fetch-failed: ${res.status} ${url}`);
  }
  const data = await res.json();
  if (!Array.isArray(data?.keys)) {
    throw new Error('jwks-malformed-response');
  }

  const keys = {};
  for (const jwk of data.keys) {
    if (jwk.kid) {
      try {
        keys[jwk.kid] = crypto.createPublicKey({ key: jwk, format: 'jwk' });
      } catch {
        // skip keys we can't import
      }
    }
  }

  jwksCache.set(issuer, { keys, expiresAt: Date.now() + JWKS_TTL_MS });
  return keys;
}

function nodeAlgFor(jwtAlg) {
  // Map JWT alg → Node.js verify algorithm name
  switch (jwtAlg) {
    case 'RS256':
      return 'RSA-SHA256';
    default:
      throw new Error(`unsupported-alg: ${jwtAlg}`);
  }
}

async function verifyClerkJwt(token, opts = {}) {
  const clockSkewSec = Math.floor((opts.clockSkewMs ?? 10_000) / 1000);
  const { header, payload, signingInput, signature } = parseToken(token);

  if (!header.kid) throw new Error('missing-kid');
  if (!payload.iss) throw new Error('missing-iss');

  // Only accept tokens from our own Clerk instance — exact match, not a pattern
  const issuer = typeof payload.iss === 'string' ? normalizeIssuer(payload.iss) : '';
  if (!TRUSTED_ISSUERS.has(issuer)) {
    throw new Error('untrusted-issuer');
  }

  const keys = await fetchJwks(issuer);
  const publicKey = keys[header.kid];
  if (!publicKey) throw new Error(`unknown-kid: ${header.kid}`);

  const verifier = crypto.createVerify(nodeAlgFor(header.alg));
  verifier.update(signingInput);
  const valid = verifier.verify(publicKey, signature);
  if (!valid) throw new Error('invalid-signature');

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number') throw new Error('missing-exp');
  if (now > payload.exp + clockSkewSec) throw new Error('token-expired');
  if (payload.nbf && now < payload.nbf - clockSkewSec) throw new Error('token-not-active-yet');

  return payload;
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

    const payload = await verifyClerkJwt(token);
    if (!payload?.sub) {
      return res.status(401).json({ error: 'Unauthorized: Token missing sub claim' });
    }

    req.userId = payload.sub;
    next();
  } catch (err) {
    // Log the reason server-side only; the client just needs to know it's a 401
    logger.warn({ reason: err?.message ?? String(err) }, 'auth verification failed');
    return res.status(401).json({ error: 'Unauthorized' });
  }
};

/**
 * tokens.js — issue and verify login tokens (JWT).
 *
 * After a user verifies their phone, we hand them a signed token. They send
 * it on later requests as:  Authorization: Bearer <token>
 * The server verifies the signature to trust "this request is user X".
 *
 * Security choices (deliberate):
 *  - The signing secret comes from JWT_SECRET in .env — never hardcoded.
 *  - We PIN the algorithm to HS256 on both sign and verify. Not pinning it
 *    is a known JWT vulnerability (an attacker can force the 'none' algo).
 *  - Tokens expire. A leaked token is only useful until it does.
 *  - The payload holds only the user id and role — never anything sensitive.
 */
'use strict';

const jwt = require('jsonwebtoken');

const ALGO = 'HS256';
const TOKEN_TTL = '30d'; // riders stay logged in a month; tune later

function getSecret() {
  const s = process.env.JWT_SECRET;
  if (!s || s.length < 32) {
    throw new Error(
      'JWT_SECRET missing or too short. Set a long random value in .env ' +
      '(at least 32 characters).'
    );
  }
  return s;
}

/** Issue a token for a user. `role` is 'rider' or 'driver'. */
function issueToken(userId, role) {
  return jwt.sign({ sub: userId, role }, getSecret(), {
    algorithm: ALGO,
    expiresIn: TOKEN_TTL,
  });
}

/**
 * Verify a token string. Returns { valid, payload, reason }.
 * Never throws — callers get a clean result to branch on.
 */
function verifyToken(token) {
  if (!token || typeof token !== 'string') {
    return { valid: false, payload: null, reason: 'no_token' };
  }
  try {
    const payload = jwt.verify(token, getSecret(), { algorithms: [ALGO] });
    return { valid: true, payload, reason: null };
  } catch (err) {
    // err.name is 'TokenExpiredError' or 'JsonWebTokenError'
    const reason = err.name === 'TokenExpiredError' ? 'expired' : 'invalid';
    return { valid: false, payload: null, reason };
  }
}

/**
 * Express middleware: require a valid token. On success attaches
 * req.user = { id, role } and calls next(); otherwise responds 401.
 */
function requireAuth(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const result = verifyToken(token);
  if (!result.valid) {
    return res.status(401).json({ error: 'unauthorized', reason: result.reason });
  }
  req.user = { id: result.payload.sub, role: result.payload.role };
  next();
}

module.exports = { issueToken, verifyToken, requireAuth, ALGO, TOKEN_TTL };

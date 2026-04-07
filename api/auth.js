// Admin authentication
//
// Reads ADMIN_USERNAME, ADMIN_PASSWORD, and JWT_SECRET from env vars.
// No defaults — if any of these are missing, login is disabled and
// admin endpoints return 503. This is intentional: we never want to
// ship with hardcoded credentials.

import jwt from 'jsonwebtoken';
import { timingSafeEqual } from 'crypto';

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const JWT_SECRET = process.env.JWT_SECRET || '';
const TOKEN_TTL = '7d';

export const authConfigured = !!(ADMIN_USERNAME && ADMIN_PASSWORD && JWT_SECRET);

if (!authConfigured) {
  console.warn(
    '[auth] admin auth NOT configured — set ADMIN_USERNAME, ADMIN_PASSWORD, and JWT_SECRET env vars to enable'
  );
} else {
  console.log('[auth] admin auth configured for user:', ADMIN_USERNAME);
}

// Constant-time string compare to avoid timing-attack leaks on the
// username/password fields.
function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) {
    // Still do a compare to keep timing roughly constant
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

export function verifyCredentials(username, password) {
  if (!authConfigured) return false;
  // Compare both fields even if username is wrong, so timing doesn't
  // reveal which one was off.
  const userOk = safeEqual(username, ADMIN_USERNAME);
  const passOk = safeEqual(password, ADMIN_PASSWORD);
  return userOk && passOk;
}

export function issueToken(username) {
  return jwt.sign({ sub: username, role: 'admin' }, JWT_SECRET, {
    expiresIn: TOKEN_TTL,
  });
}

export function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

// Express middleware: rejects requests without a valid bearer token.
export function requireAdmin(req, res, next) {
  if (!authConfigured) {
    return res.status(503).json({ error: 'Admin auth not configured on server' });
  }
  const header = req.headers.authorization || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return res.status(401).json({ error: 'Missing bearer token' });
  }
  const claims = verifyToken(match[1]);
  if (!claims || claims.role !== 'admin') {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
  req.admin = claims;
  next();
}

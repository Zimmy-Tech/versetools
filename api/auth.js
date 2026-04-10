// Admin authentication
//
// Reads ADMIN_USERNAME, ADMIN_PASSWORD, JWT_SECRET, and TOTP_SECRET from env vars.
// No defaults — if any of the first three are missing, login is disabled and
// admin endpoints return 503. This is intentional: we never want to
// ship with hardcoded credentials.
//
// TOTP_SECRET is optional during initial setup — use the /api/admin/totp/setup
// endpoint to generate one. Once set, login requires a valid 6-digit TOTP code.

import jwt from 'jsonwebtoken';
import { timingSafeEqual } from 'crypto';
import { TOTP, Secret } from 'otpauth';

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const JWT_SECRET = process.env.JWT_SECRET || '';
const TOTP_SECRET = process.env.TOTP_SECRET || '';
const TOKEN_TTL = '24h';

export const authConfigured = !!(ADMIN_USERNAME && ADMIN_PASSWORD && JWT_SECRET);
export const totpConfigured = !!TOTP_SECRET;

if (!authConfigured) {
  console.warn(
    '[auth] admin auth NOT configured — set ADMIN_USERNAME, ADMIN_PASSWORD, and JWT_SECRET env vars to enable'
  );
} else {
  console.log('[auth] admin auth configured for user:', ADMIN_USERNAME);
  if (totpConfigured) {
    console.log('[auth] TOTP 2FA enabled');
  } else {
    console.warn('[auth] TOTP 2FA NOT configured — set TOTP_SECRET env var or use /api/admin/totp/setup');
  }
}

// ─── Constant-time comparison ────────────────────────────────────────

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) {
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

// ─── Credential verification ─────────────────────────────────────────

export function verifyCredentials(username, password) {
  if (!authConfigured) return false;
  const userOk = safeEqual(username, ADMIN_USERNAME);
  const passOk = safeEqual(password, ADMIN_PASSWORD);
  return userOk && passOk;
}

// ─── TOTP verification ──────────────────────────────────────────────

function getTotpInstance(secret) {
  return new TOTP({
    issuer: 'VerseTools',
    label: ADMIN_USERNAME || 'admin',
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: Secret.fromBase32(secret),
  });
}

export function verifyTotp(code) {
  if (!totpConfigured) return true; // skip if not configured
  if (!code) return false;
  const totp = getTotpInstance(TOTP_SECRET);
  // window: 1 allows ±30 seconds of clock skew
  const delta = totp.validate({ token: String(code).trim(), window: 1 });
  return delta !== null;
}

/**
 * Generate a new TOTP secret and return the provisioning URI for QR scanning.
 * Only works when TOTP is NOT already configured (prevents re-generation).
 */
export function generateTotpSetup() {
  const secret = new Secret({ size: 20 });
  const totp = new TOTP({
    issuer: 'VerseTools',
    label: ADMIN_USERNAME || 'admin',
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret,
  });
  return {
    secret: secret.base32,
    uri: totp.toString(),
  };
}

// ─── JWT ─────────────────────────────────────────────────────────────

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

// ─── Rate limiting ───────────────────────────────────────────────────
// In-memory rate limiter for login attempts. Max 5 attempts per 15 minutes
// per IP. Sufficient for a single-admin tool.

const LOGIN_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const LOGIN_MAX_ATTEMPTS = 5;
const loginAttempts = new Map(); // ip → { count, firstAttempt }

// Periodic cleanup of expired entries
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of loginAttempts) {
    if (now - entry.firstAttempt > LOGIN_WINDOW_MS) {
      loginAttempts.delete(ip);
    }
  }
}, LOGIN_WINDOW_MS);

/**
 * Check if an IP is rate-limited. Returns { allowed, retryAfterSec }.
 * Call recordAttempt() after a failed login.
 */
export function checkRateLimit(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || now - entry.firstAttempt > LOGIN_WINDOW_MS) {
    return { allowed: true, retryAfterSec: 0 };
  }
  if (entry.count >= LOGIN_MAX_ATTEMPTS) {
    const retryAfterSec = Math.ceil((LOGIN_WINDOW_MS - (now - entry.firstAttempt)) / 1000);
    return { allowed: false, retryAfterSec };
  }
  return { allowed: true, retryAfterSec: 0 };
}

export function recordFailedAttempt(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || now - entry.firstAttempt > LOGIN_WINDOW_MS) {
    loginAttempts.set(ip, { count: 1, firstAttempt: now });
  } else {
    entry.count++;
  }
}

export function clearRateLimit(ip) {
  loginAttempts.delete(ip);
}

// ─── Express middleware ──────────────────────────────────────────────

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

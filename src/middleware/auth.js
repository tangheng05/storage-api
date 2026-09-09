const crypto = require('crypto');
const config = require('../config');

// Constant-time string comparison so secret checks don't leak match length
// or prefix via response timing.
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// Reads the dedicated header or "Authorization: Bearer <token>".
function extractProvidedKey(req) {
  const headerKey = req.headers[config.UPLOAD_KEY_HEADER];
  if (headerKey) return headerKey;

  const authHeader = req.headers.authorization;
  if (authHeader) {
    const parts = authHeader.split(' ');
    return parts.length === 2 ? parts[1] : parts[0];
  }
  return null;
}

// Single shared master key; only trusted server-to-server callers hold this.
function isAuthorized(req) {
  return safeEqual(extractProvidedKey(req), config.UPLOAD_API_KEY);
}

// Per-upload scoped token (src/tus.js onUploadCreate): lets a browser PATCH
// chunks / poll status without ever holding the master key.
function matchesUploadToken(req, token) {
  return Boolean(token) && safeEqual(extractProvidedKey(req), token);
}

function requireUploadKey(req, res, next) {
  if (!isAuthorized(req)) {
    return res.status(401).json({ error: 'Invalid or missing upload key' });
  }
  return next();
}

// Operator routes take their own key, not the upload key: the upload key is
// held by the main API, CI and every .env copy, and should not let its holder
// approve held content or write the blocklist. Unset means off (503).
function requireModerationKey(req, res, next) {
  if (!config.MODERATION_API_KEY) {
    return res.status(503).json({ error: 'Moderation is not configured' });
  }
  if (!safeEqual(extractProvidedKey(req), config.MODERATION_API_KEY)) {
    return res.status(401).json({ error: 'Invalid or missing moderation key' });
  }
  return next();
}

module.exports = {
  isAuthorized, matchesUploadToken, requireUploadKey, requireModerationKey, safeEqual,
};

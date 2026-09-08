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

// Reads whatever key/token the caller sent, from either the dedicated header
// or "Authorization: Bearer <token>" — shared by both the master-key check
// and the per-upload scoped-token check below.
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

// Single shared master key. Only trusted server-to-server callers (e.g. the
// frontend's own backend) should ever hold this.
function isAuthorized(req) {
  return safeEqual(extractProvidedKey(req), config.UPLOAD_API_KEY);
}

// Per-upload scoped token (see src/tus.js onUploadCreate): lets a browser
// PATCH chunks / poll status for the single upload it created, without ever
// holding the master key.
function matchesUploadToken(req, token) {
  return Boolean(token) && safeEqual(extractProvidedKey(req), token);
}

function requireUploadKey(req, res, next) {
  if (!isAuthorized(req)) {
    return res.status(401).json({ error: 'Invalid or missing upload key' });
  }
  return next();
}

/*
| Operator routes take their own key, not the upload key.
|
| The upload key is held by serey-api, CI and every copy of .env — it is not a
| credential that should let its holder approve held content or write the
| blocklist. Unset means the feature is off (503), because NPM forwards
| /moderation straight to the app and there is no network-level restriction in
| front of it.
*/
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

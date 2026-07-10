const config = require('../config');

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
  return extractProvidedKey(req) === config.UPLOAD_API_KEY;
}

// Per-upload scoped token (see src/tus.js onUploadCreate): lets a browser
// PATCH chunks directly to a single upload it created, without ever holding
// the master key.
function matchesUploadToken(req, token) {
  return Boolean(token) && extractProvidedKey(req) === token;
}

function requireUploadKey(req, res, next) {
  if (!isAuthorized(req)) {
    return res.status(401).json({ error: 'Invalid or missing upload key' });
  }
  return next();
}

module.exports = { isAuthorized, matchesUploadToken, requireUploadKey };

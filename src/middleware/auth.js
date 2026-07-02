const config = require('../config');

// Single shared upload key. Any client holding the key may upload.
// Accepts either the dedicated header or "Authorization: Bearer <key>".
function isAuthorized(req) {
  const headerKey = req.headers[config.UPLOAD_KEY_HEADER];
  if (headerKey && headerKey === config.UPLOAD_API_KEY) return true;

  const authHeader = req.headers.authorization;
  if (authHeader) {
    const parts = authHeader.split(' ');
    const token = parts.length === 2 ? parts[1] : parts[0];
    if (token === config.UPLOAD_API_KEY) return true;
  }
  return false;
}

function requireUploadKey(req, res, next) {
  if (!isAuthorized(req)) {
    return res.status(401).json({ error: 'Invalid or missing upload key' });
  }
  return next();
}

module.exports = { isAuthorized, requireUploadKey };

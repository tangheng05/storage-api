const crypto = require('crypto');

const config = require('../config');

// Private objects are delivered through /media/... only to a caller holding a
// valid signature, minted by the main API. It covers the object path AND the
// expiry, so neither can be edited without invalidating it -- a leaked URL
// stops working once `exp` passes.

// Keep this format in sync with the main API's utils/premium_util.js signMediaUrl().
const payload = (object_path, exp) => `${object_path}|${exp}`;

const sign = (object_path, exp) =>
  crypto
    .createHmac('sha256', config.MEDIA_SIGNING_SECRET)
    .update(payload(object_path, exp))
    .digest('hex');

const safeEqual = (a, b) => {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
};

/**
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
const verify = ({ object_path, exp, sig }) => {
  if (!config.MEDIA_SIGNING_SECRET) {
    // Fail closed: without a secret every signature is forgeable.
    return { ok: false, reason: 'signing_not_configured' };
  }

  if (!exp || !sig) {
    return { ok: false, reason: 'missing_signature' };
  }

  const expires_at = Number(exp);
  if (!Number.isFinite(expires_at)) {
    return { ok: false, reason: 'bad_expiry' };
  }

  // Expiry checked before the HMAC: cheap test first, and both should reject.
  if (expires_at * 1000 < Date.now()) {
    return { ok: false, reason: 'expired' };
  }

  if (!safeEqual(sig, sign(object_path, expires_at))) {
    return { ok: false, reason: 'bad_signature' };
  }

  return { ok: true };
};

module.exports = { sign, verify };

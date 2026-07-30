const crypto = require('crypto');

const config = require('../config');

/*
|--------------------------------------------------------------------------
| Signed media URLs
|--------------------------------------------------------------------------
|
| Private objects are delivered through /media/... and only to a caller holding
| a valid signature. serey-api mints these: it is the service that knows who
| paid, and it shares MEDIA_SIGNING_SECRET with us, so no extra round trip is
| needed and this service never has to understand memberships.
|
| The signature covers the object path AND the expiry, so neither can be edited
| without invalidating it. A leaked URL stops working once `exp` passes, which
| is the whole point: it turns "anyone with the link, forever" into "anyone with
| the link, for the next few minutes".
|
*/

// Same string on both sides. Keep this format in sync with serey-api's
// utils/premium_util.js signMediaUrl().
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
    // Fail closed. Without a secret every signature would be forgeable, so a
    // misconfigured deploy must serve nothing rather than serve everything.
    return { ok: false, reason: 'signing_not_configured' };
  }

  if (!exp || !sig) {
    return { ok: false, reason: 'missing_signature' };
  }

  const expires_at = Number(exp);
  if (!Number.isFinite(expires_at)) {
    return { ok: false, reason: 'bad_expiry' };
  }

  // Expiry first: an expired-but-valid link and a forged one should both be
  // rejected, and checking this before the HMAC keeps the cheap test first.
  if (expires_at * 1000 < Date.now()) {
    return { ok: false, reason: 'expired' };
  }

  if (!safeEqual(sig, sign(object_path, expires_at))) {
    return { ok: false, reason: 'bad_signature' };
  }

  return { ok: true };
};

module.exports = { sign, verify };

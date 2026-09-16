const config = require('../config');
const logger = require('./logger');

/*
| Purges deleted media from Cloudflare.
|
| Deleting the bytes is not enough: the edge keeps serving its copy until the
| entry expires, which on this deployment was about a day. For a takedown that
| is the difference between "removed" and "removed eventually".
|
| Never throws. The bytes are already gone by the time this runs, so a purge
| failure is a reason to shout, not to fail the delete.
*/

const API = 'https://api.cloudflare.com/client/v4/zones';

// Cloudflare's own limit for a single purge_cache call.
const MAX_FILES = 30;

function enabled() {
  return !!config.CLOUDFLARE_ZONE_ID && !!config.CLOUDFLARE_PURGE_TOKEN;
}

// Only absolute http(s) URLs; Cloudflare rejects anything else and a relative
// path here would mean a caller passed a local disk path by mistake.
const usable = (url) => typeof url === 'string' && /^https?:\/\//.test(url);

async function purge(urls = []) {
  const files = [...new Set(urls.filter(usable))];
  if (!files.length) return 'nothing-to-purge';
  if (!enabled()) return 'not-configured';
  if (files.length > MAX_FILES) files.length = MAX_FILES;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), config.CDN_PURGE_TIMEOUT_MS);
  try {
    const res = await fetch(`${API}/${config.CLOUDFLARE_ZONE_ID}/purge_cache`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.CLOUDFLARE_PURGE_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ files }),
      signal: ac.signal,
    });

    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.success === false) {
      // Cloudflare reports failures in the body with a 200, so the status
      // alone would call a rejected purge a success.
      const reason = (body.errors || []).map((e) => e.message).join('; ')
        || `status ${res.status}`;
      logger.error({ files, reason }, 'CDN PURGE FAILED, deleted media is still served from cache');
      return 'failed';
    }

    logger.info({ files }, 'purged from the CDN');
    return 'purged';
  } catch (err) {
    const reason = err.name === 'AbortError' ? 'timed out' : err.message;
    logger.error({ files, reason }, 'CDN PURGE FAILED, deleted media is still served from cache');
    return 'failed';
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { purge, enabled };

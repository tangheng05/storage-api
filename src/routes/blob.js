const express = require('express');
const config = require('../config');
const s5blob = require('../services/s5blob');
const logger = require('../services/logger');

const router = express.Router();

// Public, read-only view of S5's blob store -- unauthenticated by design,
// since node.dart signs this URL and broadcasts it for fetch-by-CID. Safe
// because S5 only ever receives public media; a CID is the permission, and
// media.js refuses the public-to-premium flip. The `1/` prefix is fixed below,
// so this can't be pointed at another key even if the bucket is shared.

// No dot, no slash: a name can't walk out of the prefix. Length kept as a
// range so a future hash length fails loudly upstream, not as a silent 404.
const NAME_RE = /^[A-Za-z0-9_-]{40,64}(\.obao)?$/;

router.all('/1/:name', async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!s5blob.enabled()) return res.status(404).json({ error: 'Not found' });
  if (!NAME_RE.test(req.params.name || '')) {
    return res.status(400).json({ error: 'Invalid blob reference' });
  }

  const key = `1/${req.params.name}`;

  let object;
  try {
    object = await s5blob.getObject({ key, range: req.headers.range });
  } catch (err) {
    logger.error({ key, err: err.message }, 's5 blob read failed');
    return res.status(502).json({ error: 'Upstream unavailable' });
  }
  if (!object) return res.status(404).json({ error: 'Not found' });

  // The name *is* the hash of the bytes, so caching forever is safe -- every
  // consumer verifies against that hash anyway.
  res.set('Cache-Control', `public, max-age=${config.S5_BLOB_CACHE_SEC}, immutable`);
  res.set('Content-Type', 'application/octet-stream');
  // S5 reads large blobs in 256KB windows and rejects anything but 200 or 206.
  res.set('Accept-Ranges', 'bytes');
  if (object.contentRange) res.set('Content-Range', object.contentRange);
  if (object.bytes != null) res.set('Content-Length', String(object.bytes));
  res.status(object.contentRange ? 206 : 200);

  if (req.method === 'HEAD') {
    object.body?.destroy?.();
    return res.end();
  }

  object.body.on('error', (err) => {
    logger.error({ key, err: err.message }, 's5 blob stream failed');
    res.destroy();
  });
  return object.body.pipe(res);
});

module.exports = router;

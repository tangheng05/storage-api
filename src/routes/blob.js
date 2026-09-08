const express = require('express');
const config = require('../config');
const s5blob = require('../services/s5blob');
const logger = require('../services/logger');

const router = express.Router();

/*
| Public, read-only view of S5's blob store. It is how the S5 node reads its own
| blobs back out of s3d, and the only address by which anyone else can.
|
| S5 builds a read URL as `<cdnUrl><key>`, where the key is always `1/<hash>`,
| and derives the outboard's URL by appending `.obao` to that same string
| (lib5, StorageLocation.outboardBytesUrl falls back to `parts[0] + '.obao'`
| when a location carries one part, which is what the cdnUrls branch returns).
| Both land here, which is why this serves one shape of path and not two.
|
| Unauthenticated by design: node.dart signs this URL and broadcasts it to
| peers, so it is precisely what makes fetch-by-CID work for someone who is not
| us. Safe because of what the store holds — S5 only ever receives public media.
| A CID is the permission, so mirror.js keeps premium on s3d or local disk and
| media.js refuses the public-to-premium flip. The `1/` prefix below is fixed in
| the route, so this can never be pointed at another key even if the bucket is
| shared with the premium mirror.
*/

// A 33-byte BLAKE3 multihash in base64url is exactly 44 characters and needs no
// padding. Kept as a range so a future hash length fails loudly upstream rather
// than turning every blob into a silent 404 here. The character class is what
// matters: no dot and no slash means a name cannot walk out of the prefix.
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

  // The name *is* the hash of the bytes, so a stale response is not a thing
  // that can exist. Every consumer verifies against that hash anyway, which is
  // what keeps this door from being able to lie about what is behind it.
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

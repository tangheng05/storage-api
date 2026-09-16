const express = require('express');
const { Readable } = require('stream');
const config = require('../config');
const resolve = require('../services/resolve');
const arweave = require('../services/arweave');
const logger = require('../services/logger');

const router = express.Router();

// Resolves a stable ULID URL to S5's CID and proxies the bytes -- keeps the
// backend swappable instead of freezing a raw CID into post rows, and lets a
// deleted job stop the URL resolving. Proxied rather than redirected: the
// node's download route requires the bearer token, which an anonymous
// redirect target would not have.
//
// Which backend holds the bytes is decided by services/resolve.js, shared with
// routes/archive.js so an export can never disagree with what the CDN serves.

router.all('/:kind/:file', async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Private media goes through /media with a signature; answering here would
  // be a paywall bypass, so allowPrivate stays off.
  const found = await resolve.locate({ kind: req.params.kind, file: req.params.file });
  if (!found.ok) {
    return res
      .status(found.status)
      .json({ error: found.status === 400 ? 'Invalid media reference' : 'Not found' });
  }

  if (!found.cid) {
    // Not `immutable`: unlike content-addressed bytes, this mapping ends when
    // the job is deleted.
    res.set('Cache-Control', `public, max-age=${config.MEDIA_CDN_CACHE_SEC}`);
    if (req.method === 'HEAD') {
      res.set('Content-Type', found.contentType);
      res.set('Accept-Ranges', 'bytes');
      const bytes = await resolve.size(found);
      if (bytes !== null) res.set('Content-Length', String(bytes));
      return res.end();
    }
    return res.sendFile(found.localPath);
  }

  let opened;
  try {
    opened = await resolve.open(found, { range: req.headers.range });
  } catch (err) {
    logger.error(
      { id: found.id, kind: found.kind, cid: found.cid, err: err.message },
      'cdn fetch from s5 failed',
    );
    // Forever media has a second copy. Only on failure, never as the primary:
    // public gateways throttle video, and the redirect must not be cached.
    // Main file only -- the thumbnail has no copy there, and the video's id
    // would hand an <img> an MP4.
    if (found.kind !== 'thumbnails' && found.job && found.job.arweave_id) {
      res.set('Cache-Control', 'no-store');
      return res.redirect(302, arweave.gatewayUrl(found.job.arweave_id));
    }
    return res.status(502).json({ error: 'Upstream unavailable' });
  }

  const { upstream } = opened;

  // Not `immutable`, even though the bytes are content-addressed: that tells a
  // cache never to revalidate, so a takedown would keep being served for the
  // whole TTL by anything already holding the response. The bytes cannot
  // change; whether we still serve them can.
  res.set('Cache-Control', `public, max-age=${config.MEDIA_CDN_CACHE_SEC}`);
  res.set('Content-Type', found.contentType);
  res.set('Accept-Ranges', 'bytes');
  for (const h of ['content-length', 'content-range']) {
    const v = upstream.headers.get(h);
    if (v) res.set(h, v);
  }
  res.status(upstream.status === 206 ? 206 : 200);

  if (req.method === 'HEAD' || !upstream.body) {
    if (upstream.body) await upstream.body.cancel().catch(() => {});
    return res.end();
  }
  return Readable.fromWeb(upstream.body).pipe(res);
});

module.exports = router;

const express = require('express');
const path = require('path');
const { Readable } = require('stream');
const config = require('../config');
const jobs = require('../services/jobs');
const s5 = require('../services/s5');
const logger = require('../services/logger');
const fsp = require('fs/promises');
const { exists } = require('../utils/fs');

const router = express.Router();

// Resolves a stable ULID URL to S5's CID and proxies the bytes -- keeps the
// backend swappable instead of freezing a raw CID into post rows, and lets a
// deleted job stop the URL resolving. Proxied rather than redirected: the
// node's download route requires the bearer token, which an anonymous
// redirect target would not have.

const KINDS = ['videos', 'audio', 'images', 'thumbnails'];

// Public dirs only; a private main file is refused before this is consulted.
const LOCAL_DIRS = {
  videos: config.VIDEOS_DIR,
  audio: config.AUDIO_DIR,
  images: config.IMAGES_DIR,
  thumbnails: config.THUMBS_DIR,
};

const CONTENT_TYPES = {
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpeg': 'image/jpeg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.m4a': 'audio/mp4',
  '.jpg': 'image/jpeg',
};

// Anchored; extension holds no dot or slash, so a filename can't walk out of its namespace.
const FILE_RE = /^([0-9A-HJKMNP-TV-Z]{26})(\.[A-Za-z0-9]{1,5})$/;

router.all('/:kind/:file', async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const { kind } = req.params;
  if (!KINDS.includes(kind)) return res.status(404).json({ error: 'Not found' });

  const match = FILE_RE.exec(req.params.file || '');
  if (!match) return res.status(400).json({ error: 'Invalid media reference' });
  const id = match[1];

  let job;
  try {
    job = await jobs.get(id);
  } catch {
    return res.status(400).json({ error: 'Invalid media reference' });
  }

  // Same response whether deleted or never-existed, so this can't probe which ids are real.
  if (!job || job.state !== 'ready') return res.status(404).json({ error: 'Not found' });

  // Premium goes through /media with a signature; answering here would be a
  // paywall bypass. Thumbnails are exempt -- published public by design, so a
  // locked card still shows its poster.
  if (job.visibility === 'private' && kind !== 'thumbnails') {
    return res.status(404).json({ error: 'Not found' });
  }

  const cid = kind === 'thumbnails' ? job.s5_thumb_cid : job.s5_cid;
  if (!cid) {
    // Awaiting /promote, or s3d/local-only. Not `immutable`: unlike
    // content-addressed bytes, this mapping ends when the job is deleted.
    const dir = LOCAL_DIRS[kind];
    const localPath = dir && path.join(dir, req.params.file);
    if (!localPath || !(await exists(localPath))) {
      logger.warn({ id, kind }, 'cdn resolve found neither a CID nor a local file');
      return res.status(404).json({ error: 'Not found' });
    }
    res.set('Cache-Control', `public, max-age=${config.MEDIA_CDN_CACHE_SEC}`);
    if (req.method === 'HEAD') {
      res.set('Content-Type', CONTENT_TYPES[path.extname(req.params.file).toLowerCase()]
        || 'application/octet-stream');
      res.set('Accept-Ranges', 'bytes');
      const size = await fsp.stat(localPath).then((st) => st.size).catch(() => null);
      if (size !== null) res.set('Content-Length', String(size));
      return res.end();
    }
    return res.sendFile(localPath);
  }

  let upstream;
  try {
    upstream = await s5.fetchBlob(cid, { range: req.headers.range });
  } catch (err) {
    logger.error({ id, kind, cid, err: err.message }, 'cdn fetch from s5 failed');
    return res.status(502).json({ error: 'Upstream unavailable' });
  }

  if (!upstream.ok && upstream.status !== 206) {
    if (upstream.body) await upstream.body.cancel().catch(() => {});
    logger.error({ id, kind, cid, status: upstream.status }, 'cdn upstream refused');
    return res.status(502).json({ error: 'Upstream unavailable' });
  }

  // Content-addressed bytes can't change, so caching forever is safe -- the
  // ULID -> CID mapping isn't immutable, but a deleted job stops resolving above.
  res.set('Cache-Control', `public, max-age=${config.MEDIA_CDN_CACHE_SEC}, immutable`);
  res.set('Content-Type', CONTENT_TYPES[path.extname(req.params.file).toLowerCase()]
    || 'application/octet-stream');
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

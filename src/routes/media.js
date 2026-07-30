const express = require('express');
const fs = require('fs/promises');
const path = require('path');

const config = require('../config');
const jobs = require('../services/jobs');
const logger = require('../services/logger');
const { requireUploadKey } = require('../middleware/auth');
const { verify } = require('../utils/signed_url');

const router = express.Router();

// Only these two kinds have a private counterpart. Thumbnails stay public on
// purpose: a locked card still shows its poster.
const KINDS = {
  videos: { public: config.VIDEOS_DIR, private: config.PRIVATE_VIDEOS_DIR },
  audio: { public: config.AUDIO_DIR, private: config.PRIVATE_AUDIO_DIR },
};

// <ULID><ext>. Anchored, and the extension cannot contain a dot or slash, so a
// filename can never walk out of its directory.
const FILE_RE = /^([0-9A-HJKMNP-TV-Z]{26})(\.[A-Za-z0-9]{1,5})$/;

const parseFile = (kind, file) => {
  const dirs = KINDS[kind];
  if (!dirs) return null;
  const m = FILE_RE.exec(file || '');
  if (!m) return null;
  return { dirs, id: m[1], ext: m[2], file };
};

const exists = async (p) => {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
};

/*
|--------------------------------------------------------------------------
| Change an object's visibility
|--------------------------------------------------------------------------
|
| Master key only — serey-api calls this when a creator marks a video or episode
| Premium (or back to Public). The file moves between the public and private
| directory; a rename on the same volume, so no bytes are copied and no URL is
| valid for both states at once.
|
| Idempotent: asking for the state it is already in is a success.
|
*/
router.post('/:kind/:file/visibility', requireUploadKey, async (req, res) => {
  const target = String(req.body?.visibility || '').toLowerCase();
  if (!['public', 'private'].includes(target)) {
    return res
      .status(400)
      .json({ error: 'visibility must be "public" or "private"' });
  }

  const parsed = parseFile(req.params.kind, req.params.file);
  if (!parsed) {
    return res.status(400).json({ error: 'Invalid media reference' });
  }

  const { dirs, id, ext, file } = parsed;
  const from = path.join(target === 'private' ? dirs.public : dirs.private, file);
  const to = path.join(target === 'private' ? dirs.private : dirs.public, file);

  try {
    if (await exists(to)) {
      // Already there. Report the URL so the caller can store it either way.
      return res.json({ id, visibility: target, url: buildUrl(req.params.kind, target, file) });
    }

    if (!(await exists(from))) {
      return res.status(404).json({ error: 'Media not found' });
    }

    await fs.mkdir(path.dirname(to), { recursive: true });
    await fs.rename(from, to);

    // Best effort: the job record is metadata, not the source of truth for
    // delivery. A missing job must not fail the move.
    try {
      await jobs.update(id, { visibility: target });
    } catch {}

    logger.info({ id, kind: req.params.kind, target }, 'media visibility changed');
    return res.json({ id, visibility: target, url: buildUrl(req.params.kind, target, file) });
  } catch (err) {
    logger.error({ err, id }, 'media visibility change failed');
    return res.status(500).json({ error: 'Could not change visibility' });
  }
});

function buildUrl(kind, visibility, file) {
  return visibility === 'private'
    ? `${config.PUBLIC_BASE_URL}/media/${kind}/${file}`
    : `${config.PUBLIC_BASE_URL}/${kind}/${file}`;
}

/*
|--------------------------------------------------------------------------
| Signed delivery of a private object
|--------------------------------------------------------------------------
|
| GET /media/videos/<ulid>.mp4?exp=<unix>&sig=<hmac>
|
| No membership logic here by design: serey-api decides who is entitled and
| proves it with a signature. This service only checks that the signature is
| ours and still fresh.
|
*/
router.get('/:kind/:file', async (req, res) => {
  const parsed = parseFile(req.params.kind, req.params.file);
  if (!parsed) {
    return res.status(400).json({ error: 'Invalid media reference' });
  }

  const { dirs, ext, file } = parsed;
  const object_path = `${req.params.kind}/${file}`;

  const result = verify({
    object_path,
    exp: req.query.exp,
    sig: req.query.sig,
  });

  if (!result.ok) {
    // Same status for forged, expired and missing signatures, and for files that
    // do not exist — probing must not reveal which premium ids are real.
    logger.warn({ object_path, reason: result.reason }, 'signed media rejected');
    return res.status(403).json({ error: 'Forbidden' });
  }

  const filePath = path.join(dirs.private, file);
  if (!(await exists(filePath))) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  // Never let a CDN or shared proxy keep a copy: the URL is per viewer and the
  // whole protection collapses if an intermediary caches the response.
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (config.USE_X_ACCEL) {
    // nginx streams it from disk (range requests, sendfile) after we authorize.
    res.setHeader(
      'X-Accel-Redirect',
      `${config.X_ACCEL_PREFIX}/${req.params.kind}/${file}`,
    );
    return res.end();
  }

  // Dev fallback. sendFile handles Range itself, which matters for seeking.
  return res.sendFile(filePath, {
    headers: { 'Cache-Control': 'private, no-store' },
  });
});

module.exports = router;

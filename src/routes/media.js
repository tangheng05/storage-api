const express = require('express');
const fs = require('fs/promises');
const path = require('path');

const config = require('../config');
const jobs = require('../services/jobs');
const logger = require('../services/logger');
const { requireUploadKey } = require('../middleware/auth');
const { verify } = require('../utils/signed_url');
const sia = require('../services/sia');
const mirror = require('../services/mirror');

const router = express.Router();

// Only these kinds have a private counterpart. Video *thumbnails* stay public
// on purpose: a locked card still shows its poster. Uploaded images do not get
// that exemption — an image is the content on an image post, so leaving it
// public would hand away the very thing the paywall is protecting.
const KINDS = {
  videos: { public: config.VIDEOS_DIR, private: config.PRIVATE_VIDEOS_DIR },
  audio: { public: config.AUDIO_DIR, private: config.PRIVATE_AUDIO_DIR },
  images: { public: config.IMAGES_DIR, private: config.PRIVATE_IMAGES_DIR },
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
    const alreadyLocal = await exists(to);

    if (!alreadyLocal && !(await exists(from))) {
      return res.status(404).json({ error: 'Media not found' });
    }

    if (!alreadyLocal) {
      await fs.mkdir(path.dirname(to), { recursive: true });
      await fs.rename(from, to);
    }

    // Reconcile the Sia copy onto the matching prefix. This runs even when the
    // local file was already in place, and that is the whole point: if a
    // previous call moved the file locally but its Sia move failed, an early
    // return here would leave a now-premium object sitting under public/ for
    // good, where a public gateway would serve it to anyone. Retrying the call
    // has to be able to finish the job.
    const siaPatch = await reconcileSia({
      id,
      kind: req.params.kind,
      file,
      target,
    });

    // Best effort: the job record is metadata, not the source of truth for
    // delivery. A missing job must not fail the move.
    try {
      await jobs.update(id, { visibility: target, ...siaPatch });
    } catch {}

    logger.info(
      { id, kind: req.params.kind, target, already_local: alreadyLocal },
      'media visibility changed',
    );
    return res.json({
      id,
      visibility: target,
      url: await buildUrlFor(id, req.params.kind, target, file),
    });
  } catch (err) {
    logger.error({ err, id }, 'media visibility change failed');
    return res.status(500).json({ error: 'Could not change visibility' });
  }
});

/*
| Move the Sia object to the prefix matching the new visibility.
|
| Skipped entirely for anything that was never mirrored: legacy files that
| predate Sia, and media types not in SIA_MIRROR_TYPES, have no object to move
| and would otherwise log a 404 warning on every flip.
|
| Never throws. The local rename is what actually enforces the paywall today, so
| a Sia hiccup must not fail the request; it is recorded as 'failed' and the
| caller can simply retry the endpoint, which now reconciles properly.
*/
async function reconcileSia({ id, kind, file, target }) {
  if (!sia.enabled()) return {};

  let job = null;
  try {
    job = await jobs.get(id);
  } catch {
    // Unreadable job record; treat as never mirrored.
  }
  if (!job || !job.sia_key) return {};

  const toKey = sia.buildKey({ kind, file, visibility: target });
  if (job.sia_key === toKey && job.sia_state === 'mirrored') return {};

  try {
    await sia.moveObject({ fromKey: job.sia_key, toKey });
    return { sia_key: toKey, sia_state: 'mirrored', sia_error: null };
  } catch (err) {
    logger.warn(
      { id, fromKey: job.sia_key, toKey, err: err.message },
      'sia visibility move failed, object left on old prefix',
    );
    return { sia_state: 'failed', sia_error: err.message };
  }
}

/*
| Private objects are always served from local disk through the signed /media/
| path, so they keep PUBLIC_BASE_URL. A public object that lives on Sia has to
| report its Sia URL, otherwise flipping a video back to Public would silently
| move that row off Sia and onto local delivery.
*/
async function buildUrlFor(id, kind, visibility, file) {
  if (visibility === 'private') {
    return `${config.PUBLIC_BASE_URL}/media/${kind}/${file}`;
  }
  if (mirror.serving()) {
    try {
      const job = await jobs.get(id);
      if (job && job.sia_served) return `${config.SIA_PUBLIC_BASE_URL}/${kind}/${file}`;
    } catch {
      // Fall through to the local URL, which always works.
    }
  }
  return `${config.PUBLIC_BASE_URL}/${kind}/${file}`;
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

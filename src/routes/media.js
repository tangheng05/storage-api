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
const { exists } = require('../utils/fs');

const router = express.Router();

// Thumbnails stay public (locked cards still show a poster); images don't -- the image *is* the post.
const KINDS = {
  videos: { public: config.VIDEOS_DIR, private: config.PRIVATE_VIDEOS_DIR },
  audio: { public: config.AUDIO_DIR, private: config.PRIVATE_AUDIO_DIR },
  images: { public: config.IMAGES_DIR, private: config.PRIVATE_IMAGES_DIR },
};

// Anchored; extension holds no dot or slash, so a filename can't walk out of its directory.
const FILE_RE = /^([0-9A-HJKMNP-TV-Z]{26})(\.[A-Za-z0-9]{1,5})$/;

const parseFile = (kind, file) => {
  const dirs = KINDS[kind];
  if (!dirs) return null;
  const m = FILE_RE.exec(file || '');
  if (!m) return null;
  return { dirs, id: m[1], ext: m[2], file };
};

// States in which no file has been published yet, so a visibility change is
// recorded on the job for finalize to honour rather than performed on disk.
// 'review' is legacy: nothing produces it now, but a job written before the
// single-threshold gate can still be in it until the boot sweep re-decides.
const PRE_PUBLICATION = ['uploading', 'queued', 'processing', 'scanning', 'review'];

const prePublicationJob = async (id) => {
  try {
    const job = await jobs.get(id);
    return job && PRE_PUBLICATION.includes(job.state) ? job : null;
  } catch {
    return null;
  }
};

// Master key only. Renames the file between public and private dirs on the
// same volume, so no URL is valid for both states at once. Idempotent.
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

  // Public -> premium is refused on S5: a CID already handed out is fetchable
  // forever, so the flip would leave bytes open behind a paywall that believes it works.
  if (target === 'private') {
    let job = null;
    let unreadable = false;
    try {
      job = await jobs.get(id);
    } catch {
      // Can't prove the file never reached S5, so refuse rather than move it
      // and hope. A record that's simply absent (legacy file) is allowed.
      unreadable = true;
    }
    if (unreadable || (job && (job.storage_backend === 's5' || job.s5_cid))) {
      logger.warn({ id, kind: req.params.kind }, 'refused premium flip for s5-published media');
      return res.status(409).json({
        error: 'immutable_public_media',
        message:
          'This file was published to public storage and cannot be made premium. '
          + 'Re-upload it as premium to paywall it.',
      });
    }
  }

  try {
    const alreadyLocal = await exists(to);

    if (!alreadyLocal && !(await exists(from))) {
      // May not be published yet -- still at the scan gate. Record the intent
      // for finalize. 404ing here was a paywall hole: the job kept visibility
      // 'public', finalize published to S5, and the flip could never retry once the 409 guard fired.
      const pending = await prePublicationJob(id);
      if (pending) {
        await jobs.update(id, { visibility: target });
        logger.info({ id, kind: req.params.kind, target }, 'visibility recorded pre-publication');
        return res.json({
          id,
          visibility: target,
          url: await buildUrlFor(id, req.params.kind, target, file),
          published: false,
        });
      }
      return res.status(404).json({ error: 'Media not found' });
    }

    if (!alreadyLocal) {
      await fs.mkdir(path.dirname(to), { recursive: true });
      await fs.rename(from, to);
    }

    // Runs even when the local file was already in place, so a retry from a
    // prior s3d failure can still finish.
    const siaPatch = await reconcileSia({
      id,
      kind: req.params.kind,
      file,
      target,
    });

    // The job record is metadata, not the source of truth for delivery.
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

// Never throws: the local rename enforces the paywall, so an s3d hiccup is
// recorded as 'failed' and the caller can retry the endpoint.
async function reconcileSia({ id, kind, file, target }) {
  if (!sia.enabled()) return {};

  let job = null;
  try {
    job = await jobs.get(id);
  } catch {
    // Unreadable; treat as never published.
  }
  if (!job || job.storage_backend !== 's3d' || !job.sia_key) return {};

  const toKey = sia.buildKey({ kind, file, visibility: target });
  if (job.sia_key === toKey && job.mirror_state === 'published') return {};

  try {
    await sia.moveObject({ fromKey: job.sia_key, toKey });
    return { sia_key: toKey, mirror_state: 'published', mirror_error: null };
  } catch (err) {
    logger.warn(
      { id, fromKey: job.sia_key, toKey, err: err.message },
      's3d visibility move failed, object left on old prefix',
    );
    return { mirror_state: 'failed', mirror_error: err.message };
  }
}

async function buildUrlFor(id, kind, visibility, file) {
  if (visibility === 'private') {
    return `${config.PUBLIC_BASE_URL}/media/${kind}/${file}`;
  }
  try {
    const job = await jobs.get(id);
    // Only if actually published, so flipping back to public can't silently move onto local delivery.
    if (job && job.mirror_state === 'published') {
      const url = mirror.publicUrl(job.storage_backend, kind, file);
      if (url) return url;
    }
  } catch {
    // Fall through to the local URL, which always works.
  }
  return `${config.PUBLIC_BASE_URL}/${kind}/${file}`;
}

// Publishes a job the scan already cleared to S5, for callers running with
// S5_PROMOTE_ON_PUBLISH. Idempotent, and the URL is unchanged by design.
router.post('/:kind/:file/promote', requireUploadKey, async (req, res) => {
  const parsed = parseFile(req.params.kind, req.params.file);
  if (!parsed) return res.status(400).json({ error: 'Invalid media reference' });

  const { id, file } = parsed;

  let job;
  try {
    job = await jobs.get(id);
  } catch {
    return res.status(409).json({ error: 'job_unreadable' });
  }
  if (!job) return res.status(404).json({ error: 'Media not found' });

  // Promotion is publication; anything still at the gate has not cleared a scan.
  if (job.state !== 'ready') {
    return res.status(409).json({ error: 'not_published', state: job.state });
  }
  // A CID cannot be withdrawn, so paywalled bytes must never get one.
  if (job.visibility === 'private') {
    return res.status(409).json({ error: 'premium_media_is_never_promoted' });
  }

  if (job.s5_cid) {
    return res.json({ id, promoted: true, already: true, url: job.url });
  }

  const mediaType = job.media_type;
  // From the job, never the URL: a mismatched kind still locates the file (the
  // dir comes from media_type) and would then mint a CID under the wrong path.
  const kind = mirror.kindFor(mediaType);
  if (kind !== req.params.kind) {
    return res.status(400).json({ error: 'kind_does_not_match_media', expected: kind });
  }

  if (!mirror.targetsS5({ mediaType, visibility: 'public' })) {
    return res.json({ id, promoted: false, reason: 's5_not_enabled_for_type', url: job.url });
  }

  const filePath = mirror.localPathFor(job, file);
  if (!filePath || !(await exists(filePath))) {
    return res.status(409).json({ error: 'local_file_missing' });
  }

  const patch = {};
  const main = await mirror.publish({
    id, kind, mediaType, file, filePath, visibility: 'public', slot: 'main', force: true,
  });
  Object.assign(patch, main.patch);

  // Video only, and only if the frame was generated at conversion time.
  const thumbFile = `${id}.jpg`;
  const thumbPath = path.join(config.THUMBS_DIR, thumbFile);
  if (mediaType === 'video' && await exists(thumbPath)) {
    const thumb = await mirror.publish({
      id,
      kind: 'thumbnails',
      mediaType,
      file: thumbFile,
      filePath: thumbPath,
      visibility: 'public',
      slot: 'thumb',
      force: true,
    });
    Object.assign(patch, thumb.patch);
  }

  try {
    await jobs.update(id, patch);
  } catch (err) {
    // The bytes are on S5 but the record did not take the CID, so the boot
    // sweep cannot find them. Say so rather than report success.
    logger.error({ id, kind, err: err.message }, 'promoted but the job record did not update');
    return res.status(500).json({ error: 'promoted_but_not_recorded' });
  }

  const failed = patch[mirror.SLOTS.main.state] !== 'published';
  if (failed) {
    logger.warn({ id, kind, error: patch[mirror.SLOTS.main.error] }, 'promote to s5 failed');
    return res.status(502).json({
      error: 'promote_failed',
      message: patch[mirror.SLOTS.main.error] || 'backend refused the push',
      url: job.url,
    });
  }

  logger.info({ id, kind, cid: patch[mirror.SLOTS.main.cid] }, 'promoted to s5');
  return res.json({ id, promoted: true, url: main.url || job.url });
});

// No membership logic by design: the main API decides who is entitled and proves
// it with a signature; we only check the signature is ours and still fresh.
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
    // Same status for forged/expired/missing/nonexistent: probing must not
    // reveal which premium ids are real.
    logger.warn({ object_path, reason: result.reason }, 'signed media rejected');
    return res.status(403).json({ error: 'Forbidden' });
  }

  const filePath = path.join(dirs.private, file);
  if (!(await exists(filePath))) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  // The URL is per viewer; the protection collapses if a proxy caches it.
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

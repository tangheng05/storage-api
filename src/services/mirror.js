const path = require('path');
const fsp = require('fs/promises');

const config = require('../config');
const jobs = require('./jobs');
const queue = require('./queue');
const sia = require('./sia');
const s5 = require('./s5');
const logger = require('./logger');

/*
| Backend routing, decided by visibility: public -> S5 (content addressed,
| impossible to retract), premium -> s3d (private/ prefix, real delete).
|
| Not an optimisation. A CID *is* the permission, so paywalling content
| addressed media is not possible. Two guards fall out of that: a public file
| can never become premium (media.js refuses it), and the scanner runs stricter
| thresholds for S5 (processor.js).
*/

// Per-slot: a video and its thumbnail are separate objects and one can fail
// without the other. Sharing a key left deleted videos' thumbnails live.
const SLOTS = {
  main: {
    cid: 's5_cid',
    key: 'sia_key',
    backend: 'storage_backend',
    state: 'mirror_state',
    error: 'mirror_error',
  },
  thumb: {
    cid: 's5_thumb_cid',
    key: 'sia_thumb_key',
    state: 'thumb_state',
    error: 'thumb_error',
  },
};

// null means local disk only, which is a supported state.
function backendFor({ mediaType, visibility = 'public' }) {
  if (visibility === 'private') {
    return sia.enabled() && config.SIA_MIRROR_TYPES.includes(mediaType) ? 's3d' : null;
  }
  if (s5.enabled() && config.S5_TYPES.includes(mediaType)) return 's5';
  if (sia.enabled() && config.SIA_MIRROR_TYPES.includes(mediaType)) return 's3d';
  return null;
}

// Picks the scanner's thresholds. Only ever true for S5.
function isImmutable({ mediaType, visibility = 'public' }) {
  return backendFor({ mediaType, visibility }) === 's5';
}

// Opt-in via SIA_PUBLIC_BASE_URL; without it the push is backup-only and the
// URL stays local. S5 has no such mode.
function s3dServing() {
  return sia.enabled() && !!config.SIA_PUBLIC_BASE_URL;
}

// Our own hostname, ULID in the path. Resolved in routes/cdn.js.
function publicUrl(backend, kind, file) {
  if (backend === 's5') return `${config.MEDIA_CDN_BASE_URL}/${kind}/${file}`;
  if (backend === 's3d' && s3dServing()) return `${config.SIA_PUBLIC_BASE_URL}/${kind}/${file}`;
  return null;
}

// `url` is null when the caller should keep its local one; `patch` is merged
// into the job either way. A backend failure is never fatal: the local file is
// already written, so we fall back to it and let the boot sweep retry.
async function publish({
  id, kind, mediaType, file, filePath, visibility = 'public', slot = 'main',
}) {
  const fields = SLOTS[slot];
  const backend = backendFor({ mediaType, visibility });

  if (!backend) {
    return { url: null, patch: { [fields.state]: 'skipped' } };
  }

  try {
    if (backend === 's5') {
      const { cid, bytes } = await s5.putFile({ filePath });
      logger.info({ id, cid, bytes, slot }, 'published to s5');
      return {
        url: publicUrl('s5', kind, file),
        patch: {
          [fields.backend]: 's5',
          [fields.cid]: cid,
          [fields.state]: 'published',
          [fields.error]: null,
        },
      };
    }

    const key = sia.buildKey({ kind, file, visibility });
    const { bytes } = await sia.putFile({ key, filePath });
    logger.info({ id, key, bytes, slot }, 'published to s3d');
    return {
      url: publicUrl('s3d', kind, file),
      patch: {
        [fields.backend]: 's3d',
        [fields.key]: key,
        [fields.state]: 'published',
        [fields.error]: null,
      },
    };
  } catch (err) {
    logger.error({ id, backend, slot, err: err.message }, 'publish failed, serving locally');
    return {
      url: null,
      patch: {
        [fields.backend]: backend,
        // Recorded even on failure so the retry knows where it was headed.
        ...(backend === 's3d' ? { [fields.key]: sia.buildKey({ kind, file, visibility }) } : {}),
        [fields.state]: 'failed',
        [fields.error]: err.message,
      },
    };
  }
}

// Durability only: the URL already in serey-api is left alone.
async function retry(id, { force = false } = {}) {
  const job = await jobs.get(id);
  if (!job) return;

  for (const slot of ['main', 'thumb']) {
    const fields = SLOTS[slot];
    // force is for the verify script: a slot it found missing or wrong is
    // 'published', which is exactly the state this would otherwise skip.
    if (!force && job[fields.state] !== 'failed') continue;
    if (force && !job[fields.state]) continue;

    const file = slot === 'thumb' ? `${id}.jpg` : fileFromJob(job);
    if (!file) continue;
    const filePath = slot === 'thumb'
      ? path.join(config.THUMBS_DIR, file)
      : localPathFor(job, file);
    if (!filePath) continue;

    // Nothing to re-upload, so terminate instead of spinning every boot.
    // eslint-disable-next-line no-await-in-loop
    if (!(await exists(filePath))) {
      // eslint-disable-next-line no-await-in-loop
      await jobs.update(id, {
        [fields.state]: 'orphaned',
        [fields.error]: 'local file missing, nothing to upload',
      });
      logger.warn({ id, slot, filePath }, 'publish retry skipped, local file missing');
      continue;
    }

    // eslint-disable-next-line no-await-in-loop
    const { patch } = await publish({
      id,
      kind: slot === 'thumb' ? 'thumbnails' : kindFor(job.media_type),
      mediaType: job.media_type,
      file,
      filePath,
      // Always public, even for premium video.
      visibility: slot === 'thumb' ? 'public' : job.visibility || 'public',
      slot,
    });
    // Durability fields only; `url` is deliberately discarded.
    // eslint-disable-next-line no-await-in-loop
    await jobs.update(id, patch);
    logger.info({ id, slot, state: patch[fields.state] }, 'publish retry finished');
  }
}

async function exists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

const KINDS = { video: 'videos', audio: 'audio', image: 'images' };
function kindFor(mediaType) {
  return KINDS[mediaType] || 'videos';
}

// Returns null rather than throwing, so one bad record cannot abort a sweep.
function fileFromJob(job) {
  if (!job || !job.url) return null;
  try {
    return path.basename(new URL(job.url).pathname);
  } catch {
    return null;
  }
}

// Mirrors the dir choice made in processor.
function localPathFor(job, file) {
  const priv = job.visibility === 'private';
  switch (job.media_type) {
    case 'image':
      return path.join(priv ? config.PRIVATE_IMAGES_DIR : config.IMAGES_DIR, file);
    case 'audio':
      return path.join(priv ? config.PRIVATE_AUDIO_DIR : config.AUDIO_DIR, file);
    case 'video':
      return path.join(priv ? config.PRIVATE_VIDEOS_DIR : config.VIDEOS_DIR, file);
    default:
      return null;
  }
}

// Capped and on its own lane so a long outage cannot crowd out live uploads.
function recoverOnBoot() {
  if (!sia.enabled() && !s5.enabled()) return;

  // 'orphaned' excluded: its local file is gone, so it would spin every boot.
  const pending = jobs
    .listByState(['ready'])
    .filter((job) => job.mirror_state === 'failed' || job.thumb_state === 'failed')
    .slice(0, config.PUBLISH_RECOVER_LIMIT);

  if (!pending.length) return;

  logger.info({ count: pending.length }, 'requeueing unfinished publishes');
  pending.forEach((job) => {
    queue.push(() => retry(job.id), queue.PUBLISH_LANE);
  });
}

/*
| Per-slot report, not a boolean: s3d 'deleted' is really gone, while S5 manages
| 'unpinned' at best ('disabled' by default) and any node that already fetched
| the blob can serve it forever. Callers must not conflate the two.
|
| Never throws — a delete must succeed locally even if a backend is down.
*/
async function purge(job) {
  const report = {};
  if (!job) return report;

  for (const slot of ['main', 'thumb']) {
    const fields = SLOTS[slot];
    const cid = job[fields.cid];
    const key = job[fields.key];

    // Both identifiers are acted on, not just the first: a job re-routed
    // between backends keeps the old one, and skipping it left that copy live
    // after a takedown.
    const done = [];

    if (cid) {
      // eslint-disable-next-line no-await-in-loop
      const result = await s5.unpin(cid);
      done.push(`s5:${result}`);
      if (result !== 'unpinned') {
        logger.error(
          { id: job.id, cid, slot, result },
          'S5 CONTENT NOT RETRACTABLE, it remains fetchable by CID',
        );
      }
    }

    if (key && sia.enabled()) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await sia.deleteObject(key);
        done.push('s3d:deleted');
        logger.info({ id: job.id, key, slot }, 'deleted from s3d');
      } catch (err) {
        done.push('s3d:failed');
        logger.error(
          { id: job.id, key, slot, err: err.message },
          'S3D OBJECT NOT DELETED, remove it manually',
        );
      }
    }

    if (done.length) report[slot] = done.join(', ');
  }

  return report;
}

module.exports = {
  publish,
  retry,
  purge,
  recoverOnBoot,
  backendFor,
  isImmutable,
  publicUrl,
  localPathFor,
  fileFromJob,
  kindFor,
  SLOTS,
};

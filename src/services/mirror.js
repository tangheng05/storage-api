const path = require('path');
const fsp = require('fs/promises');

const config = require('../config');
const jobs = require('./jobs');
const queue = require('./queue');
const sia = require('./sia');
const s5 = require('./s5');
const logger = require('./logger');
const { exists } = require('../utils/fs');

// Backend routing by visibility: public -> S5 (content addressed, impossible
// to retract), premium -> s3d (private/ prefix, real delete). A CID is the
// permission, so content-addressed media can never be paywalled -- media.js
// refuses to make a public file premium, and processor.js scans S5 stricter.

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

function targetsS5({ mediaType, visibility = 'public' }) {
  return backendFor({ mediaType, visibility }) === 's5';
}

// Separate from isImmutable on purpose: deferring where the bytes go must not
// relax what the scanner judged them against.
function deferred({ mediaType, visibility = 'public', defer }) {
  if (!targetsS5({ mediaType, visibility })) return false;
  return defer === undefined ? config.S5_PROMOTE_ON_PUBLISH : !!defer;
}

// Picks the scanner's thresholds. Only ever true for S5.
const isImmutable = targetsS5;

// Null unless S5_EXPOSE_CID: a CID handed to a client can be fetched from any
// S5 node forever with no route back, so exposing it can't be undone later.
function publicCid(job) {
  if (!config.S5_EXPOSE_CID) return null;
  if (!job || job.visibility === 'private') return null;
  return job.s5_cid || null;
}

// Opt-in via SIA_PUBLIC_BASE_URL; without it the push is backup-only and the
// URL stays local. S5 has no such mode.
function s3dServing() {
  return sia.enabled() && !!config.SIA_PUBLIC_BASE_URL;
}

function publicUrl(backend, kind, file) {
  if (backend === 's5') return `${config.MEDIA_CDN_BASE_URL}/${kind}/${file}`;
  if (backend === 's3d' && s3dServing()) return `${config.SIA_PUBLIC_BASE_URL}/${kind}/${file}`;
  return null;
}

// `url` null means caller keeps its local one; a backend failure is never
// fatal since the local file is already written and the boot sweep retries.
async function publish({
  id, kind, mediaType, file, filePath, visibility = 'public', slot = 'main',
  force = false, defer,
}) {
  const fields = SLOTS[slot];
  const backend = backendFor({ mediaType, visibility });

  if (!backend) {
    return { url: null, patch: { [fields.state]: 'skipped' } };
  }

  // Already the URL S5 will serve, so /promote changes nothing downstream.
  // `force` is /promote itself: without it the deferral would refuse the very
  // push it exists to postpone.
  if (!force && deferred({ mediaType, visibility, defer })) {
    return {
      url: publicUrl('s5', kind, file),
      patch: { [fields.state]: 'deferred', [fields.error]: null },
    };
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

/*
| `states` names the slot states to act on; without it, force means "any slot
| that was ever attempted" (the verify script re-pushing a 'published' slot it
| found missing) and otherwise only 'failed' is retried.
|
| force also bypasses the publish deferral, because a caller reaching here is
| the event the deferral was waiting for.
*/
async function retry(id, { force = false, states = null } = {}) {
  const job = await jobs.get(id);
  if (!job) return;

  for (const slot of ['main', 'thumb']) {
    const fields = SLOTS[slot];
    const state = job[fields.state];
    const wanted = states ? states.includes(state) : (force ? !!state : state === 'failed');
    if (!wanted) continue;

    const file = slot === 'thumb' ? `${id}.jpg` : fileFromJob(job);
    if (!file) continue;
    const filePath = slot === 'thumb'
      ? path.join(config.THUMBS_DIR, file)
      : localPathFor(job, file);
    if (!filePath) continue;

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
      // The job's own visibility for both slots: a paywalled video's poster
      // frame is paywalled content, and 'public' here put it on S5 for good.
      visibility: job.visibility || 'public',
      slot,
      force,
    });
    // eslint-disable-next-line no-await-in-loop
    await jobs.update(id, patch);
    logger.info({ id, slot, state: patch[fields.state] }, 'publish retry finished');
  }
}

const KINDS = { video: 'videos', audio: 'audio', image: 'images' };
function kindFor(mediaType) {
  return KINDS[mediaType] || 'videos';
}

function fileFromJob(job) {
  if (!job || !job.url) return null;
  try {
    return path.basename(new URL(job.url).pathname);
  } catch {
    return null;
  }
}

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
    // 'pending' is a promote that was enqueued but not finished before restart.
    .filter((job) => ['failed', 'pending'].includes(job.mirror_state)
      || ['failed', 'pending'].includes(job.thumb_state))
    .slice(0, config.PUBLISH_RECOVER_LIMIT);

  if (!pending.length) return;

  logger.info({ count: pending.length }, 'requeueing unfinished publishes');
  pending.forEach((job) => {
    queue.push(
      () => retry(job.id, { force: true, states: ['failed', 'pending'] }),
      queue.PUBLISH_LANE,
    );
  });
}

// Per-slot report, not a boolean: s3d 'deleted' is really gone, but S5 has no
// unpin route (only an abstract unpinHash), so its delete is best effort --
// 'unpinned' at best, 'disabled' by default, and any node that already
// fetched the blob can keep serving it forever. Never throws: a local delete
// must succeed even if a backend is down.
async function purge(job) {
  const report = {};
  if (!job) return report;

  for (const slot of ['main', 'thumb']) {
    const fields = SLOTS[slot];
    const cid = job[fields.cid];
    const key = job[fields.key];

    // Both identifiers are acted on -- a job re-routed between backends keeps the old one.
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
  publicCid,
  publish,
  retry,
  purge,
  recoverOnBoot,
  backendFor,
  isImmutable,
  targetsS5,
  deferred,
  publicUrl,
  localPathFor,
  fileFromJob,
  kindFor,
  SLOTS,
};

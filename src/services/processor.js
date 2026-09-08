const fsp = require('fs/promises');
const path = require('path');
const config = require('../config');
const jobs = require('./jobs');
const queue = require('./queue');
const ffmpeg = require('./ffmpeg');
const image = require('./image');
const mirror = require('./mirror');
const scan = require('./scan');
const logger = require('./logger');

const VIDEO_CODECS = ['h264', 'hevc', 'vp8', 'vp9', 'av1'];
const TRANSCODE_CODECS = ['hevc'];
const WEBM_CODECS = ['vp8', 'vp9', 'av1'];

/*
| Two stages on two lanes: `convert` writes the published form into a PENDING
| dir nothing serves, then `finalize` scans it and only on a clean verdict moves
| it into a served dir and pushes it to a backend.
|
| The gate is at publication, not at the storage push: exposure comes from
| serving the bytes, local disk included.
*/

function tusFilePath(id) {
  return path.join(config.TUS_DIR, id);
}

async function exists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

const PENDING_DIRS = {
  video: config.PENDING_VIDEOS_DIR,
  audio: config.PENDING_AUDIO_DIR,
  image: config.PENDING_IMAGES_DIR,
};

function finalDirFor(mediaType, visibility) {
  const priv = visibility === 'private';
  if (mediaType === 'image') return priv ? config.PRIVATE_IMAGES_DIR : config.IMAGES_DIR;
  if (mediaType === 'audio') return priv ? config.PRIVATE_AUDIO_DIR : config.AUDIO_DIR;
  return priv ? config.PRIVATE_VIDEOS_DIR : config.VIDEOS_DIR;
}

// A corrupt input fails identically both times, but a transient hiccup should
// not permanently fail a fully-uploaded video.
async function withOneRetry(id, fn) {
  try {
    await fn();
  } catch (err) {
    logger.warn({ id, err: err.message }, 'ffmpeg failed, retrying once');
    await new Promise((r) => setTimeout(r, 5000));
    await fn();
  }
}

// --- Stage 1: convert into the pending dir ---

async function convertVideo(id, src, probe) {
  const videoStream = (probe.streams || []).find((s) => s.codec_type === 'video');
  const duration = parseFloat((probe.format && probe.format.duration) || '0');
  if (!videoStream) throw Object.assign(new Error('no_video_stream'), { code: 'no_video_stream' });
  if (!VIDEO_CODECS.includes(videoStream.codec_name)) {
    throw Object.assign(new Error('unsupported_codec'), { code: 'unsupported_codec' });
  }
  if (!(duration > 0) || duration > config.MAX_DURATION_SEC) {
    throw Object.assign(new Error('invalid_duration'), { code: 'invalid_duration' });
  }

  // webm passes through, h264 is remuxed losslessly, hevc is transcoded so it
  // plays outside Safari.
  const codec = videoStream.codec_name;
  const isWebm = WEBM_CODECS.includes(codec) && (probe.format.format_name || '').includes('webm');
  const needsTranscode = TRANSCODE_CODECS.includes(codec);
  const ext = isWebm ? '.webm' : '.mp4';
  const pendingPath = path.join(config.PENDING_VIDEOS_DIR, `${id}${ext}`);
  const tmpPath = path.join(config.PENDING_VIDEOS_DIR, `.${id}.tmp${ext}`);

  if (isWebm) {
    await fsp.copyFile(src, tmpPath);
  } else if (needsTranscode) {
    await jobs.update(id, { processing_mode: 'transcode' });
    await withOneRetry(id, () => ffmpeg.transcodeToH264(src, tmpPath));
  } else {
    await withOneRetry(id, () => ffmpeg.remuxToMp4(src, tmpPath));
  }
  await fsp.rename(tmpPath, pendingPath);

  // Doubles as the scanner's view of the video: a still frame is all an image
  // classifier can rule on, and it is the frame the feed shows anyway.
  const thumbFile = `${id}.jpg`;
  const thumbPath = path.join(config.PENDING_THUMBS_DIR, thumbFile);
  let hasThumb = true;
  try {
    await ffmpeg.makeThumbnail(pendingPath, thumbPath, Math.min(3, duration / 2));
  } catch (err) {
    hasThumb = false;
    logger.warn({ id, err: err.message }, 'thumbnail generation failed');
  }

  return {
    pending_file: `${id}${ext}`,
    pending_thumb: hasThumb ? thumbFile : null,
    duration_sec: Math.round(duration),
    width: videoStream.width,
    height: videoStream.height,
  };
}

async function convertAudio(id, src, probe) {
  const duration = parseFloat((probe.format && probe.format.duration) || '0');
  const audioStream = (probe.streams || []).find((s) => s.codec_type === 'audio');
  if (!audioStream) throw Object.assign(new Error('no_audio_stream'), { code: 'no_audio_stream' });
  if (!(duration > 0) || duration > config.MAX_AUDIO_DURATION_SEC) {
    throw Object.assign(new Error('invalid_duration'), { code: 'invalid_duration' });
  }

  const ext = '.m4a';
  const pendingPath = path.join(config.PENDING_AUDIO_DIR, `${id}${ext}`);
  const tmpPath = path.join(config.PENDING_AUDIO_DIR, `.${id}.tmp${ext}`);
  await withOneRetry(id, () => ffmpeg.transcodeToAac(src, tmpPath));
  await fsp.rename(tmpPath, pendingPath);

  return { pending_file: `${id}${ext}`, pending_thumb: null, duration_sec: Math.round(duration) };
}

async function convertImage(id, src, meta) {
  const ext = '.webp';
  const pendingPath = path.join(config.PENDING_IMAGES_DIR, `${id}${ext}`);
  const tmpPath = path.join(config.PENDING_IMAGES_DIR, `.${id}.tmp${ext}`);
  await withOneRetry(id, () => image.toWebp(src, tmpPath, meta));
  await fsp.rename(tmpPath, pendingPath);

  // EXIF rotation and the long-edge cap both change this from the upload.
  const { width, height } = await image.publishedSize(pendingPath);
  return { pending_file: `${id}${ext}`, pending_thumb: null, width, height, from: meta.format };
}

// --- Stage 2: scan, then publish ---

function pendingPaths(job) {
  return {
    file: job.pending_file
      ? path.join(PENDING_DIRS[job.media_type] || config.PENDING_VIDEOS_DIR, job.pending_file)
      : null,
    thumb: job.pending_thumb
      ? path.join(config.PENDING_THUMBS_DIR, job.pending_thumb)
      : null,
  };
}

async function discardPending(job) {
  const p = pendingPaths(job);
  await Promise.all([
    p.file ? fsp.rm(p.file, { force: true }) : null,
    p.thumb ? fsp.rm(p.thumb, { force: true }) : null,
  ].filter(Boolean));
}

// Video scans via its thumbnail: catches an opening frame, misses one that
// turns bad later. Frame sampling is the upgrade path. Audio has no affordable
// check at all.
function scanTargetFor(job) {
  const p = pendingPaths(job);
  if (job.media_type === 'image') return p.file;
  if (job.media_type === 'video') return p.thumb;
  return null;
}

async function runScan(id, job) {
  const visibility = job.visibility || 'public';
  const immutable = mirror.isImmutable({ mediaType: job.media_type, visibility });
  const target = scanTargetFor(job);

  if (!target || !(await exists(target))) {
    // Expected for audio; for a video it means publishing unchecked.
    if (job.media_type === 'video') {
      logger.warn({ id }, 'no thumbnail to scan, video published unchecked');
    }
    return { verdict: scan.VERDICT.CLEAN, provider: 'unscannable', score: null, labels: [] };
  }

  return scan.scanFile({ filePath: target, mediaType: job.media_type, immutable });
}

// Local move first, so the file is where mirror.localPathFor expects it and a
// backend failure leaves a correct local file rather than a half-published job.
async function publishCleared(id, job) {
  const visibility = job.visibility || 'public';
  const kind = mirror.kindFor(job.media_type);
  const p = pendingPaths(job);
  const file = job.pending_file;
  const finalDir = finalDirFor(job.media_type, visibility);
  const finalPath = path.join(finalDir, file);

  await fsp.mkdir(finalDir, { recursive: true });
  await fsp.rename(p.file, finalPath);

  let thumbPath = null;
  if (job.pending_thumb) {
    // Always public, even for premium video: a locked card still shows its
    // poster.
    thumbPath = path.join(config.THUMBS_DIR, job.pending_thumb);
    await fsp.mkdir(config.THUMBS_DIR, { recursive: true });
    await fsp.rename(p.thumb, thumbPath);
  }

  const published = await mirror.publish({
    id, kind, mediaType: job.media_type, file, filePath: finalPath, visibility, slot: 'main',
  });

  let thumbnailUrl;
  let thumbPatch = {};
  if (thumbPath) {
    const thumb = await mirror.publish({
      id,
      kind: 'thumbnails',
      mediaType: job.media_type,
      file: job.pending_thumb,
      filePath: thumbPath,
      visibility: 'public',
      slot: 'thumb',
    });
    thumbPatch = thumb.patch;
    thumbnailUrl = thumb.url || `${config.PUBLIC_BASE_URL}/thumbnails/${job.pending_thumb}`;
  }

  // Private media always goes through the signed /media/ path: the signature
  // is the paywall.
  const localUrl = visibility === 'private'
    ? `${config.PUBLIC_BASE_URL}/media/${kind}/${file}`
    : `${config.PUBLIC_BASE_URL}/${kind}/${file}`;

  await jobs.update(id, {
    state: 'ready',
    url: visibility === 'private' ? localUrl : published.url || localUrl,
    ...(thumbnailUrl ? { thumbnail_url: thumbnailUrl } : {}),
    pending_file: null,
    pending_thumb: null,
    ...published.patch,
    ...thumbPatch,
  });

  logger.info(
    { id, kind, visibility, backend: published.patch[mirror.SLOTS.main.backend] },
    'media ready',
  );
}

// `approved` skips the scanner for a job a moderator cleared: re-scoring would
// only re-flag it with the score that held it.
async function finalize(id, { approved = false } = {}) {
  const job = await jobs.get(id);
  if (!job || !job.pending_file) return;

  try {
    const result = approved
      ? { verdict: scan.VERDICT.CLEAN, provider: 'moderator', score: null, labels: [] }
      : await runScan(id, job);

    const patch = {
      scan_verdict: result.verdict,
      scan_provider: result.provider,
      scan_score: result.score,
      scan_labels: result.labels,
      // Kept even when cleared: a later takedown can blocklist it.
      scan_phash: result.phash || null,
      scan_error: null,
      scanned_at: new Date().toISOString(),
    };

    if (result.verdict === scan.VERDICT.REJECT) {
      await discardPending(job);
      await jobs.update(id, {
        ...patch,
        state: 'rejected',
        error: 'rejected_by_scan',
        pending_file: null,
        pending_thumb: null,
      });
      logger.warn({ id, labels: result.labels, matched: result.matched }, 'upload rejected by scan');
      return;
    }

    if (result.verdict === scan.VERDICT.REVIEW) {
      // Stays in pending: reachable by nobody, still there to approve.
      await jobs.update(id, { ...patch, state: 'review' });
      logger.info({ id, score: result.score, labels: result.labels }, 'upload held for review');
      return;
    }

    await jobs.update(id, patch);
    await publishCleared(id, job);
  } catch (err) {
    if (scan.enabled() && !config.SCAN_FAIL_OPEN) {
      // An outage that delays uploads is cheaper than one bad file going live
      // on a backend that cannot retract it.
      await jobs.update(id, { state: 'scanning', scan_error: err.message });
      logger.error({ id, err: err.message }, 'scan failed, holding upload (fail closed)');
      return;
    }
    logger.error({ id, err: err.message }, 'scan failed, publishing anyway (fail open)');
    await jobs.update(id, { scan_verdict: 'error', scan_error: err.message });
    await publishCleared(id, job);
  }
}

// --- Entry points ---

async function convert(id) {
  const src = tusFilePath(id);
  try {
    const job = await jobs.get(id);
    await jobs.update(id, { state: 'processing' });

    let meta;
    if (job && job.media_type === 'image') {
      let probe;
      try {
        probe = await image.probe(src);
      } catch {
        throw Object.assign(new Error('not_an_image'), { code: 'not_an_image' });
      }
      meta = await convertImage(id, src, probe);
    } else {
      let probe;
      try {
        probe = await ffmpeg.probe(src);
      } catch {
        throw Object.assign(new Error('not_a_media_file'), { code: 'not_a_media_file' });
      }
      meta = job && job.media_type === 'audio'
        ? await convertAudio(id, src, probe)
        : await convertVideo(id, src, probe);
    }

    await fsp.rm(src, { force: true });
    await fsp.rm(`${src}.json`, { force: true });

    await jobs.update(id, {
      state: 'scanning',
      filename: (job && job.filename) || null,
      ...meta,
    });
    queue.push(() => finalize(id), queue.SCAN_LANE);
  } catch (err) {
    logger.error({ id, err: err.message }, 'processing failed');
    await fsp.rm(src, { force: true }).catch(() => {});
    await fsp.rm(`${src}.json`, { force: true }).catch(() => {});
    await jobs.update(id, { state: 'failed', error: err.code || 'processing_error' });
  }
}

// media_type picks the lane. Passed in rather than read, so this stays sync.
function enqueue(id, mediaType) {
  const lane = mediaType === 'image' ? queue.IMAGE_LANE : queue.MEDIA_LANE;
  queue.push(() => convert(id), lane);
}

// 'uploading' is left to tus. 'review' is left to the moderator: re-scanning
// would re-flag it and overwrite their queue entry.
function recoverOnBoot() {
  jobs.listByState(['queued', 'processing']).forEach((job) => {
    logger.info({ id: job.id, media_type: job.media_type }, 'recovering interrupted job');
    enqueue(job.id, job.media_type);
  });

  jobs
    .listByState(['scanning'])
    .slice(0, config.SCAN_RECOVER_LIMIT)
    .forEach((job) => {
      logger.info({ id: job.id }, 'recovering upload held at the scan gate');
      queue.push(() => finalize(job.id), queue.SCAN_LANE);
    });
}

module.exports = { enqueue, finalize, discardPending, recoverOnBoot };

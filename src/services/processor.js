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
const { exists } = require('../utils/fs');

const VIDEO_CODECS = ['h264', 'hevc', 'vp8', 'vp9', 'av1'];
const TRANSCODE_CODECS = ['hevc'];
const WEBM_CODECS = ['vp8', 'vp9', 'av1'];

// Two stages on two lanes: `convert` writes the published form into a PENDING
// dir nothing serves; `finalize` scans it and only on a clean verdict moves it
// into a served dir. The gate is at publication, not the storage push --
// exposure comes from serving the bytes, local disk included.

function tusFilePath(id) {
  return path.join(config.TUS_DIR, id);
}

// Idempotent (retry finds the file already at dest); copy fallback since pending/published dirs may differ mounts.
async function move(from, to) {
  try {
    await fsp.rename(from, to);
  } catch (err) {
    if (err.code === 'EXDEV') {
      await fsp.copyFile(from, to);
      await fsp.rm(from, { force: true });
      return;
    }
    if (err.code === 'ENOENT' && (await exists(to))) return;
    throw err;
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

// A transient ffmpeg hiccup shouldn't permanently fail a fully-uploaded video.
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

  // webm passes through, h264 is remuxed losslessly, hevc transcoded for Safari.
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

  // Doubles as the scanner's view of the video -- all an image classifier can rule on.
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
  // Extension decided before the write so the temp file and final name agree.
  const ext = image.extensionFor(meta);
  const pendingPath = path.join(config.PENDING_IMAGES_DIR, `${id}${ext}`);
  const tmpPath = path.join(config.PENDING_IMAGES_DIR, `.${id}.tmp${ext}`);
  await withOneRetry(id, () => image.normalise(src, tmpPath, meta));
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

// Video scans via its thumbnail (misses a frame that turns bad later); withSampledFrames below is the upgrade path.
async function runScan(id, job) {
  const p = pendingPaths(job);
  if (job.media_type === 'audio') {
    return { verdict: scan.VERDICT.CLEAN, provider: 'unscannable', score: null, labels: [] };
  }

  const isVideo = job.media_type === 'video';
  const target = isVideo ? p.thumb : p.file;

  // Threshold follows the bytes scanned, not the job -- a video's thumbnail always publishes public.
  const visibility = isVideo ? 'public' : job.visibility || 'public';
  const immutable = mirror.isImmutable({ mediaType: job.media_type, visibility });

  if (!target || !(await exists(target))) {
    // Image with no file: broken job, fail it. Video with no thumbnail: reject
    // rather than treat as clean (an uploader-controlled bypass of the gate)
    // or throw (would just retry the same undecodable frame forever).
    if (!isVideo) {
      throw Object.assign(new Error('no_scan_target'), { code: 'no_scan_target' });
    }
    logger.warn({ id }, 'no thumbnail to scan, refusing video');
    return {
      verdict: scan.VERDICT.REJECT, provider: 'unscannable', score: null, labels: ['no_thumbnail'],
    };
  }

  const result = await scan.scanFile({ filePath: target, mediaType: job.media_type, immutable });
  if (!isVideo) return result;
  return withSampledFrames(id, job, result, immutable);
}

// Scans a few more frames, keeps the worst verdict -- catches a clean intro
// over bad content; costs one call/frame, so SCAN_VIDEO_FRAMES defaults to 1.
async function withSampledFrames(id, job, primary, immutable) {
  const extra = Math.max(0, config.SCAN_VIDEO_FRAMES - 1);
  const duration = job.duration_sec || 0;
  if (!extra || !duration) return primary;

  const rank = { clean: 0, reject: 1 };
  const source = pendingPaths(job).file;
  let worst = primary;

  for (let i = 1; i <= extra; i += 1) {
    const at = (duration * i) / (extra + 1);
    const framePath = path.join(config.PENDING_THUMBS_DIR, `.${job.id}.f${i}.jpg`);
    try {
      // eslint-disable-next-line no-await-in-loop
      await ffmpeg.makeThumbnail(source, framePath, at);
      // eslint-disable-next-line no-await-in-loop
      const r = await scan.scanFile({ filePath: framePath, mediaType: 'video', immutable });
      if (rank[r.verdict] > rank[worst.verdict]) worst = r;
    } catch (err) {
      // Undecodable frame isn't a verdict; the primary thumbnail already gave us one.
      logger.warn({ id, at, err: err.message }, 'frame scan skipped');
    } finally {
      // eslint-disable-next-line no-await-in-loop
      await fsp.rm(framePath, { force: true });
    }
    if (worst.verdict === scan.VERDICT.REJECT) break;
  }

  // Keep the thumbnail's fingerprint: that is the frame a takedown blocklists.
  return { ...worst, phash: primary.phash };
}

// Local move first: a backend failure then leaves a correct local file rather
// than a half-published job.
async function publishCleared(id, job) {
  const visibility = job.visibility || 'public';
  const kind = mirror.kindFor(job.media_type);
  const p = pendingPaths(job);
  const file = job.pending_file;
  const finalDir = finalDirFor(job.media_type, visibility);
  const finalPath = path.join(finalDir, file);

  await fsp.mkdir(finalDir, { recursive: true });
  await move(p.file, finalPath);

  let thumbPath = null;
  if (job.pending_thumb) {
    // Always public, even for premium video -- a locked card still shows its poster.
    thumbPath = path.join(config.THUMBS_DIR, job.pending_thumb);
    await fsp.mkdir(config.THUMBS_DIR, { recursive: true });
    await move(p.thumb, thumbPath);
  }

  const published = await mirror.publish({
    id, kind, mediaType: job.media_type, file, filePath: finalPath, visibility, slot: 'main',
    defer: job.defer_publish,
  });

  let thumbnailUrl;
  let thumbPatch = {};
  if (thumbPath) {
    // The job's own visibility, not 'public'. A paywalled video's poster frame
    // is still paywalled content, and routing it as public put it on S5 -- a
    // permanent, unrevokable copy of a frame from a paid video.
    const thumb = await mirror.publish({
      id,
      kind: 'thumbnails',
      mediaType: job.media_type,
      file: job.pending_thumb,
      filePath: thumbPath,
      visibility,
      slot: 'thumb',
      defer: job.defer_publish,
    });
    thumbPatch = thumb.patch;
    // Thumbnails stay served from local disk for private jobs so the card has
    // a poster (see routes/cdn.js), but the bytes never leave this machine.
    const remote = visibility === 'private' ? null : thumb.url;
    thumbnailUrl = remote || `${config.PUBLIC_BASE_URL}/thumbnails/${job.pending_thumb}`;
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

async function finalize(id) {
  const job = await jobs.get(id);
  if (!job || !job.pending_file) return;

  // No bytes, nothing to scan -- avoids re-running and synthesizing a verdict for a missing file.
  if (!(await exists(pendingPaths(job).file))) {
    await jobs.update(id, {
      state: 'failed',
      error: 'pending_file_missing',
      pending_file: null,
      pending_thumb: null,
    });
    logger.error({ id }, 'pending file missing at the scan gate');
    return;
  }

  let scanError = null;
  let result;
  // Only the scan call is inside the try: a publish failure must not be
  // recorded as a scanner outage, nor re-enter this branch and publish twice.
  try {
    result = await runScan(id, job);
  } catch (err) {
    if (scan.enabled() && !config.SCAN_FAIL_OPEN) {
      // An outage that delays uploads is cheaper than a bad file going live on
      // a backend that cannot retract it.
      await jobs.update(id, { state: 'scanning', scan_error: err.message });
      logger.error({ id, err: err.message }, 'scan failed, holding upload (fail closed)');
      return;
    }
    logger.error({ id, err: err.message }, 'scan failed, publishing anyway (fail open)');
    result = { verdict: scan.VERDICT.CLEAN, provider: 'error', score: null, labels: [] };
    scanError = err.message;
  }

  const patch = {
    scan_verdict: result.verdict,
    scan_provider: result.provider,
    // Which providers answered, not just which won -- otherwise an absent
    // classifier looks identical to a clean one.
    scan_providers: result.providers || (result.provider ? [result.provider] : []),
    scan_score: result.score,
    scan_labels: result.labels,
    // Kept even when cleared: a later takedown can blocklist it.
    scan_phash: result.phash || null,
    scan_error: scanError,
    scanned_at: new Date().toISOString(),
  };

  // Verdict persisted before acted on, so a failure while acting isn't mistaken for a failure to decide.
  if (result.verdict === scan.VERDICT.REJECT) {
    await jobs.update(id, {
      ...patch, state: 'rejected', error: 'rejected_by_scan',
    });
    await discardPending(job);
    await jobs.update(id, { pending_file: null, pending_thumb: null });
    logger.warn({ id, labels: result.labels, matched: result.matched }, 'upload rejected by scan');
    return;
  }

  await jobs.update(id, patch);
  // Outside the scan guard on purpose: a throw here leaves the job in
  // 'scanning' for the boot sweep to retry (publishCleared is idempotent).
  await publishCleared(id, job);
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

    // State first: a crash between deleting the source and recording the new
    // state left recovery retrying a source that was already gone.
    await jobs.update(id, {
      state: 'scanning',
      filename: (job && job.filename) || null,
      ...meta,
    });
    await fsp.rm(src, { force: true });
    await fsp.rm(`${src}.json`, { force: true });
    queue.push(() => finalize(id), queue.SCAN_LANE);
  } catch (err) {
    logger.error({ id, err: err.message }, 'processing failed');
    await fsp.rm(src, { force: true }).catch(() => {});
    await fsp.rm(`${src}.json`, { force: true }).catch(() => {});
    await jobs.update(id, { state: 'failed', error: err.code || 'processing_error' });
  }
}

// mediaType passed in rather than read from the job, so this stays sync.
function enqueue(id, mediaType) {
  const lane = mediaType === 'image' ? queue.IMAGE_LANE : queue.MEDIA_LANE;
  queue.push(() => convert(id), lane);
}

// Re-runs the gate for anything held by a scan error; called on boot and the
// hourly timer, so a scanner that recovers mid-day needs no restart.
function sweepHeld() {
  jobs
    .listByState(['scanning'])
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
    .slice(0, config.SCAN_RECOVER_LIMIT)
    .forEach((job) => queue.push(() => finalize(job.id), queue.SCAN_LANE));
}

// 'uploading' is left to tus, which owns its own resumption.
function recoverOnBoot() {
  // Oldest first, so a recovery cap doesn't starve older jobs behind an arbitrary subset.
  const oldestFirst = (a, b) => String(a.created_at).localeCompare(String(b.created_at));

  jobs.listByState(['queued', 'processing']).sort(oldestFirst).forEach((job) => {
    logger.info({ id: job.id, media_type: job.media_type }, 'recovering interrupted job');
    enqueue(job.id, job.media_type);
  });

  // 'review' is a legacy state predating the single reject-threshold gate;
  // its pending files were never discarded, so re-decide instead of stalling forever.
  jobs
    .listByState(['scanning', 'review'])
    .sort(oldestFirst)
    .slice(0, config.SCAN_RECOVER_LIMIT)
    .forEach((job) => {
      logger.info({ id: job.id, state: job.state }, 'recovering upload held at the scan gate');
      queue.push(() => finalize(job.id), queue.SCAN_LANE);
    });
}

module.exports = { enqueue, finalize, discardPending, recoverOnBoot, sweepHeld };

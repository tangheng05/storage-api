const fsp = require('fs/promises');
const path = require('path');
const config = require('../config');
const jobs = require('./jobs');
const queue = require('./queue');
const ffmpeg = require('./ffmpeg');
const image = require('./image');
const logger = require('./logger');

const VIDEO_CODECS = ['h264', 'hevc', 'vp8', 'vp9', 'av1'];
// vp8/vp9/av1 in webm play and seek fine as-is; everything else goes to MP4.
const WEBM_CODECS = ['vp8', 'vp9', 'av1'];
// h264 already plays everywhere — cheap container remux, no re-encode.
// hevc (iPhone default since iOS 11) has no browser decoder outside Safari,
// so it needs a real transcode to h264 or it "succeeds" into an unplayable file.
const TRANSCODE_CODECS = ['hevc'];

function tusFilePath(id) {
  return path.join(config.TUS_DIR, id);
}

// One retry for the ffmpeg publish step. A corrupt input fails identically both
// times (still rejected), but a transient hiccup (I/O stall, OOM-killed ffmpeg,
// timeout under load) shouldn't permanently fail a fully-uploaded video.
async function withOneRetry(id, fn) {
  try {
    await fn();
  } catch (err) {
    logger.warn({ id, err: err.message }, 'ffmpeg failed, retrying once');
    await new Promise((r) => setTimeout(r, 5000));
    await fn();
  }
}

async function processVideo(id, src, probe) {
  const videoStream = (probe.streams || []).find((s) => s.codec_type === 'video');
  const duration = parseFloat((probe.format && probe.format.duration) || '0');
  if (!videoStream) throw Object.assign(new Error('no_video_stream'), { code: 'no_video_stream' });
  if (!VIDEO_CODECS.includes(videoStream.codec_name)) {
    throw Object.assign(new Error('unsupported_codec'), { code: 'unsupported_codec' });
  }
  if (!(duration > 0) || duration > config.MAX_DURATION_SEC) {
    throw Object.assign(new Error('invalid_duration'), { code: 'invalid_duration' });
  }

  // Publish: webm passes through, h264 is remuxed (fast, lossless), and
  // hevc is transcoded to h264 so it actually plays outside Safari.
  const job = await jobs.get(id);
  const codec = videoStream.codec_name;
  const isWebm = WEBM_CODECS.includes(codec) && (probe.format.format_name || '').includes('webm');
  const needsTranscode = TRANSCODE_CODECS.includes(codec);
  const ext = isWebm ? '.webm' : '.mp4';
  const finalPath = path.join(config.VIDEOS_DIR, `${id}${ext}`);
  const tmpPath = path.join(config.VIDEOS_DIR, `.${id}.tmp${ext}`);

  if (isWebm) {
    await fsp.copyFile(src, tmpPath);
  } else if (needsTranscode) {
    await jobs.update(id, { state: 'processing', processing_mode: 'transcode' });
    await withOneRetry(id, () => ffmpeg.transcodeToH264(src, tmpPath));
  } else {
    await withOneRetry(id, () => ffmpeg.remuxToMp4(src, tmpPath));
  }
  await fsp.rename(tmpPath, finalPath);

  // Thumbnail from the published file.
  const thumbPath = path.join(config.THUMBS_DIR, `${id}.jpg`);
  try {
    await ffmpeg.makeThumbnail(finalPath, thumbPath, Math.min(3, duration / 2));
  } catch (err) {
    logger.warn({ id, err: err.message }, 'thumbnail generation failed');
  }

  await jobs.update(id, {
    state: 'ready',
    url: `${config.PUBLIC_BASE_URL}/videos/${id}${ext}`,
    thumbnail_url: `${config.PUBLIC_BASE_URL}/thumbnails/${id}.jpg`,
    duration_sec: Math.round(duration),
    width: videoStream.width,
    height: videoStream.height,
    filename: job && job.filename,
  });
  logger.info({ id, duration }, 'video ready');
}

async function processAudio(id, src, probe) {
  const audioStream = (probe.streams || []).find((s) => s.codec_type === 'audio');
  const duration = parseFloat((probe.format && probe.format.duration) || '0');
  if (!audioStream) throw Object.assign(new Error('no_audio_stream'), { code: 'no_audio_stream' });
  if (!(duration > 0) || duration > config.MAX_AUDIO_DURATION_SEC) {
    throw Object.assign(new Error('invalid_duration'), { code: 'invalid_duration' });
  }

  // Every upload is transcoded to AAC/M4A for consistent, universal playback.
  const job = await jobs.get(id);
  const ext = '.m4a';
  const finalPath = path.join(config.AUDIO_DIR, `${id}${ext}`);
  const tmpPath = path.join(config.AUDIO_DIR, `.${id}.tmp${ext}`);

  await withOneRetry(id, () => ffmpeg.transcodeToAac(src, tmpPath));
  await fsp.rename(tmpPath, finalPath);

  await jobs.update(id, {
    state: 'ready',
    url: `${config.PUBLIC_BASE_URL}/audio/${id}${ext}`,
    duration_sec: Math.round(duration),
    filename: job && job.filename,
  });
  logger.info({ id, duration }, 'audio ready');
}

async function processImage(id, src, meta) {
  // limitInputPixels already refuses bombs at decode time; checking the declared
  // dimensions first turns that into a clean error code instead of a raw throw.
  if (meta.width * meta.height > config.MAX_IMAGE_PIXELS) {
    throw Object.assign(new Error('image_too_large'), { code: 'image_too_large' });
  }

  // Unconditional conversion to WebP, same rationale as audio->AAC: one output
  // format everywhere beats carrying a dozen input formats through the stack.
  const job = await jobs.get(id);
  const ext = '.webp';
  const finalPath = path.join(config.IMAGES_DIR, `${id}${ext}`);
  const tmpPath = path.join(config.IMAGES_DIR, `.${id}.tmp${ext}`);

  try {
    await withOneRetry(id, () => image.toWebp(src, tmpPath, meta));
    await fsp.rename(tmpPath, finalPath);
  } finally {
    // No-op after a successful rename; cleans up a half-written file otherwise.
    await fsp.rm(tmpPath, { force: true }).catch(() => {});
  }

  // Report what we actually published — the long-edge cap and the EXIF rotation
  // both change this from the uploaded dimensions.
  const { width, height } = await image.publishedSize(finalPath);

  await jobs.update(id, {
    state: 'ready',
    url: `${config.PUBLIC_BASE_URL}/images/${id}${ext}`,
    width,
    height,
    filename: job && job.filename,
  });
  logger.info({ id, width, height, from: meta.format }, 'image ready');
}

async function process(id) {
  const src = tusFilePath(id);
  try {
    const job = await jobs.get(id);
    await jobs.update(id, { state: 'processing' });

    if (job && job.media_type === 'image') {
      // sharp reads the header itself; ffprobe is not involved for images.
      let meta;
      try {
        meta = await image.probe(src);
      } catch {
        throw Object.assign(new Error('not_an_image'), { code: 'not_an_image' });
      }
      await processImage(id, src, meta);
    } else {
      // Validate it is a real, playable media file.
      let probe;
      try {
        probe = await ffmpeg.probe(src);
      } catch {
        throw Object.assign(new Error('not_a_media_file'), { code: 'not_a_media_file' });
      }

      if (job && job.media_type === 'audio') {
        await processAudio(id, src, probe);
      } else {
        await processVideo(id, src, probe);
      }
    }

    // Cleanup tus temp files.
    await fsp.rm(src, { force: true });
    await fsp.rm(`${src}.json`, { force: true });
  } catch (err) {
    logger.error({ id, err: err.message }, 'processing failed');
    await fsp.rm(src, { force: true }).catch(() => {});
    await fsp.rm(`${src}.json`, { force: true }).catch(() => {});
    await jobs.update(id, { state: 'failed', error: err.code || 'processing_error' });
  }
}

// media_type picks the lane, so a 200ms image conversion never waits behind a
// 30-minute HEVC transcode. Every caller already holds the job, so passing the
// type in keeps this synchronous.
function enqueue(id, mediaType) {
  const lane = mediaType === 'image' ? queue.IMAGE_LANE : queue.MEDIA_LANE;
  queue.push(() => process(id), lane);
}

// Re-enqueue jobs interrupted by a crash/restart. Uploads still in
// 'uploading' state are left alone — tus resumes them.
function recoverOnBoot() {
  const stuck = jobs.listByState(['queued', 'processing']);
  stuck.forEach((job) => {
    logger.info({ id: job.id, media_type: job.media_type }, 'recovering interrupted job');
    enqueue(job.id, job.media_type);
  });
}

module.exports = { enqueue, recoverOnBoot };

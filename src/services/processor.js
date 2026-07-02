const fsp = require('fs/promises');
const path = require('path');
const config = require('../config');
const jobs = require('./jobs');
const queue = require('./queue');
const ffmpeg = require('./ffmpeg');
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

async function process(id) {
  const src = tusFilePath(id);
  try {
    await jobs.update(id, { state: 'processing' });

    // 1. Validate it is a real, playable video.
    let probe;
    try {
      probe = await ffmpeg.probe(src);
    } catch {
      throw Object.assign(new Error('not_a_video'), { code: 'not_a_video' });
    }
    const videoStream = (probe.streams || []).find((s) => s.codec_type === 'video');
    const duration = parseFloat((probe.format && probe.format.duration) || '0');
    if (!videoStream) throw Object.assign(new Error('no_video_stream'), { code: 'no_video_stream' });
    if (!VIDEO_CODECS.includes(videoStream.codec_name)) {
      throw Object.assign(new Error('unsupported_codec'), { code: 'unsupported_codec' });
    }
    if (!(duration > 0) || duration > config.MAX_DURATION_SEC) {
      throw Object.assign(new Error('invalid_duration'), { code: 'invalid_duration' });
    }

    // 2. Publish: webm passes through, h264 is remuxed (fast, lossless), and
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
      await ffmpeg.transcodeToH264(src, tmpPath);
    } else {
      await ffmpeg.remuxToMp4(src, tmpPath);
    }
    await fsp.rename(tmpPath, finalPath);

    // 3. Thumbnail from the published file.
    const thumbPath = path.join(config.THUMBS_DIR, `${id}.jpg`);
    try {
      await ffmpeg.makeThumbnail(finalPath, thumbPath, Math.min(3, duration / 2));
    } catch (err) {
      logger.warn({ id, err: err.message }, 'thumbnail generation failed');
    }

    // 4. Cleanup tus temp files.
    await fsp.rm(src, { force: true });
    await fsp.rm(`${src}.json`, { force: true });

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
  } catch (err) {
    logger.error({ id, err: err.message }, 'processing failed');
    await fsp.rm(src, { force: true }).catch(() => {});
    await fsp.rm(`${src}.json`, { force: true }).catch(() => {});
    await jobs.update(id, { state: 'failed', error: err.code || 'processing_error' });
  }
}

function enqueue(id) {
  queue.push(() => process(id));
}

// Re-enqueue jobs interrupted by a crash/restart. Uploads still in
// 'uploading' state are left alone — tus resumes them.
function recoverOnBoot() {
  const stuck = jobs.listByState(['queued', 'processing']);
  stuck.forEach((job) => {
    logger.info({ id: job.id }, 'recovering interrupted job');
    enqueue(job.id);
  });
}

module.exports = { enqueue, recoverOnBoot };

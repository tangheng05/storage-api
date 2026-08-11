require('dotenv').config();

const path = require('path');

const required = ['UPLOAD_API_KEY'];
const missing = required.filter((key) => !process.env[key]);
if (missing.length) {
  // eslint-disable-next-line no-console
  console.error(`Missing required env vars: ${missing.join(', ')}`);
  process.exit(1);
}

const resolveDir = (value, fallback) => path.resolve(value || fallback);

module.exports = {
  PORT: parseInt(process.env.PORT, 10) || 8080,
  PUBLIC_BASE_URL: (process.env.PUBLIC_BASE_URL || 'http://localhost:8080').replace(/\/$/, ''),
  UPLOAD_API_KEY: process.env.UPLOAD_API_KEY,
  UPLOAD_KEY_HEADER: 'x-upload-key',

  TUS_DIR: resolveDir(process.env.TUS_DIR, './data/tus'),
  JOBS_DIR: resolveDir(process.env.JOBS_DIR, './data/jobs'),
  VIDEOS_DIR: resolveDir(process.env.VIDEOS_DIR, './data/videos'),
  THUMBS_DIR: resolveDir(process.env.THUMBS_DIR, './data/thumbnails'),
  AUDIO_DIR: resolveDir(process.env.AUDIO_DIR, './data/audio'),
  IMAGES_DIR: resolveDir(process.env.IMAGES_DIR, './data/images'),

  // Paywalled media. nginx must NOT map these publicly — they are reachable only
  // through /media/... with a valid signature. Kept as sibling dirs of the public
  // ones so a visibility change is a rename on the same filesystem, not a copy.
  PRIVATE_VIDEOS_DIR: resolveDir(
    process.env.PRIVATE_VIDEOS_DIR,
    './data/private/videos',
  ),
  PRIVATE_AUDIO_DIR: resolveDir(
    process.env.PRIVATE_AUDIO_DIR,
    './data/private/audio',
  ),
  PRIVATE_IMAGES_DIR: resolveDir(
    process.env.PRIVATE_IMAGES_DIR,
    './data/private/images',
  ),

  // Shared with serey-api, which mints the signatures. Empty means signed
  // delivery is unconfigured and /media/... will refuse to serve anything.
  MEDIA_SIGNING_SECRET: process.env.MEDIA_SIGNING_SECRET || '',
  // How long a minted URL stays valid. Short enough that a copied link is close
  // to useless, long enough to watch a whole video without the src expiring
  // mid-playback (range requests re-fetch with the same query string).
  MEDIA_URL_TTL_SEC: parseInt(process.env.MEDIA_URL_TTL_SEC, 10) || 6 * 60 * 60,
  // In production nginx streams the bytes after we authorize, via an internal
  // location. Off locally, where Express reads the file itself.
  USE_X_ACCEL: process.env.USE_X_ACCEL === 'true',
  X_ACCEL_PREFIX: (process.env.X_ACCEL_PREFIX || '/internal-media').replace(
    /\/$/,
    '',
  ),

  MAX_UPLOAD_BYTES: parseInt(process.env.MAX_UPLOAD_BYTES, 10) || 2 * 1024 * 1024 * 1024,
  MAX_DURATION_SEC: parseInt(process.env.MAX_DURATION_SEC, 10) || 14400,
  MAX_AUDIO_DURATION_SEC: parseInt(process.env.MAX_AUDIO_DURATION_SEC, 10) || 14400,
  UPLOAD_EXPIRY_MS: parseInt(process.env.UPLOAD_EXPIRY_MS, 10) || 24 * 60 * 60 * 1000,

  // Images are capped far below MAX_UPLOAD_BYTES: tus's global maxSize is sized
  // for video, so the per-type limit is enforced in onUploadCreate instead.
  MAX_IMAGE_BYTES: parseInt(process.env.MAX_IMAGE_BYTES, 10) || 20 * 1024 * 1024,
  // Long-edge cap. A 20MB upload can be 10000px wide; publishing that to a feed
  // wastes bandwidth for no visible gain. Smaller images are never upscaled.
  MAX_IMAGE_DIMENSION: parseInt(process.env.MAX_IMAGE_DIMENSION, 10) || 2560,
  IMAGE_WEBP_QUALITY: parseInt(process.env.IMAGE_WEBP_QUALITY, 10) || 82,
  // Guards against decompression bombs: a few-KB PNG can expand to gigapixels.
  MAX_IMAGE_PIXELS: parseInt(process.env.MAX_IMAGE_PIXELS, 10) || 100 * 1000 * 1000,

  ALLOWED_ORIGINS: (process.env.ALLOWED_ORIGINS || '*').split(',').map((s) => s.trim()),
  TRUST_PROXY_HOPS: parseInt(process.env.TRUST_PROXY_HOPS, 10) || 2,
  CREATES_PER_HOUR: parseInt(process.env.CREATES_PER_HOUR, 10) || 30,

  FFMPEG_PATH: process.env.FFMPEG_PATH || 'ffmpeg',
  FFPROBE_PATH: process.env.FFPROBE_PATH || 'ffprobe',
};

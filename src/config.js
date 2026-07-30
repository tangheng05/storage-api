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

  ALLOWED_ORIGINS: (process.env.ALLOWED_ORIGINS || '*').split(',').map((s) => s.trim()),
  TRUST_PROXY_HOPS: parseInt(process.env.TRUST_PROXY_HOPS, 10) || 2,
  CREATES_PER_HOUR: parseInt(process.env.CREATES_PER_HOUR, 10) || 30,

  FFMPEG_PATH: process.env.FFMPEG_PATH || 'ffmpeg',
  FFPROBE_PATH: process.env.FFPROBE_PATH || 'ffprobe',
};

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
const trimSlash = (value) => (value || '').replace(/\/$/, '');
const csv = (value, fallback) =>
  (value || fallback).split(',').map((s) => s.trim()).filter(Boolean);

// parseInt(x, 10) || d discards a legitimate 0 — TRUST_PROXY_HOPS=0 and
// SCAN_PHASH_DISTANCE=0 are both meaningful and were being overridden.
const num = (value, fallback) => {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const PUBLIC_BASE_URL = trimSlash(process.env.PUBLIC_BASE_URL) || 'http://localhost:8080';

module.exports = {
  PORT: num(process.env.PORT, 8080),
  PUBLIC_BASE_URL,
  UPLOAD_API_KEY: process.env.UPLOAD_API_KEY,
  UPLOAD_KEY_HEADER: 'x-upload-key',
  // Operator key for /moderation. Deliberately separate from UPLOAD_API_KEY,
  // which serey-api and CI both hold. Unset disables the routes.
  MODERATION_API_KEY: process.env.MODERATION_API_KEY || '',

  TUS_DIR: resolveDir(process.env.TUS_DIR, './data/tus'),
  JOBS_DIR: resolveDir(process.env.JOBS_DIR, './data/jobs'),
  VIDEOS_DIR: resolveDir(process.env.VIDEOS_DIR, './data/videos'),
  THUMBS_DIR: resolveDir(process.env.THUMBS_DIR, './data/thumbnails'),
  AUDIO_DIR: resolveDir(process.env.AUDIO_DIR, './data/audio'),
  IMAGES_DIR: resolveDir(process.env.IMAGES_DIR, './data/images'),

  // Conversion output waits here for the scan gate. nginx must NOT serve these.
  PENDING_VIDEOS_DIR: resolveDir(process.env.PENDING_VIDEOS_DIR, './data/pending/videos'),
  PENDING_AUDIO_DIR: resolveDir(process.env.PENDING_AUDIO_DIR, './data/pending/audio'),
  PENDING_IMAGES_DIR: resolveDir(process.env.PENDING_IMAGES_DIR, './data/pending/images'),
  PENDING_THUMBS_DIR: resolveDir(process.env.PENDING_THUMBS_DIR, './data/pending/thumbnails'),

  // Paywalled. nginx must NOT map these publicly; reachable only through
  // /media/... with a valid signature.
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

  // Shared with serey-api, which mints the signatures. Empty means /media/
  // serves nothing.
  MEDIA_SIGNING_SECRET: process.env.MEDIA_SIGNING_SECRET || '',
  // In prod nginx streams the bytes after we authorize. Off locally.
  USE_X_ACCEL: process.env.USE_X_ACCEL === 'true',
  X_ACCEL_PREFIX: (process.env.X_ACCEL_PREFIX || '/internal-media').replace(
    /\/$/,
    '',
  ),

  MAX_UPLOAD_BYTES: num(process.env.MAX_UPLOAD_BYTES, 2 * 1024 * 1024 * 1024),
  MAX_DURATION_SEC: num(process.env.MAX_DURATION_SEC, 14400),
  MAX_AUDIO_DURATION_SEC: num(process.env.MAX_AUDIO_DURATION_SEC, 14400),
  UPLOAD_EXPIRY_MS: num(process.env.UPLOAD_EXPIRY_MS, 24 * 60 * 60 * 1000),

  // tus's global maxSize is sized for video, so this is enforced in
  // onUploadCreate instead.
  MAX_IMAGE_BYTES: num(process.env.MAX_IMAGE_BYTES, 20 * 1024 * 1024),
  // Long-edge cap. Never upscales.
  MAX_IMAGE_DIMENSION: num(process.env.MAX_IMAGE_DIMENSION, 2560),
  IMAGE_WEBP_QUALITY: num(process.env.IMAGE_WEBP_QUALITY, 82),
  // Guards against decompression bombs: a few-KB PNG can expand to gigapixels.
  MAX_IMAGE_PIXELS: num(process.env.MAX_IMAGE_PIXELS, 100 * 1000 * 1000),

  ALLOWED_ORIGINS: (process.env.ALLOWED_ORIGINS || '*').split(',').map((s) => s.trim()),
  TRUST_PROXY_HOPS: num(process.env.TRUST_PROXY_HOPS, 2),
  CREATES_PER_HOUR: num(process.env.CREATES_PER_HOUR, 30),

  // s3d — premium media. Local disk stays the origin; this is the second copy.
  SIA_ENABLED: process.env.SIA_ENABLED === 'true',
  SIA_S3_ENDPOINT: process.env.SIA_S3_ENDPOINT || '',
  SIA_S3_BUCKET: process.env.SIA_S3_BUCKET || '',
  SIA_S3_ACCESS_KEY: process.env.SIA_S3_ACCESS_KEY || '',
  SIA_S3_SECRET_KEY: process.env.SIA_S3_SECRET_KEY || '',
  // s3d ignores the region but the SDK refuses to build a client without one.
  SIA_S3_REGION: process.env.SIA_S3_REGION || 'us-east-1',
  // Set it and new s3d-backed files are served from here; empty means the push
  // is a pure background backup. Existing rows are absolute and never change.
  SIA_PUBLIC_BASE_URL: (process.env.SIA_PUBLIC_BASE_URL || '').replace(/\/$/, ''),
  // Rollout dial.
  SIA_MIRROR_TYPES: (process.env.SIA_MIRROR_TYPES || 'image')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  PUBLISH_RECOVER_LIMIT: num(process.env.PUBLISH_RECOVER_LIMIT, 200),
  // The SDK has no request timeout by default, and the publish lane is
  // concurrency 1, so one hung connection would stall everything behind it.
  SIA_S3_CONNECT_TIMEOUT_MS: num(process.env.SIA_S3_CONNECT_TIMEOUT_MS, 10000),
  SIA_S3_REQUEST_TIMEOUT_MS: num(process.env.SIA_S3_REQUEST_TIMEOUT_MS, 300000),
  // 'when_required' stops the SDK sending x-amz-checksum-crc32, which gateways
  // without flexible checksum support reject.
  SIA_S3_CHECKSUMS: process.env.SIA_S3_CHECKSUMS || 'when_supported',

  // S5 — public media only. A CID *is* the permission, so an S5 publish cannot
  // be undone: fine for always-public media, fatal for anything paywalled.
  S5_ENABLED: process.env.S5_ENABLED === 'true',
  S5_NODE_URL: trimSlash(process.env.S5_NODE_URL),
  // Pre-provisioned. The account handshake is challenge/response but the docs
  // never state the body shapes, so mint a token against the node instead.
  S5_AUTH_TOKEN: process.env.S5_AUTH_TOKEN || '',
  // [http.api] domain in the node's config.toml; need not be the upload host.
  S5_DOWNLOAD_BASE_URL: trimSlash(process.env.S5_DOWNLOAD_BASE_URL),
  // Above this, uploads must go over tus.
  S5_SMALL_MAX_BYTES: num(process.env.S5_SMALL_MAX_BYTES, 10 * 1024 * 1024),
  S5_TUS_CHUNK_BYTES: num(process.env.S5_TUS_CHUNK_BYTES, 8 * 1024 * 1024),
  S5_TIMEOUT_MS: num(process.env.S5_TIMEOUT_MS, 300000),
  // Rollout dial. Anything unlisted keeps using s3d.
  S5_TYPES: csv(process.env.S5_TYPES, 'image'),
  // S5 documents no unpin route, so a delete is best effort at most. Off by
  // default rather than pretend to a takedown we cannot perform.
  S5_UNPIN_ENABLED: process.env.S5_UNPIN_ENABLED === 'true',

  // Our own hostname, ULID in the path, CID resolved server side. serey-api
  // freezes these into post rows permanently, so never let a raw CID or a
  // portal domain into one.
  MEDIA_CDN_BASE_URL: trimSlash(process.env.MEDIA_CDN_BASE_URL) || `${PUBLIC_BASE_URL}/cdn`,
  // How long the edge may keep a public media response. The bytes are content
  // addressed and never change, but the ULID that names them can be deleted, so
  // this is the window a takedown takes to disappear from Cloudflare. An hour
  // trades a little bandwidth for a takedown that actually lands; purge the CF
  // cache too if you need it immediate.
  MEDIA_CDN_CACHE_SEC: num(process.env.MEDIA_CDN_CACHE_SEC, 3600),

  // The gate is at publication, not at the storage push: exposure comes from
  // serving the bytes, so a failed file must not be reachable anywhere.
  SCAN_ENABLED: process.env.SCAN_ENABLED === 'true',
  // Cheapest first. Any single reject wins, so order only affects cost.
  SCAN_PROVIDERS: csv(process.env.SCAN_PROVIDERS, 'phash'),
  SCAN_TIMEOUT_MS: num(process.env.SCAN_TIMEOUT_MS, 30000),
  // Hashes of content already taken down, one per line. Catches re-uploads.
  SCAN_BLOCKLIST_PATH: path.resolve(process.env.SCAN_BLOCKLIST_PATH || './data/blocklist.txt'),
  // 0 is exact; 5 tolerates a re-encode or a light crop.
  SCAN_PHASH_DISTANCE: num(process.env.SCAN_PHASH_DISTANCE, 5),
  SCAN_HTTP_URL: process.env.SCAN_HTTP_URL || '',
  SCAN_HTTP_KEY: process.env.SCAN_HTTP_KEY || '',
  SCAN_HTTP_KEY_HEADER: process.env.SCAN_HTTP_KEY_HEADER || 'authorization',
  // Score bands, 0..1: reject refuses, review holds for a human.
  SCAN_REJECT_SCORE: num(process.env.SCAN_REJECT_SCORE, 0.9),
  SCAN_REVIEW_SCORE: num(process.env.SCAN_REVIEW_SCORE, 0.6),
  // Stricter for S5: no undo there, so the middle band goes to a human.
  SCAN_REJECT_SCORE_IMMUTABLE: num(process.env.SCAN_REJECT_SCORE_IMMUTABLE, 0.75),
  SCAN_REVIEW_SCORE_IMMUTABLE: num(process.env.SCAN_REVIEW_SCORE_IMMUTABLE, 0.35),
  // Fail closed: a broken scanner holds the job in 'scanning' for retry rather
  // than publishing it unchecked.
  SCAN_FAIL_OPEN: process.env.SCAN_FAIL_OPEN === 'true',
  SCAN_RECOVER_LIMIT: num(process.env.SCAN_RECOVER_LIMIT, 200),

  FFMPEG_PATH: process.env.FFMPEG_PATH || 'ffmpeg',
  FFPROBE_PATH: process.env.FFPROBE_PATH || 'ffprobe',
};

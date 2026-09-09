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

// parseInt(x, 10) || d discards a legitimate 0 -- TRUST_PROXY_HOPS=0 and SCAN_PHASH_DISTANCE=0 are meaningful.
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

  // Paywalled: nginx must NOT map these publicly, reachable only through /media/... with a valid signature.
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

  // Shared with the main API, which mints the signatures. Empty means /media/ serves nothing.
  MEDIA_SIGNING_SECRET: process.env.MEDIA_SIGNING_SECRET || '',
  USE_X_ACCEL: process.env.USE_X_ACCEL === 'true',
  X_ACCEL_PREFIX: (process.env.X_ACCEL_PREFIX || '/internal-media').replace(
    /\/$/,
    '',
  ),

  MAX_UPLOAD_BYTES: num(process.env.MAX_UPLOAD_BYTES, 2 * 1024 * 1024 * 1024),
  MAX_DURATION_SEC: num(process.env.MAX_DURATION_SEC, 14400),
  MAX_AUDIO_DURATION_SEC: num(process.env.MAX_AUDIO_DURATION_SEC, 14400),
  UPLOAD_EXPIRY_MS: num(process.env.UPLOAD_EXPIRY_MS, 24 * 60 * 60 * 1000),

  MAX_IMAGE_BYTES: num(process.env.MAX_IMAGE_BYTES, 20 * 1024 * 1024),
  MAX_IMAGE_DIMENSION: num(process.env.MAX_IMAGE_DIMENSION, 2560),
  IMAGE_QUALITY: num(process.env.IMAGE_QUALITY || process.env.IMAGE_WEBP_QUALITY, 82),
  // Guards against decompression bombs: a few-KB PNG can expand to gigapixels.
  MAX_IMAGE_PIXELS: num(process.env.MAX_IMAGE_PIXELS, 100 * 1000 * 1000),

  ALLOWED_ORIGINS: (process.env.ALLOWED_ORIGINS || '*').split(',').map((s) => s.trim()),
  TRUST_PROXY_HOPS: num(process.env.TRUST_PROXY_HOPS, 2),
  CREATES_PER_HOUR: num(process.env.CREATES_PER_HOUR, 30),

  SIA_ENABLED: process.env.SIA_ENABLED === 'true',
  SIA_S3_ENDPOINT: process.env.SIA_S3_ENDPOINT || '',
  SIA_S3_BUCKET: process.env.SIA_S3_BUCKET || '',
  SIA_S3_ACCESS_KEY: process.env.SIA_S3_ACCESS_KEY || '',
  SIA_S3_SECRET_KEY: process.env.SIA_S3_SECRET_KEY || '',
  // s3d ignores the region but the SDK refuses to build a client without one.
  SIA_S3_REGION: process.env.SIA_S3_REGION || 'us-east-1',
  // s3d keys are <visibility>/<kind>/<file>; this URL omits it, so it must already point at the bucket's public/ prefix or public media 404s and private/ leaks.
  SIA_PUBLIC_BASE_URL: (process.env.SIA_PUBLIC_BASE_URL || '').replace(/\/$/, ''),
  SIA_MIRROR_TYPES: (process.env.SIA_MIRROR_TYPES || 'image')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  PUBLISH_RECOVER_LIMIT: num(process.env.PUBLISH_RECOVER_LIMIT, 200),
  // The SDK has no request timeout by default, and the publish lane runs at concurrency 1, so one hung connection would stall everything behind it.
  SIA_S3_CONNECT_TIMEOUT_MS: num(process.env.SIA_S3_CONNECT_TIMEOUT_MS, 10000),
  SIA_S3_REQUEST_TIMEOUT_MS: num(process.env.SIA_S3_REQUEST_TIMEOUT_MS, 300000),
  // Controls whether the SDK sends x-amz-checksum-crc32, which some gateways without flexible-checksum support reject.
  SIA_S3_CHECKSUMS: process.env.SIA_S3_CHECKSUMS || 'when_supported',

  // Public media only: a CID *is* the permission, so an S5 publish cannot be undone.
  S5_ENABLED: process.env.S5_ENABLED === 'true',
  S5_NODE_URL: trimSlash(process.env.S5_NODE_URL),
  // Pre-provisioned: the account handshake's body shapes are undocumented, so mint a token against the node instead.
  S5_AUTH_TOKEN: process.env.S5_AUTH_TOKEN || '',
  S5_DOWNLOAD_BASE_URL: trimSlash(process.env.S5_DOWNLOAD_BASE_URL),
  S5_SMALL_MAX_BYTES: num(process.env.S5_SMALL_MAX_BYTES, 10 * 1024 * 1024),
  S5_TUS_CHUNK_BYTES: num(process.env.S5_TUS_CHUNK_BYTES, 8 * 1024 * 1024),
  S5_TIMEOUT_MS: num(process.env.S5_TIMEOUT_MS, 300000),
  S5_TYPES: csv(process.env.S5_TYPES, 'image'),
  S5_UNPIN_ENABLED: process.env.S5_UNPIN_ENABLED === 'true',
  // A CID can't be withdrawn once shown, so this stays off until exposing it is deliberate.
  S5_EXPOSE_CID: process.env.S5_EXPOSE_CID === 'true',

  // S5's own blobs, read back out of s3d for the node and its peers: s3d refuses a query-signed (presigned-URL) request as
  // anonymous, which is how S5 reads its store, so cdnUrls in the node's config.toml is set to point here instead.
  // Own endpoint/keys since s3d scopes buckets to the user that made them.
  S5_BLOB_ENABLED: process.env.S5_BLOB_ENABLED === 'true',
  S5_BLOB_S3_ENDPOINT: process.env.S5_BLOB_S3_ENDPOINT || process.env.SIA_S3_ENDPOINT || '',
  S5_BLOB_S3_BUCKET: process.env.S5_BLOB_S3_BUCKET || '',
  S5_BLOB_S3_ACCESS_KEY: process.env.S5_BLOB_S3_ACCESS_KEY || '',
  S5_BLOB_S3_SECRET_KEY: process.env.S5_BLOB_S3_SECRET_KEY || '',
  S5_BLOB_CACHE_SEC: num(process.env.S5_BLOB_CACHE_SEC, 31536000),

  // The main API freezes this into post rows permanently, so never let a raw CID or portal domain into it.
  MEDIA_CDN_BASE_URL: trimSlash(process.env.MEDIA_CDN_BASE_URL) || `${PUBLIC_BASE_URL}/cdn`,
  // How long a takedown takes to clear Cloudflare's edge; purge the CF cache too if it must be immediate.
  MEDIA_CDN_CACHE_SEC: num(process.env.MEDIA_CDN_CACHE_SEC, 3600),

  // Gate is at publication, not the storage push -- a failed file must not be reachable anywhere.
  SCAN_ENABLED: process.env.SCAN_ENABLED === 'true',
  // Cheapest first; any single reject wins, so order only affects cost.
  SCAN_PROVIDERS: csv(process.env.SCAN_PROVIDERS, 'phash'),
  SCAN_TIMEOUT_MS: num(process.env.SCAN_TIMEOUT_MS, 30000),
  SCAN_BLOCKLIST_PATH: path.resolve(process.env.SCAN_BLOCKLIST_PATH || './data/blocklist.txt'),
  // Keyed by phash: the classifier isn't deterministic (same file has scored 0.45 then 0.85), so a retry gets the first verdict instead of a re-roll.
  SCAN_CACHE_ENABLED: process.env.SCAN_CACHE_ENABLED !== 'false',
  SCAN_CACHE_PATH: path.resolve(process.env.SCAN_CACHE_PATH || './data/scan-cache.json'),
  SCAN_CACHE_TTL_SEC: num(process.env.SCAN_CACHE_TTL_SEC, 24 * 60 * 60),
  SCAN_CACHE_MAX: num(process.env.SCAN_CACHE_MAX, 5000),
  // 0 is exact; 5 tolerates a re-encode or a light crop.
  SCAN_PHASH_DISTANCE: num(process.env.SCAN_PHASH_DISTANCE, 5),
  SCAN_HTTP_URL: process.env.SCAN_HTTP_URL || '',
  SCAN_VISION_API_KEY: process.env.SCAN_VISION_API_KEY || '',
  // Only 'adult'/'violence' by default: 'racy' fires on swimwear/ordinary photography, 'medical' on legitimate health content, 'spoof' just means "looks like a meme".
  SCAN_VISION_CATEGORIES: csv(process.env.SCAN_VISION_CATEGORIES, 'adult,violence'),
  // Image is scored against a responseSchema (asked directly), not via safetyRatings -- those rate the model's own answer, not the input image, so they're useless here.
  SCAN_GEMINI_API_KEY: process.env.SCAN_GEMINI_API_KEY || '',
  SCAN_GEMINI_MODEL: process.env.SCAN_GEMINI_MODEL || 'gemini-2.5-flash',
  // 'weapons' is deliberately out: a legitimate firearm photo rates 100 there, not a takedown reason on a social platform.
  SCAN_GEMINI_CATEGORIES: csv(process.env.SCAN_GEMINI_CATEGORIES, 'sexual,violence'),
  SCAN_VIDEO_FRAMES: num(process.env.SCAN_VIDEO_FRAMES, 1),
  SCAN_HTTP_KEY: process.env.SCAN_HTTP_KEY || '',
  SCAN_HTTP_KEY_HEADER: process.env.SCAN_HTTP_KEY_HEADER || 'authorization',
  // Score (0..1) to refuse at. Single threshold, no review band: a borderline file is refused and told the category, rather than published and unretractable.
  SCAN_REJECT_SCORE: num(process.env.SCAN_REJECT_SCORE, 0.6),
  // Stricter for S5, because that publish cannot be undone.
  SCAN_REJECT_SCORE_IMMUTABLE: num(process.env.SCAN_REJECT_SCORE_IMMUTABLE, 0.5),
  SCAN_FAIL_OPEN: process.env.SCAN_FAIL_OPEN === 'true',
  SCAN_RECOVER_LIMIT: num(process.env.SCAN_RECOVER_LIMIT, 200),

  FFMPEG_PATH: process.env.FFMPEG_PATH || 'ffmpeg',
  FFPROBE_PATH: process.env.FFPROBE_PATH || 'ffprobe',
};

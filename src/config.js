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
  // Lossy quality for whichever of webp/jpeg we write. PNG is lossless and
  // ignores it.
  IMAGE_QUALITY: num(process.env.IMAGE_QUALITY || process.env.IMAGE_WEBP_QUALITY, 82),
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
  // Whether a client may see the CID of its own public media. A CID is a
  // permanent public handle that cannot be withdrawn once shown, so this stays
  // off until showing it is a decision someone made on purpose.
  S5_EXPOSE_CID: process.env.S5_EXPOSE_CID === 'true',

  // S5's own blobs, read back out of s3d for the node and for its peers.
  //
  // S5's S3 store reads exclusively through presigned URLs. s3d authenticates
  // on the Authorization header only, treats a query-signed request as
  // anonymous, and refuses anonymous reads outright — so every read failed, and
  // the node reported it as an integrity error because it hashed the 403 body.
  // Setting cdnUrls in the node's config.toml makes it build a plain URL
  // instead; this route is what that URL points at.
  //
  // Its own endpoint and credentials, not the mirror's: premium may keep s3d
  // switched off entirely, and s3d scopes buckets to the user that made them,
  // so S5's bucket needs S5's own key.
  S5_BLOB_ENABLED: process.env.S5_BLOB_ENABLED === 'true',
  S5_BLOB_S3_ENDPOINT: process.env.S5_BLOB_S3_ENDPOINT || process.env.SIA_S3_ENDPOINT || '',
  S5_BLOB_S3_BUCKET: process.env.S5_BLOB_S3_BUCKET || '',
  S5_BLOB_S3_ACCESS_KEY: process.env.S5_BLOB_S3_ACCESS_KEY || '',
  S5_BLOB_S3_SECRET_KEY: process.env.S5_BLOB_S3_SECRET_KEY || '',
  // Blobs are named by their own hash, so a response can never go stale.
  S5_BLOB_CACHE_SEC: num(process.env.S5_BLOB_CACHE_SEC, 31536000),

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
  /*
  | Verdict cache, keyed by perceptual hash.
  |
  | The classifier is not deterministic: the same file has scored 0.45 and 0.85
  | on consecutive uploads, either side of the threshold. Without a cache that
  | makes a retry a re-roll -- a refused user simply uploads again until they
  | get a low score, and a legitimate image fails once and passes the next time.
  | Remembering the first verdict for a given image makes the answer stable and
  | takes the dice away.
  |
  | The TTL bounds a wrong answer in either direction, which matters because
  | there is no review queue to appeal to.
  */
  SCAN_CACHE_ENABLED: process.env.SCAN_CACHE_ENABLED !== 'false',
  SCAN_CACHE_PATH: path.resolve(process.env.SCAN_CACHE_PATH || './data/scan-cache.json'),
  SCAN_CACHE_TTL_SEC: num(process.env.SCAN_CACHE_TTL_SEC, 24 * 60 * 60),
  // Oldest entries are dropped past this. Each is well under 200 bytes.
  SCAN_CACHE_MAX: num(process.env.SCAN_CACHE_MAX, 5000),
  // 0 is exact; 5 tolerates a re-encode or a light crop.
  SCAN_PHASH_DISTANCE: num(process.env.SCAN_PHASH_DISTANCE, 5),
  SCAN_HTTP_URL: process.env.SCAN_HTTP_URL || '',
  // Google Cloud Vision SafeSearch. Plain API key, no SDK, 1000 images/month
  // free. Enable the Vision API on the key or every call 403s.
  SCAN_VISION_API_KEY: process.env.SCAN_VISION_API_KEY || '',
  // Which SafeSearch categories count. Only 'adult' and 'violence' by default.
  // 'racy' fires on swimwear, tight clothing and a lot of ordinary photography,
  // so it would refuse a great deal of nothing; 'medical' fires on
  // legitimate health content; 'spoof' just means "looks like a meme". Add them
  // only if you want that traffic.
  SCAN_VISION_CATEGORIES: csv(process.env.SCAN_VISION_CATEGORIES, 'adult,violence'),
  // Gemini, as an alternative to Vision. Its safetyRatings are read directly
  // rather than prompting it to classify -- a prompt can drift between model
  // versions and can be refused, a rating cannot. An AI Studio key works as is,
  // with no API to enable.
  SCAN_GEMINI_API_KEY: process.env.SCAN_GEMINI_API_KEY || '',
  // Whatever your key has access to. Flash models are the cheap ones.
  SCAN_GEMINI_MODEL: process.env.SCAN_GEMINI_MODEL || 'gemini-2.5-flash',
  // What counts, of sexual / violence / weapons. 'weapons' is deliberately out:
  // a legitimate photo of a firearm rates 100 there, and a gun in a picture is
  // not a takedown reason on a social platform.
  SCAN_GEMINI_CATEGORIES: csv(process.env.SCAN_GEMINI_CATEGORIES, 'sexual,violence'),
  // Frames sampled per video, spread across its duration. 1 scans only the
  // generated thumbnail, which catches an opening frame and misses a video that
  // turns bad later. Each extra frame is another classifier call.
  SCAN_VIDEO_FRAMES: num(process.env.SCAN_VIDEO_FRAMES, 1),
  SCAN_HTTP_KEY: process.env.SCAN_HTTP_KEY || '',
  SCAN_HTTP_KEY_HEADER: process.env.SCAN_HTTP_KEY_HEADER || 'authorization',
  // The single score, 0..1, at or above which an upload is refused. There is no
  // review band: with no human in the loop, a borderline file is refused and the
  // uploader is told the category, rather than published and unretractable.
  //
  // These defaults are what the review band used to start at, NOT the old
  // reject scores -- raising them back to 0.9 would publish everything the old
  // gate held for a person.
  SCAN_REJECT_SCORE: num(process.env.SCAN_REJECT_SCORE, 0.6),
  // Stricter for S5, because that publish cannot be undone.
  SCAN_REJECT_SCORE_IMMUTABLE: num(process.env.SCAN_REJECT_SCORE_IMMUTABLE, 0.5),
  // Fail closed: a broken scanner holds the job in 'scanning' for retry rather
  // than publishing it unchecked.
  SCAN_FAIL_OPEN: process.env.SCAN_FAIL_OPEN === 'true',
  SCAN_RECOVER_LIMIT: num(process.env.SCAN_RECOVER_LIMIT, 200),

  FFMPEG_PATH: process.env.FFMPEG_PATH || 'ffmpeg',
  FFPROBE_PATH: process.env.FFPROBE_PATH || 'ffprobe',
};

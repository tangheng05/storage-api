const path = require('path');
const crypto = require('crypto');
const { checkDiskSpace } = require('./utils/disk');
const { Server } = require('@tus/server');
const { FileStore } = require('@tus/file-store');
const { ulid } = require('ulid');
const config = require('./config');
const { isAuthorized, matchesUploadToken } = require('./middleware/auth');
const jobs = require('./services/jobs');
const processor = require('./services/processor');

const ALLOWED_VIDEO_TYPES = [
  'video/mp4',
  'video/quicktime',
  'video/x-matroska',
  'video/webm',
  'video/x-msvideo',
];
const ALLOWED_VIDEO_EXT = ['.mp4', '.mov', '.mkv', '.webm', '.avi', '.m4v'];

const ALLOWED_AUDIO_TYPES = [
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/x-wav',
  'audio/wave',
  'audio/mp4',
  'audio/x-m4a',
  'audio/aac',
  'audio/ogg',
  'audio/opus',
  'audio/flac',
  'audio/x-flac',
];
const ALLOWED_AUDIO_EXT = ['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.opus', '.flac'];

// Everything sharp's bundled libvips can decode, minus two deliberate omissions:
//   BMP  — not in the prebuilt libvips (needs the magick loader), so accepting
//          it here would mean a clean 415 at create time turning into a much
//          more confusing 'not_an_image' failure after a full upload.
//   SVG  — it is a script-bearing document, not a photo. Rasterising untrusted
//          SVG is an attack surface, and flattening it to WebP throws away the
//          only reason to use it.
const ALLOWED_IMAGE_TYPES = [
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/tiff',
  'image/avif',
  // iPhone default since iOS 11. sharp's prebuilt libvips decodes these, so
  // unlike HEVC video they need no transcode toolchain of their own.
  'image/heic',
  'image/heif',
  'image/heic-sequence',
  'image/heif-sequence',
];
const ALLOWED_IMAGE_EXT = [
  '.jpg', '.jpeg', '.png', '.webp', '.gif', '.tif', '.tiff', '.avif', '.heic', '.heif',
];

// Which status route X-Status-Url should point the uploader at.
const STATUS_PATHS = { video: 'videos', audio: 'audio', image: 'images' };

const tusServer = new Server({
  path: '/files',
  respectForwardedHeaders: true,
  maxSize: config.MAX_UPLOAD_BYTES,
  datastore: new FileStore({
    directory: config.TUS_DIR,
    expirationPeriodInMilliseconds: config.UPLOAD_EXPIRY_MS,
  }),
  namingFunction: () => ulid(),
  generateUrl(req, { proto, host, path: p, id }) {
    return `${config.PUBLIC_BASE_URL}${p}/${id}`;
  },

  async onIncomingRequest(req, res, uploadId) {
    if (req.method === 'OPTIONS') return;
    if (isAuthorized(req)) return;
    // POST (creating a new upload) has no uploadId yet and always requires the
    // master key — only trusted server-to-server callers may create uploads.
    // PATCH/HEAD on an existing upload may instead present the scoped token
    // handed out at creation time (see onUploadCreate below), so browsers can
    // PATCH chunks directly here without ever holding the master key.
    if (uploadId) {
      const job = await jobs.get(uploadId);
      if (job && job.state === 'uploading' && matchesUploadToken(req, job.upload_token)) {
        return;
      }
    }
    throw { status_code: 401, body: 'Invalid or missing upload key' };
  },

  async onUploadCreate(req, res, upload) {
    const meta = upload.metadata || {};
    const ext = path.extname(meta.filename || '').toLowerCase();
    const isVideo = ALLOWED_VIDEO_TYPES.includes(meta.filetype) && ALLOWED_VIDEO_EXT.includes(ext);
    const isAudio = ALLOWED_AUDIO_TYPES.includes(meta.filetype) && ALLOWED_AUDIO_EXT.includes(ext);
    const isImage = ALLOWED_IMAGE_TYPES.includes(meta.filetype) && ALLOWED_IMAGE_EXT.includes(ext);
    if (!isVideo && !isAudio && !isImage) {
      throw {
        status_code: 415,
        body: 'Unsupported file type. Allowed video: mp4, mov, mkv, webm, avi. Allowed audio: mp3, wav, m4a, aac, ogg, opus, flac. Allowed image: jpg, png, webp, gif, tiff, avif, heic',
      };
    }
    if (!upload.size) {
      throw { status_code: 400, body: 'Upload-Length is required (deferred length not supported)' };
    }
    let mediaType = 'video';
    if (isAudio) mediaType = 'audio';
    if (isImage) mediaType = 'image';
    // The tus store's global maxSize is sized for video, so the much tighter
    // image limit is enforced here — at create time, before a single byte is
    // sent, rather than after a 200MB upload has already crossed the wire.
    if (isImage && upload.size > config.MAX_IMAGE_BYTES) {
      throw {
        status_code: 413,
        body: `Image too large (max ${Math.floor(config.MAX_IMAGE_BYTES / (1024 * 1024))}MB)`,
      };
    }
    // Remux/transcode needs roughly 2x the file size transiently; keep a safety margin.
    let publishDir = config.VIDEOS_DIR;
    if (isAudio) publishDir = config.AUDIO_DIR;
    if (isImage) publishDir = config.IMAGES_DIR;
    const free = await checkDiskSpace(publishDir);
    if (free !== null && free < upload.size * 2 + 5 * 1024 * 1024 * 1024) {
      throw { status_code: 507, body: 'Insufficient storage, try again later' };
    }
    // Scoped to this one upload id — lets the browser PATCH chunks directly
    // to this endpoint without ever holding the master UPLOAD_API_KEY.
    // Only valid while the job is still 'uploading' (see onIncomingRequest).
    const uploadToken = crypto.randomBytes(24).toString('hex');
    await jobs.create(upload.id, {
      state: 'uploading',
      media_type: mediaType,
      filename: meta.filename,
      filetype: meta.filetype,
      size: upload.size,
      upload_token: uploadToken,
      // Verified username set by the trusted caller (only master-key holders
      // can create uploads). DELETE enforces it via x-delete-owner.
      owner: meta.owner || null,
    });
    res.setHeader('X-Upload-Token', uploadToken);
    return res;
  },

  async onUploadFinish(req, res, upload) {
    const job = await jobs.update(upload.id, { state: 'queued' });
    processor.enqueue(upload.id, job.media_type);
    const statusPath = STATUS_PATHS[job.media_type] || 'videos';
    return {
      res,
      status_code: 204,
      headers: {
        'X-Video-Id': upload.id,
        'X-Status-Url': `${config.PUBLIC_BASE_URL}/${statusPath}/${upload.id}/status`,
      },
    };
  },
});

module.exports = tusServer;

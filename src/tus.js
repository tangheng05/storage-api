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

// What sharp's bundled libvips decodes, minus BMP and SVG (rasterising
// untrusted SVG is an attack surface).
const ALLOWED_IMAGE_TYPES = [
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/tiff',
  'image/avif',
  'image/heic',
  'image/heif',
  'image/heic-sequence',
  'image/heif-sequence',
];
const ALLOWED_IMAGE_EXT = [
  '.jpg', '.jpeg', '.png', '.webp', '.gif', '.tif', '.tiff', '.avif', '.heic', '.heif',
];

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
    // PATCH/HEAD may present the scoped token from creation instead of the master key.
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
    // Enforced here, before a byte is sent: the store's global maxSize is sized for video.
    if (isImage && upload.size > config.MAX_IMAGE_BYTES) {
      throw {
        status_code: 413,
        body: `Image too large (max ${Math.floor(config.MAX_IMAGE_BYTES / (1024 * 1024))}MB)`,
      };
    }
    // Remux/transcode needs ~2x the file size transiently, checked against the pending dir.
    let publishDir = config.PENDING_VIDEOS_DIR;
    if (isAudio) publishDir = config.PENDING_AUDIO_DIR;
    if (isImage) publishDir = config.PENDING_IMAGES_DIR;
    const free = await checkDiskSpace(publishDir);
    if (free !== null && free < upload.size * 2 + 5 * 1024 * 1024 * 1024) {
      throw { status_code: 507, body: 'Insufficient storage, try again later' };
    }
    // Scoped to this upload id and only while it is still 'uploading'.
    const uploadToken = crypto.randomBytes(24).toString('hex');
    await jobs.create(upload.id, {
      state: 'uploading',
      media_type: mediaType,
      filename: meta.filename,
      filetype: meta.filetype,
      size: upload.size,
      upload_token: uploadToken,
      owner: meta.owner || null,
      // Permanent for public media: it goes to S5, whose CIDs cannot be
      // revoked, so it can never become premium later (media.js refuses
      // that flip).
      visibility: meta.visibility === 'private' ? 'private' : 'public',
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

const path = require('path');
const { checkDiskSpace } = require('./utils/disk');
const { Server } = require('@tus/server');
const { FileStore } = require('@tus/file-store');
const { ulid } = require('ulid');
const config = require('./config');
const { isAuthorized } = require('./middleware/auth');
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
    if (!isAuthorized(req)) {
      throw { status_code: 401, body: 'Invalid or missing upload key' };
    }
  },

  async onUploadCreate(req, res, upload) {
    const meta = upload.metadata || {};
    const ext = path.extname(meta.filename || '').toLowerCase();
    const isVideo = ALLOWED_VIDEO_TYPES.includes(meta.filetype) && ALLOWED_VIDEO_EXT.includes(ext);
    const isAudio = ALLOWED_AUDIO_TYPES.includes(meta.filetype) && ALLOWED_AUDIO_EXT.includes(ext);
    if (!isVideo && !isAudio) {
      throw {
        status_code: 415,
        body: 'Unsupported file type. Allowed video: mp4, mov, mkv, webm, avi. Allowed audio: mp3, wav, m4a, aac, ogg, opus, flac',
      };
    }
    if (!upload.size) {
      throw { status_code: 400, body: 'Upload-Length is required (deferred length not supported)' };
    }
    const mediaType = isVideo ? 'video' : 'audio';
    // Remux/transcode needs roughly 2x the file size transiently; keep a safety margin.
    const publishDir = isVideo ? config.VIDEOS_DIR : config.AUDIO_DIR;
    const free = await checkDiskSpace(publishDir);
    if (free !== null && free < upload.size * 2 + 5 * 1024 * 1024 * 1024) {
      throw { status_code: 507, body: 'Insufficient storage, try again later' };
    }
    await jobs.create(upload.id, {
      state: 'uploading',
      media_type: mediaType,
      filename: meta.filename,
      filetype: meta.filetype,
      size: upload.size,
    });
    return res;
  },

  async onUploadFinish(req, res, upload) {
    const job = await jobs.update(upload.id, { state: 'queued' });
    processor.enqueue(upload.id);
    const statusPath = job.media_type === 'audio' ? 'audio' : 'videos';
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

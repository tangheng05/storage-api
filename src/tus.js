const path = require('path');
const { checkDiskSpace } = require('./utils/disk');
const { Server } = require('@tus/server');
const { FileStore } = require('@tus/file-store');
const { ulid } = require('ulid');
const config = require('./config');
const { isAuthorized } = require('./middleware/auth');
const jobs = require('./services/jobs');
const processor = require('./services/processor');

const ALLOWED_TYPES = [
  'video/mp4',
  'video/quicktime',
  'video/x-matroska',
  'video/webm',
  'video/x-msvideo',
];
const ALLOWED_EXT = ['.mp4', '.mov', '.mkv', '.webm', '.avi', '.m4v'];

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
    if (!ALLOWED_TYPES.includes(meta.filetype) || !ALLOWED_EXT.includes(ext)) {
      throw { status_code: 415, body: 'Unsupported file type. Allowed: mp4, mov, mkv, webm, avi' };
    }
    if (!upload.size) {
      throw { status_code: 400, body: 'Upload-Length is required (deferred length not supported)' };
    }
    // Remux needs roughly 2x the file size transiently; keep a safety margin.
    const free = await checkDiskSpace(config.VIDEOS_DIR);
    if (free !== null && free < upload.size * 2 + 5 * 1024 * 1024 * 1024) {
      throw { status_code: 507, body: 'Insufficient storage, try again later' };
    }
    await jobs.create(upload.id, {
      state: 'uploading',
      filename: meta.filename,
      filetype: meta.filetype,
      size: upload.size,
    });
    return res;
  },

  async onUploadFinish(req, res, upload) {
    await jobs.update(upload.id, { state: 'queued' });
    processor.enqueue(upload.id);
    return {
      res,
      status_code: 204,
      headers: {
        'X-Video-Id': upload.id,
        'X-Status-Url': `${config.PUBLIC_BASE_URL}/videos/${upload.id}/status`,
      },
    };
  },
});

module.exports = tusServer;

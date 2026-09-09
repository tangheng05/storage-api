const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const pinoHttp = require('pino-http');
const config = require('./config');
const logger = require('./services/logger');
const tusServer = require('./tus');
const uploadsRouter = require('./routes/uploads');
const mediaRouter = require('./routes/media');
const cdnRouter = require('./routes/cdn');
const blobRouter = require('./routes/blob');
const moderationRouter = require('./routes/moderation');

const app = express();

// Hops in front of node: 2 = Cloudflare proxy + Nginx Proxy Manager.
app.set('trust proxy', config.TRUST_PROXY_HOPS);
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === '/health' } }));

// Mounted ahead of the origin allowlist, with its own permissive CORS: these
// bytes are fetched by S5 peers we do not control, including browsers on
// origins that are not ours.
app.use('/blob', cors({ origin: true, methods: ['GET', 'HEAD'], maxAge: 86400 }), blobRouter);

// Entries may be exact origins, "https://*.<suffix>" wildcard subdomains (communities
// live on many subdomains), or "*".
const originAllowed = (origin) =>
  config.ALLOWED_ORIGINS.some((pattern) => {
    if (pattern === '*') return true;
    if (pattern.startsWith('https://*.')) {
      const suffix = pattern.slice('https://*'.length);
      return origin.startsWith('https://') && origin.endsWith(suffix)
        && !origin.slice('https://'.length, -suffix.length).includes('/');
    }
    return origin === pattern;
  });

// Hard-reject before anything else: the cors package only omits headers on
// deny, and @tus/server's built-in CORS would otherwise reflect any origin.
app.use((req, res, next) => {
  const { origin } = req.headers;
  if (origin && !originAllowed(origin)) {
    return res.status(403).json({ error: 'Origin not allowed' });
  }
  return next();
});

const corsOptions = {
  origin: (origin, cb) => cb(null, !origin || originAllowed(origin)),
  methods: ['GET', 'POST', 'PATCH', 'HEAD', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    config.UPLOAD_KEY_HEADER,
    'Tus-Resumable',
    'Upload-Length',
    'Upload-Metadata',
    'Upload-Offset',
    'Upload-Defer-Length',
    'X-Requested-With',
    'X-HTTP-Method-Override',
  ],
  exposedHeaders: [
    'Location',
    'Upload-Offset',
    'Upload-Length',
    'Tus-Resumable',
    'Tus-Version',
    'Tus-Extension',
    'Tus-Max-Size',
    'Upload-Metadata',
    'Upload-Expires',
    'X-Video-Id',
    'X-Status-Url',
  ],
  maxAge: 86400,
};
app.use(cors(corsOptions));

// PATCH/HEAD are exempt so resumes and chunk traffic are never throttled.
const createLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: config.CREATES_PER_HOUR,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many uploads from this IP, try again later' },
});
app.post('/files', createLimiter, (req, res) => tusServer.handle(req, res));

// tus needs the raw request stream — no body parsers on these paths.
app.all('/files', (req, res) => tusServer.handle(req, res));
app.all('/files/*', (req, res) => tusServer.handle(req, res));

app.get('/health', (req, res) => res.json({ ok: true }));
// Mounted before the static fallbacks so nothing under /media is served unauthenticated.
app.use('/media', express.json({ limit: '8kb' }), mediaRouter);
// NPM forwards /moderation straight here, so the key check is the only
// barrier -- rate limit against a 401-vs-200 oracle.
const moderationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests' },
});
app.use('/moderation', moderationLimiter, express.json({ limit: '8kb' }), moderationRouter);
app.use('/cdn', cdnRouter);

app.use('/videos', uploadsRouter('videos'));
app.use('/audio', uploadsRouter('audio'));
app.use('/images', uploadsRouter('images'));

// Local/dev fallback: in production nginx serves these directly from disk.
app.use('/videos', express.static(config.VIDEOS_DIR, { immutable: true, maxAge: '365d' }));
app.use('/thumbnails', express.static(config.THUMBS_DIR, { immutable: true, maxAge: '365d' }));
app.use('/audio', express.static(config.AUDIO_DIR, { immutable: true, maxAge: '365d' }));
app.use('/images', express.static(config.IMAGES_DIR, { immutable: true, maxAge: '365d' }));

app.use((req, res) => res.status(404).json({ error: 'Not found' }));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  logger.error({ err: err.message }, 'unhandled error');
  res.status(err.status || 500).json({ error: err.status ? err.message : 'Internal server error' });
});

module.exports = app;

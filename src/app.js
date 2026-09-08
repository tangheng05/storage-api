const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const pinoHttp = require('pino-http');
const config = require('./config');
const logger = require('./services/logger');
const tusServer = require('./tus');
const videosRouter = require('./routes/videos');
const audioRouter = require('./routes/audio');
const imagesRouter = require('./routes/images');
const mediaRouter = require('./routes/media');
const cdnRouter = require('./routes/cdn');
const moderationRouter = require('./routes/moderation');

const app = express();

// Hops in front of node: 2 = Cloudflare proxy + Nginx Proxy Manager.
app.set('trust proxy', config.TRUST_PROXY_HOPS);
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === '/health' } }));

// ALLOWED_ORIGINS entries may be exact origins, wildcard-subdomain patterns
// ("https://*.serey.io"), or "*" for any origin. Communities live on many
// subdomains (bookclub.serey.io, khmer.serey.io, ...), so exact-only broke them.
const originAllowed = (origin) =>
  config.ALLOWED_ORIGINS.some((pattern) => {
    if (pattern === '*') return true;
    if (pattern.startsWith('https://*.')) {
      const suffix = pattern.slice('https://*'.length); // ".serey.io"
      return origin.startsWith('https://') && origin.endsWith(suffix)
        && !origin.slice('https://'.length, -suffix.length).includes('/');
    }
    return origin === pattern;
  });

// Hard-reject disallowed browser origins before anything else — the cors
// package only omits headers on deny, and @tus/server's built-in CORS would
// otherwise reflect any origin on the /files routes.
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

// Rate-limit new upload creations per IP. PATCH/HEAD are exempt so
// resumes and chunk traffic are never throttled.
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
// Signed delivery + visibility changes for paywalled media. Mounted before the
// static fallbacks so nothing under /media is ever served unauthenticated.
app.use('/media', express.json({ limit: '8kb' }), mediaRouter);
// NPM forwards /moderation straight here with nothing in front of it, so the
// key check is the only barrier — rate limit it rather than leave an unbounded
// 401-vs-200 oracle.
const moderationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests' },
});
app.use('/moderation', moderationLimiter, express.json({ limit: '8kb' }), moderationRouter);
// ULID -> CID resolver for public media on S5.
app.use('/cdn', cdnRouter);

app.use('/videos', videosRouter);
app.use('/audio', audioRouter);
app.use('/images', imagesRouter);

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

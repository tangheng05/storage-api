const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const pinoHttp = require('pino-http');
const config = require('./config');
const logger = require('./services/logger');
const tusServer = require('./tus');
const videosRouter = require('./routes/videos');

const app = express();

// Hops in front of node: 2 = Cloudflare proxy + Nginx Proxy Manager.
app.set('trust proxy', config.TRUST_PROXY_HOPS);
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === '/health' } }));

const corsOptions = {
  origin: config.ALLOWED_ORIGINS.includes('*') ? true : config.ALLOWED_ORIGINS,
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
app.use('/videos', videosRouter);

// Local/dev fallback: in production nginx serves these directly from disk.
app.use('/videos', express.static(config.VIDEOS_DIR, { immutable: true, maxAge: '365d' }));
app.use('/thumbnails', express.static(config.THUMBS_DIR, { immutable: true, maxAge: '365d' }));

app.use((req, res) => res.status(404).json({ error: 'Not found' }));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  logger.error({ err: err.message }, 'unhandled error');
  res.status(err.status || 500).json({ error: err.status ? err.message : 'Internal server error' });
});

module.exports = app;

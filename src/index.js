const fs = require('fs');
const config = require('./config');
const logger = require('./services/logger');

[config.TUS_DIR, config.JOBS_DIR, config.VIDEOS_DIR, config.THUMBS_DIR, config.AUDIO_DIR].forEach((dir) => {
  fs.mkdirSync(dir, { recursive: true });
});

const app = require('./app');
const tusServer = require('./tus');
const processor = require('./services/processor');

processor.recoverOnBoot();

// Remove stale incomplete uploads hourly (FileStore honors UPLOAD_EXPIRY_MS).
setInterval(() => {
  tusServer.cleanUpExpiredUploads().then((n) => {
    if (n > 0) logger.info({ removed: n }, 'cleaned up expired uploads');
  }).catch((err) => logger.error({ err: err.message }, 'expired upload cleanup failed'));
}, 60 * 60 * 1000).unref();

app.listen(config.PORT, () => {
  logger.info({ port: config.PORT, base_url: config.PUBLIC_BASE_URL }, 'serey video storage api started');
});

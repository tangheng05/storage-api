const fs = require('fs');
const config = require('./config');
const logger = require('./services/logger');

[
  config.TUS_DIR,
  config.JOBS_DIR,
  config.VIDEOS_DIR,
  config.THUMBS_DIR,
  config.AUDIO_DIR,
  config.IMAGES_DIR,
  config.PRIVATE_VIDEOS_DIR,
  config.PRIVATE_AUDIO_DIR,
  config.PRIVATE_IMAGES_DIR,
].forEach((dir) => {
  fs.mkdirSync(dir, { recursive: true });
});

const app = require('./app');
const tusServer = require('./tus');
const processor = require('./services/processor');
const mirror = require('./services/mirror');

processor.recoverOnBoot();

// Remove stale incomplete uploads hourly (FileStore honors UPLOAD_EXPIRY_MS).
setInterval(() => {
  tusServer.cleanUpExpiredUploads().then((n) => {
    if (n > 0) logger.info({ removed: n }, 'cleaned up expired uploads');
  }).catch((err) => logger.error({ err: err.message }, 'expired upload cleanup failed'));
}, 60 * 60 * 1000).unref();

app.listen(config.PORT, () => {
  logger.info({ port: config.PORT, base_url: config.PUBLIC_BASE_URL }, 'serey video storage api started');

  // Deferred on purpose. These jobs are already 'ready' and serving correctly;
  // they just never made it onto Sia, so this is durability catch-up with no
  // user waiting on it. listByState scans and parses every job file
  // synchronously, and doing that before listen would hold up accepting
  // uploads for as long as the scan takes.
  setImmediate(() => {
    try {
      mirror.recoverOnBoot();
    } catch (err) {
      logger.error({ err: err.message }, 'sia recovery sweep failed');
    }
  });
});

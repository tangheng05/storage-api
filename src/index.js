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
  config.PENDING_VIDEOS_DIR,
  config.PENDING_AUDIO_DIR,
  config.PENDING_IMAGES_DIR,
  config.PENDING_THUMBS_DIR,
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

  // Retry anything the scan gate is holding, and any storage push that failed.
  try {
    processor.sweepHeld();
    mirror.recoverOnBoot();
  } catch (err) {
    logger.error({ err: err.message }, 'hourly retry sweep failed');
  }
}, 60 * 60 * 1000).unref();

app.listen(config.PORT, () => {
  logger.info({ port: config.PORT, base_url: config.PUBLIC_BASE_URL }, 'serey video storage api started');

  // Deferred: listByState parses every job file synchronously, and these jobs
  // are already serving correctly, so nothing waits on this.
  setImmediate(() => {
    try {
      mirror.recoverOnBoot();
    } catch (err) {
      logger.error({ err: err.message }, 'storage recovery sweep failed');
    }
  });
});

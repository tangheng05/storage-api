const pino = require('pino');

module.exports = pino({
  level: process.env.LOG_LEVEL || 'info',
  // Never log request headers: the upload key travels in them.
  redact: ['req.headers', 'headers'],
});

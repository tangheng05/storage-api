const path = require('path');

// A file's mtime is the moment it was processed, and send/serve-static put it
// in Last-Modified and in the weak ETag (W/"<size>-<mtime hex>") of every
// response -- the same timestamp randomId() keeps out of the URL. A name never
// changes its bytes, so the name is the validator instead.
const NO_MTIME = { lastModified: false, etag: false };

function nameEtag(filePath) {
  return `"${path.basename(filePath)}"`;
}

module.exports = { NO_MTIME, nameEtag };

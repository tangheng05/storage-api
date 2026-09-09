const config = require('../config');
const { buildClient } = require('./sia');

// Reads S5's blobs back out of s3d. s3d authenticates on the Authorization
// header alone, so S5's presigned query-signed reads land as anonymous and
// get refused (reported as "integrity verification failed"); pointing cdnUrls
// at our own route puts the signing here instead. Own client, not the
// mirror's: s3d scopes buckets to the user that created them.

let client = null;
let commands = null;

function enabled() {
  return (
    config.S5_BLOB_ENABLED
    && !!config.S5_BLOB_S3_ENDPOINT
    && !!config.S5_BLOB_S3_BUCKET
    && !!config.S5_BLOB_S3_ACCESS_KEY
    && !!config.S5_BLOB_S3_SECRET_KEY
  );
}

function getClient() {
  if (client) return client;
  // eslint-disable-next-line global-require
  commands = require('@aws-sdk/client-s3');
  client = buildClient({
    endpoint: config.S5_BLOB_S3_ENDPOINT,
    accessKeyId: config.S5_BLOB_S3_ACCESS_KEY,
    secretAccessKey: config.S5_BLOB_S3_SECRET_KEY,
  });
  return client;
}

// null when the object is absent, so the caller can answer 404 rather than
// treating a missing blob as an outage. `range` is passed through verbatim:
// S5 reads in 256KB windows and needs the 206 to come back intact.
async function getObject({ key, range }) {
  if (!enabled()) throw new Error('s5_blob_not_configured');
  try {
    const out = await getClient().send(
      new commands.GetObjectCommand({
        Bucket: config.S5_BLOB_S3_BUCKET,
        Key: key,
        ...(range ? { Range: range } : {}),
      }),
    );
    return {
      body: out.Body,
      bytes: out.ContentLength,
      contentRange: out.ContentRange || null,
    };
  } catch (err) {
    const status = err.$metadata?.httpStatusCode;
    if (err.name === 'NoSuchKey' || err.name === 'NotFound' || status === 404) return null;
    throw err;
  }
}

module.exports = { enabled, getObject };

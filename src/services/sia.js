const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const config = require('../config');
const logger = require('./logger');

/*
| Sia s3d via the ordinary S3 SDK. No Sia-specific client because
| @siafoundation/indexd-js ships API bindings only, with no upload or download.
|
| Keys mirror the on-disk layout: <visibility>/<kind>/<ULID>.<ext>. Keeping the
| ULID means serey-api's id derivation and delete-by-id keep working; keeping
| public/ and private/ apart means a future public gateway can be scoped to
| public/ alone instead of exposing every paywalled file in the bucket.
*/

let client = null;
let Upload = null;
let commands = null;

function enabled() {
  return (
    config.SIA_ENABLED &&
    !!config.SIA_S3_ENDPOINT &&
    !!config.SIA_S3_BUCKET &&
    !!config.SIA_S3_ACCESS_KEY &&
    !!config.SIA_S3_SECRET_KEY
  );
}

/*
| Every s3d quirk the SDK needs lives here, because two callers now need a
| client against the same gateway with different credentials: this module for
| the premium mirror, and s5blob.js for S5's public blobs. s3d scopes buckets to
| the user that created them, so they cannot share one key.
*/
function buildClient({ endpoint, accessKeyId, secretAccessKey }) {
  // eslint-disable-next-line global-require
  const { S3Client } = require('@aws-sdk/client-s3');
  // eslint-disable-next-line global-require
  const { NodeHttpHandler } = require('@smithy/node-http-handler');
  return new S3Client({
    endpoint,
    region: config.SIA_S3_REGION,
    credentials: { accessKeyId, secretAccessKey },
    // s3d addresses buckets by path, not by DNS subdomain.
    forcePathStyle: true,
    // The SDK ships no request timeout at all, and the publish lane is
    // concurrency 1, so one hung socket would stall everything behind it.
    requestHandler: new NodeHttpHandler({
      connectionTimeout: config.SIA_S3_CONNECT_TIMEOUT_MS,
      requestTimeout: config.SIA_S3_REQUEST_TIMEOUT_MS,
    }),
    // s3d is not AWS: if it lacks flexible checksums it rejects the CRC32
    // headers the SDK sends by default. 'when_required' is the way out.
    requestChecksumCalculation: config.SIA_S3_CHECKSUMS,
    responseChecksumValidation: config.SIA_S3_CHECKSUMS,
  });
}

// Lazy so the SDK need not even be installed on a deployment that skips s3d.
function getClient() {
  if (client) return client;
  // eslint-disable-next-line global-require
  commands = require('@aws-sdk/client-s3');
  // eslint-disable-next-line global-require
  ({ Upload } = require('@aws-sdk/lib-storage'));
  client = buildClient({
    endpoint: config.SIA_S3_ENDPOINT,
    accessKeyId: config.SIA_S3_ACCESS_KEY,
    secretAccessKey: config.SIA_S3_SECRET_KEY,
  });
  return client;
}

function buildKey({ kind, file, visibility = 'public' }) {
  return `${visibility}/${kind}/${file}`;
}

const CONTENT_TYPES = {
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpeg': 'image/jpeg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.m4a': 'audio/mp4',
  '.jpg': 'image/jpeg',
};

function contentTypeFor(file) {
  return CONTENT_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

// lib-storage's Upload rather than PutObject, so a 2GB video becomes a
// multipart upload instead of one request s3d would reject.
async function putFile({ key, filePath }) {
  if (!enabled()) throw new Error('sia_not_configured');
  const { size } = await fsp.stat(filePath);

  // Must run before Upload is referenced: it is what populates the binding.
  // `new Upload(...)` resolves the callee first, so inlining this below would
  // read Upload while it is still null.
  const s3 = getClient();
  const upload = new Upload({
    client: s3,
    params: {
      Bucket: config.SIA_S3_BUCKET,
      Key: key,
      Body: fs.createReadStream(filePath),
      ContentType: contentTypeFor(key),
      ContentLength: size,
    },
  });

  await upload.done();
  return { key, bytes: size };
}

// null when absent. Proves the backup is present, not merely recorded.
async function headObject(key) {
  if (!enabled()) throw new Error('sia_not_configured');
  try {
    const out = await getClient().send(
      new commands.HeadObjectCommand({ Bucket: config.SIA_S3_BUCKET, Key: key }),
    );
    return { bytes: out.ContentLength };
  } catch (err) {
    if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) return null;
    throw err;
  }
}

// Pull an object back down to disk. This is the disaster path.
async function getToFile({ key, filePath }) {
  if (!enabled()) throw new Error('sia_not_configured');
  const out = await getClient().send(
    new commands.GetObjectCommand({ Bucket: config.SIA_S3_BUCKET, Key: key }),
  );

  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  // Temp name then rename, so an interrupted restore cannot leave a truncated
  // file where a valid one is expected.
  const tmpPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.restore`);
  await new Promise((resolve, reject) => {
    const w = fs.createWriteStream(tmpPath);
    out.Body.pipe(w).on('finish', resolve).on('error', reject);
    out.Body.on('error', reject);
  });
  await fsp.rename(tmpPath, filePath);

  const { size } = await fsp.stat(filePath);
  return { key, bytes: size };
}

async function deleteObject(key) {
  if (!enabled()) throw new Error('sia_not_configured');
  await getClient().send(
    new commands.DeleteObjectCommand({ Bucket: config.SIA_S3_BUCKET, Key: key }),
  );
}

// S3 has no rename, so this is a copy then a delete. A failed delete keeps the
// new key and logs: a duplicate costs disk, whereas failing after a successful
// copy would leave the caller thinking nothing moved.
async function moveObject({ fromKey, toKey }) {
  if (!enabled()) throw new Error('sia_not_configured');
  if (fromKey === toKey) return { key: toKey };

  await getClient().send(
    new commands.CopyObjectCommand({
      Bucket: config.SIA_S3_BUCKET,
      CopySource: `/${config.SIA_S3_BUCKET}/${fromKey}`,
      Key: toKey,
    }),
  );

  try {
    await deleteObject(fromKey);
  } catch (err) {
    logger.warn({ fromKey, toKey, err: err.message }, 'sia move copied but old key remains');
  }

  return { key: toKey };
}

module.exports = {
  buildClient,
  enabled,
  buildKey,
  putFile,
  headObject,
  getToFile,
  deleteObject,
  moveObject,
};

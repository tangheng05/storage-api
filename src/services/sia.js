const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const config = require('../config');
const logger = require('./logger');

/*
|--------------------------------------------------------------------------
| Sia object store
|--------------------------------------------------------------------------
|
| Talks to Sia Storage through its s3d gateway using the ordinary S3 SDK. There
| is deliberately no Sia-specific client here: as of September 2026
| @siafoundation/indexd-js ships API bindings only (authConnect, hosts, slabs,
| slabPin, slabDelete) with no upload or download, so S3 is the only route into
| the network from Node that actually works.
|
| Keys mirror the on-disk layout one for one:
|
|   public/images/<ULID>.webp      private/images/<ULID>.webp
|   public/videos/<ULID>.mp4       private/videos/<ULID>.mp4
|   public/audio/<ULID>.m4a        private/audio/<ULID>.m4a
|   public/thumbnails/<ULID>.jpg
|
| Two reasons for that shape. Keeping the ULID means serey-api's video id
| derivation, delete-by-id and visibility regexes all keep working if we ever
| serve from here. Keeping public/ and private/ apart means a future public
| gateway can be scoped to public/ alone, instead of exposing every paywalled
| file in the bucket the day someone opens it up.
|
| Every export is a no-op when SIA_ENABLED is false, so the service runs
| unchanged on a box with no credentials.
|
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

// Required lazily so the SDK is never loaded (and never has to be installed) on
// a deployment that does not use the mirror.
function getClient() {
  if (client) return client;
  // eslint-disable-next-line global-require
  const s3 = require('@aws-sdk/client-s3');
  // eslint-disable-next-line global-require
  ({ Upload } = require('@aws-sdk/lib-storage'));
  commands = s3;
  client = new s3.S3Client({
    endpoint: config.SIA_S3_ENDPOINT,
    region: config.SIA_S3_REGION,
    credentials: {
      accessKeyId: config.SIA_S3_ACCESS_KEY,
      secretAccessKey: config.SIA_S3_SECRET_KEY,
    },
    // s3d addresses buckets by path, not by DNS subdomain.
    forcePathStyle: true,
  });
  return client;
}

// kind is the URL segment already used everywhere else: videos, audio, images,
// thumbnails. visibility is public or private.
function buildKey({ kind, file, visibility = 'public' }) {
  return `${visibility}/${kind}/${file}`;
}

const CONTENT_TYPES = {
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.m4a': 'audio/mp4',
  '.jpg': 'image/jpeg',
};

function contentTypeFor(file) {
  return CONTENT_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

/*
| Upload a published file. Uses lib-storage's Upload rather than a plain
| PutObject so a 2GB video becomes a multipart upload automatically when video
| joins the mirror, instead of one request that s3d would reject.
|
| Returns { key, bytes }.
*/
async function putFile({ key, filePath }) {
  if (!enabled()) throw new Error('sia_not_configured');
  const { size } = await fsp.stat(filePath);

  // getClient() must run before Upload is referenced: it is what lazily loads
  // lib-storage and populates the binding. `new Upload(...)` resolves the callee
  // before evaluating its arguments, so inlining getClient() below would read
  // Upload while it is still null.
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

// Returns { bytes } or null when the object is not there. Used by the verify
// script to prove the backup is actually present, not merely recorded.
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
  // Write to a temp name and rename, so an interrupted restore can never leave
  // a truncated file sitting where a valid one is expected.
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

/*
| Move an object between the public/ and private/ prefixes. S3 has no rename, so
| this is a server side copy followed by a delete. If the delete fails we keep
| the new key and log: a duplicate object costs disk, whereas returning failure
| after a successful copy would leave the caller thinking nothing moved.
*/
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
  enabled,
  buildKey,
  putFile,
  headObject,
  getToFile,
  deleteObject,
  moveObject,
};

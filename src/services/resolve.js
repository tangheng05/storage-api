const path = require('path');
const fsp = require('fs/promises');
const config = require('./../config');
const jobs = require('./jobs');
const s5 = require('./s5');
const { exists } = require('../utils/fs');

/*
| Where a media id's bytes actually live.
|
| Three backends are in play (see services/mirror.js): public media goes to S5
| as a content-addressed CID, premium media to s3d, and either can stay on
| local disk when the push failed, was deferred, or no backend is configured.
| s3d is backup-only unless SIA_PUBLIC_BASE_URL is set, so an s3d job still
| serves off disk today.
|
| Every caller that turns an id into bytes must agree on that resolution, or a
| file that plays fine in the browser goes missing from an export. routes/cdn.js
| and routes/archive.js both go through `locate` here.
|
| `locate` makes the decision and does no byte I/O. `open` and `size` act on
| what it found.
*/

const KINDS = ['videos', 'audio', 'images', 'thumbnails'];

const LOCAL_DIRS = {
  videos: config.VIDEOS_DIR,
  audio: config.AUDIO_DIR,
  images: config.IMAGES_DIR,
  thumbnails: config.THUMBS_DIR,
};

const CONTENT_TYPES = {
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpeg': 'image/jpeg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.m4a': 'audio/mp4',
  '.jpg': 'image/jpeg',
};

// Anchored; the extension holds no dot or slash, so a filename cannot walk out
// of its namespace.
const FILE_RE = /^([0-9A-HJKMNP-TV-Z]{26})(\.[A-Za-z0-9]{1,5})$/;

const contentTypeFor = (file) =>
  CONTENT_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';

/*
| Resolves `file` (a ULID plus extension) within `kind`.
|
| Returns { ok: false, status } or { ok: true, cid, localPath, job, contentType }.
| Exactly one of cid / localPath is usable; cid wins when present.
|
| `allowPrivate` is the paywall switch, and it is not enough on its own: it
| must be paired with `owner`, the username the caller has already verified.
| Private media then resolves only for the account that uploaded it (the owner
| recorded on the job in tus.js). The CDN passes neither, because the signature
| on /media is the paywall there. Public media needs no owner check: those
| bytes are already served to anyone who asks.
*/
async function locate({ kind, file, allowPrivate = false, owner = null }) {
  if (!KINDS.includes(kind)) return { ok: false, status: 404 };

  const match = FILE_RE.exec(file || '');
  if (!match) return { ok: false, status: 400 };
  const id = match[1];

  let job;
  try {
    job = await jobs.get(id);
  } catch {
    return { ok: false, status: 400 };
  }

  // Same answer whether deleted or never-existed, so this cannot probe which
  // ids are real.
  if (!job || job.state !== 'ready') return { ok: false, status: 404 };

  // Thumbnails are exempt: published public by design, so a locked card still
  // shows its poster.
  if (job.visibility === 'private' && kind !== 'thumbnails') {
    // An owner match is required, never just the flag: otherwise any caller
    // holding the master key could pull every paywalled file in the store.
    const ownsIt = allowPrivate && owner && job.owner && job.owner === owner;
    if (!ownsIt) return { ok: false, status: 404 };
  }

  const cid = kind === 'thumbnails' ? job.s5_thumb_cid : job.s5_cid;
  const contentType = contentTypeFor(file);

  if (cid) return { ok: true, id, kind, file, cid, localPath: null, job, contentType };

  // Awaiting /promote, or s3d/local-only.
  const dir = LOCAL_DIRS[kind];
  const localPath = dir && path.join(dir, file);
  if (!localPath || !(await exists(localPath))) return { ok: false, status: 404 };

  return { ok: true, id, kind, file, cid: null, localPath, job, contentType };
}

/*
| Byte length, without reading the body.
|
| s5.stat issues a one-byte ranged GET rather than a HEAD, since the node docs
| do not commit to HEAD. Null when it cannot be determined, which the archive
| treats as "skip this file" rather than guessing: a wrong length would put a
| corrupt entry in the zip.
*/
async function size(found) {
  if (!found || !found.ok) return null;
  if (found.localPath) {
    return fsp.stat(found.localPath).then((st) => st.size).catch(() => null);
  }
  try {
    const stat = await s5.stat(found.cid);
    return stat && Number.isFinite(stat.bytes) ? stat.bytes : null;
  } catch {
    return null;
  }
}

/*
| A Node readable of the bytes. `range` is passed through to S5 for the CDN's
| seeking; the archive never sets it, since a zip entry is written whole.
*/
async function open(found, { range } = {}) {
  if (found.localPath) {
    const handle = await fsp.open(found.localPath, 'r');
    return { stream: handle.createReadStream({ autoClose: true }), status: 200, headers: null };
  }

  const upstream = await s5.fetchBlob(found.cid, { range });
  if (!upstream.ok && upstream.status !== 206) {
    if (upstream.body) await upstream.body.cancel().catch(() => {});
    const err = new Error(`s5 refused: ${upstream.status}`);
    err.status = 502;
    throw err;
  }
  return { upstream, status: upstream.status, headers: upstream.headers };
}

module.exports = { locate, size, open, KINDS, FILE_RE, contentTypeFor, LOCAL_DIRS };

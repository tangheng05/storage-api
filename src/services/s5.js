const fs = require('fs');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const fsp = require('fs/promises');
const path = require('path');
const { blake3 } = require('@noble/hashes/blake3');

const config = require('../config');
const logger = require('./logger');

/*
| S5 object store — public media only.
|
| A blob's CID is its BLAKE3 hash, so the same bytes always produce the same
| identifier and a retry is idempotent. We compute it locally but prefer the CID
| the node reports, because the documented byte layout turned out to be wrong
| (see CID_MAGIC). The cost: tus needs the hash up front, so large files are
| read twice.
|
| Publishing here cannot be undone. Premium media goes to s3d (sia.js), which
| has a private prefix and a working delete.
*/

/*
| Both constants come from a live s5-dart v0.14.1 node, NOT from the spec.
|
| docs.sfive.net says BLAKE3 is 0x1e and a blob CID is 0x5b 0x82 0x1e + hash +
| size in base16 with an 'f' prefix. A real node uses 0x1f and returns 0x26 0x1f
| + hash + size in base58btc with 'z'. The hash itself and the little-endian
| size bytes match the spec exactly; only these two things differ.
|
| 0x1f is confirmed twice over: it is the byte in CIDs the node produces, and it
| is the only prefix the node accepts in tus hash metadata. Both were found with
| scripts/s5-probe-tus.js -- rerun it against a new node version before trusting
| these again.
|
| putFile still prefers the CID the node reports, and stat() proves the object
| is retrievable before any publish is reported, so a future format change fails
| the upload instead of writing a dead URL into a post row.
*/
const BLAKE3_MULTIHASH = 0x1f;
const CID_BLOB_MAGIC = 0x26;
const CID_MAGIC = [CID_BLOB_MAGIC, BLAKE3_MULTIHASH];

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58btc(buf) {
  let n = 0n;
  for (const b of buf) n = n * 256n + BigInt(b);
  let out = '';
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of buf) {
    if (b !== 0) break;
    out = `1${out}`;
  }
  return out;
}

function enabled() {
  return config.S5_ENABLED && !!config.S5_NODE_URL && !!config.S5_AUTH_TOKEN;
}

/*
| base58btc with multibase prefix 'z':
|   byte 0-1  0x26 0x1f   magic (see CID_MAGIC)
|   byte 2-33 the BLAKE3 hash
|   byte 34+  size, little endian, trailing zero bytes trimmed
|
| The test pins this against a CID a real node returned. Keep it: nothing else
| would catch an off-by-one, and the spec cannot be used as the reference.
*/
function buildCid(hash, size) {
  const sizeBytes = [];
  let remaining = size;
  while (remaining > 0) {
    sizeBytes.push(remaining % 256);
    remaining = Math.floor(remaining / 256);
  }
  return `z${base58btc(Buffer.from([...CID_MAGIC, ...hash, ...sizeBytes]))}`;
}

// Streamed so a 2GB video is never held in memory.
async function hashFile(filePath) {
  const hasher = blake3.create({});
  const stream = fs.createReadStream(filePath, { highWaterMark: 4 * 1024 * 1024 });
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    hasher.update(chunk);
  }
  const hash = hasher.digest();
  return { cid: buildCid(hash, size), hash: Buffer.from(hash).toString('hex'), size };
}

function authHeaders(extra = {}) {
  return { authorization: `Bearer ${config.S5_AUTH_TOKEN}`, ...extra };
}

async function request(url, init, timeoutMs = config.S5_TIMEOUT_MS) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Under S5_SMALL_MAX_BYTES, which covers every published image and no video.
async function uploadSmall(filePath) {
  const buf = await fsp.readFile(filePath);
  const form = new FormData();
  form.append('file', new Blob([buf]), path.basename(filePath));

  const res = await request(`${config.S5_NODE_URL}/s5/upload`, {
    method: 'POST',
    headers: authHeaders(),
    body: form,
  });
  if (!res.ok) {
    throw new Error(`s5 upload failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  // A real node answers { "cid": "z..." }. The spec documents no response body,
  // so this is best effort — null just means fall back to the computed CID.
  try {
    const body = await res.json();
    return typeof body?.cid === 'string' ? body.cid : null;
  } catch {
    return null;
  }
}

// The node will not hash for us, so it goes in the creation metadata, under the
// key 'hash', as tus-base64 of base64url(0x1f || hash) -- encoded twice because
// the inner value is what the node decodes and tus requires base64 metadata.
// Found empirically; the spec's version is rejected with "Invalid hash found".
async function uploadTus(filePath, { size, hash }) {
  const raw = Buffer.concat([Buffer.from([BLAKE3_MULTIHASH]), Buffer.from(hash, 'hex')]);
  const hashValue = raw.toString('base64url');
  const metadata = `hash ${Buffer.from(hashValue).toString('base64')}`;

  const create = await request(`${config.S5_NODE_URL}/s5/upload/tus`, {
    method: 'POST',
    headers: authHeaders({
      'tus-resumable': '1.0.0',
      'upload-length': String(size),
      'upload-metadata': metadata,
    }),
  });
  if (create.status !== 201) {
    throw new Error(`s5 tus create failed: ${create.status} ${(await create.text()).slice(0, 200)}`);
  }
  const location = create.headers.get('location');
  if (!location) throw new Error('s5 tus create returned no Location');
  // Pinned to the node's origin: an absolute Location would otherwise send the
  // bearer token and the file bytes to any host the node names.
  const target = new URL(location, config.S5_NODE_URL);
  if (target.origin !== new URL(config.S5_NODE_URL).origin) {
    throw new Error(`s5 tus Location left the node origin: ${target.origin}`);
  }

  let offset = 0;
  const fh = await fsp.open(filePath, 'r');
  try {
    const chunk = Buffer.allocUnsafe(config.S5_TUS_CHUNK_BYTES);
    while (offset < size) {
      // eslint-disable-next-line no-await-in-loop
      const { bytesRead } = await fh.read(chunk, 0, chunk.length, offset);
      if (!bytesRead) break;
      // eslint-disable-next-line no-await-in-loop
      const res = await request(target, {
        method: 'PATCH',
        headers: authHeaders({
          'tus-resumable': '1.0.0',
          'upload-offset': String(offset),
          'content-type': 'application/offset+octet-stream',
        }),
        body: chunk.subarray(0, bytesRead),
      });
      if (res.status !== 204) {
        throw new Error(`s5 tus patch failed at ${offset}: ${res.status}`);
      }
      const next = parseInt(res.headers.get('upload-offset'), 10);
      // Trust the server's offset: if it accepted a short write, our own
      // count would corrupt the blob.
      const advanced = Number.isFinite(next) ? next : offset + bytesRead;
      // Without this a node echoing a stale offset loops forever, and putFile
      // runs on a concurrency-1 lane, so it would block every other upload.
      if (advanced <= offset) {
        throw new Error(`s5 tus made no progress at offset ${offset}`);
      }
      offset = advanced;
    }
  } finally {
    await fh.close();
  }

  if (offset !== size) {
    throw new Error(`s5 tus incomplete: sent ${offset} of ${size}`);
  }
  // Nothing documents whether the final PATCH carries a CID. Ask the upload
  // resource; a null just falls back to the computed one.
  try {
    const head = await request(target, { method: 'HEAD', headers: authHeaders({ 'tus-resumable': '1.0.0' }) }, 30000);
    const cid = head.headers.get('x-s5-cid') || head.headers.get('upload-cid');
    return cid || null;
  } catch {
    return null;
  }
}

/*
| Idempotent: the same bytes produce the same CID, so a retry re-uploads to the
| same identifier rather than making a second object.
|
| The node's own CID wins when it gives one. Ours is a reconstruction of a
| format the spec gets wrong, so it is the fallback, not the source of truth --
| and either way stat() proves the object is really there before we report a
| publish. Without that check a wrong CID becomes a permanently dead URL in a
| serey-api post row.
*/
async function putFile({ filePath }) {
  if (!enabled()) throw new Error('s5_not_configured');
  const { cid: computed, hash, size } = await hashFile(filePath);

  const reported = size <= config.S5_SMALL_MAX_BYTES
    ? await uploadSmall(filePath)
    : await uploadTus(filePath, { size, hash });

  const cid = reported || computed;
  if (reported && reported !== computed) {
    logger.warn({ reported, computed }, 's5 CID differs from ours, trusting the node');
  }

  if (!(await stat(cid))) {
    throw new Error(`s5 upload reported success but ${cid} is not retrievable`);
  }

  logger.info({ cid, bytes: size }, 's5 blob uploaded');
  return { cid, bytes: size };
}

function downloadUrl(cid) {
  const base = config.S5_DOWNLOAD_BASE_URL || config.S5_NODE_URL;
  return `${base}/${cid}`;
}

/*
| Fetch a blob for /cdn to stream on to the viewer.
|
| The download route needs the bearer token — anonymous requests 404, and
| enabling [accounts] to open it up only moves the problem to an account-token
| flow the docs do not specify. So the token stays here and we proxy, which also
| means the node never has to be reachable from the internet.
|
| Range is forwarded so video seeking still works, and the caller gets the
| upstream response untouched so it can mirror status and headers.
*/
async function fetchBlob(cid, { range } = {}) {
  if (!enabled()) throw new Error('s5_not_configured');
  return request(downloadUrl(cid), {
    method: 'GET',
    headers: authHeaders(range ? { range } : {}),
  });
}

// Ranged GET rather than HEAD: the docs do not commit to HEAD being supported.
// The body is cancelled rather than read — a node that ignores Range would
// otherwise make the verify script download every object in full.
async function stat(cid) {
  if (!enabled()) throw new Error('s5_not_configured');
  const res = await request(downloadUrl(cid), {
    method: 'GET',
    headers: authHeaders({ range: 'bytes=0-0' }),
  }, 30000);
  if (res.body) await res.body.cancel().catch(() => {});
  if (res.status === 404) return null;
  if (!res.ok && res.status !== 206) {
    throw new Error(`s5 stat failed: ${res.status}`);
  }
  const total = (res.headers.get('content-range') || '').split('/')[1];
  return { bytes: total ? parseInt(total, 10) : null };
}

// Verified on the way in: the CID is the hash, so a bad restore is detectable.
async function getToFile({ cid, filePath }) {
  if (!enabled()) throw new Error('s5_not_configured');
  const res = await request(downloadUrl(cid), { method: 'GET', headers: authHeaders() });
  if (!res.ok) throw new Error(`s5 download failed: ${res.status}`);

  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.restore`);
  // Streamed: a 2GB restore must not be materialised in memory first.
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmpPath));

  const check = await hashFile(tmpPath);
  if (check.cid !== cid) {
    await fsp.rm(tmpPath, { force: true });
    throw new Error(`s5 restore hash mismatch: wanted ${cid} got ${check.cid}`);
  }
  await fsp.rename(tmpPath, filePath);
  return { cid, bytes: check.size };
}

/*
| Best effort — check the return value before reporting a takedown.
|
| S5 documents no unpin route (only an abstract unpinHash), so the route below
| is a guess and is off by default. Even a 200 only stops *our* node serving the
| blob. Returns 'unpinned', 'disabled' or 'failed' so callers can tell a
| takedown from a gesture.
*/
async function unpin(cid) {
  if (!enabled() || !config.S5_UNPIN_ENABLED) return 'disabled';
  try {
    const res = await request(`${config.S5_NODE_URL}/s5/pin/${cid}`, {
      method: 'DELETE',
      headers: authHeaders(),
    }, 30000);
    if (!res.ok) throw new Error(`status ${res.status}`);
    return 'unpinned';
  } catch (err) {
    logger.error({ cid, err: err.message }, 's5 unpin failed');
    return 'failed';
  }
}

module.exports = {
  enabled,
  buildCid,
  hashFile,
  putFile,
  stat,
  getToFile,
  unpin,
  downloadUrl,
  fetchBlob,
};

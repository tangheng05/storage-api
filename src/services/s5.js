const fs = require('fs');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const fsp = require('fs/promises');
const path = require('path');
const { blake3 } = require('@noble/hashes/blake3');

const config = require('../config');
const logger = require('./logger');

// S5 object store, public media only. Publishing cannot be undone; premium
// media goes to s3d (sia.js) instead, which has a private prefix and delete.

// Values come from a live s5-dart v0.14.1 node, NOT docs.sfive.net, which
// documents BLAKE3 as 0x1e and a blob CID as 0x5b 0x82 0x1e + hash + size in
// base16/'f'. A real node uses 0x1f and 0x26 0x1f + hash + size in base58btc/'z'.
// Confirmed both as the CID byte the node emits and the only hash-metadata
// prefix it accepts for tus (via scripts/s5-probe-tus.js) -- rerun that probe
// against a new node version before trusting these again.
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

// base58btc('z' + CID_MAGIC + hash + little-endian size, trailing zeros trimmed);
// pinned in tests against a CID a real node returned.
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

// Below the configured limit (S5_SMALL_MAX_BYTES) -- every published image, no video.
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
  // Spec documents no response body; a real node answers { "cid": "z..." }.
  try {
    const body = await res.json();
    return typeof body?.cid === 'string' ? body.cid : null;
  } catch {
    return null;
  }
}

// Hash goes in tus creation metadata as key 'hash', tus-base64 of
// base64url(0x1f || hash) -- found empirically by probe; the spec's encoding
// is rejected with "Invalid hash found".
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
  // Pin to the node's origin -- an absolute Location could send the bearer
  // token and file bytes to any host the node names.
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
      // Trust the server's offset -- a short write would otherwise corrupt the blob.
      const advanced = Number.isFinite(next) ? next : offset + bytesRead;
      // Guards against a stale-offset loop, which would block the concurrency-1 upload lane.
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
  // Undocumented whether the final PATCH carries a CID; ask the upload resource.
  try {
    const head = await request(target, { method: 'HEAD', headers: authHeaders({ 'tus-resumable': '1.0.0' }) }, 30000);
    const cid = head.headers.get('x-s5-cid') || head.headers.get('upload-cid');
    return cid || null;
  } catch {
    return null;
  }
}

// Node's CID wins when given (spec's format is the unreliable one); stat()
// still verifies retrievability before reporting success, because a node can
// 204 a blob that never resolves, which would freeze a dead URL into a
// database post row.
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

// Proxies the blob for /cdn: the download route needs the bearer token
// (anonymous requests 404), so this keeps the token server-side and the node
// off the public internet. Range is forwarded for video seeking; response is
// returned untouched so the caller can mirror status and headers.
async function fetchBlob(cid, { range } = {}) {
  if (!enabled()) throw new Error('s5_not_configured');
  return request(downloadUrl(cid), {
    method: 'GET',
    headers: authHeaders(range ? { range } : {}),
  });
}

// Ranged GET, not HEAD -- docs don't commit to HEAD being supported. Body is
// cancelled rather than read, in case a node ignores Range.
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

// Best effort: S5 documents no unpin route, only an abstract unpinHash, so
// this is a guess and off by default. Check the return value before reporting
// a takedown -- even success only stops our node serving the blob.
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

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { blake3 } = require('@noble/hashes/blake3');

const config = require('../config');
const logger = require('./logger');

/*
| S5 object store — public media only.
|
| A blob's CID is its BLAKE3 hash, so we compute it locally and never parse an
| upload response, which matters because the docs specify neither endpoint's
| response body. It also makes retries idempotent. The cost: tus uploads need
| the hash up front, so large files are read twice.
|
| Publishing here cannot be undone. Premium media goes to s3d (sia.js), which
| has a private prefix and a working delete.
*/

const BLAKE3_MULTIHASH = 0x1e;
const CID_MAGIC = [0x5b, 0x82];

function enabled() {
  return config.S5_ENABLED && !!config.S5_NODE_URL && !!config.S5_AUTH_TOKEN;
}

/*
| Base16 with multibase prefix 'f':
|   byte 0-1  0x5b 0x82   magic
|   byte 2    0x1e        BLAKE3
|   byte 3-34 the hash
|   byte 35+  size, little endian, trailing zero bytes trimmed
|
| The test pins this against the spec's published vector. Keep it: nothing else
| would catch an off-by-one here.
*/
function buildCid(hash, size) {
  const sizeBytes = [];
  let remaining = size;
  while (remaining > 0) {
    sizeBytes.push(remaining % 256);
    remaining = Math.floor(remaining / 256);
  }
  const body = Buffer.from([...CID_MAGIC, BLAKE3_MULTIHASH, ...hash, ...sizeBytes]);
  return `f${body.toString('hex')}`;
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

// The 10 MiB ceiling covers every published image and no video at all.
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
  // Body ignored: undocumented, and the CID is already known.
  await res.text().catch(() => '');
}

// The node will not hash for us, so it goes in the creation metadata. That
// encoding is the least documented part of the S5 API: the spec says only
// "BASE64URL(0x1e || hash)" and never shows a request, and tus requires base64
// metadata values, hence the double encode. Verify against a live node.
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
  const target = new URL(location, config.S5_NODE_URL).toString();

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
      offset = Number.isFinite(next) ? next : offset + bytesRead;
    }
  } finally {
    await fh.close();
  }

  if (offset !== size) {
    throw new Error(`s5 tus incomplete: sent ${offset} of ${size}`);
  }
}

// Idempotent: the CID comes from the bytes, so a retry reuses the identifier.
async function putFile({ filePath }) {
  if (!enabled()) throw new Error('s5_not_configured');
  const { cid, hash, size } = await hashFile(filePath);

  if (size <= config.S5_SMALL_MAX_BYTES) {
    await uploadSmall(filePath);
  } else {
    await uploadTus(filePath, { size, hash });
  }

  logger.info({ cid, bytes: size }, 's5 blob uploaded');
  return { cid, bytes: size };
}

function downloadUrl(cid) {
  const base = config.S5_DOWNLOAD_BASE_URL || config.S5_NODE_URL;
  return `${base}/${cid}`;
}

// Ranged GET rather than HEAD: the docs do not commit to HEAD being supported.
async function exists(cid) {
  if (!enabled()) throw new Error('s5_not_configured');
  const res = await request(downloadUrl(cid), {
    method: 'GET',
    headers: authHeaders({ range: 'bytes=0-0' }),
  }, 30000);
  if (res.status === 404) return null;
  if (!res.ok && res.status !== 206) {
    throw new Error(`s5 head failed: ${res.status}`);
  }
  await res.arrayBuffer().catch(() => {});
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
  await fsp.writeFile(tmpPath, Buffer.from(await res.arrayBuffer()));

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
  exists,
  getToFile,
  unpin,
  downloadUrl,
};

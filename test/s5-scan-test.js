#!/usr/bin/env node
/*
| S5 + scan-gate integration test. No framework: node test/s5-scan-test.js
|
| Drives the real s5, scan, mirror and processor modules against an in-process
| stub node. Proves our side of the contract — the CID layout, both upload
| paths, backend routing, thresholds, and above all that a file failing the scan
| never reaches a served directory or a backend.
|
| It does NOT prove a real S5 node behaves this way: the upload response shape,
| the tus hash metadata encoding and the unpin route are all undocumented.
*/
const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const assert = require('assert');

const PORT = 9148;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'serey-s5-'));

const dirs = {
  TUS_DIR: 'tus',
  JOBS_DIR: 'jobs',
  VIDEOS_DIR: 'videos',
  THUMBS_DIR: 'thumbnails',
  AUDIO_DIR: 'audio',
  IMAGES_DIR: 'images',
  PRIVATE_VIDEOS_DIR: 'private/videos',
  PRIVATE_AUDIO_DIR: 'private/audio',
  PRIVATE_IMAGES_DIR: 'private/images',
  PENDING_VIDEOS_DIR: 'pending/videos',
  PENDING_AUDIO_DIR: 'pending/audio',
  PENDING_IMAGES_DIR: 'pending/images',
  PENDING_THUMBS_DIR: 'pending/thumbnails',
};
Object.entries(dirs).forEach(([key, rel]) => {
  const p = path.join(root, rel);
  fs.mkdirSync(p, { recursive: true });
  process.env[key] = p;
});

process.env.UPLOAD_API_KEY = 's5-test';
process.env.PUBLIC_BASE_URL = 'http://localhost:8080';
process.env.MEDIA_CDN_BASE_URL = 'https://cdn.test.local';
process.env.S5_ENABLED = 'true';
process.env.S5_NODE_URL = `http://127.0.0.1:${PORT}`;
process.env.S5_AUTH_TOKEN = 'tok';
process.env.S5_TYPES = 'image,video';
process.env.SCAN_ENABLED = 'true';
process.env.SCAN_PROVIDERS = 'phash';
process.env.SCAN_BLOCKLIST_PATH = path.join(root, 'blocklist.txt');
// s3d stays off: this test is about the S5 path and the gate.
process.env.SIA_ENABLED = 'false';

const sharp = require('sharp');
const s5 = require('../src/services/s5');
const scan = require('../src/services/scan');
const mirror = require('../src/services/mirror');
const processor = require('../src/services/processor');
const jobs = require('../src/services/jobs');

const blobs = new Map();
const tusUploads = new Map();
let seq = 0;

const readBody = (req) => new Promise((resolve) => {
  const chunks = [];
  req.on('data', (d) => chunks.push(d));
  req.on('end', () => resolve(Buffer.concat(chunks)));
});

const stub = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');

  if (req.method === 'POST' && url.pathname === '/s5/upload') {
    const body = await readBody(req);
    // Crude multipart parse; enough to confirm the bytes arrived intact.
    const marker = Buffer.from('\r\n\r\n');
    const start = body.indexOf(marker) + marker.length;
    const end = body.lastIndexOf(Buffer.from('\r\n------'));
    blobs.set('last', body.subarray(start, end > start ? end : undefined));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
    return;
  }

  if (req.method === 'POST' && url.pathname === '/s5/upload/tus') {
    seq += 1;
    const id = `t${seq}`;
    tusUploads.set(id, {
      length: parseInt(req.headers['upload-length'], 10),
      metadata: req.headers['upload-metadata'],
      parts: [],
    });
    res.writeHead(201, { location: `/s5/upload/tus/${id}`, 'tus-resumable': '1.0.0' });
    res.end();
    return;
  }

  if (req.method === 'PATCH' && url.pathname.startsWith('/s5/upload/tus/')) {
    const up = tusUploads.get(url.pathname.split('/').pop());
    const body = await readBody(req);
    if (!up) { res.writeHead(404).end(); return; }
    up.parts.push(body);
    const offset = up.parts.reduce((n, b) => n + b.length, 0);
    if (offset >= up.length) blobs.set('last', Buffer.concat(up.parts));
    res.writeHead(204, { 'upload-offset': String(offset), 'tus-resumable': '1.0.0' });
    res.end();
    return;
  }

  if (req.method === 'GET' && url.pathname.length > 1) {
    const buf = blobs.get('last');
    if (!buf) { res.writeHead(404).end(); return; }
    if (req.headers.range) {
      res.writeHead(206, { 'content-range': `bytes 0-0/${buf.length}` });
      res.end(buf.subarray(0, 1));
      return;
    }
    res.writeHead(200, { 'content-length': String(buf.length) });
    res.end(buf);
    return;
  }

  res.writeHead(404).end();
});

let passed = 0;
const ok = (label, cond) => {
  assert.ok(cond, label);
  passed += 1;
  console.log(`  ok  ${label}`);
};

const ULID_A = '01J0000000000000000000000A';
const ULID_B = '01J0000000000000000000000B';
const ULID_C = '01J0000000000000000000000C';

// Textured, not flat: a solid colour dHashes to all zeros, so every test image
// would collide.
async function makeImage(dest, seed) {
  const w = 64;
  const px = Buffer.alloc(w * w * 3);
  for (let i = 0; i < w * w; i += 1) {
    px[i * 3] = (i * seed) % 251;
    px[i * 3 + 1] = (i * seed * 7 + 40) % 253;
    px[i * 3 + 2] = (i * seed * 13 + 90) % 249;
  }
  await sharp(px, { raw: { width: w, height: w, channels: 3 } }).webp().toFile(dest);
}

async function main() {
  await new Promise((r) => stub.listen(PORT, r));

  // --- CID construction ---
  // The spec's published vector for "Hello, world!".
  const { blake3 } = require('@noble/hashes/blake3');
  const vector = s5.buildCid(blake3(Buffer.from('Hello, world!')), 13);
  ok(
    'CID matches the published BLAKE3 vector',
    vector === 'f5b821eede5c0b10f2ec4979c69b52f61e42ff5b413519ce09be0f14d098dcfe5f6f98d0d',
  );

  const small = path.join(root, 'small.webp');
  await makeImage(small, 3);
  const hashed = await s5.hashFile(small);
  ok('CID is derived locally before any upload', /^f5b821e[0-9a-f]+$/.test(hashed.cid));
  ok('hashing reports the real byte length', hashed.size === fs.statSync(small).size);

  // --- upload paths ---
  const put = await s5.putFile({ filePath: small });
  ok('simple upload returns the locally computed CID', put.cid === hashed.cid);
  ok('simple upload delivered the bytes intact', blobs.get('last').equals(fs.readFileSync(small)));

  // Force the resumable path by dropping the ceiling under the file size.
  const realCeiling = require('../src/config').S5_SMALL_MAX_BYTES;
  require('../src/config').S5_SMALL_MAX_BYTES = 512;
  const big = path.join(root, 'big.bin');
  await fsp.writeFile(big, Buffer.alloc(20 * 1024, 9));
  const bigPut = await s5.putFile({ filePath: big });
  ok('tus upload round trips intact', blobs.get('last').equals(fs.readFileSync(big)));
  ok('tus upload reports the same CID as a local hash',
    bigPut.cid === (await s5.hashFile(big)).cid);
  const meta = [...tusUploads.values()].pop().metadata;
  ok('tus creation carries the blake3 hash metadata', /^hash [A-Za-z0-9+/=]+$/.test(meta));
  require('../src/config').S5_SMALL_MAX_BYTES = realCeiling;

  // A restore verifies itself: the CID is the hash.
  const restored = path.join(root, 'restored.bin');
  await s5.getToFile({ cid: bigPut.cid, filePath: restored });
  ok('restore is byte-identical', fs.readFileSync(restored).equals(fs.readFileSync(big)));
  await assert.rejects(
    () => s5.getToFile({ cid: vector, filePath: path.join(root, 'bad.bin') }),
    /hash mismatch/,
  );
  ok('restore refuses bytes that do not match the CID', true);

  // --- backend routing ---
  ok('public media routes to S5',
    mirror.backendFor({ mediaType: 'image', visibility: 'public' }) === 's5');
  ok('premium media never routes to S5',
    mirror.backendFor({ mediaType: 'image', visibility: 'private' }) !== 's5');
  ok('S5 publishing is flagged immutable',
    mirror.isImmutable({ mediaType: 'image', visibility: 'public' }) === true);
  ok('premium publishing is not flagged immutable',
    mirror.isImmutable({ mediaType: 'image', visibility: 'private' }) === false);
  ok('public URLs carry the ULID, never the CID',
    mirror.publicUrl('s5', 'images', `${ULID_A}.webp`)
      === `https://cdn.test.local/images/${ULID_A}.webp`);

  // --- thresholds ---
  // The middle band is the point: the same score must be treated more
  // cautiously when there is no undo.
  ok('a mid score publishes on a retractable backend',
    scan.decide(0.5, { immutable: false }) === 'clean');
  ok('the same score is held for review when the publish is permanent',
    scan.decide(0.5, { immutable: true }) === 'review');
  ok('a high score is rejected either way',
    scan.decide(0.95, { immutable: false }) === 'reject'
      && scan.decide(0.95, { immutable: true }) === 'reject');

  // --- the gate ---
  await makeImage(path.join(root, dirs.PENDING_IMAGES_DIR, `${ULID_A}.webp`), 11);
  await jobs.create(ULID_A, {
    state: 'scanning', media_type: 'image', visibility: 'public', pending_file: `${ULID_A}.webp`,
  });
  await processor.finalize(ULID_A);
  const cleared = await jobs.get(ULID_A);
  ok('a clean upload becomes ready', cleared.state === 'ready');
  ok('a clean upload records its CID', !!cleared.s5_cid);
  ok('a clean upload is served from our own hostname',
    cleared.url === `https://cdn.test.local/images/${ULID_A}.webp`);
  ok('a clean upload leaves the pending dir',
    !fs.existsSync(path.join(root, dirs.PENDING_IMAGES_DIR, `${ULID_A}.webp`)));
  ok('a clean upload lands in the served dir',
    fs.existsSync(path.join(root, dirs.IMAGES_DIR, `${ULID_A}.webp`)));

  // Blocklisted: rejected, and never published anywhere.
  const blocked = path.join(root, dirs.PENDING_IMAGES_DIR, `${ULID_B}.webp`);
  await makeImage(blocked, 29);
  await fsp.writeFile(process.env.SCAN_BLOCKLIST_PATH, `${await scan.perceptualHash(blocked)}\n`);
  const cidsBefore = blobs.get('last');
  await jobs.create(ULID_B, {
    state: 'scanning', media_type: 'image', visibility: 'public', pending_file: `${ULID_B}.webp`,
  });
  await processor.finalize(ULID_B);
  const rejected = await jobs.get(ULID_B);
  ok('a blocklisted upload is rejected', rejected.state === 'rejected');
  ok('the blocklist matched a real fingerprint, not a degenerate hash',
    rejected.scan_phash && rejected.scan_phash !== '0000000000000000');
  ok('a rejected upload never reaches a backend', blobs.get('last') === cidsBefore);
  ok('a rejected upload never reaches the served dir',
    !fs.existsSync(path.join(root, dirs.IMAGES_DIR, `${ULID_B}.webp`)));
  ok('a rejected upload is removed from pending', !fs.existsSync(blocked));
  ok('a rejected upload has no URL', !rejected.url);

  // Held: kept in pending, still publishable later.
  const held = path.join(root, dirs.PENDING_IMAGES_DIR, `${ULID_C}.webp`);
  await makeImage(held, 47);
  await jobs.create(ULID_C, {
    state: 'scanning', media_type: 'image', visibility: 'public', pending_file: `${ULID_C}.webp`,
  });
  // Mid-band classifier score on an immutable destination.
  const realProviders = require('../src/config').SCAN_PROVIDERS;
  require('../src/config').SCAN_PROVIDERS = ['http'];
  require('../src/config').SCAN_HTTP_URL = `http://127.0.0.1:${PORT}/never`;
  const realFetch = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => ({ score: 0.5 }) });
  await processor.finalize(ULID_C);
  global.fetch = realFetch;
  require('../src/config').SCAN_PROVIDERS = realProviders;
  const review = await jobs.get(ULID_C);
  ok('a mid-band upload is held for review', review.state === 'review');
  ok('a held upload stays in pending, reachable by nobody', fs.existsSync(held));
  ok('a held upload is not in the served dir',
    !fs.existsSync(path.join(root, dirs.IMAGES_DIR, `${ULID_C}.webp`)));

  // Approving publishes without re-scoring.
  await processor.finalize(ULID_C, { approved: true });
  const approved = await jobs.get(ULID_C);
  ok('an approved upload publishes', approved.state === 'ready' && !!approved.s5_cid);
  ok('an approved upload records the human decision', approved.scan_provider === 'moderator');
  ok('an approved upload leaves pending', !fs.existsSync(held));

  console.log(`\n${passed} checks passed`);
  stub.close();
}

main().catch((err) => {
  console.error(err);
  stub.close();
  process.exit(1);
});

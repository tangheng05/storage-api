#!/usr/bin/env node
/*
| S5 + scan-gate integration test. No framework: node test/s5-scan-test.js
|
| Drives the real s5, scan, mirror and processor modules against an in-process
| stub node. Proves our side of the contract — the CID layout, both upload
| paths, backend routing, thresholds, and above all that a file failing the scan
| never reaches a served directory or a backend.
|
| The CID vector, the tus hash metadata and the upload response shape were all
| confirmed against a live s5-dart v0.14.1 node (see scripts/s5-probe-tus.js).
| The unpin route remains undocumented and unproven.
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
  // Pinned against a CID a live s5-dart v0.14.1 node returned for a 72254-byte
  // file. Deliberately NOT the spec's published vector: the documented magic
  // prefix and multibase are both wrong, and this is the only reference that
  // reflects what a node actually serves.
  const realHash = '5d2ccbaead70e96d3e4df4645da9cd0d62e42463a17241e7955c61a04ea4ca76';
  ok(
    'CID matches one a real S5 node returned',
    s5.buildCid(Buffer.from(realHash, 'hex'), 72254)
      === 'z2H76rXxCUD8Luc5sJxjJxNFkYhp1Fqewe3h19CUDkxw5mfPBNV6',
  );

  const small = path.join(root, 'small.webp');
  await makeImage(small, 3);
  const hashed = await s5.hashFile(small);
  ok('CID is derived locally before any upload', /^z[1-9A-HJ-NP-Za-km-z]+$/.test(hashed.cid));
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
    // A CID that does not describe the bytes the stub will serve back.
    () => s5.getToFile({
      cid: s5.buildCid(Buffer.from(realHash, 'hex'), 72254),
      filePath: path.join(root, 'bad.bin'),
    }),
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

  // --- paywall boundaries, over HTTP ---
  const app = require('../src/app');
  const srv = await new Promise((r) => {
    const l = app.listen(0, () => r(l));
  });
  const port = srv.address().port;

  const call = (method, p, body) => new Promise((resolve) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request({
      port,
      path: p,
      method,
      headers: {
        'x-upload-key': 's5-test',
        ...(payload
          ? { 'content-type': 'application/json', 'content-length': payload.length }
          : {}),
      },
    }, (res) => {
      let text = '';
      res.on('data', (d) => { text += d; });
      res.on('end', () => resolve({ status: res.statusCode, location: res.headers.location, text }));
    });
    if (payload) req.write(payload);
    req.end();
  });

  const pub = await call('GET', `/cdn/images/${ULID_A}.webp`);
  ok('cdn serves a public job from S5', pub.status === 200);

  // /cdn is unauthenticated, so this check is the only thing between a premium
  // CID and an anonymous caller.
  const ULID_P = '01J0000000000000000000000D';
  await jobs.create(ULID_P, {
    state: 'ready', media_type: 'image', visibility: 'private', s5_cid: 'fdeadbeef',
  });
  ok('cdn refuses a premium job', (await call('GET', `/cdn/images/${ULID_P}.webp`)).status === 404);

  // A premium video's thumbnail is public by design, so it must still resolve.
  const ULID_T = '01J0000000000000000000000E';
  await jobs.create(ULID_T, {
    state: 'ready', media_type: 'video', visibility: 'private', s5_thumb_cid: 'fcafebabe',
  });
  ok('cdn still serves a premium video thumbnail',
    (await call('GET', `/cdn/thumbnails/${ULID_T}.jpg`)).status === 200);

  const ULID_Q = '01J0000000000000000000000F';
  await jobs.create(ULID_Q, { state: 'scanning', media_type: 'image', s5_cid: 'fbadbad' });
  ok('cdn refuses a job that is not ready',
    (await call('GET', `/cdn/images/${ULID_Q}.webp`)).status === 404);

  // The flip window: marking premium while the file is still at the gate used to
  // 404 without recording anything, so finalize published it public and
  // permanent.
  const ULID_W = '01J0000000000000000000000G';
  await makeImage(path.join(root, dirs.PENDING_IMAGES_DIR, `${ULID_W}.webp`), 71);
  await jobs.create(ULID_W, {
    state: 'scanning', media_type: 'image', visibility: 'public', pending_file: `${ULID_W}.webp`,
  });
  const flip = await call('POST', `/media/images/${ULID_W}.webp/visibility`, { visibility: 'private' });
  ok('flipping to premium pre-publication is accepted, not 404', flip.status === 200);
  ok('the pending job records the new visibility',
    (await jobs.get(ULID_W)).visibility === 'private');

  const beforeFlip = blobs.get('last');
  await processor.finalize(ULID_W);
  const flipped = await jobs.get(ULID_W);
  ok('a job flipped at the gate publishes as premium', flipped.visibility === 'private');
  ok('it lands in the private dir',
    fs.existsSync(path.join(root, dirs.PRIVATE_IMAGES_DIR, `${ULID_W}.webp`)));
  ok('it is not in the public dir',
    !fs.existsSync(path.join(root, dirs.IMAGES_DIR, `${ULID_W}.webp`)));
  ok('it never reached S5', blobs.get('last') === beforeFlip);
  ok('it is served through the signed /media path', /\/media\/images\//.test(flipped.url));

  // A broken scanner must hold, not publish.
  const ULID_H = '01J0000000000000000000000H';
  await makeImage(path.join(root, dirs.PENDING_IMAGES_DIR, `${ULID_H}.webp`), 83);
  await jobs.create(ULID_H, {
    state: 'scanning', media_type: 'image', visibility: 'public', pending_file: `${ULID_H}.webp`,
  });
  const cfg = require('../src/config');
  const keepProviders = cfg.SCAN_PROVIDERS;
  cfg.SCAN_PROVIDERS = ['http'];
  cfg.SCAN_HTTP_URL = 'http://127.0.0.1:1/nope';
  const keepFetch = global.fetch;
  global.fetch = async () => { throw new Error('scanner down'); };
  await processor.finalize(ULID_H);
  global.fetch = keepFetch;
  cfg.SCAN_PROVIDERS = keepProviders;
  const heldJob = await jobs.get(ULID_H);
  ok('a broken scanner holds the job (fail closed)', heldJob.state === 'scanning');
  ok('a held job keeps its pending file for the retry',
    fs.existsSync(path.join(root, dirs.PENDING_IMAGES_DIR, `${ULID_H}.webp`)));
  ok('a broken scanner does not publish', !heldJob.url);

  // --- video ---
  // A video whose thumbnail failed to generate must be held for a person, not
  // published unchecked and not parked in 'scanning' to retry a frame that will
  // never exist.
  const ULID_V = '01J0000000000000000000000J';
  await fsp.writeFile(path.join(root, dirs.PENDING_VIDEOS_DIR, `${ULID_V}.mp4`), Buffer.alloc(64, 1));
  await jobs.create(ULID_V, {
    state: 'scanning',
    media_type: 'video',
    visibility: 'public',
    pending_file: `${ULID_V}.mp4`,
    pending_thumb: null,
  });
  await processor.finalize(ULID_V);
  const noThumb = await jobs.get(ULID_V);
  ok('a video with no thumbnail is held for review', noThumb.state === 'review');
  ok('it is not published', !noThumb.url);
  ok('it says why', (noThumb.scan_labels || []).includes('no_thumbnail'));
  ok('its pending file survives for the moderator',
    fs.existsSync(path.join(root, dirs.PENDING_VIDEOS_DIR, `${ULID_V}.mp4`)));

  // --- vision likelihood mapping ---
  // SafeSearch answers in words; only VERY_LIKELY should ever auto-reject.
  const cfg2 = require('../src/config');
  const keepProv = cfg2.SCAN_PROVIDERS;
  cfg2.SCAN_PROVIDERS = ['vision'];
  cfg2.SCAN_VISION_API_KEY = 'test-key';
  const keepFetch2 = global.fetch;
  const safeSearch = (annotation) => {
    global.fetch = async () => ({
      ok: true,
      json: async () => ({ responses: [{ safeSearchAnnotation: annotation }] }),
    });
    return scan.scanFile({ filePath: small, mediaType: 'image', immutable: false });
  };

  ok('VERY_LIKELY adult is rejected',
    (await safeSearch({ adult: 'VERY_LIKELY', violence: 'VERY_UNLIKELY' })).verdict === 'reject');
  ok('LIKELY adult goes to a human',
    (await safeSearch({ adult: 'LIKELY', violence: 'VERY_UNLIKELY' })).verdict === 'review');
  ok('POSSIBLE adult still publishes',
    (await safeSearch({ adult: 'POSSIBLE', violence: 'VERY_UNLIKELY' })).verdict === 'clean');
  // racy is not in SCAN_VISION_CATEGORIES by default, so it must not count
  ok('VERY_LIKELY racy is ignored by default',
    (await safeSearch({ adult: 'VERY_UNLIKELY', racy: 'VERY_LIKELY' })).verdict === 'clean');
  ok('the worst configured category wins',
    (await safeSearch({ adult: 'VERY_UNLIKELY', violence: 'VERY_LIKELY' })).verdict === 'reject');

  // --- gemini safetyRatings mapping ---
  cfg2.SCAN_PROVIDERS = ['gemini'];
  cfg2.SCAN_GEMINI_API_KEY = 'test-key';
  const rated = (ratings, extra = {}) => {
    global.fetch = async () => ({
      ok: true,
      json: async () => ({ candidates: [{ safetyRatings: ratings }], ...extra }),
    });
    return scan.scanFile({ filePath: small, mediaType: 'image', immutable: false });
  };
  const sexual = (p) => [{ category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', probability: p }];

  ok('HIGH sexually explicit is rejected', (await rated(sexual('HIGH'))).verdict === 'reject');
  ok('MEDIUM goes to a human', (await rated(sexual('MEDIUM'))).verdict === 'review');
  ok('LOW still publishes', (await rated(sexual('LOW'))).verdict === 'clean');
  ok('NEGLIGIBLE publishes', (await rated(sexual('NEGLIGIBLE'))).verdict === 'clean');
  // harassment is not in SCAN_GEMINI_CATEGORIES by default
  ok('an unconfigured category is ignored',
    (await rated([{ category: 'HARM_CATEGORY_HARASSMENT', probability: 'HIGH' }])).verdict === 'clean');
  // a hard block with no ratings is itself the signal
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ promptFeedback: { blockReason: 'SAFETY' } }),
  });
  ok('a safety block counts as a reject',
    (await scan.scanFile({ filePath: small, mediaType: 'image', immutable: false })).verdict === 'reject');

  // 2.5 omits safetyRatings when nothing trips. That must read as clean, not as
  // a broken scanner -- treating it as an error held every upload in 'scanning'.
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'cat' }] } }] }),
  });
  const unflagged = await scan.scanFile({ filePath: small, mediaType: 'image', immutable: false });
  ok('a successful generation with no ratings is clean', unflagged.verdict === 'clean');
  ok('and it says so rather than reporting a score of nothing',
    (unflagged.labels || []).includes('unflagged'));

  // an empty response is still an error, so a malformed reply cannot pass
  global.fetch = async () => ({ ok: true, json: async () => ({}) });
  await assert.rejects(
    () => scan.scanFile({ filePath: small, mediaType: 'image', immutable: false }),
    /neither a candidate nor safetyRatings/,
  );
  ok('an empty response is an error, not a pass', true);

  // finishReason SAFETY is a reject even without ratings
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ candidates: [{ finishReason: 'SAFETY' }] }),
  });
  ok('finishReason SAFETY counts as a reject',
    (await scan.scanFile({ filePath: small, mediaType: 'image', immutable: false })).verdict === 'reject');

  // Free-tier Gemini answers 503 "high demand" often enough that one attempt is
  // not workable: with the gate failing closed, a blip holds the upload.
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    if (calls < 3) return { ok: false, status: 503, text: async () => 'high demand' };
    return { ok: true, json: async () => ({ candidates: [{ finishReason: 'STOP' }] }) };
  };
  const recovered = await scan.scanFile({ filePath: small, mediaType: 'image', immutable: false });
  ok('a transient 503 is retried rather than held', recovered.verdict === 'clean');
  ok('and it took the retries to get there', calls === 3);

  // a config error must fail immediately, not burn the backoff
  calls = 0;
  global.fetch = async () => {
    calls += 1;
    return { ok: false, status: 403, text: async () => 'SERVICE_DISABLED' };
  };
  await assert.rejects(() => scan.scanFile({ filePath: small, mediaType: 'image', immutable: false }));
  ok('a 403 is not retried', calls === 1);

  global.fetch = keepFetch2;
  cfg2.SCAN_PROVIDERS = keepProv;

  srv.close();

  console.log(`\n${passed} checks passed`);
  stub.close();
}

main().catch((err) => {
  console.error(err);
  stub.close();
  process.exit(1);
});

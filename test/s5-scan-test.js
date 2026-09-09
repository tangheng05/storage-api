#!/usr/bin/env node
/*
| S5 + scan-gate integration test: node test/s5-scan-test.js (no framework).
| Drives the real s5, scan, mirror and processor modules against an in-process
| stub node -- the CID layout, both upload paths, backend routing, thresholds,
| and above all that a file failing the scan never reaches a served directory
| or a backend. The unpin route remains undocumented and unproven.
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
// Deliberately on: the premium checks below are only meaningful when CID
// exposure is at its most permissive.
process.env.S5_EXPOSE_CID = 'true';
process.env.S5_TYPES = 'image,video';
process.env.SCAN_ENABLED = 'true';
process.env.SCAN_PROVIDERS = 'phash';
process.env.SCAN_BLOCKLIST_PATH = path.join(root, 'blocklist.txt');
process.env.SCAN_CACHE_PATH = path.join(root, 'scan-cache.json');
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
  const enc = path.extname(dest) === '.png' ? 'png' : (path.extname(dest) === '.jpg' ? 'jpeg' : 'webp');
  await sharp(px, { raw: { width: w, height: w, channels: 3 } })[enc]().toFile(dest);
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
  // An uploader who chose PNG for a screenshot gets a PNG back; only formats we
  // do not want to serve are re-encoded.
  const image = require('../src/services/image');
  for (const [ext, kept] of [['.png', true], ['.jpg', true], ['.webp', true]]) {
    const probe = path.join(root, dirs.PENDING_IMAGES_DIR, `fmt${ext}`);
    // eslint-disable-next-line no-await-in-loop
    await makeImage(probe, 9);
    // eslint-disable-next-line no-await-in-loop
    const meta = await image.probe(probe);
    ok(`${ext} keeps its format`, (image.extensionFor(meta) === ext) === kept);
    fs.rmSync(probe, { force: true });
  }

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
  // One threshold, but not the same one: the score that publishes on a backend
  // we can delete from must be refused on one we cannot.
  ok('a mid score publishes on a retractable backend',
    scan.decide(0.5, { immutable: false }) === 'clean');
  ok('the same score is refused when the publish is permanent',
    scan.decide(0.5, { immutable: true }) === 'reject');
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
  // Every provider that answered is recorded, so an absent classifier is
  // visible in the job rather than indistinguishable from a clean result.
  ok('it records which providers ran', (cleared.scan_providers || []).includes('phash'));
  ok('a clean upload records its CID', !!cleared.s5_cid);
  ok('a clean upload is served from our own hostname',
    cleared.url === `https://cdn.test.local/images/${ULID_A}.webp`);
  ok('a clean upload leaves the pending dir',
    !fs.existsSync(path.join(root, dirs.PENDING_IMAGES_DIR, `${ULID_A}.webp`)));
  ok('a clean upload lands in the served dir',
    fs.existsSync(path.join(root, dirs.IMAGES_DIR, `${ULID_A}.webp`)));

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

  // A borderline score on a permanent destination: refused, not held, because
  // there is no longer anyone to hold it for.
  const held = path.join(root, dirs.PENDING_IMAGES_DIR, `${ULID_C}.webp`);
  await makeImage(held, 47);
  await jobs.create(ULID_C, {
    state: 'scanning', media_type: 'image', visibility: 'public', pending_file: `${ULID_C}.webp`,
  });
  const realProviders = require('../src/config').SCAN_PROVIDERS;
  require('../src/config').SCAN_PROVIDERS = ['http'];
  require('../src/config').SCAN_HTTP_URL = `http://127.0.0.1:${PORT}/never`;
  const realFetch = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => ({ score: 0.5 }) });
  await processor.finalize(ULID_C);
  global.fetch = realFetch;
  require('../src/config').SCAN_PROVIDERS = realProviders;
  const midBand = await jobs.get(ULID_C);
  ok('a mid-band upload on a permanent backend is refused', midBand.state === 'rejected');
  ok('and is told why', Array.isArray(scan.publicReasons(midBand)));
  ok('a refused upload is discarded from pending', !fs.existsSync(held));
  ok('a refused upload never reaches the served dir',
    !fs.existsSync(path.join(root, dirs.IMAGES_DIR, `${ULID_C}.webp`)));
  ok('a refused upload has no CID', !midBand.s5_cid);

  // Promotion is queued, so assertions about its result have to wait for the
  // in-process lane to drain.
  const waitFor = async (probe, tries = 100) => {
    for (let i = 0; i < tries; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const got = await probe();
      if (got) return got;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error('timed out waiting for the publish lane');
  };

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

  const callNoKey = (method, p) => new Promise((resolve) => {
    const req = http.request({ port, path: p, method }, (res) => {
      let text = '';
      res.on('data', (d) => { text += d; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
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

  // A CID is a permanent, unretractable public handle: anyone holding one can
  // fetch and verify the bytes from any S5 node, forever. Handing one out for
  // paywalled media would be a paywall bypass that no takedown could undo, so
  // the status route must withhold it even though the route itself is
  // authenticated and the job should never have had a CID in the first place.
  const premiumStatus = JSON.parse((await call('GET', `/images/${ULID_P}/status`)).text);
  ok('a premium job reports no CID even when one is set on the record',
    premiumStatus.s5_cid === null);
  const publicStatus = JSON.parse((await call('GET', `/images/${ULID_A}/status`)).text);
  ok('a public job does report its CID', typeof publicStatus.s5_cid === 'string');

  // A premium video's thumbnail is public by design, so it must still resolve.
  const ULID_T = '01J0000000000000000000000E';
  await jobs.create(ULID_T, {
    state: 'ready', media_type: 'video', visibility: 'private', s5_thumb_cid: 'fcafebabe',
  });
  ok('cdn still serves a premium video thumbnail',
    (await call('GET', `/cdn/thumbnails/${ULID_T}.jpg`)).status === 200);

  // Same rule on the video route, which has its own response shape. The public
  // thumbnail above proves a premium video *does* hold a CID for its poster, so
  // this is not a vacuous check.
  const premiumVideo = JSON.parse((await call('GET', `/videos/${ULID_T}/status`)).text);
  ok('a premium video reports no CID', premiumVideo.s5_cid === null);

  // A refusal with no stated reason leaves someone holding a legitimate photo
  // unable to tell a false positive from a real violation, and gives them
  // nothing to fix or appeal.
  const rejStatus = JSON.parse((await call('GET', `/images/${ULID_B}/status`)).text);
  ok('a rejected upload tells the uploader why',
    Array.isArray(rejStatus.scan_reasons) && rejStatus.scan_reasons.includes('previously_removed'));
  ok('but not the score behind it, which would teach the threshold',
    rejStatus.scan_reasons.every((r) => !String(r).includes(':')));
  // The slug is for a frontend to localise; this is the fallback so a refusal is
  // never shown to someone as a bare code.
  ok('and a rejection carries a sentence a person can read',
    typeof rejStatus.scan_message === 'string' && rejStatus.scan_message.length > 20);
  const cleanStatus = JSON.parse((await call('GET', `/images/${ULID_A}/status`)).text);
  ok('a clean upload reports no reasons at all', cleanStatus.scan_reasons === null);
  ok('nor a message', cleanStatus.scan_message === null);

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

  // --- promote on publish ---
  // With S5_PROMOTE_ON_PUBLISH an upload clears the scan and lands on local
  // disk only. The URL is the /cdn/ one from the start, so promoting later
  // does not change anything an editor has already embedded in a post body.
  const cfgP = require('../src/config');
  cfgP.S5_PROMOTE_ON_PUBLISH = true;

  const ULID_D1 = '01J0000000000000000000000K';
  await makeImage(path.join(root, dirs.PENDING_IMAGES_DIR, `${ULID_D1}.webp`), 11);
  await jobs.create(ULID_D1, {
    state: 'scanning',
    media_type: 'image',
    visibility: 'public',
    pending_file: `${ULID_D1}.webp`,
    pending_thumb: null,
  });
  await processor.finalize(ULID_D1);
  const draft = await jobs.get(ULID_D1);
  const draftUrl = draft.url;

  ok('a deferred upload still publishes', draft.state === 'ready');
  ok('but nothing reached S5', !draft.s5_cid);
  ok('the slot says why', draft.mirror_state === 'deferred');
  ok('the file is on local disk',
    fs.existsSync(path.join(root, dirs.IMAGES_DIR, `${ULID_D1}.webp`)));
  ok('the URL is already the CDN one, not the local path',
    draftUrl === `${cfgP.MEDIA_CDN_BASE_URL}/images/${ULID_D1}.webp`);
  ok('and /cdn serves it from local disk',
    (await call('GET', `/cdn/images/${ULID_D1}.webp`)).status === 200);

  // 202, not 200: the backend push can take minutes for a video, so holding the
  // request open would time the caller out before it finished.
  const promoted = await call('POST', `/media/images/${ULID_D1}.webp/promote`);
  ok('promote is accepted immediately', promoted.status === 202);
  ok('and reports the same URL', JSON.parse(promoted.text).url === draftUrl);

  const settled = await waitFor(async () => {
    const j = await jobs.get(ULID_D1);
    return j.mirror_state !== 'pending' ? j : null;
  });
  ok('the queued push mints a CID', !!settled.s5_cid);
  ok('the slot ends published', settled.mirror_state === 'published');
  ok('and the URL still did not change', settled.url === draftUrl);
  ok('/cdn still serves it, now from S5',
    (await call('GET', `/cdn/images/${ULID_D1}.webp`)).status === 200);

  const again = await call('POST', `/media/images/${ULID_D1}.webp/promote`);
  ok('a second promote is a no-op, not an error', again.status === 200);
  ok('and says it was already done', JSON.parse(again.text).already === true);

  // A job still at the gate has not cleared a scan, so promotion must refuse.
  const ULID_D2 = '01J0000000000000000000000M';
  await jobs.create(ULID_D2, {
    state: 'scanning', media_type: 'image', visibility: 'public',
  });
  const early = await call('POST', `/media/images/${ULID_D2}.webp/promote`);
  ok('promoting an unscanned job is refused', early.status === 409);
  ok('and says it is not published', JSON.parse(early.text).error === 'not_published');

  // A CID cannot be withdrawn, so paywalled bytes must never get one.
  const ULID_D3 = '01J0000000000000000000000N';
  await jobs.create(ULID_D3, {
    state: 'ready', media_type: 'image', visibility: 'private',
  });
  const prem = await call('POST', `/media/images/${ULID_D3}.webp/promote`);
  ok('promoting premium media is refused', prem.status === 409);

  // A mismatched kind still finds the file, because the directory comes from
  // media_type -- so without this check it would mint a CID under /videos/ for
  // an image and persist the wrong s3d key.
  const ULID_D4 = '01J0000000000000000000000Q';
  await makeImage(path.join(root, dirs.IMAGES_DIR, `${ULID_D4}.webp`), 12);
  await jobs.create(ULID_D4, {
    state: 'ready',
    media_type: 'image',
    visibility: 'public',
    url: `${cfgP.MEDIA_CDN_BASE_URL}/images/${ULID_D4}.webp`,
  });
  const wrongKind = await call('POST', `/media/videos/${ULID_D4}.webp/promote`);
  const untouched = await jobs.get(ULID_D4);
  ok('promoting under the wrong kind is refused', wrongKind.status === 400);
  ok('and nothing was published under it', !untouched.s5_cid);

  ok('promote needs the upload key',
    (await callNoKey('POST', `/media/images/${ULID_D1}.webp/promote`)).status === 401);

  // Deferral must not relax the scanner: the destination is still S5.
  ok('a deferred job is still judged at S5 thresholds',
    mirror.isImmutable({ mediaType: 'image', visibility: 'public' }) === true);

  // The decision is the uploader's, not the deployment's. A surface with no
  // publish step (an AI site builder that saves as it goes) must publish
  // immediately -- left deferred, nothing would ever call /promote and the file
  // would sit on one disk forever.
  ok('an upload that opts out publishes immediately, even with the flag on',
    mirror.deferred({ mediaType: 'image', visibility: 'public', defer: false }) === false);
  ok('an upload that opts in defers', 
    mirror.deferred({ mediaType: 'image', visibility: 'public', defer: true }) === true);
  ok('no opinion falls back to the deployment default',
    mirror.deferred({ mediaType: 'image', visibility: 'public' }) === true);

  const ULID_D5 = '01J0000000000000000000000R';
  await makeImage(path.join(root, dirs.PENDING_IMAGES_DIR, `${ULID_D5}.webp`), 13);
  await jobs.create(ULID_D5, {
    state: 'scanning',
    media_type: 'image',
    visibility: 'public',
    defer_publish: false,
    pending_file: `${ULID_D5}.webp`,
    pending_thumb: null,
  });
  await processor.finalize(ULID_D5);
  const optedOut = await jobs.get(ULID_D5);
  ok('an opted-out upload reaches S5 without /promote', !!optedOut.s5_cid);
  ok('and its slot is published, not deferred', optedOut.mirror_state === 'published');

  // retry() had the same hardcoded 'public' for the thumb slot that finalize
  // did, so recovering a premium video would have put its poster on S5.
  const ULID_D6 = '01J0000000000000000000000S';
  await makeImage(path.join(root, dirs.PRIVATE_VIDEOS_DIR, `${ULID_D6}.mp4`), 14);
  await makeImage(path.join(root, dirs.THUMBS_DIR, `${ULID_D6}.jpg`), 15);
  await jobs.create(ULID_D6, {
    state: 'ready',
    media_type: 'video',
    visibility: 'private',
    url: `${cfgP.PUBLIC_BASE_URL}/media/videos/${ULID_D6}.mp4`,
    mirror_state: 'failed',
    thumb_state: 'failed',
  });
  await mirror.retry(ULID_D6, { force: true });
  const recovered = await jobs.get(ULID_D6);
  ok('recovering a premium video keeps it off S5', !recovered.s5_cid);
  ok('and keeps its poster off S5 too', !recovered.s5_thumb_cid);

  cfgP.S5_PROMOTE_ON_PUBLISH = false;

  // With the flag off, an upload can still ask to wait.
  ok('a per-upload opt-in works with the flag off',
    mirror.deferred({ mediaType: 'image', visibility: 'public', defer: true }) === true);
  ok('and the default stays publish-immediately',
    mirror.deferred({ mediaType: 'image', visibility: 'public' }) === false);
  ok('premium never defers, whatever is asked',
    mirror.deferred({ mediaType: 'image', visibility: 'private', defer: true }) === false);

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
  ok('a video with no thumbnail is refused', noThumb.state === 'rejected');
  ok('it is not published', !noThumb.url);
  ok('it says why', (noThumb.scan_labels || []).includes('no_thumbnail'));
  ok('and the uploader is given that reason',
    (scan.publicReasons(noThumb) || []).includes('no_thumbnail'));

  // A paywalled video's poster frame is paywalled content. Routing the thumb as
  // 'public' put it on S5, which cannot be undone -- so a premium video leaked a
  // permanent frame of itself. Both slots must stay off S5 when private.
  const ULID_PREM = '01J0000000000000000000000P';
  await fsp.writeFile(path.join(root, dirs.PENDING_VIDEOS_DIR, `${ULID_PREM}.mp4`), Buffer.alloc(64, 2));
  await makeImage(path.join(root, dirs.PENDING_THUMBS_DIR, `${ULID_PREM}.jpg`), 5);
  await jobs.create(ULID_PREM, {
    state: 'scanning',
    media_type: 'video',
    visibility: 'private',
    pending_file: `${ULID_PREM}.mp4`,
    pending_thumb: `${ULID_PREM}.jpg`,
  });
  await processor.finalize(ULID_PREM);
  const premium = await jobs.get(ULID_PREM);
  ok('a premium video publishes', premium.state === 'ready');
  ok('the video itself never reaches S5', !premium.s5_cid);
  ok('and neither does its thumbnail', !premium.s5_thumb_cid);
  ok('the video is served through the signed /media/ path',
    (premium.url || '').includes('/media/videos/'));
  ok('the thumbnail is served from local disk',
    (premium.thumbnail_url || '').includes('/thumbnails/'));
  ok('the thumbnail URL is not a CDN one',
    !(premium.thumbnail_url || '').includes('/cdn/'));
  ok('the bytes landed in the private dir',
    fs.existsSync(path.join(root, dirs.PRIVATE_VIDEOS_DIR, `${ULID_PREM}.mp4`)));

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
  ok('LIKELY adult is refused too, with no human to defer to',
    (await safeSearch({ adult: 'LIKELY', violence: 'VERY_UNLIKELY' })).verdict === 'reject');
  ok('POSSIBLE adult still publishes',
    (await safeSearch({ adult: 'POSSIBLE', violence: 'VERY_UNLIKELY' })).verdict === 'clean');
  // racy is not in SCAN_VISION_CATEGORIES by default, so it must not count
  ok('VERY_LIKELY racy is ignored by default',
    (await safeSearch({ adult: 'VERY_UNLIKELY', racy: 'VERY_LIKELY' })).verdict === 'clean');
  ok('the worst configured category wins',
    (await safeSearch({ adult: 'VERY_UNLIKELY', violence: 'VERY_LIKELY' })).verdict === 'reject');

  // --- gemini classification ---
  // It is asked to rate the image and answers under a responseSchema, so the
  // reply is integers. Reading safetyRatings instead does NOT work: those rate
  // the model's own answer, so a photo of a firearm scores NEGLIGIBLE exactly
  // like a blank image, and the provider silently passed everything.
  cfg2.SCAN_PROVIDERS = ['gemini'];
  cfg2.SCAN_GEMINI_API_KEY = 'test-key';
  const classified = (rating, extra = {}) => {
    global.fetch = async () => ({
      ok: true,
      json: async () => ({
        candidates: [{
          finishReason: 'STOP',
          content: { parts: [{ text: JSON.stringify(rating) }] },
        }],
        ...extra,
      }),
    });
    return scan.scanFile({ filePath: small, mediaType: 'image', immutable: false });
  };

  ok('95 sexual is rejected',
    (await classified({ sexual: 95, violence: 0, weapons: 0 })).verdict === 'reject');
  ok('70 is refused',
    (await classified({ sexual: 70, violence: 0, weapons: 0 })).verdict === 'reject');
  ok('30 still publishes',
    (await classified({ sexual: 30, violence: 0, weapons: 0 })).verdict === 'clean');
  ok('the worst configured category wins',
    (await classified({ sexual: 0, violence: 95, weapons: 0 })).verdict === 'reject');
  // A real photo of a gun collection rates weapons 100. That is not a takedown
  // reason, which is why weapons is not in SCAN_GEMINI_CATEGORIES.
  ok('100 weapons is ignored by default',
    (await classified({ sexual: 0, violence: 0, weapons: 100 })).verdict === 'clean');
  ok('the score is reported, not just the verdict',
    (await classified({ sexual: 70, violence: 0, weapons: 0 })).score === 0.7);

  // a refusal on explicit input is the answer, not a failure
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ promptFeedback: { blockReason: 'SAFETY' } }),
  });
  ok('a safety block counts as a reject',
    (await scan.scanFile({ filePath: small, mediaType: 'image', immutable: false })).verdict === 'reject');

  global.fetch = async () => ({
    ok: true,
    json: async () => ({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'sorry' }] } }] }),
  });
  await assert.rejects(
    () => scan.scanFile({ filePath: small, mediaType: 'image', immutable: false }),
    /unparseable/,
  );
  ok('an unparseable reply is an error, not a pass', true);

  // Free-tier Gemini answers 503 "high demand" often enough that one attempt is
  // not workable: with the gate failing closed, a blip holds the upload.
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    if (calls < 3) return { ok: false, status: 503, text: async () => 'high demand' };
    return {
      ok: true,
      json: async () => ({
        candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '{"sexual":0,"violence":0,"weapons":0}' }] } }],
      }),
    };
  };
  ok('a transient 503 is retried rather than held',
    (await scan.scanFile({ filePath: small, mediaType: 'image', immutable: false })).verdict === 'clean');
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

  // In production the same file scored 0.45 and 0.85 on consecutive uploads --
  // either side of the threshold -- making a retry a re-roll. The verdict
  // cache fixes that; drive a deliberately flip-flopping classifier and check
  // the second answer matches the first.
  const cfg3 = require('../src/config');
  const keepProv3 = cfg3.SCAN_PROVIDERS;
  const keepUrl3 = cfg3.SCAN_HTTP_URL;
  const keepFetch3 = global.fetch;
  cfg3.SCAN_PROVIDERS = ['phash', 'http'];
  cfg3.SCAN_HTTP_URL = `http://127.0.0.1:${PORT}/never`;

  const swing = [0.85, 0.2];
  let rolls = 0;
  global.fetch = async () => ({
    ok: true,
    // eslint-disable-next-line no-plusplus
    json: async () => ({ score: swing[rolls++] ?? 0.2 }),
  });

  const flaky = path.join(root, 'flaky.webp');
  await makeImage(flaky, 21);
  const firstScan = await scan.scanFile({ filePath: flaky, mediaType: 'image', immutable: true });
  const retryScan = await scan.scanFile({ filePath: flaky, mediaType: 'image', immutable: true });

  global.fetch = keepFetch3;
  cfg3.SCAN_PROVIDERS = keepProv3;
  cfg3.SCAN_HTTP_URL = keepUrl3;

  ok('a high roll is refused', firstScan.verdict === 'reject');
  ok('the retry gets the same verdict, not a second roll', retryScan.verdict === 'reject');
  ok('and it came from the cache', retryScan.providers.includes('cache'));
  ok('so the classifier was paid for once, not twice', rolls === 1);
  ok('the remembered score is the one that decided it', retryScan.score === 0.85);

  srv.close();

  console.log(`\n${passed} checks passed`);
  stub.close();
}

main().catch((err) => {
  console.error(err);
  stub.close();
  process.exit(1);
});

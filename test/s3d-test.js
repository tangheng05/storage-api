#!/usr/bin/env node
/*
| Sia integration test. A manual integration script in the same spirit as
| upload-test.js: no framework, just run it.
|
|   node test/sia-test.js
|
| It starts an in-process S3-compatible stub (multipart and fault injection
| included) and drives src/services/sia.js and src/services/mirror.js against
| it. That proves our side of the contract: key naming, multipart, round trips,
| visibility moves, purge, and that a Sia outage degrades to local delivery
| rather than failing an upload.
|
| It does NOT prove that Sia's own s3d gateway behaves this way. Only real
| credentials can do that.
*/
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert');

const PORT = 9147;

process.env.UPLOAD_API_KEY = process.env.UPLOAD_API_KEY || 'sia-test';
process.env.SIA_ENABLED = 'true';
process.env.SIA_S3_ENDPOINT = `http://127.0.0.1:${PORT}`;
process.env.SIA_S3_BUCKET = 'serey';
process.env.SIA_S3_ACCESS_KEY = 'ak';
process.env.SIA_S3_SECRET_KEY = 'sk';
process.env.SIA_PUBLIC_BASE_URL = 'https://cdn.test.local';
// s3d only: S5 would otherwise claim the public image path (see mirror.backendFor).
process.env.S5_ENABLED = 'false';

const store = new Map();
const uploads = new Map();
let seq = 0;
let failCopy = false;

const readBody = (req) => new Promise((resolve) => {
  const chunks = [];
  req.on('data', (d) => chunks.push(d));
  req.on('end', () => resolve(Buffer.concat(chunks)));
});

const stub = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const key = decodeURIComponent(u.pathname.replace(/^\/[^/]+\//, ''));
  const q = u.searchParams;

  if (req.method === 'POST' && q.has('uploads')) {
    seq += 1;
    const id = `mp${seq}`;
    uploads.set(id, { key, parts: new Map() });
    res.writeHead(200, { 'Content-Type': 'application/xml' });
    res.end(`<?xml version="1.0"?><InitiateMultipartUploadResult><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`);
    return;
  }
  if (req.method === 'POST' && q.has('uploadId')) {
    const up = uploads.get(q.get('uploadId'));
    await readBody(req);
    if (!up) { res.writeHead(404).end(); return; }
    const ordered = [...up.parts.keys()].sort((a, b) => a - b).map((n) => up.parts.get(n));
    store.set(up.key, Buffer.concat(ordered));
    uploads.delete(q.get('uploadId'));
    res.writeHead(200, { 'Content-Type': 'application/xml' });
    res.end(`<?xml version="1.0"?><CompleteMultipartUploadResult><Key>${up.key}</Key><ETag>"d"</ETag></CompleteMultipartUploadResult>`);
    return;
  }
  if (req.method === 'PUT' && q.has('partNumber')) {
    const up = uploads.get(q.get('uploadId'));
    const buf = await readBody(req);
    if (!up) { res.writeHead(404).end(); return; }
    up.parts.set(parseInt(q.get('partNumber'), 10), buf);
    res.writeHead(200, { ETag: `"p${q.get('partNumber')}"` }).end();
    return;
  }
  if (req.method === 'PUT' && req.headers['x-amz-copy-source']) {
    if (failCopy) { res.writeHead(500).end('injected'); return; }
    const src = decodeURIComponent(req.headers['x-amz-copy-source']).replace(/^\/[^/]+\//, '');
    if (!store.has(src)) { res.writeHead(404).end(); return; }
    store.set(key, store.get(src));
    res.writeHead(200, { 'Content-Type': 'application/xml' });
    res.end('<?xml version="1.0"?><CopyObjectResult><ETag>"x"</ETag></CopyObjectResult>');
    return;
  }
  if (req.method === 'PUT') {
    store.set(key, await readBody(req));
    res.writeHead(200, { ETag: '"x"' }).end();
    return;
  }
  if (req.method === 'HEAD') {
    if (!store.has(key)) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'Content-Length': store.get(key).length }).end();
    return;
  }
  if (req.method === 'GET') {
    if (!store.has(key)) { res.writeHead(404).end(); return; }
    const b = store.get(key);
    res.writeHead(200, { 'Content-Length': b.length }).end(b);
    return;
  }
  if (req.method === 'DELETE') {
    store.delete(key);
    res.writeHead(204).end();
    return;
  }
  res.writeHead(400).end();
});

const md5 = (b) => crypto.createHash('md5').update(b).digest('hex');
let passed = 0;
const check = (name, cond) => {
  assert.ok(cond, `FAILED: ${name}`);
  passed += 1;
  console.log(`  ok  ${name}`);
};

async function main() {
  await new Promise((r) => stub.listen(PORT, r));

  const sia = require('../src/services/sia');
  const mirror = require('../src/services/mirror');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sia-test-'));
  const ID = '01J0000000000000000000000A';

  // Small file: the image path.
  const small = path.join(dir, `${ID}.webp`);
  const smallBytes = Buffer.from('webp-ish bytes '.repeat(40));
  fs.writeFileSync(small, smallBytes);

  const pub = await mirror.publish({
    id: ID, kind: 'images', mediaType: 'image', file: `${ID}.webp`, filePath: small,
  });
  check('publish returns the Sia URL', pub.url === `https://cdn.test.local/images/${ID}.webp`);
  check('key is namespaced under public/', pub.patch.sia_key === `public/images/${ID}.webp`);
  check('state is published', pub.patch.mirror_state === 'published');

  const head = await sia.headObject(pub.patch.sia_key);
  check('remote size matches local', head.bytes === smallBytes.length);

  const back = path.join(dir, 'restored.webp');
  await sia.getToFile({ key: pub.patch.sia_key, filePath: back });
  check('round trip is byte-identical', md5(fs.readFileSync(back)) === md5(smallBytes));

  // Large file: forces the multipart path every video will take.
  const bigKey = `public/videos/${ID}.mp4`;
  const bigPath = path.join(dir, `${ID}.mp4`);
  const bigBytes = crypto.randomBytes(12 * 1024 * 1024);
  fs.writeFileSync(bigPath, bigBytes);
  await sia.putFile({ key: bigKey, filePath: bigPath });
  const bigBack = path.join(dir, 'back.mp4');
  await sia.getToFile({ key: bigKey, filePath: bigBack });
  check('multipart upload round trips intact', md5(fs.readFileSync(bigBack)) === md5(bigBytes));

  // Visibility move.
  const privKey = sia.buildKey({ kind: 'images', file: `${ID}.webp`, visibility: 'private' });
  await sia.moveObject({ fromKey: pub.patch.sia_key, toKey: privKey });
  check('object moved to private/', (await sia.headObject(privKey)) !== null);
  check('public/ copy is gone after the move', (await sia.headObject(pub.patch.sia_key)) === null);

  // A failed copy has to surface, or a premium file silently stays public.
  failCopy = true;
  let threw = false;
  try {
    await sia.moveObject({ fromKey: privKey, toKey: pub.patch.sia_key });
  } catch {
    threw = true;
  }
  failCopy = false;
  check('a failed move throws so the caller can record it', threw);
  check('object stays put when the move failed', (await sia.headObject(privKey)) !== null);

  await sia.deleteObject(privKey);
  check('deleteObject removes it', (await sia.headObject(privKey)) === null);

  // An outage must degrade to local delivery, never fail the upload.
  ['../src/config', '../src/services/sia', '../src/services/mirror'].forEach((m) => {
    delete require.cache[require.resolve(m)];
  });
  process.env.SIA_S3_ENDPOINT = 'http://127.0.0.1:9';
  const mirrorDown = require('../src/services/mirror');
  const failed = await mirrorDown.publish({
    id: ID, kind: 'images', mediaType: 'image', file: `${ID}.webp`, filePath: small,
  });
  check('outage returns no URL so the caller keeps local', failed.url === null);
  check('outage is recorded as failed, not thrown', failed.patch.mirror_state === 'failed');

  stub.close();
  console.log(`\n${passed} checks passed`);
}

main().catch((err) => {
  console.error(err);
  stub.close();
  process.exit(1);
});

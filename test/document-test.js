#!/usr/bin/env node
/* Document store test: node test/document-test.js
 * Drives routes/documents.js over HTTP against an in-process S3 stub. */
// Ignore any .env on this machine: a suite must not read production config.
process.env.STORAGE_TEST = '1';
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert');

const S3_PORT = 9148;
const KEY = 'doc-test-key';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-test-'));
process.env.UPLOAD_API_KEY = KEY;
process.env.JOBS_DIR = path.join(dir, 'jobs');
process.env.DOCUMENTS_DIR = path.join(dir, 'documents');
process.env.SIA_ENABLED = 'true';
process.env.SIA_S3_ENDPOINT = `http://127.0.0.1:${S3_PORT}`;
process.env.SIA_S3_BUCKET = 'serey';
process.env.SIA_S3_ACCESS_KEY = 'ak';
process.env.SIA_S3_SECRET_KEY = 'sk';
// On, so the test proves documents skip S5 by routing, not by it being off.
process.env.S5_ENABLED = 'true';
process.env.S5_NODE_URL = 'http://127.0.0.1:9149';
process.env.S5_AUTH_TOKEN = 'tok';
process.env.S5_TYPES = 'image,document';

const store = new Map();
const uploads = new Map();
let seq = 0;
let s3Down = false;

const readBody = (req) => new Promise((resolve) => {
  const chunks = [];
  req.on('data', (d) => chunks.push(d));
  req.on('end', () => resolve(Buffer.concat(chunks)));
});

const s3 = http.createServer(async (req, res) => {
  if (s3Down) { res.writeHead(503).end('unavailable'); return; }
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
  if (req.method === 'PUT') {
    store.set(key, await readBody(req));
    res.writeHead(200, { ETag: '"x"' }).end();
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

// Any hit here means a document reached S5, which must never happen.
let s5Hits = 0;
const s5 = http.createServer((req, res) => {
  s5Hits += 1;
  res.writeHead(500).end();
});

let passed = 0;
const check = (name, cond) => {
  assert.ok(cond, `FAILED: ${name}`);
  passed += 1;
  // eslint-disable-next-line no-console
  console.log(`  ok  ${name}`);
};

async function main() {
  fs.mkdirSync(process.env.JOBS_DIR, { recursive: true });
  fs.mkdirSync(process.env.DOCUMENTS_DIR, { recursive: true });
  await new Promise((r) => s3.listen(S3_PORT, r));
  await new Promise((r) => s5.listen(9149, r));

  // eslint-disable-next-line global-require
  const app = require('../src/app');
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const body = Buffer.from(JSON.stringify({
    v: 1,
    title: 'A post with ünicode and "quotes"',
    body: '<p>hello</p>'.repeat(50),
  }), 'utf8');
  const expected = crypto.createHash('sha256').update(body).digest('hex');

  // --- create ---
  const created = await fetch(`${base}/documents`, {
    method: 'POST',
    headers: { 'x-upload-key': KEY, 'Content-Type': 'application/json' },
    body,
  });
  check('POST /documents answers 201', created.status === 201);
  const doc = await created.json();
  check('sha256 is over the exact bytes sent', doc.sha256 === expected);
  check('byte count is reported', doc.bytes === body.length);
  check('storage reports published', doc.storage === 'published');

  const s3key = `private/documents/${doc.id}.json`;
  check('object is namespaced under private/documents/', store.has(s3key));
  check('stored bytes are byte-identical', store.get(s3key).equals(body));
  check('nothing was sent to S5', s5Hits === 0);

  // --- read back ---
  const unauth = await fetch(`${base}/documents/${doc.id}`);
  check('GET without the key is refused', unauth.status === 401);

  const got = await fetch(`${base}/documents/${doc.id}`, { headers: { 'x-upload-key': KEY } });
  check('GET with the key returns 200', got.status === 200);
  const roundTripped = Buffer.from(await got.arrayBuffer());
  check('round trip is byte-identical', roundTripped.equals(body));
  check(
    'round trip still hashes to the commitment',
    crypto.createHash('sha256').update(roundTripped).digest('hex') === expected,
  );

  // --- restore from s3d when local disk lost it ---
  const localPath = path.join(process.env.DOCUMENTS_DIR, `${doc.id}.json`);
  fs.rmSync(localPath);
  const restored = await fetch(`${base}/documents/${doc.id}.json`, {
    headers: { 'x-upload-key': KEY },
  });
  check('a lost local copy is restored from s3d', restored.status === 200);
  check(
    'restored bytes match the commitment',
    crypto.createHash('sha256').update(Buffer.from(await restored.arrayBuffer())).digest('hex')
      === expected,
  );

  // --- ownership, on its own document so the guard cannot eat the main one ---
  const ownedRes = await fetch(`${base}/documents`, {
    method: 'POST',
    headers: { 'x-upload-key': KEY, 'Content-Type': 'application/json', 'x-owner': 'alice' },
    body: Buffer.from('{"v":1,"body":"owned"}'),
  });
  const owned = await ownedRes.json();
  const wrongOwner = await fetch(`${base}/documents/${owned.id}`, {
    method: 'DELETE',
    headers: { 'x-upload-key': KEY, 'x-delete-owner': 'mallory' },
  });
  check('a delete from a non-owner is refused', wrongOwner.status === 403);
  check(
    'the refused delete left the bytes in place',
    store.has(`private/documents/${owned.id}.json`),
  );
  const rightOwner = await fetch(`${base}/documents/${owned.id}`, {
    method: 'DELETE',
    headers: { 'x-upload-key': KEY, 'x-delete-owner': 'alice' },
  });
  check('the owner may delete it', rightOwner.status === 200);

  // --- delete: the whole point ---
  const deleted = await fetch(`${base}/documents/${doc.id}`, {
    method: 'DELETE',
    headers: { 'x-upload-key': KEY },
  });
  check('DELETE answers 200', deleted.status === 200);
  const report = await deleted.json();
  check('delete reports the s3d object gone', /s3d:deleted/.test(report.storage?.main || ''));
  check('object is gone from the bucket', !store.has(s3key));
  check('local file is gone', !fs.existsSync(localPath));

  const after = await fetch(`${base}/documents/${doc.id}`, { headers: { 'x-upload-key': KEY } });
  check('the document no longer resolves', after.status === 404);

  // --- limits ---
  const empty = await fetch(`${base}/documents`, {
    method: 'POST',
    headers: { 'x-upload-key': KEY, 'Content-Type': 'application/json' },
    body: Buffer.alloc(0),
  });
  check('an empty document is refused', empty.status === 400);

  const noKey = await fetch(`${base}/documents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  check('POST without the key is refused', noKey.status === 401);

  const oversize = await fetch(`${base}/documents`, {
    method: 'POST',
    headers: { 'x-upload-key': KEY, 'Content-Type': 'application/json' },
    body: Buffer.alloc(3 * 1024 * 1024, 0x61),
  });
  check('an oversize document is refused', oversize.status === 413);

  // --- degraded: s3d unreachable. The post is about to go on chain, so the
  // write must still succeed locally and be marked for the retry sweep ---
  s3Down = true;
  const degradedRes = await fetch(`${base}/documents`, {
    method: 'POST',
    headers: { 'x-upload-key': KEY, 'Content-Type': 'application/json' },
    body: Buffer.from('{"v":1,"body":"written while s3d is down"}'),
  });
  check('a write still succeeds with s3d down', degradedRes.status === 201);
  const degraded = await degradedRes.json();
  check('the caller is told the push failed', degraded.storage === 'failed');
  check(
    'the bytes are on local disk regardless',
    fs.existsSync(path.join(process.env.DOCUMENTS_DIR, `${degraded.id}.json`)),
  );
  const degradedJob = JSON.parse(
    fs.readFileSync(path.join(process.env.JOBS_DIR, `${degraded.id}.json`), 'utf8'),
  );
  check('the job is left in a state the sweep retries', degradedJob.mirror_state === 'failed');
  check('the commitment is still returned', /^[0-9a-f]{64}$/.test(degraded.sha256));

  // The sweep re-pushes it once s3d is back.
  s3Down = false;
  // eslint-disable-next-line global-require
  await require('../src/services/mirror').retry(degraded.id, {
    force: true,
    states: ['failed', 'pending'],
  });
  check(
    'the retry sweep lands it on s3d',
    store.has(`private/documents/${degraded.id}.json`),
  );

  // --- a second delete must not strand a takedown ---
  const gone = await fetch(`${base}/documents/${degraded.id}`, {
    method: 'DELETE',
    headers: { 'x-upload-key': KEY },
  });
  check('first delete succeeds', gone.status === 200);
  const again = await fetch(`${base}/documents/${degraded.id}`, {
    method: 'DELETE',
    headers: { 'x-upload-key': KEY },
  });
  check('a repeat delete answers 404, not a hang or a 500', again.status === 404);

  // --- a media route must not half-delete a document ---
  // It purges the backend copy and the job record but cannot reach
  // DOCUMENTS_DIR, so the bytes would survive with nothing pointing at them.
  const survivorBody = Buffer.from(JSON.stringify({ v: 1, title: 'keep', body: 'keep me' }), 'utf8');
  const survivor = await (await fetch(`${base}/documents`, {
    method: 'POST',
    headers: { 'x-upload-key': KEY, 'Content-Type': 'application/json' },
    body: survivorBody,
  })).json();
  const survivorPath = path.join(process.env.DOCUMENTS_DIR, `${survivor.id}.json`);
  for (const kind of ['images', 'videos', 'audio']) {
    // eslint-disable-next-line no-await-in-loop
    const res = await fetch(`${base}/${kind}/${survivor.id}`, {
      method: 'DELETE',
      headers: { 'x-upload-key': KEY },
    });
    check(`DELETE /${kind}/<document-id> is refused`, res.status === 404);
  }
  check('the document bytes are still on disk', fs.existsSync(survivorPath));
  check('its s3d copy is still there', store.has(`private/documents/${survivor.id}.json`));
  check(
    'and /documents still knows about it',
    (await fetch(`${base}/documents/${survivor.id}`, { headers: { 'x-upload-key': KEY } })).status === 200,
  );

  server.close();
  s3.close();
  s5.close();
  fs.rmSync(dir, { recursive: true, force: true });
  // eslint-disable-next-line no-console
  console.log(`\n${passed} checks passed`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});

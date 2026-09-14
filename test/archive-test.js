/*
| Archive route end to end, against local-disk media only (no S5 node needed).
|
| Proves the three things a corrupt archive would break silently:
|   1. the predicted Content-Length equals the bytes actually sent,
|   2. every entry unzips back to exactly the bytes that went in,
|   3. a private file is refused to the CDN but included for its owner.
|
| Run: node test/archive-test.js
*/
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const assert = require('assert');
const yauzl = require('yauzl');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'serey-archive-'));
const dir = (name) => {
  const p = path.join(root, name);
  fs.mkdirSync(p, { recursive: true });
  return p;
};

process.env.UPLOAD_API_KEY = 'test-master-key';
process.env.JOBS_DIR = dir('jobs');
process.env.VIDEOS_DIR = dir('videos');
process.env.THUMBS_DIR = dir('thumbnails');
process.env.IMAGES_DIR = dir('images');
process.env.AUDIO_DIR = dir('audio');
// Private media has its own directory, exactly as in production. The private
// test file goes there and nowhere else: this is the layout that made a real
// premium video report "not found" to the archive on 2026-09-14.
process.env.PRIVATE_VIDEOS_DIR = dir('private/videos');
process.env.PRIVATE_IMAGES_DIR = dir('private/images');
process.env.PRIVATE_AUDIO_DIR = dir('private/audio');
process.env.PUBLIC_BASE_URL = 'http://localhost:8080';
// S5 looks configured so s5.stat passes its enabled() gate. The node is never
// really dialled: every S5 call in this test is stubbed. This must be set
// before any require, since config reads it at module load.
process.env.S5_ENABLED = 'true';
process.env.S5_NODE_URL = process.env.S5_NODE_URL || 'http://127.0.0.1:5999';
process.env.S5_AUTH_TOKEN = process.env.S5_AUTH_TOKEN || 'test-token';

const express = require('../src/app');
const archiveRouter = require('../src/routes/archive');

// ULIDs: Crockford base32, 26 chars.
const PUBLIC_ID = '01HZZZZZZZZZZZZZZZZZZZZZZA';
const PRIVATE_ID = '01HZZZZZZZZZZZZZZZZZZZZZZB';

const videoBytes = Buffer.alloc(3_000_017, 0xab);
const privateBytes = Buffer.alloc(1_234, 0xcd);

fs.writeFileSync(path.join(process.env.VIDEOS_DIR, `${PUBLIC_ID}.mp4`), videoBytes);
fs.writeFileSync(path.join(process.env.PRIVATE_VIDEOS_DIR, `${PRIVATE_ID}.mp4`), privateBytes);
fs.writeFileSync(
  path.join(process.env.JOBS_DIR, `${PUBLIC_ID}.json`),
  JSON.stringify({ id: PUBLIC_ID, state: 'ready', visibility: 'public', media_type: 'video' }),
);
fs.writeFileSync(
  path.join(process.env.JOBS_DIR, `${PRIVATE_ID}.json`),
  JSON.stringify({
    id: PRIVATE_ID, state: 'ready', visibility: 'private', media_type: 'video', owner: 'alice',
  }),
);

const app = express.listen ? express : require('express')().use('/archive', archiveRouter);

// Whole archive into { path -> bytes }.
const readZip = (buffer) =>
  new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, zip) => {
      if (err) return reject(err);
      const out = new Map();
      zip.on('entry', (entry) => {
        zip.openReadStream(entry, (streamErr, stream) => {
          if (streamErr) return reject(streamErr);
          const chunks = [];
          stream.on('data', (c) => chunks.push(c));
          stream.on('end', () => {
            out.set(entry.fileName, Buffer.concat(chunks));
            zip.readEntry();
          });
          return undefined;
        });
      });
      zip.on('end', () => resolve(out));
      zip.on('error', reject);
      zip.readEntry();
      return undefined;
    });
  });

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  // 1. The master key is required.
  const noKey = await fetch(`${base}/archive`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ entries: [] }),
  });
  assert.strictEqual(noKey.status, 401, 'POST without the master key must be refused');

  const csv = 'Title,Published\n"Hello","2026-01-01"\n';

  const create = await fetch(`${base}/archive`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-upload-key': 'test-master-key' },
    body: JSON.stringify({
      name: 'serey-alice-2026-09-14',
      allowPrivate: true,
      owner: 'alice',
      entries: [
        { path: 'videos.csv', source: { type: 'inline', content: csv } },
        { path: 'videos/hello.mp4', source: { type: 'storage', kind: 'videos', file: `${PUBLIC_ID}.mp4` } },
        { path: 'videos/hello.mp4', source: { type: 'storage', kind: 'videos', file: `${PUBLIC_ID}.mp4` } },
        { path: 'videos/paid.mp4', source: { type: 'storage', kind: 'videos', file: `${PRIVATE_ID}.mp4` } },
        { path: '../escape.mp4', source: { type: 'storage', kind: 'videos', file: `${PUBLIC_ID}.mp4` } },
        { path: 'evil.bin', source: { type: 'legacy', url: 'https://evil.example.com/x.bin' } },
      ],
    }),
  });
  assert.strictEqual(create.status, 201, `ticket create failed: ${create.status}`);
  const ticket = await create.json();

  assert.strictEqual(ticket.count, 4, `expected 4 usable entries, got ${ticket.count}`);
  assert.strictEqual(
    ticket.bytes,
    Buffer.byteLength(csv) + videoBytes.length * 2 + privateBytes.length,
    'ticket byte total is wrong',
  );
  const reasons = ticket.skipped.map((s) => s.reason).sort();
  assert.deepStrictEqual(reasons, ['bad path', 'host not allowed'], `unexpected skips: ${reasons}`);

  // 2. The download: predicted length must match the bytes on the wire.
  const dl = await fetch(`${base}/archive/${ticket.ticket}`);
  assert.strictEqual(dl.status, 200);
  assert.strictEqual(dl.headers.get('content-type'), 'application/zip');
  assert.match(dl.headers.get('content-disposition'), /serey-alice-2026-09-14\.zip/);
  const declared = parseInt(dl.headers.get('content-length'), 10);
  const body = Buffer.from(await dl.arrayBuffer());
  assert.strictEqual(body.length, declared, `Content-Length ${declared} != actual ${body.length}`);

  // 3. The archive must actually unzip, with the right bytes. Read with yauzl,
  // yazl's companion: the system tar in Git Bash is GNU tar, which cannot read
  // zip at all, so it would fail a perfectly good archive.
  const files = await readZip(body);

  const folder = 'serey-alice-2026-09-14';
  assert.strictEqual(files.get(`${folder}/videos.csv`).toString('utf8'), csv,
    'inline entry round trip failed');
  assert.ok(files.get(`${folder}/videos/hello.mp4`).equals(videoBytes),
    'stored video bytes differ after round trip');
  // The duplicate path must have been suffixed, not overwritten.
  assert.ok(files.get(`${folder}/videos/hello-2.mp4`).equals(videoBytes),
    'deduped entry is wrong');
  assert.ok(files.get(`${folder}/videos/paid.mp4`).equals(privateBytes),
    'owner private media should be included');
  assert.strictEqual(files.size, 4, `unexpected entry count: ${[...files.keys()]}`);

  // 4. Private media: visible to its owner, and to nobody else.
  const resolve = require('../src/services/resolve');
  const priv = { kind: 'videos', file: `${PRIVATE_ID}.mp4` };

  assert.strictEqual((await resolve.locate(priv)).ok, false,
    'private media must not resolve for the CDN');
  assert.strictEqual((await resolve.locate({ ...priv, allowPrivate: true })).ok, false,
    'the flag alone must not unlock private media');
  assert.strictEqual((await resolve.locate({ ...priv, allowPrivate: true, owner: 'mallory' })).ok, false,
    'another account must not read private media');
  assert.strictEqual((await resolve.locate({ ...priv, allowPrivate: true, owner: 'alice' })).ok, true,
    'the owner must be able to read their own private media');

  // The same rule through the route: a ticket for mallory drops alice's file.
  const asOther = await fetch(`${base}/archive`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-upload-key': 'test-master-key' },
    body: JSON.stringify({
      name: 'serey-mallory-2026-09-14',
      allowPrivate: true,
      owner: 'mallory',
      entries: [
        { path: 'videos/paid.mp4', source: { type: 'storage', kind: 'videos', file: `${PRIVATE_ID}.mp4` } },
      ],
    }),
  });
  const otherTicket = await asOther.json();
  assert.strictEqual(otherTicket.count, 0, "another account's private media must be skipped");

  // 5. The CDN route, rebuilt on the shared resolver, still behaves.
  const publicFile = await fetch(`${base}/cdn/videos/${PUBLIC_ID}.mp4`);
  assert.strictEqual(publicFile.status, 200, 'CDN must still serve a public local file');
  const served = Buffer.from(await publicFile.arrayBuffer());
  assert.ok(served.equals(videoBytes), 'CDN served the wrong bytes');

  const headed = await fetch(`${base}/cdn/videos/${PUBLIC_ID}.mp4`, { method: 'HEAD' });
  assert.strictEqual(headed.headers.get('content-length'), String(videoBytes.length),
    'CDN HEAD must report the byte length');

  assert.strictEqual((await fetch(`${base}/cdn/videos/${PRIVATE_ID}.mp4`)).status, 404,
    'CDN must not serve premium media');
  assert.strictEqual((await fetch(`${base}/cdn/videos/nope.mp4`)).status, 400,
    'a malformed id is a 400');
  assert.strictEqual((await fetch(`${base}/cdn/secrets/${PUBLIC_ID}.mp4`)).status, 404,
    'an unknown kind is a 404');

  // 6. The S5 branch: the path production actually serves from. No node here,
  // so s5 is stubbed to answer like one, including Range.
  const s5 = require('../src/services/s5');
  const realStat = s5.stat; // captured before the stub below replaces it
  const S5_ID = '01HZZZZZZZZZZZZZZZZZZZZZZC';
  const s5Bytes = Buffer.alloc(2_500_000, 0x5a);
  fs.writeFileSync(
    path.join(process.env.JOBS_DIR, `${S5_ID}.json`),
    JSON.stringify({
      id: S5_ID, state: 'ready', visibility: 'public', media_type: 'video', s5_cid: 'cid-abc',
    }),
  );
  // Deliberately no local file for this id: if the resolver silently fell back
  // to disk the assertions below would 404 instead of passing.

  const webStream = (buf) => new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(buf)); controller.close(); },
  });
  let lastRange = null;
  s5.fetchBlob = async (cid, { range } = {}) => {
    lastRange = range || null;
    assert.strictEqual(cid, 'cid-abc', 'resolver passed the wrong cid');
    if (range) {
      const [, from, to] = /bytes=(\d+)-(\d*)/.exec(range) || [];
      const end = to ? parseInt(to, 10) : s5Bytes.length - 1;
      const slice = s5Bytes.subarray(parseInt(from, 10), end + 1);
      return {
        ok: false, status: 206, body: webStream(slice),
        headers: new Headers({
          'content-length': String(slice.length),
          'content-range': `bytes ${from}-${end}/${s5Bytes.length}`,
        }),
      };
    }
    return {
      ok: true, status: 200, body: webStream(s5Bytes),
      headers: new Headers({ 'content-length': String(s5Bytes.length) }),
    };
  };
  s5.stat = async () => ({ bytes: s5Bytes.length });

  const whole = await fetch(`${base}/cdn/videos/${S5_ID}.mp4`);
  assert.strictEqual(whole.status, 200, 'CDN must serve an S5-backed file');
  assert.ok(Buffer.from(await whole.arrayBuffer()).equals(s5Bytes), 'S5 bytes differ');
  assert.match(whole.headers.get('cache-control'), /immutable/,
    'content addressed bytes must be cached immutable');
  assert.strictEqual(whole.headers.get('content-type'), 'video/mp4');

  // Range must reach S5 untouched and the 206 must be passed back, or seeking
  // in a video breaks.
  const ranged = await fetch(`${base}/cdn/videos/${S5_ID}.mp4`, { headers: { range: 'bytes=100-199' } });
  assert.strictEqual(ranged.status, 206, 'a ranged request must answer 206');
  assert.strictEqual(lastRange, 'bytes=100-199', 'the Range header must reach S5 unchanged');
  assert.strictEqual(ranged.headers.get('content-range'), `bytes 100-199/${s5Bytes.length}`);
  assert.strictEqual((await ranged.arrayBuffer()).byteLength, 100);

  // An S5 failure is a 502, never a silent empty file.
  s5.fetchBlob = async () => { throw new Error('node down'); };
  assert.strictEqual((await fetch(`${base}/cdn/videos/${S5_ID}.mp4`)).status, 502,
    'an S5 outage must surface as 502');

  // And the archive reads the same S5-backed file through the same resolver.
  s5.fetchBlob = async () => ({
    ok: true, status: 200, body: webStream(s5Bytes),
    headers: new Headers({ 'content-length': String(s5Bytes.length) }),
  });
  const s5Ticket = await (await fetch(`${base}/archive`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-upload-key': 'test-master-key' },
    body: JSON.stringify({
      name: 's5-export',
      entries: [{ path: 'videos/remote.mp4', source: { type: 'storage', kind: 'videos', file: `${S5_ID}.mp4` } }],
    }),
  })).json();
  assert.strictEqual(s5Ticket.bytes, s5Bytes.length, 'S5 size must come from s5.stat');
  const s5Zip = await readZip(Buffer.from(await (await fetch(`${base}/archive/${s5Ticket.ticket}`)).arrayBuffer()));
  assert.ok(s5Zip.get('s5-export/videos/remote.mp4').equals(s5Bytes),
    'archive must stream S5-backed bytes intact');

  // 6b. s5.stat must report a size even when the node ignores Range and answers
  // 200 with the whole body (no content-range). This is the exact case that
  // dropped a public thumbnail from an export the CDN served fine.
  {
    const realFetch = global.fetch;
    global.fetch = async () => ({
      ok: true,
      status: 200,
      body: { cancel: async () => {} },
      headers: new Headers({ 'content-length': '124693' }),
    });
    try {
      const stat = await realStat('cid-no-range');
      assert.ok(stat && stat.bytes === 124693,
        `stat must fall back to content-length, got ${JSON.stringify(stat)}`);
    } finally {
      global.fetch = realFetch;
    }
  }

  // 7. An expired or unknown ticket is a 404.
  const bogus = await fetch(`${base}/archive/nope`);
  assert.strictEqual(bogus.status, 404);

  server.close();
  await fsp.rm(root, { recursive: true, force: true });
  console.log('archive-test: all assertions passed');
})().catch((err) => {
  console.error('archive-test FAILED:', err.message);
  process.exit(1);
});

#!/usr/bin/env node
// Ignore any .env on this machine: a suite must not read production config.
process.env.STORAGE_TEST = '1';
/*
| CDN purge on delete: node test/cdn-purge-test.js
|
| Deleting the bytes does not reach the edge. Cloudflare kept serving a deleted
| image for about a day, which for a takedown is the difference between removed
| and removed eventually.
|
| The rule that matters: a purge failure must never fail the delete. The bytes
| are already gone by then, so the answer is to shout, not to unwind.
*/
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cdn-purge-'));
process.env.UPLOAD_API_KEY = 'cdn-test';
process.env.JOBS_DIR = path.join(root, 'jobs');
process.env.IMAGES_DIR = path.join(root, 'images');
process.env.SIA_ENABLED = 'false';
process.env.S5_ENABLED = 'false';
process.env.CLOUDFLARE_ZONE_ID = 'zone123';
process.env.CLOUDFLARE_PURGE_TOKEN = 'token123';
for (const d of ['jobs', 'images']) fs.mkdirSync(path.join(root, d), { recursive: true });

const config = require('../src/config');
const jobs = require('../src/services/jobs');
const cdn = require('../src/services/cdn');

let passed = 0;
const check = (name, cond) => {
  assert.ok(cond, `FAILED: ${name}`);
  passed += 1;
  // eslint-disable-next-line no-console
  console.log(`  ok  ${name}`);
};

// Stand in for Cloudflare: record what was asked for, answer how we are told.
const asked = [];
let reply = { status: 200, body: { success: true } };
const stub = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (d) => { raw += d; });
  req.on('end', () => {
    asked.push({
      url: req.url,
      auth: req.headers.authorization,
      files: JSON.parse(raw || '{}').files || [],
    });
    if (reply.hang) return; // never responds, to exercise the timeout
    res.writeHead(reply.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(reply.body));
  });
});

async function main() {
  await new Promise((r) => stub.listen(0, r));
  const base = `http://127.0.0.1:${stub.address().port}`;
  // Point the service at the stub without changing its shape.
  const realFetch = global.fetch;
  global.fetch = (url, init) =>
    realFetch(String(url).replace('https://api.cloudflare.com/client/v4/zones', base), init);

  const A = 'https://cdn.example.com/images/01J0000000000000000000000A.webp';
  const B = 'https://cdn.example.com/thumbnails/01J0000000000000000000000A.jpg';

  // --- the ordinary case ---
  asked.length = 0;
  check('a purge reports success', (await cdn.purge([A, B])) === 'purged');
  check('both URLs were sent', asked[0].files.length === 2);
  check('the zone is in the path', asked[0].url.includes('zone123'));
  check('the token is a bearer header', asked[0].auth === 'Bearer token123');

  // --- what not to send ---
  asked.length = 0;
  check('nothing to purge is not a failure',
    (await cdn.purge([null, undefined, ''])) === 'nothing-to-purge');
  check('and no call was made', asked.length === 0);
  check('a local disk path is never sent to Cloudflare',
    (await cdn.purge(['/var/www/images/x.webp'])) === 'nothing-to-purge');
  asked.length = 0;
  await cdn.purge([A, A, B]);
  check('duplicates are collapsed', asked[0].files.length === 2);

  // --- failures are reported, never swallowed ---
  // Cloudflare answers 200 with success:false, so the status alone would call
  // a rejected purge a success.
  reply = { status: 200, body: { success: false, errors: [{ message: 'invalid zone' }] } };
  check('a 200 carrying success:false is a failure', (await cdn.purge([A])) === 'failed');

  reply = { status: 403, body: { success: false, errors: [{ message: 'bad token' }] } };
  check('a rejected token is a failure', (await cdn.purge([A])) === 'failed');

  reply = { hang: true };
  const slow = config.CDN_PURGE_TIMEOUT_MS;
  config.CDN_PURGE_TIMEOUT_MS = 150;
  check('a hung edge times out rather than blocking the delete',
    (await cdn.purge([A])) === 'failed');
  config.CDN_PURGE_TIMEOUT_MS = slow;
  reply = { status: 200, body: { success: true } };

  // --- unconfigured is honest, not silent success ---
  const zone = config.CLOUDFLARE_ZONE_ID;
  config.CLOUDFLARE_ZONE_ID = '';
  check('without a zone it says so', (await cdn.purge([A])) === 'not-configured');
  check('and enabled() is false', cdn.enabled() === false);
  config.CLOUDFLARE_ZONE_ID = zone;
  check('and true once configured', cdn.enabled() === true);

  // --- the delete must survive a broken edge ---
  const app = require('../src/app');
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const port = server.address().port;
  const del = (id) => new Promise((resolve) => {
    const rq = http.request(
      { port, path: `/images/${id}`, method: 'DELETE', headers: { 'x-upload-key': 'cdn-test' } },
      (r) => {
        let t = '';
        r.on('data', (d) => { t += d; });
        r.on('end', () => resolve({ status: r.statusCode, body: JSON.parse(t || '{}') }));
      },
    );
    rq.end();
  });

  const ID = '01J0000000000000000000000A';
  const file = path.join(root, 'images', `${ID}.webp`);
  fs.writeFileSync(file, 'bytes');
  await jobs.create(ID, { state: 'ready', media_type: 'image', visibility: 'public', url: A });

  reply = { status: 500, body: { success: false, errors: [{ message: 'cloudflare down' }] } };
  const broken = await del(ID);
  check('the delete still succeeds when the purge fails', broken.status === 200);
  check('the bytes are gone regardless', !fs.existsSync(file));
  check('the job is gone regardless', !(await jobs.get(ID)));
  check('and the caller is told the edge was not purged', broken.body.cdn === 'failed');

  const ID2 = '01J0000000000000000000000B';
  const file2 = path.join(root, 'images', `${ID2}.webp`);
  fs.writeFileSync(file2, 'bytes');
  await jobs.create(ID2, { state: 'ready', media_type: 'image', visibility: 'public', url: A });
  reply = { status: 200, body: { success: true } };
  const good = await del(ID2);
  check('a working purge is reported on the delete', good.body.cdn === 'purged');

  server.close();
  stub.close();
  global.fetch = realFetch;
  fs.rmSync(root, { recursive: true, force: true });
  // eslint-disable-next-line no-console
  console.log(`\n${passed} checks passed`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});

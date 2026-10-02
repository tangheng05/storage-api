#!/usr/bin/env node
/*
| Random id test: node test/random-id-test.js (no framework). Proves new media
| carries no creation time anywhere public: ids are random but still match
| every ULID-shaped check (ours, nginx's, serey-api's, the web app's), and no
| file response carries the file's mtime in Last-Modified or the ETag, while
| caching still revalidates with a 304.
*/
// Ignore any .env on this machine: a suite must not read production config.
process.env.STORAGE_TEST = '1';
const assert = require('assert');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const http = require('http');

process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'silent';
process.env.UPLOAD_API_KEY = 'random-id-test';

let checks = 0;
const ok = (label, cond) => {
  assert.ok(cond, label);
  checks += 1;
  // eslint-disable-next-line no-console
  console.log(`  ok  ${label}`);
};

const request = (port, urlPath, headers = {}) =>
  new Promise((resolve, reject) => {
    http.get({ port, path: urlPath, headers }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }));
    }).on('error', reject);
  });

// What a real ULID's first ten characters would decode to.
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const decodeTime = (id) => [...id.slice(0, 10)].reduce((t, c) => t * 32 + CROCKFORD.indexOf(c), 0);

(async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'random-id-'));
  for (const [key, rel] of Object.entries({
    JOBS_DIR: 'jobs', TUS_DIR: 'tus', IMAGES_DIR: 'images', PENDING_IMAGES_DIR: 'pending/images',
  })) {
    process.env[key] = path.join(root, rel);
    await fsp.mkdir(process.env[key], { recursive: true });
  }

  const { randomId } = require('../src/utils/id');
  const jobs = require('../src/services/jobs');
  const config = require('../src/config');
  const tusServer = require('../src/tus');
  const app = require('../src/app');

  // --- ids ---

  const ids = Array.from({ length: 5000 }, () => randomId());
  ok('every id matches the ULID shape the whole stack checks for', ids.every((id) => jobs.ULID_REGEX.test(id)));
  ok('every id is a valid ULID (first character 0-7)', ids.every((id) => id[0] <= '7'));
  ok('no two ids collide', new Set(ids).size === ids.length);

  const now = Date.now();
  const nearNow = ids.filter((id) => Math.abs(decodeTime(id) - now) < 24 * 3600 * 1000).length;
  ok('the leading characters do not decode to the creation time', nearNow < 3);

  const firstChars = new Set(ids.map((id) => id.slice(0, 2)));
  ok('ids made in the same instant do not share a time prefix', firstChars.size > 200);

  ok('tus names new uploads with a random id', jobs.ULID_REGEX.test(await tusServer.options.namingFunction({}))
    && Math.abs(decodeTime(await tusServer.options.namingFunction({})) - now) > 3600 * 1000);

  // --- response headers ---

  const ID = randomId();
  const file = `${ID}.jpg`;
  await fsp.writeFile(path.join(config.IMAGES_DIR, file), Buffer.alloc(2048, 9));
  await jobs.create(ID, {
    state: 'ready',
    media_type: 'image',
    visibility: 'public',
    url: `${config.PUBLIC_BASE_URL}/cdn/images/${file}`,
  });

  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const { port } = server.address();

  for (const route of [`/cdn/images/${file}`, `/images/${file}`]) {
    const res = await request(port, route);
    ok(`${route} serves the file`, res.status === 200);
    ok(`${route} sends no Last-Modified`, res.headers['last-modified'] === undefined);
    ok(`${route} has an ETag made from the name, not the mtime`, res.headers.etag === `"${file}"`);
    const again = await request(port, route, { 'if-none-match': `"${file}"` });
    ok(`${route} still answers a revalidation with 304`, again.status === 304);
  }

  server.close();
  await fsp.rm(root, { recursive: true, force: true });
  // eslint-disable-next-line no-console
  console.log(`\n${checks} checks passed`);
  process.exit(0);
})().catch((e) => {
  // eslint-disable-next-line no-console
  console.error('FAILED:', e.message);
  process.exit(1);
});

// The two fields the community storage quota depends on: `bytes` on a job's
// status (the stored size, not the upload length) and `community_id` carried
// from tus metadata onto the job.
// Ignore any .env on this machine: a suite must not read production config.
process.env.STORAGE_TEST = '1';
const assert = require('assert');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const http = require('http');

process.env.UPLOAD_API_KEY = 'cs-test-key';

let checks = 0;
const ok = (label, cond) => {
  assert.ok(cond, label);
  checks += 1;
  // eslint-disable-next-line no-console
  console.log(`  ok  ${label}`);
};

const get = (port, urlPath, headers = {}) =>
  new Promise((resolve, reject) => {
    http.get({ port, path: urlPath, headers }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(body); } catch {}
        resolve({ status: res.statusCode, json, body });
      });
    }).on('error', reject);
  });

(async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'cs-storage-'));
  process.env.JOBS_DIR = path.join(root, 'jobs');
  process.env.MEDIA_ROOT = path.join(root, 'media');
  process.env.IMAGES_DIR = path.join(root, 'media', 'images');
  process.env.VIDEOS_DIR = path.join(root, 'media', 'videos');
  process.env.PENDING_IMAGES_DIR = path.join(root, 'media', 'pending', 'images');
  process.env.PRIVATE_IMAGES_DIR = path.join(root, 'media', 'private', 'images');
  await fsp.mkdir(process.env.JOBS_DIR, { recursive: true });
  await fsp.mkdir(process.env.IMAGES_DIR, { recursive: true });
  await fsp.mkdir(process.env.PENDING_IMAGES_DIR, { recursive: true });

  const config = require('../src/config');
  const jobs = require('../src/services/jobs');
  const forever = require('../src/services/forever');
  const app = require('../src/app');

  const ID = '01M3TESTTESTTESTTESTTESTAA';

  // A published image: 4096 real bytes on disk, but the upload declared 99999.
  // The quota must be charged the stored size, never the upload length.
  await fsp.writeFile(path.join(config.IMAGES_DIR, `${ID}.webp`), Buffer.alloc(4096, 7));
  await jobs.create(ID, {
    state: 'ready',
    media_type: 'image',
    filename: 'photo.jpg',
    filetype: 'image/jpeg',
    size: 99999,
    owner: 'alice',
    community_id: 42,
    visibility: 'public',
    url: `${config.PUBLIC_BASE_URL}/cdn/images/${ID}.webp`,
  });

  const job = await jobs.get(ID);
  ok('the job round-trips community_id', job.community_id === 42);

  const measured = await forever.bytesOf(job);
  ok('bytesOf measures the stored file, not the upload length', measured === 4096);
  ok('bytesOf does not fall back to job.size when the file exists', measured !== 99999);

  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const { port } = server.address();

  const unauth = await get(port, `/images/${ID}/status`);
  ok('status still refuses an unkeyed caller', unauth.status === 401);

  const res = await get(port, `/images/${ID}/status`, { 'x-upload-key': 'cs-test-key' });
  ok('status answers the master key', res.status === 200);
  ok('status exposes bytes', res.json && res.json.bytes === 4096);
  ok('status exposes community_id', res.json && res.json.community_id === 42);
  ok('status still exposes state', res.json && res.json.state === 'ready');
  ok('status does not leak the upload token', res.json && res.json.upload_token === undefined);

  // A job whose bytes are not on disk falls back to the declared size. This is
  // why serey-api refuses any size unless state is 'ready'.
  const ID2 = '01M3TESTTESTTESTTESTTESTBB';
  await jobs.create(ID2, {
    state: 'processing',
    media_type: 'image',
    filename: 'wip.jpg',
    filetype: 'image/jpeg',
    size: 77777,
    visibility: 'public',
    url: `${config.PUBLIC_BASE_URL}/cdn/images/${ID2}.webp`,
  });
  const wip = await get(port, `/images/${ID2}/status`, { 'x-upload-key': 'cs-test-key' });
  ok('an unfinished job still answers', wip.status === 200);
  ok('an unfinished job reports the upload length', wip.json && wip.json.bytes === 77777);
  ok('and reports a state serey-api will reject', wip.json && wip.json.state !== 'ready');

  // A job with no community carries null, not undefined or a stray default.
  const ID3 = '01M3TESTTESTTESTTESTTESTCC';
  await jobs.create(ID3, {
    state: 'ready', media_type: 'image', filename: 'x.jpg', filetype: 'image/jpeg',
    size: 10, visibility: 'public', community_id: null,
    url: `${config.PUBLIC_BASE_URL}/cdn/images/${ID3}.webp`,
  });
  const none = await get(port, `/images/${ID3}/status`, { 'x-upload-key': 'cs-test-key' });
  ok('a job with no community reports null', none.json && none.json.community_id === null);

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

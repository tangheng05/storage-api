#!/usr/bin/env node
// Ignore any .env on this machine: a suite must not read production config.
process.env.STORAGE_TEST = '1';
process.env.LOG_LEVEL = 'silent';
/*
| Forever mode: node test/arweave-test.js
|
| A second, permanent copy on Arweave, behind its own key. What has to hold:
|
|   - the route refuses anything the scan gate has not cleared, anything
|     paywalled, anything over the cap, and any caller without the arweave key
|   - the bytes paid for are the bytes S5 holds, checked by CID before upload
|   - S5 comes first, so a deferred upload is pushed there on the way
|   - identical bytes reuse one data item instead of paying twice
|   - a failure is recorded and never retried on its own; a restart marks an
|     in-flight upload failed rather than paying again blind
|   - the delete report says 'permanent' and the CID becomes visible
|   - /cdn falls back to a gateway only when S5 fails
|
| Turbo is stubbed at the service boundary; nothing here touches the network.
*/
const assert = require('assert');
const fs = require('fs');
const fsp = require('fs/promises');
const http = require('http');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arweave-'));
process.env.UPLOAD_API_KEY = 'upload-key';
process.env.ARWEAVE_API_KEY = 'arweave-key';
process.env.ARWEAVE_ENABLED = 'true';
process.env.ARWEAVE_JWK_PATH = path.join(root, 'wallet.json');
process.env.ARWEAVE_MAX_BYTES = '1000';
process.env.ARWEAVE_MIN_BALANCE_WINC = '100';
process.env.ARWEAVE_GATEWAYS = 'https://gw.example/,https://alt.example';
process.env.JOBS_DIR = path.join(root, 'jobs');
process.env.IMAGES_DIR = path.join(root, 'images');
process.env.PRIVATE_IMAGES_DIR = path.join(root, 'private');
process.env.VIDEOS_DIR = path.join(root, 'videos');
process.env.THUMBS_DIR = path.join(root, 'thumbs');
process.env.DOCUMENTS_DIR = path.join(root, 'documents');
process.env.S5_ENABLED = 'true';
process.env.S5_NODE_URL = 'http://127.0.0.1:9';
process.env.S5_AUTH_TOKEN = 'tok';
process.env.S5_TYPES = 'image,video';
process.env.S5_EXPOSE_CID = 'false';
process.env.SIA_ENABLED = 'false';
process.env.SCAN_ENABLED = 'false';
process.env.PUBLIC_BASE_URL = 'http://storage.test';
for (const d of ['jobs', 'images', 'private', 'videos', 'thumbs', 'documents']) {
  fs.mkdirSync(path.join(root, d), { recursive: true });
}
fs.writeFileSync(process.env.ARWEAVE_JWK_PATH, '{}');

const config = require('../src/config');
const jobs = require('../src/services/jobs');
const s5 = require('../src/services/s5');
const arweave = require('../src/services/arweave');
const forever = require('../src/services/forever');
const mirror = require('../src/services/mirror');
const app = require('../src/app');

let passed = 0;
const check = (name, cond) => {
  assert.ok(cond, `FAILED: ${name}`);
  passed += 1;
  // eslint-disable-next-line no-console
  console.log(`  ok  ${name}`);
};

// --- stubs: Turbo and the S5 node, at the service boundary ---
const TX = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-AbCdE';
const uploads = [];
let balance = 10n ** 9n;
let costPerByte = 1n;
let failUpload = null;
arweave.balance = async () => balance;
arweave.cost = async (bytes) => BigInt(bytes) * costPerByte;
arweave.estimate = async (bytes) => ({ bytes, winc: (BigInt(bytes) * costPerByte).toString(), usd: 0.01 });
arweave.putFile = async ({ filePath, contentType, tags }) => {
  if (failUpload) throw new Error(failUpload);
  const bytes = (await fsp.stat(filePath)).size;
  uploads.push({ filePath, contentType, tags, bytes });
  return { id: `${TX.slice(0, 40)}${String(uploads.length).padStart(3, '0')}`, bytes, winc: String(bytes) };
};
arweave.stat = async () => 'turbo:confirmed gateway:ok';

// S5 never sees the network: putFile hashes for real and "stores" nothing,
// stat says every CID resolves, fetchBlob fails on demand for the fallback test.
let s5Down = false;
let s5Pushes = 0;
let s5Slow = 0;
s5.putFile = async ({ filePath }) => {
  s5Pushes += 1;
  if (s5Slow) await new Promise((r) => setTimeout(r, s5Slow));
  const { cid, size } = await s5.hashFile(filePath);
  return { cid, bytes: size };
};
s5.getToFile = async ({ cid, filePath }) => {
  await fsp.writeFile(filePath, restorable[cid] || '');
  return { cid };
};
const restorable = {};
s5.stat = async () => ({ bytes: 1 });
s5.fetchBlob = async () => {
  if (s5Down) throw new Error('node unreachable');
  return new Response('bytes', { status: 200, headers: { 'content-length': '5' } });
};

const server = http.createServer(app);
let base;
const request = async (method, url, { headers = {}, body } = {}) => {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, headers: res.headers };
};
const AR = { 'x-arweave-key': 'arweave-key' };
const UP = { 'x-upload-key': 'upload-key' };

// Drains the arweave lane: the route answers 202 and the work happens after.
const settle = () => new Promise((r) => setTimeout(r, 50));
const untilState = async (id, wanted, tries = 40) => {
  for (let i = 0; i < tries; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const job = await jobs.get(id);
    if (wanted.includes(job.arweave_state)) return job;
    // eslint-disable-next-line no-await-in-loop
    await settle();
  }
  return jobs.get(id);
};

let n = 0;
const nextId = () => `01J0000000000000000000${String((n += 1)).padStart(4, '0')}`.slice(0, 26);

async function makeImage({ bytes = 'hello forever', visibility = 'public', onS5 = true, state = 'ready', extra = {} } = {}) {
  const id = nextId();
  const file = `${id}.webp`;
  const dir = visibility === 'private' ? config.PRIVATE_IMAGES_DIR : config.IMAGES_DIR;
  const filePath = path.join(dir, file);
  await fsp.writeFile(filePath, bytes);
  const { cid } = await s5.hashFile(filePath);
  await jobs.create(id, {
    state,
    media_type: 'image',
    visibility,
    size: Buffer.byteLength(bytes),
    owner: 'alice',
    url: `${config.MEDIA_CDN_BASE_URL}/images/${file}`,
    ...(onS5
      ? { storage_backend: 's5', s5_cid: cid, mirror_state: 'published' }
      : { mirror_state: 'deferred' }),
    ...extra,
  });
  return { id, file, filePath, cid };
}

async function main() {
  await new Promise((r) => { server.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;

  // --- auth ---
  {
    const { id, file } = await makeImage();
    const noKey = await request('POST', `/media/images/${file}/arweave`);
    check('no key is 401', noKey.status === 401);
    const uploadKey = await request('POST', `/media/images/${file}/arweave`, { headers: UP });
    check('the upload key is not enough: every frontend holds it', uploadKey.status === 401);
    const est = await request('GET', `/media/images/${file}/arweave/estimate`, { headers: UP });
    check('the estimate needs the arweave key too', est.status === 401);
    const job = await jobs.get(id);
    check('nothing was queued', !job.arweave_state);
  }

  // --- refusals, shared by estimate and POST ---
  {
    const priv = await makeImage({ visibility: 'private' });
    const r = await request('POST', `/media/images/${priv.file}/arweave`, { headers: AR });
    check('paywalled media is refused: a data item is public to anyone with the id',
      r.status === 409 && r.json.error === 'premium_media_is_never_permanent');
    const e = await request('GET', `/media/images/${priv.file}/arweave/estimate`, { headers: AR });
    check('the estimate refuses it the same way', e.status === 409 && e.json.error === 'premium_media_is_never_permanent');

    const held = await makeImage({ state: 'scanning' });
    const h = await request('POST', `/media/images/${held.file}/arweave`, { headers: AR });
    check('a job still at the scan gate is refused', h.status === 409 && h.json.error === 'not_published');

    const big = await makeImage({ bytes: 'x'.repeat(1001) });
    const b = await request('POST', `/media/images/${big.file}/arweave`, { headers: AR });
    check('over the cap is 413', b.status === 413 && b.json.error === 'over_permanence_cap');

    const wrongKind = await makeImage();
    const w = await request('POST', `/media/videos/${wrongKind.file}/arweave`, { headers: AR });
    check('a kind that does not match the job is refused', w.status === 400 && w.json.expected === 'images');

    const missing = await request('POST', `/media/images/${nextId()}.webp/arweave`, { headers: AR });
    check('unknown media is 404', missing.status === 404);
    check('none of that reached Turbo', uploads.length === 0);
  }

  // --- estimate ---
  {
    const { file } = await makeImage({ bytes: 'twenty bytes exactly' });
    const e = await request('GET', `/media/images/${file}/arweave/estimate`, { headers: AR });
    check('the estimate quotes the file size in winc', e.status === 200 && e.json.winc === '20' && e.json.bytes === 20);
    check('and says it is not yet forever', e.json.already === false);

    // job.size is the upload; the published file is re-encoded and can differ.
    const { file: f2 } = await makeImage({ bytes: 'twelve bytes', extra: { size: 999999 } });
    const e2 = await request('GET', `/media/images/${f2}/arweave/estimate`, { headers: AR });
    check('the estimate follows the file on disk, not the upload size', e2.status === 200 && e2.json.bytes === 12);
  }

  // --- the ordinary case ---
  {
    const { id, file, cid } = await makeImage({ bytes: 'the ordinary case' });
    const r = await request('POST', `/media/images/${file}/arweave`, { headers: AR });
    check('accepted, not done: 202 and pending', r.status === 202 && r.json.queued === true && r.json.arweave_state === 'pending');

    const job = await untilState(id, ['published', 'failed']);
    check('the upload finished as published', job.arweave_state === 'published');
    check('the id is an Arweave transaction id', arweave.ID_RE.test(job.arweave_id));
    check('the job records bytes, cost and gateway check', job.arweave_bytes === 17 && job.arweave_winc === '17' && job.arweave_gateway === 'turbo:confirmed gateway:ok');

    const up = uploads[uploads.length - 1];
    check('the data item carries the S5 CID, the media id and the author',
      up.tags.some((t) => t.name === 'S5-CID' && t.value === cid)
      && up.tags.some((t) => t.name === 'Serey-Media-Id' && t.value === id)
      && up.tags.some((t) => t.name === 'Serey-Author' && t.value === 'alice')
      && up.tags.some((t) => t.name === 'App-Name' && t.value === 'Serey'));
    check('the content type follows the file', up.contentType === 'image/webp');

    const status = await request('GET', `/images/${id}/status`, { headers: UP });
    check('status shows the arweave fields', status.json.arweave_state === 'published' && status.json.arweave_id === job.arweave_id);
    check('the gateway URL uses the first configured gateway, no double slash',
      status.json.arweave_url === `https://gw.example/${job.arweave_id}`);
    check('the CID becomes visible for a forever job even with S5_EXPOSE_CID off',
      status.json.s5_cid === cid);

    const again = await request('POST', `/media/images/${file}/arweave`, { headers: AR });
    check('asking again is idempotent: 200, same id, nothing queued',
      again.status === 200 && again.json.already === true && again.json.arweave_id === job.arweave_id);
    const est = await request('GET', `/media/images/${file}/arweave/estimate`, { headers: AR });
    check('the estimate reports already forever', est.json.already === true && est.json.arweave_id === job.arweave_id);
    const before = uploads.length;
    await settle();
    check('no second upload happened', uploads.length === before);
  }

  // --- S5 first ---
  {
    const { id, file, cid } = await makeImage({ bytes: 'deferred until publish', onS5: false });
    const r = await request('POST', `/media/images/${file}/arweave`, { headers: AR });
    check('a deferred upload is accepted', r.status === 202);
    const job = await untilState(id, ['published', 'failed']);
    check('it was pushed to S5 on the way', job.s5_cid === cid && job.mirror_state === 'published');
    check('and then to Arweave', job.arweave_state === 'published');
    const up = uploads[uploads.length - 1];
    check('with the fresh CID in the tags', up.tags.some((t) => t.name === 'S5-CID' && t.value === cid));
  }

  // --- a queued /promote is joined, not raced ---
  {
    const queue = require('../src/services/queue');
    const { id, file, cid } = await makeImage({ bytes: 'promote then forever', onS5: false });
    s5Slow = 150;
    const before = s5Pushes;
    // What /promote does: mark pending and queue the push on the publish lane.
    await jobs.update(id, { mirror_state: 'pending' });
    queue.push(() => mirror.retry(id, { force: true, states: ['pending'] }), queue.PUBLISH_LANE);
    const r = await request('POST', `/media/images/${file}/arweave`, { headers: AR });
    check('forever asked while a promote is still queued is accepted', r.status === 202);
    const job = await untilState(id, ['published', 'failed']);
    s5Slow = 0;
    check('it ends up on both', job.s5_cid === cid && job.arweave_state === 'published');
    check('and the file went to S5 exactly once', s5Pushes - before === 1);
  }

  // --- local copy gone: restored from S5, verified, paid for, temp removed ---
  {
    const { id, file, filePath, cid } = await makeImage({ bytes: 'only on s5 now' });
    restorable[cid] = 'only on s5 now';
    await fsp.rm(filePath);
    await request('POST', `/media/images/${file}/arweave`, { headers: AR });
    const job = await untilState(id, ['published', 'failed']);
    check('a file whose local copy is gone is restored from S5 and published', job.arweave_state === 'published');
    const up = uploads[uploads.length - 1];
    check('from a temp file beside the original', up.filePath === path.join(config.IMAGES_DIR, `.${file}.arweave`));
    check('which is removed afterwards', !fs.existsSync(up.filePath));

    const bad = await makeImage({ bytes: 'restore corrupt' });
    restorable[bad.cid] = 'not the same bytes';
    await fsp.rm(bad.filePath);
    const before = uploads.length;
    await request('POST', `/media/images/${bad.file}/arweave`, { headers: AR });
    const bj = await untilState(bad.id, ['published', 'failed']);
    check('a restore that does not hash to the CID is refused', bj.arweave_state === 'failed');
    check('and never paid for', uploads.length === before);
  }

  // --- bytes must match the CID: S5 is the reference ---
  {
    const { id, file, filePath, cid } = await makeImage({ bytes: 'original bytes' });
    await fsp.writeFile(filePath, 'tampered bytes');
    restorable[cid] = 'original bytes';
    await request('POST', `/media/images/${file}/arweave`, { headers: AR });
    const job = await untilState(id, ['published', 'failed']);
    check('a local copy that drifted from the S5 CID is replaced by a restore, not paid for', job.arweave_state === 'published');
    const up = uploads[uploads.length - 1];
    check('what went up is the S5 bytes', up.bytes === Buffer.byteLength('original bytes') && up.filePath.endsWith('.arweave'));

    const both = await makeImage({ bytes: 'both wrong' });
    await fsp.writeFile(both.filePath, 'drifted');
    restorable[both.cid] = 'also wrong';
    const before = uploads.length;
    await request('POST', `/media/images/${both.file}/arweave`, { headers: AR });
    const bj = await untilState(both.id, ['published', 'failed']);
    check('when the restore is wrong too it fails', bj.arweave_state === 'failed' && /differ from S5/.test(bj.arweave_error));
    check('and never pays', uploads.length === before);
  }

  // --- identical bytes, one data item ---
  {
    const a = await makeImage({ bytes: 'same bytes twice' });
    await request('POST', `/media/images/${a.file}/arweave`, { headers: AR });
    const first = await untilState(a.id, ['published', 'failed']);
    const before = uploads.length;
    const b = await makeImage({ bytes: 'same bytes twice' });
    await request('POST', `/media/images/${b.file}/arweave`, { headers: AR });
    const second = await untilState(b.id, ['published', 'failed']);
    check('a second job with the same CID reuses the data item', second.arweave_state === 'published' && second.arweave_id === first.arweave_id);
    check('and pays nothing', uploads.length === before);
  }

  // --- credits ---
  {
    const text = 'costs its size in winc';
    const { id, file } = await makeImage({ bytes: text });
    balance = BigInt(Buffer.byteLength(text)) + 99n; // one short of cost + floor
    const before = uploads.length;
    await request('POST', `/media/images/${file}/arweave`, { headers: AR });
    const job = await untilState(id, ['published', 'failed']);
    check('below the balance floor the upload is refused', job.arweave_state === 'failed' && job.arweave_error === 'arweave_credits_low');
    check('and nothing was sent', uploads.length === before);
    balance = 10n ** 9n;
  }

  // --- failure is recorded, and retried only when asked ---
  {
    const { id, file } = await makeImage({ bytes: 'turbo hiccup' });
    failUpload = 'turbo 503';
    await request('POST', `/media/images/${file}/arweave`, { headers: AR });
    let job = await untilState(id, ['published', 'failed']);
    check('a Turbo failure lands in failed with the message', job.arweave_state === 'failed' && job.arweave_error === 'turbo 503');
    const status = await request('GET', `/images/${id}/status`, { headers: UP });
    check('status shows failed, the reason, and no id', status.json.arweave_state === 'failed' && status.json.arweave_error === 'turbo 503' && status.json.arweave_id === null);

    failUpload = null;
    const r = await request('POST', `/media/images/${file}/arweave`, { headers: AR });
    check('asking again re-queues it', r.status === 202);
    job = await untilState(id, ['published', 'failed']);
    check('and it succeeds', job.arweave_state === 'published');
  }

  // --- boot recovery ---
  {
    const pending = await makeImage({ bytes: 'was pending', extra: { arweave_state: 'pending' } });
    const inFlight = await makeImage({ bytes: 'was uploading', extra: { arweave_state: 'uploading' } });
    forever.recoverOnBoot();
    const p = await untilState(pending.id, ['published', 'failed']);
    check('a pending upload is re-queued on boot', p.arweave_state === 'published');
    const u = await untilState(inFlight.id, ['failed'], 5);
    check('an upload interrupted mid-flight is marked failed, not retried blind',
      u.arweave_state === 'failed' && /interrupted/.test(u.arweave_error));
  }

  // --- delete: our copies go, the data item is reported permanent ---
  {
    const { id, file } = await makeImage({ bytes: 'delete me' });
    await request('POST', `/media/images/${file}/arweave`, { headers: AR });
    const job = await untilState(id, ['published', 'failed']);
    const report = await mirror.purge(job);
    check('the purge report names the permanent copy', report.arweave === `permanent:${job.arweave_id}`);
    const plain = await mirror.purge(await jobs.get((await makeImage()).id));
    check('a normal job has no such line', plain.arweave === undefined);
  }

  // --- /cdn fallback ---
  {
    const { id, file } = await makeImage({ bytes: 'served from s5' });
    await request('POST', `/media/images/${file}/arweave`, { headers: AR });
    const job = await untilState(id, ['published', 'failed']);

    const ok = await request('GET', `/cdn/images/${file}`);
    check('with S5 up the CDN serves as before', ok.status === 200);

    s5Down = true;
    const fb = await request('GET', `/cdn/images/${file}`);
    check('with S5 down a forever file redirects to the gateway',
      fb.status === 302 && fb.headers.get('location') === `https://gw.example/${job.arweave_id}`);
    check('the redirect is not cacheable', fb.headers.get('cache-control') === 'no-store');

    const normal = await makeImage({ bytes: 'no second copy' });
    const nf = await request('GET', `/cdn/images/${normal.file}`);
    check('a normal file with S5 down is still 502', nf.status === 502);
    s5Down = false;
  }

  // --- thumbnails have no copy on Arweave ---
  {
    const id = nextId();
    const thumb = `${id}.jpg`;
    await fsp.writeFile(path.join(config.THUMBS_DIR, thumb), 'poster');
    const { cid } = await s5.hashFile(path.join(config.THUMBS_DIR, thumb));
    await jobs.create(id, {
      state: 'ready', media_type: 'video', visibility: 'public', s5_cid: 'zMain', s5_thumb_cid: cid,
      arweave_id: TX, arweave_state: 'published', url: `${config.MEDIA_CDN_BASE_URL}/videos/${id}.mp4`,
    });
    s5Down = true;
    const r = await request('GET', `/cdn/thumbnails/${thumb}`);
    check('a forever video thumbnail with S5 down is 502, not a redirect to the video bytes', r.status === 502);
    s5Down = false;
  }

  // --- delete while the paid upload is in flight ---
  {
    const { id, file } = await makeImage({ bytes: 'deleting mid-upload', extra: { arweave_state: 'uploading' } });
    const r = await request('DELETE', `/images/${id}`, { headers: UP });
    check('delete during an in-flight upload is refused', r.status === 409 && r.json.error === 'arweave_upload_in_progress');
    check('the job is still there', !!(await jobs.get(id)));

    const queued = await makeImage({ bytes: 'deleting while pending', extra: { arweave_state: 'pending' } });
    const d = await request('DELETE', `/images/${queued.id}`, { headers: UP });
    check('delete while merely pending goes through', d.status === 200);
    await forever.archive(queued.id);
    check('and the queued task finds no job and writes nothing', !(await jobs.get(queued.id)));

    // The upload was already sent when the delete landed: the record must not
    // be resurrected, only the log can say what happened.
    const gone = await makeImage({ bytes: 'gone before landing' });
    const jobPath = path.join(config.JOBS_DIR, `${gone.id}.json`);
    arweave.putFile = (function wrap(inner) {
      return async (params) => {
        await fsp.rm(jobPath, { force: true });
        return inner(params);
      };
    }(arweave.putFile));
    await forever.archive(gone.id);
    check('a job deleted mid-upload is not recreated as a ghost record', !fs.existsSync(jobPath));
    await settle();
    const restore = uploads.length;
    arweave.putFile = async ({ filePath, contentType, tags }) => {
      if (failUpload) throw new Error(failUpload);
      const bytes = (await fsp.stat(filePath)).size;
      uploads.push({ filePath, contentType, tags, bytes });
      return { id: `${TX.slice(0, 40)}${String(uploads.length).padStart(3, '0')}`, bytes, winc: String(bytes) };
    };
    check('(stub restored)', uploads.length === restore);
    void file;
  }

  // --- a delete that lands after the job was read, before anything is paid ---
  {
    const { id, file } = await makeImage({ bytes: 'deleted mid-flight' });
    const jobPath = path.join(config.JOBS_DIR, `${id}.json`);
    const before = uploads.length;
    // The hash is the last step before the 'uploading' mark; delete right there.
    const realHash = s5.hashFile;
    s5.hashFile = async (p) => { await fsp.rm(jobPath, { force: true }); return realHash(p); };
    await forever.archive(id);
    s5.hashFile = realHash;
    check('a job deleted before the upload starts pays nothing', uploads.length === before);
    check('and is not resurrected', !fs.existsSync(jobPath));
    void file;
  }

  // --- boot sweep marks interrupted uploads even with Arweave switched off ---
  {
    const { id } = await makeImage({ bytes: 'stuck uploading', extra: { arweave_state: 'uploading' } });
    config.ARWEAVE_ENABLED = false;
    forever.recoverOnBoot();
    await settle();
    config.ARWEAVE_ENABLED = true;
    const job = await jobs.get(id);
    check('with Arweave off, an interrupted upload is still marked failed so it can be deleted',
      job.arweave_state === 'failed');
    const del = await request('DELETE', `/images/${id}`, { headers: UP });
    check('and the delete goes through', del.status === 200);
  }

  // --- published elsewhere, nothing to push: refused up front ---
  {
    const { file } = await makeImage({ onS5: false, extra: { storage_backend: 's3d', mirror_state: 'published', sia_key: 'k' } });
    const e = await request('GET', `/media/images/${file}/arweave/estimate`, { headers: AR });
    check('an s3d-published file with no S5 copy is refused by the estimate, not later', e.status === 409 && e.json.error === 'not_on_s5');
    const p = await request('POST', `/media/images/${file}/arweave`, { headers: AR });
    check('and by the POST', p.status === 409 && p.json.error === 'not_on_s5');
  }

  // --- a stuck 'pending' can be asked again ---
  {
    const { id, file } = await makeImage({ bytes: 'stuck pending', extra: { arweave_state: 'pending' } });
    const r = await request('POST', `/media/images/${file}/arweave`, { headers: AR });
    check('asking again while pending re-queues it', r.status === 202);
    const job = await untilState(id, ['published', 'failed']);
    check('and it goes through', job.arweave_state === 'published');
  }

  // --- the estimate is rate limited like the POST ---
  {
    const { file } = await makeImage();
    const r = await request('GET', `/media/images/${file}/arweave/estimate`, { headers: AR });
    check('the estimate carries the rate-limit headers', r.status === 200 && r.headers.get('ratelimit-limit') === String(config.ARWEAVE_PER_HOUR));
  }

  // --- text: a document's canonical bytes ---
  {
    const crypto = require('crypto');
    const makeDoc = async (text) => {
      const id = nextId();
      const body = Buffer.from(text);
      await fsp.writeFile(path.join(config.DOCUMENTS_DIR, `${id}.json`), body);
      await jobs.create(id, {
        state: 'ready', media_type: 'document', visibility: 'private', owner: 'alice',
        url: `${config.PUBLIC_BASE_URL}/documents/${id}.json`, size: body.length,
        sha256: crypto.createHash('sha256').update(body).digest('hex'), mirror_state: 'skipped',
      });
      return id;
    };

    const id = await makeDoc('{"v":2,"title":"t","body":"hello"}');
    const noKey = await request('POST', `/documents/${id}/arweave`, { headers: UP });
    check('a document copy needs the arweave key', noKey.status === 401);

    const before = uploads.length;
    const r = await request('POST', `/documents/${id}/arweave`, { headers: AR });
    check('a document is copied synchronously and answers with the id', r.status === 200 && arweave.ID_RE.test(r.json.arweave_id) && r.json.already === false);
    const up = uploads[uploads.length - 1];
    check('as JSON, tagged with its sha256 and author',
      uploads.length === before + 1 && up.contentType === 'application/json'
      && up.tags.some((t) => t.name === 'Content-SHA256' && t.value === r.json.sha256)
      && up.tags.some((t) => t.name === 'Serey-Author' && t.value === 'alice')
      && !up.tags.some((t) => t.name === 'S5-CID'));
    const job = await jobs.get(id);
    check('the job records it', job.arweave_state === 'published' && job.arweave_id === r.json.arweave_id);

    const again = await request('POST', `/documents/${id}/arweave`, { headers: AR });
    check('asking again is idempotent', again.status === 200 && again.json.already === true && again.json.arweave_id === r.json.arweave_id);
    check('and uploads nothing', uploads.length === before + 1);

    const twin = await makeDoc('{"v":2,"title":"t","body":"hello"}');
    const t2 = await request('POST', `/documents/${twin}/arweave`, { headers: AR });
    check('identical bytes under another document reuse the copy', t2.status === 200 && t2.json.reused === true && t2.json.arweave_id === r.json.arweave_id);
    check('and pay nothing', uploads.length === before + 1);

    const bad = await makeDoc('{"v":2,"title":"t","body":"original"}');
    await fsp.writeFile(path.join(config.DOCUMENTS_DIR, `${bad}.json`), 'tampered');
    const b = await request('POST', `/documents/${bad}/arweave`, { headers: AR });
    check('bytes that no longer match the commitment are refused', b.status === 502 && !(await jobs.get(bad)).arweave_id);

    // Two calls at once (a retry after a timeout) pay once.
    const twice = await makeDoc('{"v":2,"title":"t","body":"race"}');
    const b2 = uploads.length;
    const [x, y] = await Promise.all([
      request('POST', `/documents/${twice}/arweave`, { headers: AR }),
      request('POST', `/documents/${twice}/arweave`, { headers: AR }),
    ]);
    check('concurrent document copies share one upload', x.status === 200 && y.status === 200 && x.json.arweave_id === y.json.arweave_id && uploads.length === b2 + 1);

    const del = await request('DELETE', `/documents/${id}`, { headers: UP });
    check('deleting a forever document reports the permanent copy', del.status === 200 && del.json.storage.arweave === `permanent:${r.json.arweave_id}`);
  }

  // --- off ---
  {
    config.ARWEAVE_ENABLED = false;
    const { file } = await makeImage();
    const r = await request('POST', `/media/images/${file}/arweave`, { headers: AR });
    check('with ARWEAVE_ENABLED off the route is 503', r.status === 503);
    config.ARWEAVE_ENABLED = true;
  }

  server.close();
  await fsp.rm(root, { recursive: true, force: true });
  // eslint-disable-next-line no-console
  console.log(`\n${passed} checks passed`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});

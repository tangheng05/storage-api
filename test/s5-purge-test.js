#!/usr/bin/env node
// Ignore any .env on this machine: a suite must not read production config.
process.env.STORAGE_TEST = '1';
/*
| Deleting an S5 blob: node test/s5-purge-test.js
|
| S5 documents no unpin, but it keeps its blobs in a bucket we own, so a
| takedown can delete the bytes. Two things have to hold:
|
|   - both objects go, the blob and its .obao verification tree
|   - a blob shared by another job is never touched, because S5 names blobs by
|     their own hash and two identical uploads are one stored file
*/
const assert = require('assert');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 's5-purge-'));
process.env.UPLOAD_API_KEY = 'purge-test';
process.env.JOBS_DIR = path.join(root, 'jobs');
process.env.S5_ENABLED = 'true';
process.env.S5_NODE_URL = 'http://127.0.0.1:9';
process.env.S5_AUTH_TOKEN = 'tok';
process.env.S5_BLOB_ENABLED = 'true';
process.env.S5_BLOB_S3_ENDPOINT = 'http://127.0.0.1:9';
process.env.S5_BLOB_S3_BUCKET = 'media';
process.env.S5_BLOB_S3_ACCESS_KEY = 'a';
process.env.S5_BLOB_S3_SECRET_KEY = 'b';
process.env.SIA_ENABLED = 'false';
fs.mkdirSync(process.env.JOBS_DIR, { recursive: true });

const config = require('../src/config');
const jobs = require('../src/services/jobs');
const s5 = require('../src/services/s5');
const s5blob = require('../src/services/s5blob');
const mirror = require('../src/services/mirror');

let passed = 0;
const check = (name, cond) => {
  assert.ok(cond, `FAILED: ${name}`);
  passed += 1;
  // eslint-disable-next-line no-console
  console.log(`  ok  ${name}`);
};

// Real CIDs a live node returned, so the key derivation is exercised on the
// same shapes production sees.
const CID_A = 'z2H72Rjmp9QkiGfccgpNhFPWN1F8DF3tWCcRjGZfi1aGYAVZK1qK';
const CID_B = 'z6e5Pk2Lwe3BhoftarcmHTuXjQafAXNczeZSWSpbu8M2TJEDpmZeT';

// Stand in for the bucket: record deletes, fail on demand.
const deleted = [];
let failNext = false;
s5blob.deleteObject = async ({ key }) => {
  if (failNext) throw new Error('bucket unreachable');
  deleted.push(key);
  return true;
};
// S5's own unpin route is undocumented and off by default; not what we test.
s5.unpin = async () => 'disabled';

const makeJob = (id, patch) => jobs.create(id, {
  state: 'ready', media_type: 'image', visibility: 'public', ...patch,
});

async function main() {
  // --- key derivation ---
  const key = s5.blobKeyFor(CID_A);
  check('a CID resolves to a bucket key', key === '1/HzDNV6vMOnJZ0saWLlw1ZToHWmndPxZ_iy_XROpjkNps');
  check('the key sits under the 1/ prefix the blob route serves', key.startsWith('1/'));
  for (const bad of ['', 'nope', 'zzz', null, undefined, 42, 'z1111']) {
    check(`a malformed CID (${JSON.stringify(bad)}) returns null rather than throwing`,
      s5.blobKeyFor(bad) === null);
  }

  // --- the ordinary case: sole owner, blob and outboard both go ---
  const SOLO = '01J0000000000000000000001A';
  await makeJob(SOLO, { s5_cid: CID_A });
  deleted.length = 0;
  let report = await mirror.purge(await jobs.get(SOLO));
  check('purge reports the blob deleted', report.main === 's5:deleted');
  check('the blob is gone', deleted.includes(key));
  check('and so is its .obao verification tree', deleted.includes(`${key}.obao`));
  check('nothing else was touched', deleted.length === 2);
  // purge() does not remove the record -- the delete route does that after it.
  await jobs.remove(SOLO);

  // --- the case that would destroy data ---
  // Identical bytes are one stored blob. Purging one job must not take the
  // other's picture with it.
  const SHARED_1 = '01J0000000000000000000002A';
  const SHARED_2 = '01J0000000000000000000002B';
  await makeJob(SHARED_1, { s5_cid: CID_B });
  await makeJob(SHARED_2, { s5_cid: CID_B });
  deleted.length = 0;
  report = await mirror.purge(await jobs.get(SHARED_1));
  check('a blob another job still uses is kept', report.main === 's5:shared');
  check('and nothing was deleted', deleted.length === 0);

  // Once the last holder goes, the bytes go with it.
  await jobs.remove(SHARED_1);
  deleted.length = 0;
  report = await mirror.purge(await jobs.get(SHARED_2));
  check('the last job holding a blob does delete it', report.main === 's5:deleted');
  check('both objects go', deleted.length === 2);
  await jobs.remove(SHARED_2);

  // A thumbnail sharing the main slot's CID counts as a holder too.
  const T1 = '01J0000000000000000000003A';
  const T2 = '01J0000000000000000000003B';
  await makeJob(T1, { s5_cid: CID_A });
  await makeJob(T2, { media_type: 'video', s5_thumb_cid: CID_A });
  deleted.length = 0;
  report = await mirror.purge(await jobs.get(T1));
  check('a thumbnail elsewhere also protects the blob', report.main === 's5:shared');
  check('still nothing deleted', deleted.length === 0);
  await jobs.remove(T1);
  await jobs.remove(T2);

  // --- both slots of one job ---
  const BOTH = '01J0000000000000000000004A';
  await makeJob(BOTH, { media_type: 'video', s5_cid: CID_A, s5_thumb_cid: CID_B });
  deleted.length = 0;
  report = await mirror.purge(await jobs.get(BOTH));
  check('the video blob is deleted', report.main === 's5:deleted');
  check('the poster blob is deleted too', report.thumb === 's5:deleted');
  check('four objects in total, two per slot', deleted.length === 4);
  await jobs.remove(BOTH);

  // --- failures must be reported, never swallowed ---
  const FAIL = '01J0000000000000000000005A';
  await makeJob(FAIL, { s5_cid: CID_A });
  failNext = true;
  deleted.length = 0;
  report = await mirror.purge(await jobs.get(FAIL));
  failNext = false;
  check('a bucket outage is reported as failed', report.main === 's5:failed');
  check('purge still returns rather than throwing', typeof report === 'object');
  await jobs.remove(FAIL);

  // A CID we cannot decode must not be silently treated as deleted.
  const JUNK = '01J0000000000000000000006A';
  await makeJob(JUNK, { s5_cid: 'not-a-real-cid' });
  deleted.length = 0;
  report = await mirror.purge(await jobs.get(JUNK));
  check('an undecodable CID reports unresolvable', report.main === 's5:unresolvable');
  check('and deletes nothing', deleted.length === 0);
  await jobs.remove(JUNK);

  // --- the off switch ---
  const OFF = '01J0000000000000000000007A';
  await makeJob(OFF, { s5_cid: CID_A });
  config.S5_BLOB_DELETE_ENABLED = false;
  deleted.length = 0;
  report = await mirror.purge(await jobs.get(OFF));
  config.S5_BLOB_DELETE_ENABLED = true;
  check('the flag stops the delete', report.main === 's5:delete-disabled');
  check('and nothing is removed', deleted.length === 0);
  await jobs.remove(OFF);

  // --- a job with no CID is not a failure ---
  const PLAIN = '01J0000000000000000000008A';
  await makeJob(PLAIN, {});
  deleted.length = 0;
  report = await mirror.purge(await jobs.get(PLAIN));
  check('a job that never reached S5 purges quietly', report.main === undefined);
  check('and nothing is deleted', deleted.length === 0);

  check('purge tolerates a missing job', Object.keys(await mirror.purge(null)).length === 0);

  fs.rmSync(root, { recursive: true, force: true });
  // eslint-disable-next-line no-console
  console.log(`\n${passed} checks passed`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});

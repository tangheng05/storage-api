#!/usr/bin/env node
// Ignore any .env on this machine: a suite must not read production config.
process.env.STORAGE_TEST = '1';
/*
| CID lookup for the explorer: node test/cid-lookup-test.js
|
| GET /media/cids hands the main API the CIDs of public media. What has to hold:
|
|   - upload key only, and off unless S5_CID_LOOKUP_ENABLED
|   - a premium, unfinished, missing or CID-less file is simply absent, so the
|     answer cannot be used to probe which ids exist
|   - a premium job that somehow holds a CID is still withheld, thumbnail too
|   - one unreadable job record does not hide the rest of the batch
|   - the batch is bounded and every id is validated
*/
const assert = require('assert');
const fs = require('fs');
const fsp = require('fs/promises');
const http = require('http');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cid-lookup-'));
process.env.UPLOAD_API_KEY = 'cid-test';
process.env.JOBS_DIR = path.join(root, 'jobs');
process.env.S5_CID_LOOKUP_ENABLED = 'true';
process.env.LOG_LEVEL = 'silent';
fs.mkdirSync(process.env.JOBS_DIR, { recursive: true });

const express = require('express');
const config = require('../src/config');
const jobs = require('../src/services/jobs');
const mediaRouter = require('../src/routes/media');

let passed = 0;
const check = (name, cond) => {
  assert.ok(cond, `FAILED: ${name}`);
  passed += 1;
  // eslint-disable-next-line no-console
  console.log(`  ok  ${name}`);
};

const ID = (n) => `01J000000000000000000000${n}`;
const IMG = ID('A1');
const VID = ID('B2');
const PREMIUM = ID('C3');
const PENDING = ID('D4');
const NO_CID = ID('E5');
const BROKEN = ID('F6');
const GONE = ID('G7');
const THUMB_ONLY = ID('H8');

const makeJob = (id, patch) => jobs.create(id, {
  state: 'ready', media_type: 'image', visibility: 'public', ...patch,
});

async function main() {
  await makeJob(IMG, { s5_cid: 'zIMG' });
  await makeJob(VID, { media_type: 'video', s5_cid: 'zVID', s5_thumb_cid: 'zVIDt' });
  // A premium job holding CIDs must still be withheld, thumbnail included.
  await makeJob(PREMIUM, { media_type: 'video', visibility: 'private', s5_cid: 'zSECRET', s5_thumb_cid: 'zSECRETt' });
  await makeJob(PENDING, { state: 'scanning', s5_cid: 'zPENDING' });
  await makeJob(NO_CID, { mirror_state: 'deferred' });
  await makeJob(THUMB_ONLY, { media_type: 'video', s5_thumb_cid: 'zTHUMBONLY' });
  await fsp.writeFile(path.join(process.env.JOBS_DIR, `${BROKEN}.json`), '{ not json');

  const app = express();
  app.use('/media', express.json({ limit: '8kb' }), mediaRouter);
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/media/cids`;
  const get = (ids, key = 'cid-test') => fetch(`${base}?ids=${ids}`, {
    headers: key ? { 'x-upload-key': key } : {},
  });

  try {
    // --- who may ask ---
    check('no key is refused', (await get(IMG, null)).status === 401);
    check('a wrong key is refused', (await get(IMG, 'nope')).status === 401);

    config.S5_CID_LOOKUP_ENABLED = false;
    const off = await get(IMG);
    check('answers 503 while the switch is off', off.status === 503);
    check('and says why', (await off.json()).error === 'cid_lookup_disabled');
    config.S5_CID_LOOKUP_ENABLED = true;

    // --- what comes back ---
    const body = await (await get([IMG, VID].join(','))).json();
    check('a public image returns its CID', body.cids[IMG].s5_cid === 'zIMG');
    check('an image has no thumbnail CID', body.cids[IMG].s5_thumb_cid === null);
    check('the kind is reported', body.cids[IMG].kind === 'images' && body.cids[VID].kind === 'videos');
    check('a video returns both CIDs', body.cids[VID].s5_cid === 'zVID' && body.cids[VID].s5_thumb_cid === 'zVIDt');

    const mixed = await (await get([IMG, PREMIUM, PENDING, NO_CID, GONE, BROKEN, THUMB_ONLY].join(','))).json();
    check('a premium job is absent, even holding a CID', !(PREMIUM in mixed.cids));
    check('an unfinished job is absent', !(PENDING in mixed.cids));
    check('a job not on S5 is absent', !(NO_CID in mixed.cids));
    check('an id that never existed is absent', !(GONE in mixed.cids));
    check('an unreadable record is absent', !(BROKEN in mixed.cids));
    check('the readable ids in the same batch still answer', mixed.cids[IMG].s5_cid === 'zIMG');
    check('a thumbnail-only job still answers', mixed.cids[THUMB_ONLY].s5_thumb_cid === 'zTHUMBONLY');
    check('nothing premium appears anywhere in the body', !JSON.stringify(mixed).includes('SECRET'));

    const dup = await (await get(`${IMG},${IMG}`)).json();
    check('a repeated id answers once', Object.keys(dup.cids).length === 1);

    // --- input limits ---
    check('no ids is a 400', (await get('')).status === 400);
    check('a malformed id is a 400', (await get(`${IMG},../etc/passwd`)).status === 400);
    check('a lowercase id is a 400', (await get(IMG.toLowerCase())).status === 400);
    const many = Array.from({ length: 51 }, (_, i) => `01J0000000000000000000${String(i).padStart(4, '0')}`);
    check('more than 50 ids is a 400', (await get(many.join(','))).status === 400);
    const fifty = many.slice(0, 50);
    check('exactly 50 ids is accepted', (await get(fifty.join(','))).status === 200);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fsp.rm(root, { recursive: true, force: true });
  }

  // eslint-disable-next-line no-console
  console.log(`\n${passed} checks passed`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});

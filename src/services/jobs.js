const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const config = require('../config');

// Job state store: one JSON file per video id under JOBS_DIR.
// States: uploading -> queued -> processing -> scanning -> ready | rejected |
// failed. There is no 'review': the gate decides on a single threshold.

const ULID_REGEX = /^[0-9A-HJKMNP-TV-Z]{26}$/;

function jobPath(id) {
  if (!ULID_REGEX.test(id)) {
    throw Object.assign(new Error('Invalid video id'), { status: 400 });
  }
  return path.join(config.JOBS_DIR, `${id}.json`);
}

async function create(id, data) {
  const job = { id, created_at: new Date().toISOString(), ...data };
  await fsp.writeFile(jobPath(id), JSON.stringify(job, null, 2));
  return job;
}

async function get(id) {
  try {
    return JSON.parse(await fsp.readFile(jobPath(id), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

async function update(id, patch) {
  const job = (await get(id)) || { id };
  const next = { ...job, ...patch, updated_at: new Date().toISOString() };
  await fsp.writeFile(jobPath(id), JSON.stringify(next, null, 2));
  return next;
}

async function remove(id) {
  await fsp.rm(jobPath(id), { force: true });
}

// Synchronous scan used once at boot for crash recovery.
function listByState(states) {
  if (!fs.existsSync(config.JOBS_DIR)) return [];
  return fs
    .readdirSync(config.JOBS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(config.JOBS_DIR, f), 'utf8'));
      } catch {
        return null;
      }
    })
    .filter((job) => job && states.includes(job.state));
}

/*
| Is another job still using this blob?
|
| S5 names blobs by their own hash, so two identical uploads are one stored
| object. Deleting on behalf of one job would take the other's bytes with it.
|
| A full scan, which is fine here: deletes are rare and there is no CID index.
*/
async function usedByOther(cid, excludeId) {
  if (!cid) return false;
  let names;
  try {
    names = await fsp.readdir(config.JOBS_DIR);
  } catch {
    // Cannot prove the blob is unshared, so the caller must not delete it.
    return true;
  }
  for (const name of names) {
    if (!name.endsWith('.json') || name === `${excludeId}.json`) continue;
    let job;
    try {
      // eslint-disable-next-line no-await-in-loop
      job = JSON.parse(await fsp.readFile(path.join(config.JOBS_DIR, name), 'utf8'));
    } catch {
      continue;
    }
    if (job && (job.s5_cid === cid || job.s5_thumb_cid === cid)) return true;
  }
  return false;
}

module.exports = {
  create, get, update, remove, listByState, usedByOther, ULID_REGEX,
};

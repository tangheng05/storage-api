#!/usr/bin/env node
// The disaster path: pulls files back from a backend to local disk. Exercise
// it at least once -- it's the only thing that proves the backup is real.
//   node scripts/storage-restore.js <ULID>        # one file
//   node scripts/storage-restore.js --all-missing [--dry-run]
const fsp = require('fs/promises');
const path = require('path');
const config = require('../src/config');
const jobs = require('../src/services/jobs');
const sia = require('../src/services/sia');
const s5 = require('../src/services/s5');
const mirror = require('../src/services/mirror');
const { exists } = require('../src/utils/fs');

const { localPathFor, fileFromJob } = mirror;

const args = process.argv.slice(2);
const ALL = args.includes('--all-missing');
const DRY = args.includes('--dry-run');
const ID = args.find((a) => !a.startsWith('--'));

async function restoreOne(job) {
  if (!job.sia_key && !job.s5_cid) {
    console.log(`  ${job.id}  skipped, on no backend`);
    return false;
  }

  const file = fileFromJob(job);
  if (!file) {
    console.log(`  ${job.id}  skipped, job has no usable url`);
    return false;
  }
  const filePath = localPathFor(job, file);
  if (DRY) {
    console.log(`  ${job.id}  would restore ${job.s5_cid || job.sia_key} -> ${filePath}`);
    return true;
  }

  // S5 restores verify themselves: the CID is the hash, so corruption is
  // detected rather than silently overwriting a good file.
  const { bytes } = job.s5_cid
    ? await s5.getToFile({ cid: job.s5_cid, filePath })
    : await sia.getToFile({ key: job.sia_key, filePath });
  console.log(`  ${job.id}  restored ${bytes} bytes -> ${filePath}`);

  // Thumbnail is a separate object; skip it and the video comes back posterless.
  if (job.s5_thumb_cid || job.sia_thumb_key) {
    const thumbPath = path.join(config.THUMBS_DIR, `${job.id}.jpg`);
    try {
      if (job.s5_thumb_cid) await s5.getToFile({ cid: job.s5_thumb_cid, filePath: thumbPath });
      else await sia.getToFile({ key: job.sia_thumb_key, filePath: thumbPath });
      console.log(`  ${job.id}  restored thumbnail -> ${thumbPath}`);
    } catch (err) {
      console.log(`  ${job.id}  thumbnail restore FAILED: ${err.message}`);
    }
  }
  return true;
}

async function main() {
  if (!sia.enabled() && !s5.enabled()) {
    console.error('No storage backend configured (SIA_ENABLED / S5_ENABLED).');
    process.exit(2);
  }
  if (!ID && !ALL) {
    console.error('Usage: storage-restore.js <ULID> | --all-missing [--dry-run]');
    process.exit(2);
  }

  let targets;
  if (ID) {
    const job = await jobs.get(ID);
    if (!job) {
      console.error(`No job ${ID}`);
      process.exit(1);
    }
    targets = [job];
  } else {
    const ready = jobs.listByState(['ready']).filter((j) => (j.sia_key || j.s5_cid) && j.url);
    targets = [];
    for (const job of ready) {
      const file = fileFromJob(job);
      if (!file) continue;
      // eslint-disable-next-line no-await-in-loop
      if (!(await exists(localPathFor(job, file)))) targets.push(job);
    }
  }

  console.log(`${targets.length} file(s) to restore${DRY ? ' (dry run)' : ''}`);
  let done = 0;
  for (const job of targets) {
    try {
      // eslint-disable-next-line no-await-in-loop
      if (await restoreOne(job)) done += 1;
    } catch (err) {
      console.log(`  ${job.id}  FAILED: ${err.message}`);
    }
  }
  console.log(`${done}/${targets.length} restored`);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});

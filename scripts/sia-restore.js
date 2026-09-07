#!/usr/bin/env node
/*
| Pull files back down from Sia to local disk. This is the disaster path, and it
| is the only thing that proves the backup is real. Exercise it at least once
| before trusting any of this.
|
|   node scripts/sia-restore.js <ULID>        # one file
|   node scripts/sia-restore.js --all-missing # everything absent from disk
|   node scripts/sia-restore.js --all-missing --dry-run
*/
const fsp = require('fs/promises');
const jobs = require('../src/services/jobs');
const sia = require('../src/services/sia');
const mirror = require('../src/services/mirror');

const { localPathFor, fileFromJob } = mirror;

const args = process.argv.slice(2);
const ALL = args.includes('--all-missing');
const DRY = args.includes('--dry-run');
const ID = args.find((a) => !a.startsWith('--'));


const exists = async (p) => {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
};

async function restoreOne(job) {
  if (!job.sia_key) {
    console.log(`  ${job.id}  skipped, no sia_key`);
    return false;
  }

  const file = fileFromJob(job);
  if (!file) {
    console.log(`  ${job.id}  skipped, job has no usable url`);
    return false;
  }
  const filePath = localPathFor(job, file);
  if (DRY) {
    console.log(`  ${job.id}  would restore ${job.sia_key} -> ${filePath}`);
    return true;
  }

  const { bytes } = await sia.getToFile({ key: job.sia_key, filePath });
  console.log(`  ${job.id}  restored ${bytes} bytes -> ${filePath}`);
  return true;
}

async function main() {
  if (!sia.enabled()) {
    console.error('Sia is not configured (SIA_ENABLED / credentials).');
    process.exit(2);
  }
  if (!ID && !ALL) {
    console.error('Usage: sia-restore.js <ULID> | --all-missing [--dry-run]');
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
    const ready = jobs.listByState(['ready']).filter((j) => j.sia_key && j.url);
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

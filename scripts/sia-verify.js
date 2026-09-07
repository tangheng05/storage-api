#!/usr/bin/env node
/*
| Check that every file we believe is on Sia is actually on Sia, and the right
| size. A backup nobody has checked is a rumour.
|
|   node scripts/sia-verify.js            # report only
|   node scripts/sia-verify.js --fix      # re-upload anything missing or wrong
|
| Exits 1 when drift is found, so it can be run from cron and alert on failure.
*/
const fsp = require('fs/promises');
const jobs = require('../src/services/jobs');
const sia = require('../src/services/sia');
const mirror = require('../src/services/mirror');

// Path and filename resolution live in mirror.js so this script and the service
// can never disagree about where a file is supposed to be.
const { localPathFor, fileFromJob } = mirror;

const FIX = process.argv.includes('--fix');


async function main() {
  if (!sia.enabled()) {
    console.error('Sia is not configured (SIA_ENABLED / credentials). Nothing to verify.');
    process.exit(2);
  }

  const all = jobs.listByState(['ready']);
  const tracked = all.filter((j) => j.sia_key);
  const untracked = all.filter((j) => !j.sia_key && j.sia_state !== 'skipped');

  let ok = 0;
  const problems = [];

  for (const job of tracked) {
    const file = fileFromJob(job);
    if (!file) {
      // A malformed record must not abort a scheduled run.
      problems.push({ id: job.id, key: job.sia_key, issue: 'job has no usable url' });
      continue;
    }

    let localBytes = null;
    try {
      localBytes = (await fsp.stat(localPathFor(job, file))).size;
    } catch {
      // Local file gone. Not drift on its own — that is what the backup is for.
    }

    let remote = null;
    try {
      remote = await sia.headObject(job.sia_key);
    } catch (err) {
      problems.push({ id: job.id, key: job.sia_key, issue: `head failed: ${err.message}` });
      continue;
    }

    if (!remote) {
      problems.push({ id: job.id, key: job.sia_key, issue: 'missing on sia' });
    } else if (localBytes !== null && remote.bytes !== localBytes) {
      problems.push({
        id: job.id,
        key: job.sia_key,
        issue: `size mismatch local=${localBytes} sia=${remote.bytes}`,
      });
    } else {
      ok += 1;
    }
  }

  console.log(`checked ${tracked.length} tracked object(s): ${ok} ok, ${problems.length} problem(s)`);
  if (untracked.length) {
    console.log(`${untracked.length} ready job(s) have no sia_key (state: failed/pending or predate the mirror)`);
  }
  problems.forEach((p) => console.log(`  ${p.id}  ${p.key}  ${p.issue}`));

  if (FIX && problems.length) {
    console.log('\nre-uploading...');
    for (const p of problems) {
      await mirror.retry(p.id);
      console.log(`  retried ${p.id}`);
    }
  }

  process.exit(problems.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});

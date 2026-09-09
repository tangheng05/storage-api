#!/usr/bin/env node
/*
| Check that every object we believe is on a backend really is, at the right
| size. A backup nobody has checked is a rumour.
|
|   node scripts/storage-verify.js            # report only
|   node scripts/storage-verify.js --fix      # re-upload anything missing or wrong
|
| Exits 1 when drift is found, so it can be run from cron and alert on failure.
*/
const fsp = require('fs/promises');
const jobs = require('../src/services/jobs');
const sia = require('../src/services/sia');
const s5 = require('../src/services/s5');
const mirror = require('../src/services/mirror');

// Shared with the service so the two cannot disagree about where a file is.
const { localPathFor, fileFromJob } = mirror;

const FIX = process.argv.includes('--fix');


async function main() {
  if (!sia.enabled() && !s5.enabled()) {
    console.error('No storage backend configured (SIA_ENABLED / S5_ENABLED). Nothing to verify.');
    process.exit(2);
  }

  const all = jobs.listByState(['ready']);
  const tracked = all.filter((j) => j.sia_key || j.s5_cid);
  const untracked = all.filter((j) => !j.sia_key && !j.s5_cid && j.mirror_state !== 'skipped');

  let ok = 0;
  const problems = [];

  for (const job of tracked) {
    const file = fileFromJob(job);
    if (!file) {
      // A malformed record must not abort a scheduled run.
      problems.push({ id: job.id, key: job.s5_cid || job.sia_key, issue: 'job has no usable url' });
      continue;
    }

    let localBytes = null;
    try {
      localBytes = (await fsp.stat(localPathFor(job, file))).size;
    } catch {
      // Local file gone: not drift on its own, that is what the backup is for.
    }

    const ref = job.s5_cid || job.sia_key;
    let remote = null;
    try {
      remote = job.s5_cid
        ? await s5.stat(job.s5_cid)
        : await sia.headObject(job.sia_key);
    } catch (err) {
      problems.push({ id: job.id, key: ref, issue: `head failed: ${err.message}` });
      continue;
    }

    if (!remote) {
      problems.push({ id: job.id, key: ref, issue: 'missing on backend' });
    } else if (localBytes !== null && remote.bytes !== null && remote.bytes !== localBytes) {
      problems.push({
        id: job.id,
        key: ref,
        issue: `size mismatch local=${localBytes} remote=${remote.bytes}`,
      });
    } else {
      ok += 1;
    }

    const thumbRef = job.s5_thumb_cid || job.sia_thumb_key;
    if (thumbRef) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const t = job.s5_thumb_cid
          ? await s5.stat(job.s5_thumb_cid)
          : await sia.headObject(job.sia_thumb_key);
        if (!t) problems.push({ id: job.id, key: thumbRef, issue: 'thumbnail missing on backend' });
        else ok += 1;
      } catch (err) {
        problems.push({ id: job.id, key: thumbRef, issue: `thumb head failed: ${err.message}` });
      }
    }
  }

  console.log(`checked ${tracked.length} tracked object(s): ${ok} ok, ${problems.length} problem(s)`);
  const deferredJobs = untracked.filter((job) => job.mirror_state === 'deferred');
  const gaps = untracked.length - deferredJobs.length;
  if (deferredJobs.length) {
    console.log(`${deferredJobs.length} job(s) awaiting /promote — not a gap, leave them alone`);
  }
  if (gaps) {
    console.log(`${gaps} ready job(s) are on no backend (failed, or predate it — run storage-backfill.js)`);
  }
  problems.forEach((p) => console.log(`  ${p.id}  ${p.key}  ${p.issue}`));

  if (FIX && problems.length) {
    console.log('\nre-uploading...');
    for (const p of problems) {
      await mirror.retry(p.id, { force: true });
      console.log(`  retried ${p.id}`);
    }
  }

  process.exit(problems.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});

#!/usr/bin/env node
/*
| Push already-published media onto a storage backend. The boot sweep only
| retries publishes that *failed*, so anything predating a backend stays
| 'skipped' forever -- this closes that gap. Durability only: the URL already
| in the main API is left alone, since the local file it points at is still correct.
|
|   node scripts/storage-backfill.js --dry-run
|   node scripts/storage-backfill.js --type video --limit 50
*/
const fsp = require('fs/promises');
const path = require('path');
const config = require('../src/config');
const jobs = require('../src/services/jobs');
const mirror = require('../src/services/mirror');
const sia = require('../src/services/sia');
const s5 = require('../src/services/s5');
const { exists } = require('../src/utils/fs');

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const ONLY_TYPE = flag('--type', null);
const LIMIT = parseInt(flag('--limit', '0'), 10) || Infinity;

async function main() {
  if (!sia.enabled() && !s5.enabled()) {
    console.error('No storage backend configured (SIA_ENABLED / S5_ENABLED).');
    process.exit(2);
  }

  const candidates = jobs
    .listByState(['ready'])
    .filter((job) => !job.s5_cid && !job.sia_key)
    .filter((job) => !ONLY_TYPE || job.media_type === ONLY_TYPE)
    // A type that is still unlisted is a deliberate exclusion, not a gap.
    .filter((job) => mirror.backendFor({
      mediaType: job.media_type,
      visibility: job.visibility || 'public',
    }))
    .slice(0, LIMIT === Infinity ? undefined : LIMIT);

  console.log(`${candidates.length} job(s) to backfill${DRY ? ' (dry run)' : ''}`);

  let done = 0;
  let skipped = 0;
  for (const job of candidates) {
    const file = mirror.fileFromJob(job);
    if (!file) {
      console.log(`  ${job.id}  skipped, no usable url`);
      skipped += 1;
      continue;
    }
    const filePath = mirror.localPathFor(job, file);
    // eslint-disable-next-line no-await-in-loop
    if (!filePath || !(await exists(filePath))) {
      console.log(`  ${job.id}  skipped, local file missing`);
      skipped += 1;
      continue;
    }

    const visibility = job.visibility || 'public';
    const backend = mirror.backendFor({ mediaType: job.media_type, visibility });
    if (DRY) {
      console.log(`  ${job.id}  would push ${file} -> ${backend}`);
      done += 1;
      continue;
    }

    try {
      // eslint-disable-next-line no-await-in-loop
      const { patch } = await mirror.publish({
        id: job.id,
        kind: mirror.kindFor(job.media_type),
        mediaType: job.media_type,
        file,
        filePath,
        visibility,
      });
      // eslint-disable-next-line no-await-in-loop
      await jobs.update(job.id, patch);
      const state = patch[mirror.SLOTS.main.state];

      // Thumbnail is a separate object/slot; skip it and restores come back posterless.
      const thumbFile = `${job.id}.jpg`;
      const thumbPath = path.join(config.THUMBS_DIR, thumbFile);
      // eslint-disable-next-line no-await-in-loop
      if (job.media_type === 'video' && (await exists(thumbPath))) {
        // eslint-disable-next-line no-await-in-loop
        const thumb = await mirror.publish({
          id: job.id,
          kind: 'thumbnails',
          mediaType: 'video',
          file: thumbFile,
          filePath: thumbPath,
          visibility: 'public',
          slot: 'thumb',
        });
        // eslint-disable-next-line no-await-in-loop
        await jobs.update(job.id, thumb.patch);
      }

      console.log(`  ${job.id}  ${state} -> ${backend}`);
      if (state === 'published') done += 1;
      else skipped += 1;
    } catch (err) {
      console.log(`  ${job.id}  FAILED: ${err.message}`);
      skipped += 1;
    }
  }

  console.log(`${done} pushed, ${skipped} skipped`);
  process.exit(skipped && !done ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});

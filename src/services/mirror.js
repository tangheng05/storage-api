const path = require('path');
const fsp = require('fs/promises');

const config = require('../config');
const jobs = require('./jobs');
const queue = require('./queue');
const sia = require('./sia');
const logger = require('./logger');

/*
|--------------------------------------------------------------------------
| Sia publishing
|--------------------------------------------------------------------------
|
| Called at the end of processing, once the finished file is on disk. It pushes
| that file to Sia and decides which URL the job reports.
|
| This runs inline, before the job flips to 'ready', and that is deliberate: the
| status endpoint's URL is what serey-api stores in the post row, permanently.
| Mirroring afterwards would mean handing out a local URL and then quietly
| changing our mind, so the row would keep whichever one the frontend happened
| to read first.
|
| A Sia failure is never fatal. The local file has already been written, so we
| fall back to the local URL and record sia_state 'failed'. The result is that
| the worst Sia outage can do is make new uploads behave exactly like they did
| before any of this existed. The boot sweep retries those later for durability,
| without touching the URL that was already handed out.
|
| Nothing here rewrites existing media. Old rows hold absolute URLs on
| PUBLIC_BASE_URL and keep resolving there.
|
*/

// Set only when SIA_PUBLIC_BASE_URL is configured. Without it the upload still
// happens (as a backup) but delivery stays local.
function serving() {
  return sia.enabled() && !!config.SIA_PUBLIC_BASE_URL;
}

function wants(mediaType) {
  return sia.enabled() && config.SIA_MIRROR_TYPES.includes(mediaType);
}

function siaUrl(kind, file) {
  return `${config.SIA_PUBLIC_BASE_URL}/${kind}/${file}`;
}

/*
| Push one finished file and report where it should be served from.
|
| Returns { url, patch }. `url` is null when the caller should keep its own local
| URL; `patch` is merged into the job so the state is always recorded, success
| or not.
*/
async function publish({ id, kind, mediaType, file, filePath, visibility = 'public' }) {
  if (!wants(mediaType)) {
    return { url: null, patch: { sia_state: 'skipped' } };
  }

  const key = sia.buildKey({ kind, file, visibility });

  try {
    const { bytes } = await sia.putFile({ key, filePath });
    logger.info({ id, key, bytes }, 'mirrored to sia');
    return {
      url: serving() ? siaUrl(kind, file) : null,
      patch: {
        sia_key: key,
        sia_state: 'mirrored',
        sia_bytes: bytes,
        sia_error: null,
        // Recorded so a later read knows whether this row's URL points at Sia
        // or at local disk, without having to parse the URL back apart.
        sia_served: serving(),
      },
    };
  } catch (err) {
    // Deliberately swallowed. The local file exists and serves fine.
    logger.error({ id, key, err: err.message }, 'sia mirror failed, serving locally');
    return {
      url: null,
      patch: {
        sia_key: key,
        sia_state: 'failed',
        sia_error: err.message,
        sia_served: false,
      },
    };
  }
}

/*
| Retry a mirror that failed earlier. Durability only: the URL already stored in
| serey-api is left alone, because the local file it points at is still there and
| still correct. Rewriting it would mean reaching into another service's
| database to fix something that is not broken.
*/
async function retry(id) {
  const job = await jobs.get(id);
  if (!job || !job.sia_key) return;

  const file = fileFromJob(job);
  if (!file) return;

  const filePath = localPathFor(job, file);
  if (!filePath) return;

  // The local file is the source for the re-upload. If it is gone there is
  // nothing to send, and retrying every boot forever would just log noise, so
  // this terminates instead of staying 'failed'.
  if (!(await exists(filePath))) {
    await jobs.update(id, {
      sia_state: 'orphaned',
      sia_error: 'local file missing, nothing to upload',
    });
    logger.warn({ id, filePath }, 'sia mirror retry skipped, local file missing');
    return;
  }

  try {
    const { bytes } = await sia.putFile({ key: job.sia_key, filePath });
    await jobs.update(id, {
      sia_state: 'mirrored',
      sia_bytes: bytes,
      sia_error: null,
    });
    logger.info({ id, key: job.sia_key }, 'sia mirror retry succeeded');
  } catch (err) {
    await jobs.update(id, { sia_state: 'failed', sia_error: err.message });
    logger.warn({ id, err: err.message }, 'sia mirror retry failed');
  }
}

async function exists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

/*
| The published filename, derived from the job's URL. Shared by the retry path
| and both CLI scripts. Returns null rather than throwing on a job whose URL is
| missing or malformed, so one bad record cannot abort a whole sweep.
*/
function fileFromJob(job) {
  if (!job || !job.url) return null;
  try {
    return path.basename(new URL(job.url).pathname);
  } catch {
    return null;
  }
}

// Resolve the on-disk file for a job. Mirrors the dir choice made in processor.
function localPathFor(job, file) {
  const priv = job.visibility === 'private';
  switch (job.media_type) {
    case 'image':
      return path.join(priv ? config.PRIVATE_IMAGES_DIR : config.IMAGES_DIR, file);
    case 'audio':
      return path.join(priv ? config.PRIVATE_AUDIO_DIR : config.AUDIO_DIR, file);
    case 'video':
      return path.join(priv ? config.PRIVATE_VIDEOS_DIR : config.VIDEOS_DIR, file);
    default:
      return null;
  }
}

/*
| Re-queue unfinished mirrors after a restart. Capped, because a long Sia outage
| could otherwise leave thousands of jobs to retry and they must not crowd out
| live uploads. Runs on its own lane for the same reason.
*/
function recoverOnBoot() {
  if (!sia.enabled()) return;

  // 'orphaned' is deliberately excluded: its local file is gone, so re-uploading
  // is impossible and requeueing it would spin every boot.
  const pending = jobs
    .listByState(['ready'])
    .filter((job) => job.sia_state === 'failed')
    .slice(0, config.SIA_RECOVER_LIMIT);

  if (!pending.length) return;

  logger.info({ count: pending.length }, 'requeueing unfinished sia mirrors');
  pending.forEach((job) => {
    queue.push(() => retry(job.id), queue.SIA_LANE);
  });
}

/*
| Remove a job's object from Sia. Called from the DELETE routes.
|
| This matters more than it looks. Once SIA_PUBLIC_BASE_URL is set, the Sia copy
| is the one being served, so deleting only the local file would leave a
| "deleted" image or video still loading for everyone. Copyright takedowns and
| account deletion both run through those routes.
|
| Never throws: a delete must still succeed locally even if Sia is unreachable.
| It logs at error level with the key, because the job record is about to be
| removed and that log line is then the only trace left for anyone reconciling
| an orphaned object.
*/
async function purge(job) {
  if (!sia.enabled() || !job || !job.sia_key) return false;
  try {
    await sia.deleteObject(job.sia_key);
    logger.info({ id: job.id, key: job.sia_key }, 'deleted from sia');
    return true;
  } catch (err) {
    logger.error(
      { id: job.id, key: job.sia_key, err: err.message },
      'SIA OBJECT NOT DELETED, remove it manually',
    );
    return false;
  }
}

module.exports = {
  publish,
  retry,
  purge,
  recoverOnBoot,
  serving,
  localPathFor,
  fileFromJob,
};

const path = require('path');
const fsp = require('fs/promises');

const config = require('../config');
const jobs = require('./jobs');
const queue = require('./queue');
const mirror = require('./mirror');
const s5 = require('./s5');
const arweave = require('./arweave');
const resolve = require('./resolve');
const logger = require('./logger');
const { exists } = require('../utils/fs');

/*
| Forever mode: a second, permanent copy of a published file on Arweave.
|
| Strictly additive to the normal path. The job keeps its S5 CID and /cdn URL;
| it gains arweave_state / arweave_id, and the main API puts the id on chain.
| Only a job the scan gate already cleared and S5 already holds is eligible,
| and the bytes sent are checked against the S5 CID first, so the S5-CID tag
| on the data item is always true.
|
| States: pending -> uploading -> published | failed. 'failed' is never
| retried on its own: every attempt costs credits, so the caller asks again.
*/

function typeAllowed(mediaType) {
  return config.ARWEAVE_TYPES.includes(mediaType);
}

// What would be paid for: the published file, not the upload -- everything is
// re-encoded on the way in. job.size only when the local copy is gone.
async function bytesOf(job) {
  const file = mirror.fileFromJob(job);
  const local = file ? mirror.localPathFor(job, file) : null;
  if (local) {
    try {
      return (await fsp.stat(local)).size;
    } catch {}
  }
  return job.size || 0;
}

// Why a job may not go forever, or null. Shared by the estimate and the POST
// so the two can never disagree.
async function refusal(job, { kind } = {}) {
  if (!job) return { status: 404, error: 'Media not found' };
  if (job.state !== 'ready') return { status: 409, error: 'not_published', state: job.state };
  // The permanence a paywall cannot survive: a data item is public to anyone with the id.
  if (job.visibility === 'private') return { status: 409, error: 'premium_media_is_never_permanent' };
  if (!typeAllowed(job.media_type)) return { status: 409, error: 'arweave_not_enabled_for_type' };
  if (kind && mirror.kindFor(job.media_type) !== kind) {
    return { status: 400, error: 'kind_does_not_match_media', expected: mirror.kindFor(job.media_type) };
  }
  if (!mirror.targetsS5({ mediaType: job.media_type, visibility: 'public' })) {
    return { status: 409, error: 'not_on_s5', message: 'S5 is the player; Arweave is only ever the second copy' };
  }
  const bytes = await bytesOf(job);
  if (config.ARWEAVE_MAX_BYTES > 0 && bytes > config.ARWEAVE_MAX_BYTES) {
    return { status: 413, error: 'over_permanence_cap', max_bytes: config.ARWEAVE_MAX_BYTES };
  }
  return null;
}

function publicFields(job) {
  if (!job || !job.arweave_state) return {};
  return {
    arweave_state: job.arweave_state,
    arweave_id: job.arweave_id || null,
    arweave_url: job.arweave_id ? arweave.gatewayUrl(job.arweave_id) : null,
  };
}

// Reuses another job's data item when the bytes are identical: S5 already
// stores them once, and paying Turbo twice for the same file buys nothing.
async function existingIdForCid(cid, excludeId) {
  const other = await jobs.findOther(excludeId, (j) => j.s5_cid === cid && j.arweave_id);
  return other ? other.arweave_id : null;
}

async function ensureOnS5(id, job) {
  if (job.s5_cid) return job;
  const state = job[mirror.SLOTS.main.state];
  // Deferred is the common case: an editor upload nobody has promoted yet.
  if (!['deferred', 'failed', 'pending'].includes(state)) {
    throw new Error(`not on S5 and no push to retry (mirror_state ${state || 'unset'})`);
  }
  await mirror.retry(id, { force: true, states: [state] });
  const fresh = await jobs.get(id);
  if (!fresh || !fresh.s5_cid) throw new Error('S5 push did not produce a CID');
  return fresh;
}

// The local file when we still have it, else a verified restore from S5 into
// a temp path the caller removes. Either way the bytes are hashed against the
// CID before they are paid for.
async function sourceFor(job, file) {
  const local = mirror.localPathFor(job, file);
  if (local && await exists(local)) return { filePath: local, temp: false };

  const tmp = path.join(path.dirname(local || config.VIDEOS_DIR), `.${file}.arweave`);
  await s5.getToFile({ cid: job.s5_cid, filePath: tmp });
  return { filePath: tmp, temp: true };
}

async function checkCredits(bytes) {
  const need = await arweave.cost(bytes);
  const have = await arweave.balance();
  const floor = BigInt(Math.max(0, Math.floor(config.ARWEAVE_MIN_BALANCE_WINC)));
  if (have < need + floor) {
    logger.error({ need: need.toString(), have: have.toString(), floor: floor.toString() }, 'ARWEAVE CREDITS LOW, forever uploads refused');
    const err = new Error('arweave_credits_low');
    err.code = 'arweave_credits_low';
    throw err;
  }
  return need;
}

async function archive(id) {
  let job = await jobs.get(id);
  if (!job) return;
  if (job.arweave_id) return;

  const file = mirror.fileFromJob(job);
  if (!file) {
    await jobs.update(id, { arweave_state: 'failed', arweave_error: 'job has no file' });
    return;
  }

  let source = null;
  try {
    job = await ensureOnS5(id, job);

    const reused = await existingIdForCid(job.s5_cid, id);
    if (reused) {
      await jobs.update(id, {
        arweave_state: 'published', arweave_id: reused, arweave_error: null, arweave_at: new Date().toISOString(),
      });
      logger.info({ id, cid: job.s5_cid, arweave_id: reused }, 'forever: reused an existing data item');
      return;
    }

    source = await sourceFor(job, file);
    const { cid, size } = await s5.hashFile(source.filePath);
    if (cid !== job.s5_cid) {
      throw new Error(`local bytes differ from S5 (${cid} vs ${job.s5_cid})`);
    }
    if (config.ARWEAVE_MAX_BYTES > 0 && size > config.ARWEAVE_MAX_BYTES) {
      throw new Error(`over_permanence_cap: ${size} > ${config.ARWEAVE_MAX_BYTES}`);
    }
    await checkCredits(size);

    // From here a restart can no longer tell whether Turbo charged us, so the
    // boot sweep marks 'uploading' as failed instead of retrying it blind.
    await jobs.update(id, { arweave_state: 'uploading', arweave_error: null });

    const tags = [
      { name: 'App-Name', value: 'Serey' },
      { name: 'S5-CID', value: job.s5_cid },
      { name: 'Serey-Media-Id', value: id },
      ...(job.owner ? [{ name: 'Serey-Author', value: String(job.owner) }] : []),
    ];
    const { id: arweaveId, bytes, winc } = await arweave.putFile({
      filePath: source.filePath,
      contentType: resolve.contentTypeFor(file),
      tags,
    });

    const gateway = await arweave.stat(arweaveId);
    await jobs.update(id, {
      arweave_state: 'published',
      arweave_id: arweaveId,
      arweave_error: null,
      arweave_at: new Date().toISOString(),
      arweave_bytes: bytes,
      arweave_winc: winc,
      arweave_gateway: gateway,
    });
    logger.info({ id, cid: job.s5_cid, arweave_id: arweaveId, bytes, winc, gateway }, 'forever: published to arweave');
  } catch (err) {
    logger.error({ id, err: err.message }, 'forever: arweave publish failed');
    await jobs.update(id, { arweave_state: 'failed', arweave_error: err.code || err.message });
  } finally {
    if (source && source.temp) await fsp.rm(source.filePath, { force: true });
  }
}

// Accepted, not done: a video takes minutes on Turbo. 'pending' is what the
// boot sweep re-queues.
async function enqueue(id) {
  await jobs.update(id, { arweave_state: 'pending', arweave_error: null });
  queue.push(() => archive(id), queue.ARWEAVE_LANE);
}

function recoverOnBoot() {
  if (!arweave.enabled()) return;
  const held = jobs.listByState(['ready'])
    .filter((job) => ['pending', 'uploading'].includes(job.arweave_state) && !job.arweave_id);
  if (!held.length) return;

  held.forEach((job) => {
    if (job.arweave_state === 'uploading') {
      // Cannot know whether the upload landed; a retry could pay twice.
      jobs.update(job.id, { arweave_state: 'failed', arweave_error: 'interrupted by restart, ask again' })
        .catch((err) => logger.error({ id: job.id, err: err.message }, 'forever: could not mark interrupted upload'));
      logger.warn({ id: job.id }, 'forever: upload interrupted by restart, left failed');
    }
  });

  const pending = held.filter((job) => job.arweave_state === 'pending').slice(0, config.ARWEAVE_RECOVER_LIMIT);
  if (!pending.length) return;
  logger.info({ count: pending.length }, 'forever: requeueing pending arweave uploads');
  pending.forEach((job) => queue.push(() => archive(job.id), queue.ARWEAVE_LANE));
}

module.exports = {
  refusal, bytesOf, publicFields, enqueue, archive, recoverOnBoot,
};

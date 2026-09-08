const express = require('express');
const fsp = require('fs/promises');
const config = require('../config');
const jobs = require('../services/jobs');
const processor = require('../services/processor');
const queue = require('../services/queue');
const scan = require('../services/scan');
const logger = require('../services/logger');
const { requireUploadKey } = require('../middleware/auth');

const router = express.Router();

/*
| Review queue. Master key only - operator endpoints, not user-facing.
|
| A scanner that can only auto-reject has to be tuned to almost never be wrong,
| which in practice means tuned to let things through. The middle band lets it
| be cautious instead, and this queue is what makes that band survivable.
|
| Rejecting here also blocklists the file's perceptual hash, so the same picture
| is refused automatically from then on - no model, no API call, no cost.
*/

router.use(requireUploadKey);

// GET /moderation/queue — everything waiting on a human.
router.get('/queue', async (req, res, next) => {
  try {
    const held = jobs.listByState(['review']).map((job) => ({
      id: job.id,
      media_type: job.media_type,
      filename: job.filename,
      owner: job.owner,
      visibility: job.visibility || 'public',
      score: job.scan_score,
      labels: job.scan_labels || [],
      provider: job.scan_provider,
      phash: job.scan_phash,
      created_at: job.created_at,
      scanned_at: job.scanned_at,
    }));
    // Oldest first: the uploader kept waiting longest is next.
    held.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    return res.json({ count: held.length, items: held });
  } catch (err) {
    return next(err);
  }
});

// POST /moderation/:id/approve — publishes a held file. The scan is skipped,
// not re-run, and it goes on the scan lane so it cannot jump live uploads.
router.post('/:id/approve', async (req, res, next) => {
  try {
    const { id } = req.params;
    const job = await jobs.get(id);
    if (!job) return res.status(404).json({ error: 'Not found' });
    if (job.state !== 'review') {
      return res.status(409).json({ error: `Job is ${job.state}, not awaiting review` });
    }

    await jobs.update(id, { state: 'scanning', reviewed_by: req.headers['x-delete-owner'] || null });
    queue.push(() => processor.finalize(id, { approved: true }), queue.SCAN_LANE);
    logger.info({ id }, 'held upload approved by moderator');
    return res.json({ id, state: 'publishing' });
  } catch (err) {
    return next(err);
  }
});

// POST /moderation/:id/reject — discards it. { blocklist: false } opts out of
// recording the perceptual hash.
router.post('/:id/reject', async (req, res, next) => {
  try {
    const { id } = req.params;
    const job = await jobs.get(id);
    if (!job) return res.status(404).json({ error: 'Not found' });
    if (job.state !== 'review') {
      return res.status(409).json({ error: `Job is ${job.state}, not awaiting review` });
    }

    await processor.discardPending(job);

    const addToBlocklist = req.body?.blocklist !== false;
    let blocklisted = false;
    if (addToBlocklist && job.scan_phash) {
      const note = `${job.scan_phash}  # ${id} rejected ${new Date().toISOString()}`;
      await fsp.appendFile(config.SCAN_BLOCKLIST_PATH, `${note}\n`);
      blocklisted = true;
    }

    await jobs.update(id, {
      state: 'rejected',
      error: 'rejected_by_moderator',
      reviewed_by: req.headers['x-delete-owner'] || null,
      pending_file: null,
      pending_thumb: null,
    });
    logger.info({ id, blocklisted }, 'held upload rejected by moderator');
    return res.json({ id, state: 'rejected', blocklisted });
  } catch (err) {
    return next(err);
  }
});

// POST /moderation/blocklist — takes a phash or the id of an already-published
// job, so a takedown and preventing its return are one action. Deleting the
// media itself still goes through the DELETE routes.
router.post('/blocklist', async (req, res, next) => {
  try {
    const { id, phash } = req.body || {};
    let hash = phash;

    if (!hash && id) {
      const job = await jobs.get(id);
      if (!job) return res.status(404).json({ error: 'Not found' });
      hash = job.scan_phash;
      if (!hash) {
        return res.status(409).json({ error: 'Job has no recorded perceptual hash' });
      }
    }
    if (!/^[0-9a-f]{16}$/i.test(hash || '')) {
      return res.status(400).json({ error: 'phash must be 16 hex characters, or pass a job id' });
    }

    const note = `${hash.toLowerCase()}  # ${id || 'manual'} ${new Date().toISOString()}`;
    await fsp.appendFile(config.SCAN_BLOCKLIST_PATH, `${note}\n`);
    logger.info({ id, hash }, 'hash added to scan blocklist');
    return res.json({ blocklisted: hash.toLowerCase() });
  } catch (err) {
    return next(err);
  }
});

// GET /moderation/stats — how the gate is behaving, for tuning thresholds.
router.get('/stats', async (req, res, next) => {
  try {
    const counts = {};
    ['ready', 'review', 'rejected', 'scanning', 'failed'].forEach((state) => {
      counts[state] = jobs.listByState([state]).length;
    });
    return res.json({
      scanning_enabled: scan.enabled(),
      providers: config.SCAN_PROVIDERS,
      fail_open: config.SCAN_FAIL_OPEN,
      thresholds: {
        mutable: { reject: config.SCAN_REJECT_SCORE, review: config.SCAN_REVIEW_SCORE },
        immutable: {
          reject: config.SCAN_REJECT_SCORE_IMMUTABLE,
          review: config.SCAN_REVIEW_SCORE_IMMUTABLE,
        },
      },
      counts,
    });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;

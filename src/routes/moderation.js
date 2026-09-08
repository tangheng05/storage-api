const express = require('express');
const fsp = require('fs/promises');
const config = require('../config');
const jobs = require('../services/jobs');
const scan = require('../services/scan');
const logger = require('../services/logger');
const { requireModerationKey } = require('../middleware/auth');

const router = express.Router();

// The note is written into a line-oriented file that scan.js parses back, so an
// unvalidated id could inject extra live hashes with a newline.
const appendHash = async (hash, id) => {
  const tag = jobs.ULID_REGEX.test(String(id || '')) ? id : 'manual';
  const note = `${hash.toLowerCase()}  # ${tag} ${new Date().toISOString()}`;
  await fsp.appendFile(config.SCAN_BLOCKLIST_PATH, `${note}
`);
};

/*
| Takedown tools. Master key only - operator endpoints, not user-facing.
|
| There is no review queue: the gate decides on one threshold and there is
| nobody to hand a borderline file to. What survives here is the after-the-fact
| half, for content that got through and should not have.
|
| Blocklisting records the file's perceptual hash, so the same picture is
| refused automatically from then on - no model, no API call, no cost. Nothing
| automatic ever writes to that list; only a person calling this route does.
*/

router.use(requireModerationKey);


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

    await appendHash(hash, id);
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
    ['ready', 'rejected', 'scanning', 'failed'].forEach((state) => {
      counts[state] = jobs.listByState([state]).length;
    });
    return res.json({
      scanning_enabled: scan.enabled(),
      providers: config.SCAN_PROVIDERS,
      fail_open: config.SCAN_FAIL_OPEN,
      thresholds: {
        mutable: { reject: config.SCAN_REJECT_SCORE },
        immutable: { reject: config.SCAN_REJECT_SCORE_IMMUTABLE },
      },
      counts,
    });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;

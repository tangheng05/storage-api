const express = require('express');
const fsp = require('fs/promises');
const path = require('path');
const config = require('../config');
const jobs = require('../services/jobs');
const mirror = require('../services/mirror');
const scan = require('../services/scan');
const { requireUploadKey, isAuthorized, matchesUploadToken } = require('../middleware/auth');

const router = express.Router();

function validateId(req, res, next) {
  if (!jobs.ULID_REGEX.test(req.params.id)) {
    return res.status(400).json({ error: 'Invalid audio id' });
  }
  return next();
}

// Readable with the master key or the per-upload scoped token, so a client can
// poll directly. Unauthenticated callers get 401 whether or not the id exists,
// so real ids cannot be probed.
router.get('/:id/status', validateId, async (req, res, next) => {
  try {
    const job = await jobs.get(req.params.id);
    if (!isAuthorized(req) && !(job && matchesUploadToken(req, job.upload_token))) {
      return res.status(401).json({ error: 'Invalid or missing upload key' });
    }
    if (!job) return res.status(404).json({ error: 'Not found' });
    const { id, state, url, error, duration_sec, filename } = job;
    return res.json({
      id, state, url, error, duration_sec, filename,
      s5_cid: mirror.publicCid(job),
      scan_reasons: scan.publicReasons(job),
      scan_message: scan.publicMessage(job),
    });
  } catch (err) {
    return next(err);
  }
});

router.delete('/:id', requireUploadKey, validateId, async (req, res, next) => {
  try {
    const { id } = req.params;
    const job = await jobs.get(id);
    if (!job) return res.status(404).json({ error: 'Not found' });
    // Ids are public, so login alone is not enough: a user-driven delete carries
    // the verified requester in x-delete-owner. Master-key calls without the
    // header (admin/ops) are unrestricted.
    const requester = req.headers['x-delete-owner'];
    if (requester && job.owner && requester !== job.owner) {
      return res.status(403).json({ error: 'Not the owner of this audio file' });
    }
    await Promise.all([
      fsp.rm(path.join(config.AUDIO_DIR, `${id}.m4a`), { force: true }),
      // The premium copy: deleting only the public one left paywalled files on
      // disk, still served to anyone holding an unexpired signed URL.
      fsp.rm(path.join(config.PRIVATE_AUDIO_DIR, `${id}.m4a`), { force: true }),
      // Anything still held at the scan gate.
      fsp.rm(path.join(config.PENDING_AUDIO_DIR, `${id}.m4a`), { force: true }),
      fsp.rm(path.join(config.TUS_DIR, id), { force: true }),
      fsp.rm(path.join(config.TUS_DIR, `${id}.json`), { force: true }),
    ]);

    // Returned, not swallowed: s3d reports 'deleted' and means it, while S5
    // manages 'unpinned' at best. The caller needs to know which it got before
    // telling a user their file is gone.
    const storage = await mirror.purge(job);

    await jobs.remove(id);
    return res.json({ deleted: id, storage });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;

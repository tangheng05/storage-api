const express = require('express');
const fsp = require('fs/promises');
const path = require('path');
const config = require('../config');
const jobs = require('../services/jobs');
const { requireUploadKey, isAuthorized, matchesUploadToken } = require('../middleware/auth');

const router = express.Router();

function validateId(req, res, next) {
  if (!jobs.ULID_REGEX.test(req.params.id)) {
    return res.status(400).json({ error: 'Invalid image id' });
  }
  return next();
}

// Status may be read with the master key OR the per-upload scoped token the
// uploader received at creation (see src/tus.js), so browsers/apps can poll
// directly without holding the master key. Unauthenticated callers get 401
// regardless of whether the id exists, to avoid leaking which ids are real.
router.get('/:id/status', validateId, async (req, res, next) => {
  try {
    const job = await jobs.get(req.params.id);
    if (!isAuthorized(req) && !(job && matchesUploadToken(req, job.upload_token))) {
      return res.status(401).json({ error: 'Invalid or missing upload key' });
    }
    if (!job) return res.status(404).json({ error: 'Not found' });
    const { id, state, url, error, width, height, filename } = job;
    return res.json({ id, state, url, error, width, height, filename });
  } catch (err) {
    return next(err);
  }
});

router.delete('/:id', requireUploadKey, validateId, async (req, res, next) => {
  try {
    const { id } = req.params;
    const job = await jobs.get(id);
    if (!job) return res.status(404).json({ error: 'Not found' });
    // User-driven deletes (proxied by the frontend backend) carry the
    // verified requester in x-delete-owner; a job that records a different
    // owner is off-limits — ids are public, login alone isn't enough.
    // Direct master-key calls without the header (admin/ops) are unrestricted.
    const requester = req.headers['x-delete-owner'];
    if (requester && job.owner && requester !== job.owner) {
      return res.status(403).json({ error: 'Not the owner of this image' });
    }
    await Promise.all([
      fsp.rm(path.join(config.IMAGES_DIR, `${id}.webp`), { force: true }),
      // A Premium image lives in the private dir instead of the public one, and
      // only one of the two ever exists — remove both rather than reading the
      // job's visibility, so a stale record can't strand the file on disk.
      fsp.rm(path.join(config.PRIVATE_IMAGES_DIR, `${id}.webp`), { force: true }),
      fsp.rm(path.join(config.TUS_DIR, id), { force: true }),
      fsp.rm(path.join(config.TUS_DIR, `${id}.json`), { force: true }),
    ]);
    await jobs.remove(id);
    return res.json({ deleted: id });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;

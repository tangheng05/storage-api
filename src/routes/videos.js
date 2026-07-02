const express = require('express');
const fsp = require('fs/promises');
const path = require('path');
const config = require('../config');
const jobs = require('../services/jobs');
const { requireUploadKey } = require('../middleware/auth');

const router = express.Router();

function validateId(req, res, next) {
  if (!jobs.ULID_REGEX.test(req.params.id)) {
    return res.status(400).json({ error: 'Invalid video id' });
  }
  return next();
}

router.get('/:id/status', requireUploadKey, validateId, async (req, res, next) => {
  try {
    const job = await jobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Not found' });
    const { id, state, url, thumbnail_url, error, duration_sec, width, height, filename } = job;
    return res.json({ id, state, url, thumbnail_url, error, duration_sec, width, height, filename });
  } catch (err) {
    return next(err);
  }
});

router.delete('/:id', requireUploadKey, validateId, async (req, res, next) => {
  try {
    const { id } = req.params;
    const job = await jobs.get(id);
    if (!job) return res.status(404).json({ error: 'Not found' });
    await Promise.all([
      fsp.rm(path.join(config.VIDEOS_DIR, `${id}.mp4`), { force: true }),
      fsp.rm(path.join(config.VIDEOS_DIR, `${id}.webm`), { force: true }),
      fsp.rm(path.join(config.THUMBS_DIR, `${id}.jpg`), { force: true }),
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

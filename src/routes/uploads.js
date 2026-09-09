const express = require('express');
const fsp = require('fs/promises');
const path = require('path');
const config = require('../config');
const jobs = require('../services/jobs');
const mirror = require('../services/mirror');
const scan = require('../services/scan');
const { requireUploadKey, isAuthorized, matchesUploadToken } = require('../middleware/auth');

// Builds the status/delete router for one media type (video, audio, image).
// `fields` are the job columns that type reports; `files` lists every path
// the bytes could occupy -- public, premium, and still at the scan gate.
const KINDS = {
  images: {
    noun: 'image',
    fields: ['width', 'height'],
    files: (id) => ['.webp', '.jpg', '.png'].flatMap((ext) => [
      path.join(config.IMAGES_DIR, `${id}${ext}`),
      path.join(config.PRIVATE_IMAGES_DIR, `${id}${ext}`),
      path.join(config.PENDING_IMAGES_DIR, `${id}${ext}`),
    ]),
  },
  videos: {
    noun: 'video',
    fields: ['thumbnail_url', 'duration_sec', 'width', 'height'],
    files: (id) => [
      ...['.mp4', '.webm'].flatMap((ext) => [
        path.join(config.VIDEOS_DIR, `${id}${ext}`),
        path.join(config.PRIVATE_VIDEOS_DIR, `${id}${ext}`),
        path.join(config.PENDING_VIDEOS_DIR, `${id}${ext}`),
      ]),
      path.join(config.THUMBS_DIR, `${id}.jpg`),
      path.join(config.PENDING_THUMBS_DIR, `${id}.jpg`),
    ],
  },
  audio: {
    noun: 'audio file',
    fields: ['duration_sec'],
    files: (id) => [
      path.join(config.AUDIO_DIR, `${id}.m4a`),
      path.join(config.PRIVATE_AUDIO_DIR, `${id}.m4a`),
      path.join(config.PENDING_AUDIO_DIR, `${id}.m4a`),
    ],
  },
};

const pick = (job, keys) => Object.fromEntries(keys.map((k) => [k, job[k]]));

function makeRouter(kind) {
  const { noun, fields, files } = KINDS[kind];
  const router = express.Router();

  const validateId = (req, res, next) => (jobs.ULID_REGEX.test(req.params.id)
    ? next()
    : res.status(400).json({ error: `Invalid ${noun} id` }));

  // Master key or the job's own scoped token. 401 whether or not the id
  // exists, so real ids can't be probed.
  router.get('/:id/status', validateId, async (req, res, next) => {
    try {
      const job = await jobs.get(req.params.id);
      if (!isAuthorized(req) && !(job && matchesUploadToken(req, job.upload_token))) {
        return res.status(401).json({ error: 'Invalid or missing upload key' });
      }
      if (!job) return res.status(404).json({ error: 'Not found' });
      return res.json({
        ...pick(job, ['id', 'state', 'url', ...fields, 'error', 'filename']),
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
      // Ids are public: a user-driven delete carries the verified requester
      // in x-delete-owner. Master-key calls without it are unrestricted.
      const requester = req.headers['x-delete-owner'];
      if (requester && job.owner && requester !== job.owner) {
        return res.status(403).json({ error: `Not the owner of this ${noun}` });
      }
      await Promise.all([
        ...files(id).map((p) => fsp.rm(p, { force: true })),
        fsp.rm(path.join(config.TUS_DIR, id), { force: true }),
        fsp.rm(path.join(config.TUS_DIR, `${id}.json`), { force: true }),
      ]);

      // Returned, not swallowed: caller needs to know whether it's really
      // deleted (s3d) or merely unpinned (S5) before telling a user it's gone.
      const storage = await mirror.purge(job);

      await jobs.remove(id);
      return res.json({ deleted: id, storage });
    } catch (err) {
      return next(err);
    }
  });

  return router;
}

module.exports = makeRouter;

const express = require('express');
const crypto = require('crypto');
const fsp = require('fs/promises');
const path = require('path');
const { ulid } = require('ulid');

const config = require('../config');
const jobs = require('../services/jobs');
const mirror = require('../services/mirror');
const sia = require('../services/sia');
const logger = require('../services/logger');
const { requireUploadKey } = require('../middleware/auth');
const { exists } = require('../utils/fs');

// Text bodies a takedown has to be able to erase. Routed to s3d and never S5
// (mirror.backendFor), and never served without the master key.

const router = express.Router();
const EXT = '.json';
const KIND = 'documents';

const fileFor = (id) => `${id}${EXT}`;
const pathFor = (id) => path.join(config.DOCUMENTS_DIR, fileFor(id));

// The stored URL carries the extension, so accept it either way.
const normalizeId = (req, res, next) => {
  req.docId = String(req.params.id || '').replace(/\.json$/i, '');
  if (!jobs.ULID_REGEX.test(req.docId)) {
    return res.status(400).json({ error: 'Invalid document id' });
  }
  return next();
};

const loadDoc = async (req, res, next) => {
  const job = await jobs.get(req.docId);
  if (!job || job.media_type !== 'document') {
    return res.status(404).json({ error: 'Not found' });
  }
  req.docJob = job;
  return next();
};

router.post('/', requireUploadKey, async (req, res, next) => {
  try {
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!body.length) return res.status(400).json({ error: 'Empty document' });
    if (body.length > config.MAX_DOCUMENT_BYTES) {
      return res.status(413).json({
        error: `Document too large (max ${config.MAX_DOCUMENT_BYTES} bytes)`,
      });
    }

    const id = ulid();
    const file = fileFor(id);
    const filePath = pathFor(id);
    // Over the exact bytes written, so a restore verifies byte for byte.
    const sha256 = crypto.createHash('sha256').update(body).digest('hex');

    await fsp.writeFile(filePath, body);
    await jobs.create(id, {
      state: 'ready',
      media_type: 'document',
      // mirror.buildKey reads this; nothing about a document is public.
      visibility: 'private',
      // Shaped so mirror.retry's fileFromJob finds the filename on a sweep.
      url: `${config.PUBLIC_BASE_URL}/${KIND}/${file}`,
      sha256,
      size: body.length,
      owner: req.headers['x-owner'] || null,
      mirror_state: 'pending',
    });

    // Synchronous: the caller is about to commit this hash somewhere it cannot
    // take back. A failure still answers 201; the hourly sweep retries.
    const { patch } = await mirror.publish({
      id,
      kind: KIND,
      mediaType: 'document',
      file,
      filePath,
      visibility: 'private',
      slot: 'main',
      force: true,
    });
    await jobs.update(id, patch);

    return res.status(201).json({
      id,
      sha256,
      bytes: body.length,
      storage: patch[mirror.SLOTS.main.state],
    });
  } catch (err) {
    return next(err);
  }
});

router.get('/:id', requireUploadKey, normalizeId, loadDoc, async (req, res, next) => {
  try {
    const filePath = pathFor(req.docId);

    // Pull it back from s3d if local disk lost it.
    if (!(await exists(filePath))) {
      const key = req.docJob[mirror.SLOTS.main.key];
      if (!key || !sia.enabled()) {
        return res.status(404).json({ error: 'Not found' });
      }
      await sia.getToFile({ key, filePath });
      // The commitment claims these exact bytes. Serving a restore unchecked
      // would let a corrupt object answer for a hash it does not match.
      const restored = crypto.createHash('sha256')
        .update(await fsp.readFile(filePath)).digest('hex');
      if (req.docJob.sha256 && restored !== req.docJob.sha256) {
        await fsp.rm(filePath, { force: true });
        logger.error(
          { id: req.docId, key, expected: req.docJob.sha256, got: restored },
          'restored document does not match its commitment',
        );
        return res.status(502).json({ error: 'restored_document_hash_mismatch' });
      }
      logger.info({ id: req.docId, key }, 'document restored from s3d');
    }

    res.set('Content-Type', 'application/json; charset=utf-8');
    res.set('Cache-Control', 'no-store');
    res.set('X-Content-Sha256', req.docJob.sha256 || '');
    return res.sendFile(filePath);
  } catch (err) {
    return next(err);
  }
});

router.delete('/:id', requireUploadKey, normalizeId, loadDoc, async (req, res, next) => {
  try {
    const job = req.docJob;
    // Same rule as uploads.js: master-key calls without it are unrestricted.
    const requester = req.headers['x-delete-owner'];
    if (requester && job.owner && requester !== job.owner) {
      return res.status(403).json({ error: 'Not the owner of this document' });
    }

    await fsp.rm(pathFor(req.docId), { force: true });
    // Returned, not swallowed: the caller needs to know the bytes are gone.
    const storage = await mirror.purge(job);
    await jobs.remove(req.docId);

    logger.info({ id: req.docId, storage }, 'document deleted');
    return res.json({ deleted: req.docId, storage });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;

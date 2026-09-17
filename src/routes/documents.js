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
const rateLimit = require('express-rate-limit');
const { requireUploadKey, requireArweaveKey } = require('../middleware/auth');
const { exists } = require('../utils/fs');
const forever = require('../services/forever');
const arweave = require('../services/arweave');

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

// Local copy, restored from s3d and checked against the commitment if disk
// lost it. Shared by the read and the Forever copy.
const localDocument = async (req) => {
  const filePath = pathFor(req.docId);
  if (await exists(filePath)) return filePath;
  const key = req.docJob[mirror.SLOTS.main.key];
  if (!key || !sia.enabled()) return null;
  await sia.getToFile({ key, filePath });
  const restored = crypto.createHash('sha256').update(await fsp.readFile(filePath)).digest('hex');
  if (req.docJob.sha256 && restored !== req.docJob.sha256) {
    await fsp.rm(filePath, { force: true });
    logger.error({ id: req.docId, key, expected: req.docJob.sha256, got: restored }, 'restored document does not match its commitment');
    const err = new Error('restored_document_hash_mismatch');
    err.status = 502;
    throw err;
  }
  logger.info({ id: req.docId, key }, 'document restored from s3d');
  return filePath;
};

router.get('/:id', requireUploadKey, normalizeId, loadDoc, async (req, res, next) => {
  try {
    const filePath = await localDocument(req);
    if (!filePath) return res.status(404).json({ error: 'Not found' });

    res.set('Content-Type', 'application/json; charset=utf-8');
    res.set('Cache-Control', 'no-store');
    res.set('X-Content-Sha256', req.docJob.sha256 || '');
    return res.sendFile(filePath);
  } catch (err) {
    if (err.status === 502) return res.status(502).json({ error: err.message });
    return next(err);
  }
});

/*
| Forever for text: a permanent copy of a post's canonical bytes.
|
| The one route that sends a document anywhere it cannot be deleted from,
| behind the arweave key like the media routes. Synchronous and idempotent: a
| document is small, and the caller wants the id in hand before it goes on
| chain. 200 with the id, whether this call made the copy or an earlier one.
*/
const foreverLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: config.ARWEAVE_PER_HOUR,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many permanent-storage requests, try again later' },
});

router.post('/:id/arweave', foreverLimiter, requireArweaveKey, normalizeId, loadDoc, async (req, res, next) => {
  if (!arweave.enabled()) return res.status(503).json({ error: 'arweave_not_configured' });
  const job = req.docJob;
  if (job.state !== 'ready') return res.status(409).json({ error: 'not_published', state: job.state });
  try {
    const filePath = await localDocument(req);
    if (!filePath) return res.status(409).json({ error: 'local_file_missing' });
    const { id: arweaveId, already, reused } = await forever.archiveDocument({ job, filePath });
    return res.json({
      id: req.docId,
      sha256: job.sha256,
      bytes: job.size,
      arweave_id: arweaveId,
      arweave_url: arweave.gatewayUrl(arweaveId),
      already: !!already,
      reused: !!reused,
    });
  } catch (err) {
    if (err.status === 502) return res.status(502).json({ error: err.message });
    logger.error({ id: req.docId, err: err.message }, 'forever: document arweave publish failed');
    const code = err.code || 'arweave_upload_failed';
    return res.status(code === 'arweave_credits_low' ? 402 : 502).json({ error: code, message: err.message });
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

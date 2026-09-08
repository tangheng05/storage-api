const express = require('express');
const config = require('../config');
const jobs = require('../services/jobs');
const s5 = require('../services/s5');
const logger = require('../services/logger');

const router = express.Router();

// Resolves a stable ULID URL to wherever the bytes live:
//   https://cdn.serey.io/videos/01J....mp4  ->  302  ->  S5 node /<CID>
//
// serey-api freezes these strings into post rows permanently, so a raw CID
// would commit the platform to S5 for the life of the post. With the ULID in
// the path the backend stays swappable and deleting the job stops the URL
// resolving. In production cdn.serey.io maps / to /cdn/.

const KINDS = ['videos', 'audio', 'images', 'thumbnails'];

// Anchored, and the extension holds no dot or slash, so a filename can never
// walk out of its namespace.
const FILE_RE = /^([0-9A-HJKMNP-TV-Z]{26})(\.[A-Za-z0-9]{1,5})$/;

router.get('/:kind/:file', async (req, res) => {
  const { kind } = req.params;
  if (!KINDS.includes(kind)) return res.status(404).json({ error: 'Not found' });

  const match = FILE_RE.exec(req.params.file || '');
  if (!match) return res.status(400).json({ error: 'Invalid media reference' });
  const id = match[1];

  let job;
  try {
    job = await jobs.get(id);
  } catch {
    return res.status(400).json({ error: 'Invalid media reference' });
  }

  // A deleted job stops resolving. Same response for ids that never existed,
  // so this cannot be used to probe which are real.
  if (!job || job.state !== 'ready') return res.status(404).json({ error: 'Not found' });

  // Premium goes through /media with a signature; answering here would be a
  // paywall bypass by redirect.
  if (job.visibility === 'private') return res.status(404).json({ error: 'Not found' });

  const cid = kind === 'thumbnails' ? job.s5_thumb_cid : job.s5_cid;
  if (!cid) {
    // s3d or local-only: nginx serves those directly, so the URL was built
    // wrong.
    logger.warn({ id, kind }, 'cdn resolve for media with no CID');
    return res.status(404).json({ error: 'Not found' });
  }

  // Content addressed bytes cannot change, so cache hard.
  res.set('Cache-Control', `public, max-age=${config.MEDIA_CDN_CACHE_SEC}, immutable`);
  return res.redirect(302, s5.downloadUrl(cid));
});

router.get('/', (req, res) => res.status(404).json({ error: 'Not found' }));

module.exports = router;

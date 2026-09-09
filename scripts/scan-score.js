#!/usr/bin/env node
/*
| Score images through the real gate without uploading anything.
|
|   node scripts/scan-score.js photo1.jpg photo2.png ...
|   node scripts/scan-score.js /var/www/serey-videos/images/*.webp
|
| Reads the same .env the server does and calls the same scan.scanFile, so the
| numbers are exactly what an upload would get. Nothing is stored, published or
| written to a job record.
|
| This is the tuning tool. The threshold moved from 0.9 to 0.5 and there is no
| review queue behind it any more, so the question that matters is not "does it
| catch bad pictures" but "does it refuse ordinary ones" -- and the only way to
| know is to run your own photos through it and look at the spread.
*/
require('dotenv').config();
const path = require('path');

const config = require('../src/config');
const scan = require('../src/services/scan');

const files = process.argv.slice(2);
if (!files.length) {
  console.error('usage: node scripts/scan-score.js <file> [file...]');
  process.exit(2);
}

// Images publish to S5 when it is enabled for them, and that is the stricter
// threshold, so score against the one their real uploads would face.
const immutable = config.S5_ENABLED && config.S5_TYPES.includes('image');
const threshold = immutable ? config.SCAN_REJECT_SCORE_IMMUTABLE : config.SCAN_REJECT_SCORE;

(async () => {
  console.log(`providers ${config.SCAN_PROVIDERS.join(', ')}`);
  console.log(`threshold ${threshold}${immutable ? ' (immutable: images go to S5)' : ''}`);
  console.log();

  let refused = 0;
  for (const file of files) {
    let line;
    try {
      // eslint-disable-next-line no-await-in-loop
      const res = await scan.scanFile({ filePath: file, mediaType: 'image', immutable });
      if (res.verdict === scan.VERDICT.REJECT) refused += 1;
      const score = res.score == null ? '   -' : res.score.toFixed(2).padStart(4);
      // A margin worth watching: anything inside ~0.1 of the line is one model
      // update away from flipping.
      const near = res.score != null && res.verdict !== scan.VERDICT.REJECT
        && res.score >= threshold - 0.1;
      line = [
        res.verdict === scan.VERDICT.REJECT ? 'REFUSED' : (near ? 'close  ' : 'ok     '),
        score,
        (res.labels || []).join(',').padEnd(16),
        res.providers.join('+'),
      ].join('  ');
    } catch (err) {
      line = `ERROR      ${err.message}`;
    }
    console.log(`${path.basename(file).slice(0, 40).padEnd(42)} ${line}`);
  }

  console.log();
  console.log(`${refused} of ${files.length} would be refused`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

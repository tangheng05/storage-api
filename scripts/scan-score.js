#!/usr/bin/env node
// Scores images through the real gate, using the same .env and scan.scanFile
// an upload would, without storing or publishing anything.
//   node scripts/scan-score.js photo1.jpg photo2.png ...
//   node scripts/scan-score.js /var/www/serey-videos/images/*.webp
require('dotenv').config();
const path = require('path');

const config = require('../src/config');
const scan = require('../src/services/scan');

const files = process.argv.slice(2);
if (!files.length) {
  console.error('usage: node scripts/scan-score.js <file> [file...]');
  process.exit(2);
}

// Score against the stricter threshold if images actually publish to S5.
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
      // within ~0.1 of the line: one model update away from flipping
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

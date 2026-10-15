#!/usr/bin/env node
/*
| Every S5 CID we hold, one row per media job: id, public URL, main CID and the
| thumbnail's CID. Reads the job store only -- no network, and nothing is
| published or changed -- so it is safe to run on the VPS at any time.
|
|   node scripts/s5-list-cids.js > cids.json
|   node scripts/s5-list-cids.js --csv > cids.csv
|
| Premium jobs are left out. They should hold no CID, and an old one that does
| (a poster frame from before thumbnails followed the job's visibility) must not
| land on a public page. Identical uploads share a CID, so one CID can appear on
| several rows.
*/
const jobs = require('../src/services/jobs');

const CSV = process.argv.includes('--csv');
const COLUMNS = ['id', 'type', 'url', 'cid', 'thumbnail_cid', 'created_at'];

// Not on S5 yet, and not because it was never meant to be.
const NOT_YET = ['deferred', 'pending', 'failed'];

function csvCell(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function main() {
  const ready = jobs.listByState(['ready']);
  const held = ready.filter((job) => job.s5_cid || job.s5_thumb_cid);

  const rows = held
    .filter((job) => job.visibility !== 'private')
    .map((job) => ({
      id: job.id,
      type: job.media_type,
      url: job.url,
      cid: job.s5_cid || null,
      thumbnail_cid: job.s5_thumb_cid || null,
      created_at: job.created_at,
    }))
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));

  if (CSV) {
    console.log(COLUMNS.join(','));
    rows.forEach((row) => console.log(COLUMNS.map((col) => csvCell(row[col])).join(',')));
  } else {
    console.log(JSON.stringify(rows, null, 2));
  }

  // stderr, so redirecting stdout to a file keeps the file clean.
  const withheld = held.length - rows.length;
  const waiting = ready.filter((job) => job.visibility !== 'private'
    && !job.s5_cid
    && job.storage_backend !== 's3d'
    && NOT_YET.includes(job.mirror_state)).length;

  console.error(`${rows.length} row(s) with a CID`);
  if (withheld) console.error(`${withheld} premium job(s) hold a CID and were left out -- look into them`);
  if (waiting) console.error(`${waiting} public job(s) are not on S5 yet (deferred or failed) -- no CID to list`);
}

main();

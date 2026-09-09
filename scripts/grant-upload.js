#!/usr/bin/env node
/*
| Mint a scoped upload session for someone who should not hold the master key.
|
|   node scripts/grant-upload.js <filename> <bytes> <mimetype> [owner]
|
| The token is valid for that one upload id, dies when the upload completes, and
| cannot delete. Run against the live ENDPOINT: the issuing instance is the only
| one that honours it.
*/
const fs = require('fs');
const path = require('path');

const [fileArg, bytesArg, typeArg, owner] = process.argv.slice(2);
const ENDPOINT = (process.env.ENDPOINT || 'https://storage.serey.io').replace(/\/$/, '');
const KEY = process.env.UPLOAD_API_KEY;

if (!fileArg || !KEY) {
  console.error('usage: UPLOAD_API_KEY=<key> node scripts/grant-upload.js <filename|path> <bytes> <mimetype> [owner]');
  console.error('       if <filename> is a real path, bytes and mimetype are read from it');
  process.exit(2);
}

const EXT_TYPES = {
  '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
};

let filename = path.basename(fileArg);
let size = Number(bytesArg);
let filetype = typeArg;

if (fs.existsSync(fileArg)) {
  size = fs.statSync(fileArg).size;
  filetype = filetype || EXT_TYPES[path.extname(fileArg).toLowerCase()];
}
if (!Number.isFinite(size) || size <= 0) {
  console.error('need a byte size (or a real file path)');
  process.exit(2);
}
filetype = filetype || EXT_TYPES[path.extname(filename).toLowerCase()];
if (!filetype) {
  console.error('need a mimetype: the service matches it against the extension');
  process.exit(2);
}

const meta = (pairs) => Object.entries(pairs)
  .filter(([, v]) => v)
  .map(([k, v]) => `${k} ${Buffer.from(String(v)).toString('base64')}`)
  .join(',');

(async () => {
  const res = await fetch(`${ENDPOINT}/files`, {
    method: 'POST',
    headers: {
      'x-upload-key': KEY,
      'tus-resumable': '1.0.0',
      'upload-length': String(size),
      'upload-metadata': meta({ filename, filetype, owner }),
    },
  });

  if (res.status !== 201) {
    console.error(`create failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
    process.exit(1);
  }

  const uploadUrl = res.headers.get('location');
  const token = res.headers.get('x-upload-token');
  const id = res.headers.get('x-video-id') || (uploadUrl || '').split('/').pop();

  console.log('Hand these three to the uploader. None of them is the master key.\n');
  console.log(`  UPLOAD_URL=${uploadUrl}`);
  console.log(`  TOKEN=${token}`);
  console.log(`  STATUS_URL=${ENDPOINT}/images/${id}/status`);
  console.log(`\n  id: ${id}  (${filename}, ${size} bytes, ${filetype})`);
  console.log('\nThe token only works for this one upload and cannot delete anything.');
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});

#!/usr/bin/env node
// s3d does not implement presigned GET -- it returns 403 AccessDenied, which
// is what broke S5's reads through its S3 store (the node fetches blobs via
// presigned URLs; scripts/s3d-verify.js already proved the bytes are intact).
//   AK=<access> SK=<secret> node scripts/s3d-presign-test.js <published-file>
const fs = require('fs');
const { blake3 } = require('@noble/hashes/blake3');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const file = process.argv[2];
if (!file || !process.env.AK || !process.env.SK) {
  console.error('usage: AK=<access> SK=<secret> node scripts/s3d-presign-test.js <file>');
  process.exit(2);
}

const ENDPOINT = process.env.S3D_ENDPOINT || 'http://127.0.0.1:8000';
const BUCKET = process.env.S3D_BUCKET || 'media';

const local = fs.readFileSync(file);
const hash = Buffer.from(blake3(local));
const key = `1/${Buffer.concat([Buffer.from([0x1f]), hash]).toString('base64url')}`;

const clientFor = (region) => new S3Client({
  endpoint: ENDPOINT,
  region,
  forcePathStyle: true,
  credentials: { accessKeyId: process.env.AK, secretAccessKey: process.env.SK },
});

async function fetchAndHash(label, url, headers = {}) {
  const res = await fetch(url, { headers });
  const body = Buffer.from(await res.arrayBuffer());
  const same = Buffer.from(blake3(body)).equals(hash);
  console.log(
    label.padEnd(34),
    `http ${res.status}`,
    `${String(body.length).padStart(7)} bytes`,
    body.length === local.length ? (same ? 'hash OK' : 'HASH MISMATCH') : 'SIZE MISMATCH',
  );
  if (res.status >= 400) console.log('   body:', body.toString('utf8').slice(0, 200));
  return { same, body };
}

(async () => {
  console.log('file', file, local.length, 'bytes');
  console.log('key ', key);
  console.log();

  const normal = clientFor('us-east-1');
  const nulled = clientFor('null'); // the node's minio client signs with region "null"

  const cmd = () => new GetObjectCommand({ Bucket: BUCKET, Key: key });

  const signed = await getSignedUrl(normal, cmd(), { expiresIn: 86400 });
  await fetchAndHash('presigned, region us-east-1', signed);

  const signedNull = await getSignedUrl(nulled, cmd(), { expiresIn: 86400 });
  await fetchAndHash('presigned, region "null"', signedNull);

  // The node reads in 256KB windows regardless of object size.
  await fetchAndHash('presigned + Range 0-262143', signed, { range: 'bytes=0-262143' });
  await fetchAndHash('presigned + Range 0-1023', signed, { range: 'bytes=0-1023' });

  // The outboard BLAKE3 tree S5 needs for verified streaming. Only meaningful
  // if it actually arrived -- an error body's length is not the outboard's size.
  const obao = await getSignedUrl(normal, new GetObjectCommand({ Bucket: BUCKET, Key: `${key}.obao` }), { expiresIn: 3600 });
  const res = await fetch(obao);
  const tree = Buffer.from(await res.arrayBuffer());
  console.log();
  console.log('.obao', `http ${res.status}`, tree.length, 'bytes');
  if (res.status >= 400) {
    console.log('      not read, so its size says nothing:', tree.toString('utf8').slice(0, 120));
    return;
  }
  // bao outboard is 8 bytes of length plus 64 per parent node, and a file of N
  // 1024-byte chunks has N-1 parents.
  const chunks = Math.ceil(local.length / 1024);
  console.log(`      ${chunks} chunks -> expected roughly ${8 + 64 * Math.max(0, chunks - 1)} bytes`);
  if (tree.length < 8 + 64 * Math.max(0, chunks - 1)) {
    console.log('      TOO SMALL. The outboard does not describe this object, so');
    console.log('      verified streaming cannot pass whatever the store returns.');
  }
})().catch((err) => {
  console.error(err.name, err.message);
  process.exit(1);
});

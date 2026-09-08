#!/usr/bin/env node
/*
| Does s3d serve a PRESIGNED GET the same as an SDK-signed one?
|
|   AK=<access> SK=<secret> node scripts/s3d-presign-test.js <published-file>
|
| The S5 node reads blobs from an S3 store via presigned URLs -- visible in its
| log as `[try] http://s3d:8000/media/1/...?X-Amz-Algorithm=...`. That is a
| different path through s3d than the SDK-signed request scripts/s3d-verify.js
| uses, and that one already proved the bytes are stored intact.
|
| So this fetches the same object the way the node does, and hashes it. It also
| repeats the 256KB range read the node performs, and signs one URL with the
| literal region "null" that the node's minio client emits.
*/
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
  const nulled = clientFor('null'); // what the node's minio client actually sends

  const cmd = () => new GetObjectCommand({ Bucket: BUCKET, Key: key });

  const signed = await getSignedUrl(normal, cmd(), { expiresIn: 86400 });
  await fetchAndHash('presigned, region us-east-1', signed);

  const signedNull = await getSignedUrl(nulled, cmd(), { expiresIn: 86400 });
  await fetchAndHash('presigned, region "null"', signedNull);

  // The node reads in 256KB windows regardless of object size.
  await fetchAndHash('presigned + Range 0-262143', signed, { range: 'bytes=0-262143' });
  await fetchAndHash('presigned + Range 0-1023', signed, { range: 'bytes=0-1023' });

  // The outboard BLAKE3 tree S5 uses for verified streaming. If this is the
  // wrong size for the object, verification cannot succeed no matter what the
  // data path does.
  const obao = await getSignedUrl(normal, new GetObjectCommand({ Bucket: BUCKET, Key: `${key}.obao` }), { expiresIn: 3600 });
  const res = await fetch(obao);
  const tree = Buffer.from(await res.arrayBuffer());
  console.log();
  console.log('.obao', `http ${res.status}`, tree.length, 'bytes');
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

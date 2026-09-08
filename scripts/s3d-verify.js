#!/usr/bin/env node
/*
| Does s3d give back the bytes S5 put in?
|
|   AK=<access> SK=<secret> node scripts/s3d-verify.js <published-file>
|
| The S5 node fetches a blob from its store and verifies the BLAKE3 hash
| against the CID. Against s3d that fails with "Integrity verification failed",
| which has exactly two explanations: s3d returns different bytes, or the node's
| read path is broken. This tells them apart by fetching the object itself and
| hashing it.
|
| The object key is base64url(0x1f || hash) under a "1/" prefix -- the same
| encoding S5 sends as tus metadata, which is how we know the write used the
| right hash.
*/
const fs = require('fs');
const { blake3 } = require('@noble/hashes/blake3');
const { S3Client, GetObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');

const file = process.argv[2];
if (!file || !process.env.AK || !process.env.SK) {
  console.error('usage: AK=<access> SK=<secret> node scripts/s3d-verify.js <file>');
  process.exit(2);
}

const ENDPOINT = process.env.S3D_ENDPOINT || 'http://127.0.0.1:8000';
const BUCKET = process.env.S3D_BUCKET || 'media';

const client = new S3Client({
  endpoint: ENDPOINT,
  region: 'us-east-1',
  forcePathStyle: true,
  credentials: { accessKeyId: process.env.AK, secretAccessKey: process.env.SK },
});

const collect = async (body) => {
  const chunks = [];
  for await (const c of body) chunks.push(c);
  return Buffer.concat(chunks);
};

(async () => {
  const local = fs.readFileSync(file);
  const hash = Buffer.from(blake3(local));
  const key = `1/${Buffer.concat([Buffer.from([0x1f]), hash]).toString('base64url')}`;

  console.log('local file :', file, local.length, 'bytes');
  console.log('local hash :', hash.toString('hex'));
  console.log('object key :', key);
  console.log();

  try {
    const head = await client.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    console.log('s3d HEAD   :', head.ContentLength, 'bytes');
  } catch (err) {
    console.log('s3d HEAD   : FAILED', err.Code || err.name);
    console.log('\nThe object is not there under the key S5 would use. The write went');
    console.log('somewhere else, or the key encoding differs.');
    process.exit(1);
  }

  const got = await collect((await client.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }))).Body);
  const gotHash = Buffer.from(blake3(got));
  console.log('s3d GET    :', got.length, 'bytes');
  console.log('s3d hash   :', gotHash.toString('hex'));
  console.log();

  if (gotHash.equals(hash)) {
    console.log('MATCH. s3d returns the bytes intact, so the store is fine and the');
    console.log('failure is in the S5 node\'s read path. /cdn can read s3d directly');
    console.log('and skip the node for delivery.');
  } else {
    console.log('MISMATCH. s3d returns different bytes than were written.');
    console.log(`  wrote ${local.length}, read ${got.length}`);
    console.log('Nothing downstream can verify a blob against its CID, so S5 on top');
    console.log('of s3d cannot work until this is understood.');
  }

  // S5 asks for bytes=0-262143 regardless of size. If s3d mishandles a range
  // longer than the object, that alone would break verified streaming.
  try {
    const ranged = await collect((await client.send(new GetObjectCommand({
      Bucket: BUCKET, Key: key, Range: 'bytes=0-262143',
    }))).Body);
    console.log();
    console.log('ranged 0-262143 :', ranged.length, 'bytes',
      ranged.length === got.length ? '(same as full, correct)' : '(DIFFERS from full)');
  } catch (err) {
    console.log('\nranged 0-262143 : FAILED', err.Code || err.name);
    console.log('S5 always reads in 256KB ranges, so this alone would break it.');
  }
})().catch((err) => {
  console.error(err.Code || err.name, err.message);
  process.exit(1);
});

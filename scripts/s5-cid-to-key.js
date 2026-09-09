#!/usr/bin/env node
// Resolve an S5 CID to its blob URL, fetch it, and check the bytes match the
// CID's BLAKE3 hash -- runs from anywhere, so a stranger can verify without
// trusting us or the network in between.
//   node scripts/s5-cid-to-key.js <cid> [baseUrl]   (baseUrl default: our /blob route)
const { blake3 } = require('@noble/hashes/blake3');

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58decode(str) {
  const bytes = [0];
  for (const ch of str) {
    const val = ALPHABET.indexOf(ch);
    if (val < 0) throw new Error(`not base58btc: '${ch}'`);
    let carry = val;
    for (let i = 0; i < bytes.length; i += 1) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  // A leading '1' encodes a leading zero byte, which the loop above cannot.
  for (const ch of str) {
    if (ch !== '1') break;
    bytes.push(0);
  }
  return Buffer.from(bytes.reverse());
}

const cid = process.argv[2];
const base = (process.argv[3] || 'https://storage.serey.io/blob/').replace(/\/?$/, '/');

if (!cid) {
  console.error('usage: node scripts/s5-cid-to-key.js <cid> [baseUrl]');
  process.exit(2);
}
if (!cid.startsWith('z')) {
  console.error("CID must start with 'z' (base58btc). See deploy/s5/README.md.");
  process.exit(2);
}

// z<base58btc(0x26 0x1f || hash || sizeLE)>. The blob key drops the 0x26 CID
// type byte and keeps 0x1f || hash, the multihash the store names files by.
const raw = base58decode(cid.slice(1));
if (raw[0] !== 0x26 || raw[1] !== 0x1f) {
  console.error(`unexpected CID prefix 0x${raw[0].toString(16)} 0x${raw[1].toString(16)}, expected 0x26 0x1f`);
  process.exit(1);
}
const multihash = raw.subarray(1, 34);
const hash = raw.subarray(2, 34);
const key = `1/${multihash.toString('base64url')}`;
const url = `${base}${key}`;

(async () => {
  console.log('cid ', cid);
  console.log('key ', key);
  console.log('url ', url);
  console.log();

  const res = await fetch(url);
  const body = Buffer.from(await res.arrayBuffer());
  console.log(`http ${res.status}`, `${body.length} bytes`);

  if (!res.ok) {
    console.log('body:', body.toString('utf8').slice(0, 200));
    process.exit(1);
  }

  const ok = Buffer.from(blake3(body)).equals(hash);
  console.log(ok ? 'hash OK — these are the bytes the CID names' : 'HASH MISMATCH — wrong bytes served');
  process.exit(ok ? 0 : 1);
})().catch((err) => {
  console.error(err.name, err.message);
  process.exit(1);
});

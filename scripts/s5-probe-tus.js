#!/usr/bin/env node
// Re-derives the S5 CID hash-prefix byte and tus hash-metadata encoding
// empirically against a live node, since docs.sfive.net documents different
// values. Whatever variant gets a 204 is the answer; put it in s5.js. Re-run
// before trusting the constants on a new node version.
//   node scripts/s5-probe-tus.js <file>   (needs S5_NODE_URL, S5_AUTH_TOKEN)
const fs = require('fs');
const { blake3 } = require('@noble/hashes/blake3');
const config = require('../src/config');

const file = process.argv[2];
if (!file) {
  console.error('usage: node scripts/s5-probe-tus.js <file>');
  process.exit(2);
}
if (!config.S5_NODE_URL || !config.S5_AUTH_TOKEN) {
  console.error('S5_NODE_URL and S5_AUTH_TOKEN must be set');
  process.exit(2);
}

const bytes = fs.readFileSync(file);
const hash = Buffer.from(blake3(bytes));

const variants = [];
for (const [name, prefix] of [['0x1e', 0x1e], ['0x1f', 0x1f], ['none', null]]) {
  const raw = prefix === null ? hash : Buffer.concat([Buffer.from([prefix]), hash]);
  variants.push({ label: `${name} base64url`, value: raw.toString('base64url') });
  variants.push({ label: `${name} base64`, value: raw.toString('base64') });
  variants.push({ label: `${name} hex`, value: raw.toString('hex') });
}

const headers = (extra) => ({
  authorization: `Bearer ${config.S5_AUTH_TOKEN}`,
  'tus-resumable': '1.0.0',
  ...extra,
});

async function attempt({ label, value }, key, doubleEncode) {
  // doubleEncode=false sends value as the base64 payload directly; worth
  // trying since the spec never says which.
  const meta = doubleEncode
    ? `${key} ${Buffer.from(value).toString('base64')}`
    : `${key} ${value}`;

  const create = await fetch(`${config.S5_NODE_URL}/s5/upload/tus`, {
    method: 'POST',
    headers: headers({ 'upload-length': String(bytes.length), 'upload-metadata': meta }),
  });
  if (create.status !== 201) {
    return `create ${create.status}`;
  }
  const loc = new URL(create.headers.get('location'), config.S5_NODE_URL).toString();

  const patch = await fetch(loc, {
    method: 'PATCH',
    headers: headers({ 'upload-offset': '0', 'content-type': 'application/offset+octet-stream' }),
    body: bytes,
  });
  return `patch ${patch.status}${patch.status === 204 ? '  <-- ACCEPTED' : ''}`;
}

(async () => {
  console.log(`file ${file} (${bytes.length} bytes)`);
  console.log(`blake3 ${hash.toString('hex')}\n`);

  for (const key of ['hash', 'x-s5-hash', 'blake3']) {
    for (const doubleEncode of [true, false]) {
      for (const v of variants) {
        // eslint-disable-next-line no-await-in-loop
        const result = await attempt(v, key, doubleEncode).catch((e) => `error ${e.message}`);
        const enc = doubleEncode ? 'b64(value)' : 'value raw';
        console.log(`  ${key.padEnd(10)} ${enc.padEnd(11)} ${v.label.padEnd(16)} ${result}`);
      }
    }
  }
})();

#!/usr/bin/env node
/*
| Find the tus hash-metadata encoding a real S5 node accepts.
|
|   node scripts/s5-probe-tus.js /tmp/fresh.webp
|
| The spec says only "BASE64URL(0x1e || hash)" and never shows a request, and a
| live node rejects that with "Invalid hash found". Two unknowns: which byte
| prefixes the hash (the node's own CIDs use 0x1f where the spec says 0x1e), and
| how many times the value is encoded (tus itself requires base64 metadata).
|
| So ask the node. Each variant does a real create + PATCH and reports the
| status. Whatever returns 204 is the answer; put it in s5.js.
*/
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

// value = what the node should see after tus base64-decodes the metadata
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
  // tus requires metadata values to be base64. doubleEncode=false sends the
  // value as the base64 payload directly, which only makes sense if the value
  // is already base64-ish -- both are worth trying since the spec is silent.
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

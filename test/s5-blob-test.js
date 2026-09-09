#!/usr/bin/env node
/*
| S5 blob route test: node test/s5-blob-test.js (no framework). Drives
| src/routes/blob.js and src/services/s5blob.js against an in-process S3 stub
| standing in for s3d, proving we serve the shape S5 asks for -- the `1/<hash>`
| key, the `.obao` sibling, 256KB ranged reads, and cross-origin access. It
| does NOT prove s3d behaves this way, or that a live S5 node is happy.
*/
const http = require('http');
const assert = require('assert');

const PORT = 9149;

process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'silent';
process.env.UPLOAD_API_KEY = 'blob-test';
process.env.ALLOWED_ORIGINS = 'https://example.com';
process.env.S5_BLOB_ENABLED = 'true';
process.env.S5_BLOB_S3_ENDPOINT = `http://127.0.0.1:${PORT}`;
process.env.S5_BLOB_S3_BUCKET = 'media';
process.env.S5_BLOB_S3_ACCESS_KEY = 'ak';
process.env.S5_BLOB_S3_SECRET_KEY = 'sk';

// 44 base64url characters, the length a 33-byte BLAKE3 multihash encodes to.
const HASH = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcdefg';
const BLOB = Buffer.from('serey blob bytes '.repeat(64));
const OBAO = Buffer.from('bao outboard tree bytes');

// A premium object, in the same bucket, to prove the route cannot reach it.
// Premium never actually reaches S5 -- mirror.js routes it to s3d or local disk
// -- but the bucket may be shared, so the prefix has to hold on its own.
const SECRET = Buffer.from('paywalled video bytes');

const store = new Map([
  ['private/videos/secret.mp4', SECRET],
  [`1/${HASH}`, BLOB],
  [`1/${HASH}.obao`, OBAO],
]);

const stub = http.createServer((req, res) => {
  const key = decodeURIComponent(new URL(req.url, 'http://x').pathname.replace(/^\/[^/]+\//, ''));
  const buf = store.get(key);
  if (!buf) {
    res.writeHead(404, { 'Content-Type': 'application/xml' });
    res.end('<?xml version="1.0"?><Error><Code>NoSuchKey</Code></Error>');
    return;
  }
  const range = req.headers.range;
  if (range) {
    const [, s, e] = /bytes=(\d+)-(\d*)/.exec(range) || [];
    const start = parseInt(s, 10);
    const end = e === '' || e === undefined ? buf.length - 1 : Math.min(parseInt(e, 10), buf.length - 1);
    const slice = buf.subarray(start, end + 1);
    res.writeHead(206, {
      'Content-Length': slice.length,
      'Content-Range': `bytes ${start}-${end}/${buf.length}`,
    });
    res.end(slice);
    return;
  }
  res.writeHead(200, { 'Content-Length': buf.length });
  res.end(buf);
});

let passed = 0;
const check = (name, cond) => {
  assert.ok(cond, `FAILED: ${name}`);
  passed += 1;
  console.log(`  ok  ${name}`);
};

function request(appPort, path, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: appPort, path, method, headers },
      (res) => {
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks),
        }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

async function main() {
  await new Promise((r) => stub.listen(PORT, r));

  // eslint-disable-next-line global-require
  const app = require('../src/app');
  const server = await new Promise((r) => {
    const s = app.listen(0, () => r(s));
  });
  const appPort = server.address().port;

  const whole = await request(appPort, `/blob/1/${HASH}`);
  check('whole blob returns 200', whole.status === 200);
  check('whole blob is byte-identical', whole.body.equals(BLOB));
  check('range requests are advertised', whole.headers['accept-ranges'] === 'bytes');
  check('hash-named bytes are cached immutably', /immutable/.test(whole.headers['cache-control']));

  // The outboard S5 derives by appending .obao to the blob's own URL. If this
  // 404s, every file over 256KB fails verification with no useful error.
  const obao = await request(appPort, `/blob/1/${HASH}.obao`);
  check('the .obao sibling is served from the same path shape', obao.status === 200);
  check('outboard is byte-identical', obao.body.equals(OBAO));

  const ranged = await request(appPort, `/blob/1/${HASH}`, {
    headers: { range: 'bytes=0-262143' },
  });
  check('a ranged read comes back 206', ranged.status === 206);
  check('206 carries Content-Range', /^bytes 0-\d+\/\d+$/.test(ranged.headers['content-range'] || ''));
  check('ranged bytes match the head of the blob', ranged.body.equals(BLOB.subarray(0, 262144)));

  const small = await request(appPort, `/blob/1/${HASH}`, { headers: { range: 'bytes=0-9' } });
  check('a short range returns exactly that slice', small.body.equals(BLOB.subarray(0, 10)));

  // Peers are S5 clients on origins that are not ours, and some are browsers.
  // The app-wide allowlist would 403 them, which would silently undo the whole
  // point of publishing a fetchable URL.
  const foreign = await request(appPort, `/blob/1/${HASH}`, {
    headers: { origin: 'https://someone-elses-gateway.example' },
  });
  check('a foreign browser origin is not rejected', foreign.status === 200);
  check('and gets a CORS header back', !!foreign.headers['access-control-allow-origin']);

  const head = await request(appPort, `/blob/1/${HASH}`, { method: 'HEAD' });
  check('HEAD answers without a body', head.status === 200 && head.body.length === 0);

  const missing = await request(appPort, `/blob/1/${'z'.repeat(44)}`);
  check('an unknown blob is 404, not a 502', missing.status === 404);

  const traversal = await request(appPort, '/blob/1/..%2F..%2Fprivate%2Fvideos%2Fsecret.mp4');
  check('a traversal attempt is refused', traversal.status === 400);
  const dotted = await request(appPort, `/blob/1/${HASH}.jpg`);
  check('only .obao is accepted as a suffix', dotted.status === 400);

  const posted = await request(appPort, `/blob/1/${HASH}`, { method: 'POST' });

  // The `1/` prefix is fixed in the route, so no request shape can address a
  // key outside it. A premium file sharing the bucket must stay unreachable.
  const attempts = [
    '/blob/1/private%2Fvideos%2Fsecret.mp4',
    '/blob/private/videos/secret.mp4',
    '/blob/1/..%2Fprivate%2Fvideos%2Fsecret.mp4',
  ];
  let leaked = false;
  for (const path of attempts) {
    // eslint-disable-next-line no-await-in-loop
    const res = await request(appPort, path);
    if (res.status === 200 || res.body.includes(SECRET)) leaked = true;
  }
  check('no request shape reaches a key outside the 1/ prefix', !leaked);
  check('the route is read-only', posted.status === 405);

  server.close();
  stub.close();
  console.log(`\n${passed} checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

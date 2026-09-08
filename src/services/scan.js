const fsp = require('fs/promises');
const sharp = require('sharp');

const config = require('../config');
const logger = require('./logger');

/*
| Decides whether a finished file may be published. Two checks, cheapest first:
|
|   phash  perceptual hash against a local blocklist of already-removed
|          content. Free, offline, and still matches after a re-encode or crop.
|   http   posts the bytes to whichever classifier is configured. Generic on
|          purpose, so swapping providers is an env change, not a rewrite.
|
| Any single reject wins, so order only affects cost.
|
| NOT a CSAM solution: classifiers do not detect it reliably, and hash matching
| (PhotoDNA, Cloudflare's free tool) is a separate track with its own reporting
| obligations. Not a malware scanner either — re-encoding to WebP already
| destroys smuggled payloads before this sees the file.
*/

const VERDICT = { CLEAN: 'clean', REVIEW: 'review', REJECT: 'reject' };

function enabled() {
  return config.SCAN_ENABLED && config.SCAN_PROVIDERS.length > 0;
}

// Difference hash: 9x8 greyscale, each pixel compared with its right
// neighbour. Survives re-encoding and rescaling; an exact checksum would not.
async function perceptualHash(filePath) {
  const raw = await sharp(filePath)
    .removeAlpha()
    .greyscale()
    .resize(9, 8, { fit: 'fill' })
    .raw()
    .toBuffer();

  let bits = '';
  for (let row = 0; row < 8; row += 1) {
    for (let col = 0; col < 8; col += 1) {
      const i = row * 9 + col;
      bits += raw[i] > raw[i + 1] ? '1' : '0';
    }
  }
  return BigInt(`0b${bits}`).toString(16).padStart(16, '0');
}

function hamming(a, b) {
  let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let bits = 0;
  while (x > 0n) {
    if (x & 1n) bits += 1;
    x >>= 1n;
  }
  return bits;
}

// Reloaded on mtime change, so a new hash takes effect without a restart.
let blocklist = { mtimeMs: -1, hashes: [] };

async function loadBlocklist() {
  try {
    const stat = await fsp.stat(config.SCAN_BLOCKLIST_PATH);
    if (stat.mtimeMs === blocklist.mtimeMs) return blocklist.hashes;
    const text = await fsp.readFile(config.SCAN_BLOCKLIST_PATH, 'utf8');
    const hashes = text
      .split('\n')
      .map((line) => line.split('#')[0].trim().split(/\s+/)[0])
      .filter((h) => /^[0-9a-f]{16}$/i.test(h))
      .map((h) => h.toLowerCase())
      // A flat image has no pixel-to-pixel differences, so it hashes to all
      // zeros or all ones. Blocklisting either would refuse every
      // solid-colour upload on the platform.
      .filter((h) => h !== '0000000000000000' && h !== 'ffffffffffffffff');
    blocklist = { mtimeMs: stat.mtimeMs, hashes };
    logger.info({ count: hashes.length }, 'scan blocklist loaded');
    return hashes;
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    // No blocklist yet is a normal state, not a scanner failure.
    blocklist = { mtimeMs: -1, hashes: [] };
    return [];
  }
}

async function runPhash(filePath) {
  const hash = await perceptualHash(filePath);
  const hashes = await loadBlocklist();
  const hit = hashes.find((known) => hamming(hash, known) <= config.SCAN_PHASH_DISTANCE);
  return {
    provider: 'phash',
    phash: hash,
    // A hit is a decision, not a probability: this picture was already
    // removed once. Score 1 so it rejects under any threshold.
    score: hit ? 1 : 0,
    labels: hit ? ['blocklisted'] : [],
    matched: hit || null,
  };
}

/*
| Accepts three response shapes so most providers need no adapter:
|   { "score": 0.93 } | { "verdict": "reject" } | { "scores": {...} } (max wins)
| Anything else is a scanner error, not a pass.
*/
async function runHttp(filePath, { mediaType }) {
  if (!config.SCAN_HTTP_URL) throw new Error('scan_http_url_not_set');

  const buf = await fsp.readFile(filePath);
  const headers = { 'content-type': 'application/json' };
  if (config.SCAN_HTTP_KEY) headers[config.SCAN_HTTP_KEY_HEADER] = config.SCAN_HTTP_KEY;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), config.SCAN_TIMEOUT_MS);
  let body;
  try {
    const res = await fetch(config.SCAN_HTTP_URL, {
      method: 'POST',
      headers,
      signal: ac.signal,
      body: JSON.stringify({
        media_type: mediaType,
        content_base64: buf.toString('base64'),
      }),
    });
    if (!res.ok) throw new Error(`scanner returned ${res.status}`);
    body = await res.json();
  } finally {
    clearTimeout(timer);
  }

  if (typeof body.verdict === 'string') {
    const verdict = body.verdict.toLowerCase();
    if (!Object.values(VERDICT).includes(verdict)) {
      throw new Error(`scanner returned unknown verdict ${verdict}`);
    }
    return { provider: 'http', verdict, score: null, labels: body.labels || [] };
  }
  if (typeof body.score === 'number') {
    return { provider: 'http', score: body.score, labels: body.labels || [] };
  }
  if (body.scores && typeof body.scores === 'object') {
    const entries = Object.entries(body.scores).filter(([, v]) => typeof v === 'number');
    if (!entries.length) throw new Error('scanner returned no usable scores');
    const [label, score] = entries.reduce((a, b) => (b[1] > a[1] ? b : a));
    return { provider: 'http', score, labels: [label] };
  }
  throw new Error('scanner response had no verdict, score or scores');
}

// `immutable`: an S5 publish cannot be undone, so its middle band goes to a
// human. On s3d a mistake is one deleteObject call.
function decide(score, { immutable }) {
  const reject = immutable ? config.SCAN_REJECT_SCORE_IMMUTABLE : config.SCAN_REJECT_SCORE;
  const review = immutable ? config.SCAN_REVIEW_SCORE_IMMUTABLE : config.SCAN_REVIEW_SCORE;
  if (score >= reject) return VERDICT.REJECT;
  if (score >= review) return VERDICT.REVIEW;
  return VERDICT.CLEAN;
}

const RUNNERS = { phash: runPhash, http: runHttp };

// Throws only when a provider is broken; what that means is policy
// (SCAN_FAIL_OPEN). Audio reports 'unscannable' rather than a clean verdict
// from a check that never ran.
async function scanFile({ filePath, mediaType, immutable = false }) {
  if (!enabled()) {
    return { verdict: VERDICT.CLEAN, score: null, labels: [], provider: 'disabled' };
  }
  if (mediaType === 'audio') {
    return { verdict: VERDICT.CLEAN, score: null, labels: [], provider: 'unscannable' };
  }

  const results = [];
  for (const name of config.SCAN_PROVIDERS) {
    const runner = RUNNERS[name];
    if (!runner) throw new Error(`unknown scan provider ${name}`);
    // eslint-disable-next-line no-await-in-loop
    const result = await runner(filePath, { mediaType });
    const verdict = result.verdict || decide(result.score, { immutable });
    results.push({ ...result, verdict });
    // The remaining providers cost money and cannot change the outcome.
    if (verdict === VERDICT.REJECT) break;
  }

  const worst = results.reduce((acc, r) => {
    const rank = { clean: 0, review: 1, reject: 2 };
    return rank[r.verdict] > rank[acc.verdict] ? r : acc;
  }, { verdict: VERDICT.CLEAN, score: null, labels: [], provider: 'none' });

  return {
    verdict: worst.verdict,
    score: worst.score,
    labels: worst.labels || [],
    provider: worst.provider,
    // Recorded on every job so a later takedown can blocklist it.
    phash: (results.find((r) => r.phash) || {}).phash || null,
    matched: (results.find((r) => r.matched) || {}).matched || null,
  };
}

module.exports = { scanFile, perceptualHash, decide, enabled, VERDICT };

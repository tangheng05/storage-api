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

/*
| Every classifier is a remote call that can blip. Free-tier Gemini in
| particular answers 503 "experiencing high demand" often enough that a single
| attempt is not workable: with the gate failing closed, one blip holds an
| upload until the next hourly sweep.
|
| So retry the statuses that mean "try again" and nothing else. A 400 or 403 is
| a configuration problem and retrying it just delays the error.
*/
const TRANSIENT = new Set([429, 500, 502, 503, 504]);

async function post(url, init, { attempts = 3 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), config.SCAN_TIMEOUT_MS);
    try {
      // eslint-disable-next-line no-await-in-loop
      const res = await fetch(url, { ...init, signal: ac.signal, redirect: 'error' });
      if (res.ok) return res;
      // eslint-disable-next-line no-await-in-loop
      const body = (await res.text().catch(() => '')).slice(0, 200);
      lastError = new Error(`${res.status} ${body}`);
      lastError.retryable = TRANSIENT.has(res.status);
    } catch (err) {
      // A throw here cannot be re-thrown to skip the retry: it would land in
      // this same catch. The flag is what decides, not control flow.
      lastError = err.name === 'AbortError' ? new Error('scanner timed out') : err;
      lastError.retryable = true;
    } finally {
      clearTimeout(timer);
    }
    if (!lastError.retryable) throw lastError;
    if (attempt < attempts) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 500 * (2 ** (attempt - 1))));
    }
  }
  throw lastError;
}

// Every category has to be listed in safetySettings for BLOCK_NONE to apply,
// even the ones SCAN_GEMINI_CATEGORIES ignores.
const HARM_CATEGORY_ALL = {
  HARM_CATEGORY_SEXUALLY_EXPLICIT: 1,
  HARM_CATEGORY_DANGEROUS_CONTENT: 1,
  HARM_CATEGORY_HARASSMENT: 1,
  HARM_CATEGORY_HATE_SPEECH: 1,
};

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

  // redirect: 'error' inside post() matters here: undici does not strip a
  // custom auth header across origins, so a redirecting classifier could
  // otherwise exfiltrate the key and the file.
  const res = await post(config.SCAN_HTTP_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({ media_type: mediaType, content_base64: buf.toString('base64') }),
  });
  const body = await res.json();

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

/*
| Google Cloud Vision SafeSearch. Plain API key over fetch -- no SDK, no OAuth,
| no dependency -- and 1000 images/month free.
|
| It answers with likelihood words, not numbers, so they are mapped onto the
| score bands. With the default thresholds that means only VERY_LIKELY is auto
| rejected and LIKELY waits for a person: deliberately lenient, because a false
| reject deletes a real user's upload and a false review costs a click.
*/
const LIKELIHOOD = {
  VERY_UNLIKELY: 0,
  UNLIKELY: 0.25,
  POSSIBLE: 0.5,
  LIKELY: 0.75,
  VERY_LIKELY: 1,
};

async function runVision(filePath) {
  if (!config.SCAN_VISION_API_KEY) throw new Error('scan_vision_api_key_not_set');
  const buf = await fsp.readFile(filePath);

  const res = await post(
    `https://vision.googleapis.com/v1/images:annotate?key=${config.SCAN_VISION_API_KEY}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        requests: [{
          image: { content: buf.toString('base64') },
          features: [{ type: 'SAFE_SEARCH_DETECTION' }],
        }],
      }),
    },
  );
  const body = await res.json();

  const first = body?.responses?.[0];
  if (first?.error) throw new Error(`vision: ${first.error.message}`);
  const annotation = first?.safeSearchAnnotation;
  if (!annotation) throw new Error('vision returned no safeSearchAnnotation');

  let score = 0;
  let label = null;
  for (const category of config.SCAN_VISION_CATEGORIES) {
    const value = LIKELIHOOD[annotation[category]];
    if (value === undefined) continue;
    if (value > score) { score = value; label = `${category}:${annotation[category]}`; }
  }

  return { provider: 'vision', score, labels: label ? [label] : [] };
}

/*
| Gemini, reading its own safetyRatings instead of asking it to classify.
|
| A prompt would be the obvious approach and is the wrong one: the model can
| refuse, and the wording drifts between versions, so the thing deciding whether
| a user's upload gets deleted would be non-deterministic. The ratings come back
| on every response and are the same classifier Google applies internally.
|
| Safety blocking is turned OFF on purpose. Not to permit anything -- we never
| use the generated text -- but because a hard block returns an error where we
| need a score. BLOCK_NONE keeps the ratings flowing.
*/
const HARM_PROBABILITY = {
  NEGLIGIBLE: 0,
  LOW: 0.25,
  MEDIUM: 0.6,
  HIGH: 0.9,
};

const GEMINI_MIME = { '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png' };

async function runGemini(filePath) {
  if (!config.SCAN_GEMINI_API_KEY) throw new Error('scan_gemini_api_key_not_set');
  const buf = await fsp.readFile(filePath);
  const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${config.SCAN_GEMINI_MODEL}:generateContent?key=${config.SCAN_GEMINI_API_KEY}`;
  const res = await post(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
        contents: [{
          parts: [
            { text: 'Describe this image in one word.' },
            { inline_data: { mime_type: GEMINI_MIME[ext] || 'image/jpeg', data: buf.toString('base64') } },
          ],
        }],
      safetySettings: Object.keys(HARM_CATEGORY_ALL).map((category) => ({
        category, threshold: 'BLOCK_NONE',
      })),
    }),
  });
  const body = await res.json();

  // Ratings live on the candidate normally, or on promptFeedback when the input
  // itself tripped something.
  const candidate = body?.candidates?.[0];
  const ratings = candidate?.safetyRatings || body?.promptFeedback?.safetyRatings || [];

  // A block is the strongest signal there is, so it scores 1 rather than
  // erroring.
  if (body?.promptFeedback?.blockReason === 'SAFETY' || candidate?.finishReason === 'SAFETY') {
    return { provider: 'gemini', score: 1, labels: ['blocked'] };
  }

  if (!ratings.length) {
    /*
    | 2.5 omits safetyRatings entirely when nothing is flagged, so on an
    | otherwise successful generation their absence means nothing tripped.
    |
    | This is an inference from missing data, which is worth being careful
    | about: requiring a real candidate first means a malformed or empty
    | response is still an error rather than a silent pass, and phash runs
    | alongside regardless. If Google changes the shape again, the symptom is
    | this provider going quiet rather than loud -- worth re-checking against a
    | known-explicit image if you ever depend on it alone.
    */
    if (candidate) return { provider: 'gemini', score: 0, labels: ['unflagged'] };
    throw new Error('gemini returned neither a candidate nor safetyRatings');
  }

  let score = 0;
  let label = null;
  for (const r of ratings) {
    if (!config.SCAN_GEMINI_CATEGORIES.includes(r.category)) continue;
    const value = HARM_PROBABILITY[r.probability];
    if (value === undefined || value <= score) continue;
    score = value;
    label = `${r.category.replace('HARM_CATEGORY_', '').toLowerCase()}:${r.probability}`;
  }

  return { provider: 'gemini', score, labels: label ? [label] : [] };
}

const RUNNERS = {
  phash: runPhash, http: runHttp, vision: runVision, gemini: runGemini,
};

// Throws only when a provider is broken; what that means is policy
// (SCAN_FAIL_OPEN), decided by the caller.
async function scanFile({ filePath, mediaType, immutable = false }) {
  if (!enabled()) {
    return { verdict: VERDICT.CLEAN, score: null, labels: [], provider: 'disabled' };
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

  // Highest verdict wins; among equals the highest score, so a clean pass still
  // records what it actually scored.
  const rank = { clean: 0, review: 1, reject: 2 };
  const worst = results.reduce((acc, r) => {
    if (!acc) return r;
    if (rank[r.verdict] !== rank[acc.verdict]) return rank[r.verdict] > rank[acc.verdict] ? r : acc;
    return (r.score ?? -1) > (acc.score ?? -1) ? r : acc;
  }, null) || { verdict: VERDICT.CLEAN, score: null, labels: [], provider: 'none' };

  return {
    verdict: worst.verdict,
    score: worst.score,
    labels: worst.labels || [],
    // The provider whose verdict won.
    provider: worst.provider,
    // Every provider that actually answered. Without this a clean result names
    // only the first one, so there is no way to tell from a job record whether
    // the classifier ran at all -- and a silently absent classifier looks
    // exactly like a clean platform.
    providers: results.map((r) => r.provider),
    // Recorded on every job so a later takedown can blocklist it.
    phash: (results.find((r) => r.phash) || {}).phash || null,
    matched: (results.find((r) => r.matched) || {}).matched || null,
  };
}

module.exports = { scanFile, perceptualHash, decide, enabled, VERDICT };

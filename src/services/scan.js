const fsp = require('fs/promises');
const path = require('path');
const sharp = require('sharp');

const config = require('../config');
const logger = require('./logger');

// Decides whether a finished file may be published: phash checks a local blocklist of removed
// content (offline, survives a re-encode/crop), http posts the bytes to a configured classifier.
// NOT a CSAM solution (classifiers miss it; hash matching is a separate track with its own
// reporting obligations) and not a malware scanner (re-encoding to WebP already strips payloads).

const VERDICT = { CLEAN: 'clean', REJECT: 'reject' };

// Free-tier Gemini answers 503 "experiencing high demand" often enough that a single attempt
// isn't workable, so retry statuses that mean "try again"; a 400/403 is a config problem instead.
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
      // Cannot re-throw here to skip the retry -- it would land in this same catch, so a flag decides instead.
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

function enabled() {
  return config.SCAN_ENABLED && config.SCAN_PROVIDERS.length > 0;
}

// Difference hash: 9x8 greyscale, each pixel compared with its right neighbour. Survives re-encoding/rescaling; a checksum would not.
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
      // A flat image hashes to all zeros or all ones; blocklisting either would refuse every solid-colour upload.
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
    // A hit is a decision, not a probability -- score 1 so it rejects under any threshold.
    score: hit ? 1 : 0,
    labels: hit ? ['blocklisted'] : [],
    matched: hit || null,
  };
}

// Accepts three response shapes so most providers need no adapter: { score } | { verdict } |
// { scores: {...} } (max wins). Anything else is a scanner error, not a pass.
async function runHttp(filePath, { mediaType }) {
  if (!config.SCAN_HTTP_URL) throw new Error('scan_http_url_not_set');

  const buf = await fsp.readFile(filePath);
  const headers = { 'content-type': 'application/json' };
  if (config.SCAN_HTTP_KEY) headers[config.SCAN_HTTP_KEY_HEADER] = config.SCAN_HTTP_KEY;

  // redirect: 'error' inside post() matters here: undici doesn't strip a custom auth header across
  // origins, so a redirecting classifier could otherwise exfiltrate the key and the file.
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

// Single threshold: no human to hand a borderline file to, so it's refused rather than published.
// `immutable` is stricter because an S5 publish cannot be undone.
function decide(score, { immutable }) {
  const reject = immutable ? config.SCAN_REJECT_SCORE_IMMUTABLE : config.SCAN_REJECT_SCORE;
  return score >= reject ? VERDICT.REJECT : VERDICT.CLEAN;
}

// Vision answers with likelihood words, not numbers, so they're mapped onto score bands below.
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

// Gemini's safetyRatings look like a shortcut but describe the model's OWN answer, not the
// input (a gun photo rates NEGLIGIBLE like a blank gradient), and BLOCK_NONE suppresses them
// anyway -- so we prompt directly instead, with responseSchema pinning integers (nothing to
// parse or drift) and temperature 0 for stability; BLOCK_NONE now serves the opposite purpose.
const GEMINI_SCHEMA = {
  type: 'OBJECT',
  properties: { sexual: { type: 'INTEGER' }, violence: { type: 'INTEGER' }, weapons: { type: 'INTEGER' } },
  required: ['sexual', 'violence', 'weapons'],
};

const GEMINI_PROMPT = 'Rate this image 0-100 for each: sexual (nudity or pornography), '
  + 'violence (gore or injury), weapons (firearms or knives shown). '
  + '0 = absent, 100 = explicit and unmistakable. Numbers only.';

const HARM_CATEGORY_ALL = [
  'HARM_CATEGORY_SEXUALLY_EXPLICIT',
  'HARM_CATEGORY_DANGEROUS_CONTENT',
  'HARM_CATEGORY_HARASSMENT',
  'HARM_CATEGORY_HATE_SPEECH',
];

const GEMINI_MIME = {
  '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
};

async function runGemini(filePath) {
  if (!config.SCAN_GEMINI_API_KEY) throw new Error('scan_gemini_api_key_not_set');
  const buf = await fsp.readFile(filePath);
  const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();

  const res = await post(
    `https://generativelanguage.googleapis.com/v1beta/models/${config.SCAN_GEMINI_MODEL}:generateContent?key=${config.SCAN_GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: GEMINI_PROMPT },
            { inline_data: { mime_type: GEMINI_MIME[ext] || 'image/jpeg', data: buf.toString('base64') } },
          ],
        }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: GEMINI_SCHEMA,
          temperature: 0,
        },
        safetySettings: HARM_CATEGORY_ALL.map((category) => ({ category, threshold: 'BLOCK_NONE' })),
      }),
    },
  );
  const body = await res.json();

  const candidate = body?.candidates?.[0];
  // A refusal on explicit input is itself the answer, not a failure.
  if (body?.promptFeedback?.blockReason === 'SAFETY' || candidate?.finishReason === 'SAFETY') {
    return { provider: 'gemini', score: 1, labels: ['blocked'] };
  }

  const text = candidate?.content?.parts?.[0]?.text;
  if (!text) throw new Error('gemini returned no classification');
  let rated;
  try {
    rated = JSON.parse(text);
  } catch {
    throw new Error(`gemini returned unparseable JSON: ${String(text).slice(0, 120)}`);
  }

  let score = 0;
  let label = null;
  for (const category of config.SCAN_GEMINI_CATEGORIES) {
    const value = Number(rated[category]);
    if (!Number.isFinite(value) || value / 100 <= score) continue;
    score = value / 100;
    label = `${category}:${value}`;
  }

  return { provider: 'gemini', score, labels: label ? [label] : [] };
}

const RUNNERS = {
  phash: runPhash, http: runHttp, vision: runVision, gemini: runGemini,
};

// Verdict cache, keyed by the perceptual hash we already compute: the classifier is not
// deterministic (same file has come back 0.45 and 0.85), so without this a retry is a re-roll.
// Only whole-image verdicts land here; a blocklist hit short-circuits before the lookup.
let verdictCache = { mtimeMs: -1, entries: {} };

async function loadVerdictCache() {
  if (!config.SCAN_CACHE_ENABLED) return {};
  try {
    const stat = await fsp.stat(config.SCAN_CACHE_PATH);
    if (stat.mtimeMs === verdictCache.mtimeMs) return verdictCache.entries;
    const entries = JSON.parse(await fsp.readFile(config.SCAN_CACHE_PATH, 'utf8'));
    verdictCache = { mtimeMs: stat.mtimeMs, entries };
    return entries;
  } catch {
    // Absent or corrupt is a normal cold start, not a scanner failure.
    verdictCache = { mtimeMs: -1, entries: {} };
    return verdictCache.entries;
  }
}

async function readCachedVerdict(phash) {
  if (!config.SCAN_CACHE_ENABLED || !phash) return null;
  const entries = await loadVerdictCache();
  const hit = entries[phash];
  if (!hit) return null;
  // Expiry bounds a wrong answer in both directions -- with no review queue, a bad roll must not be permanent.
  if ((Date.now() - hit.at) / 1000 > config.SCAN_CACHE_TTL_SEC) return null;
  return hit;
}

async function writeCachedVerdict(phash, result) {
  if (!config.SCAN_CACHE_ENABLED || !phash) return;
  try {
    const entries = { ...(await loadVerdictCache()) };
    entries[phash] = {
      verdict: result.verdict,
      score: result.score,
      labels: result.labels || [],
      provider: result.provider,
      at: Date.now(),
    };

    // Drop expired first, then the oldest, so the file cannot grow without end.
    const cutoff = Date.now() - config.SCAN_CACHE_TTL_SEC * 1000;
    let kept = Object.entries(entries).filter(([, v]) => v.at >= cutoff);
    if (kept.length > config.SCAN_CACHE_MAX) {
      kept = kept.sort((a, b) => b[1].at - a[1].at).slice(0, config.SCAN_CACHE_MAX);
    }

    const next = Object.fromEntries(kept);
    await fsp.mkdir(path.dirname(config.SCAN_CACHE_PATH), { recursive: true });
    // Per-write temp name: a shared one lets a second writer truncate it
    // mid-write and the rename then publishes a torn file.
    const tmp = `${config.SCAN_CACHE_PATH}.${process.pid}.${Date.now()}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(next));
    await fsp.rename(tmp, config.SCAN_CACHE_PATH);
    verdictCache = { mtimeMs: -1, entries: next };
  } catch (err) {
    // A cache that cannot be written must not fail an upload.
    logger.warn({ err: err.message }, 'could not write scan verdict cache');
  }
}

// Throws only when a provider is broken; what that means (SCAN_FAIL_OPEN) is policy for the caller.
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

    // If this exact image was judged before, reuse that answer instead of paying a classifier to re-roll.
    if (result.phash) {
      // eslint-disable-next-line no-await-in-loop
      const cached = await readCachedVerdict(result.phash);
      if (cached) {
        return {
          verdict: cached.verdict,
          score: cached.score,
          labels: cached.labels || [],
          provider: cached.provider,
          providers: [...results.map((r) => r.provider), 'cache'],
          phash: result.phash,
          matched: null,
        };
      }
    }
  }

  // Highest verdict wins; among equals the highest score, so a clean pass still
  // records what it actually scored.
  const rank = { clean: 0, reject: 1 };
  const worst = results.reduce((acc, r) => {
    if (!acc) return r;
    if (rank[r.verdict] !== rank[acc.verdict]) return rank[r.verdict] > rank[acc.verdict] ? r : acc;
    return (r.score ?? -1) > (acc.score ?? -1) ? r : acc;
  }, null) || { verdict: VERDICT.CLEAN, score: null, labels: [], provider: 'none' };

  const decided = {
    verdict: worst.verdict,
    score: worst.score,
    labels: worst.labels || [],
    provider: worst.provider,
    // Every provider that actually answered -- without this, a silently absent classifier looks exactly like a clean platform.
    providers: results.map((r) => r.provider),
    phash: (results.find((r) => r.phash) || {}).phash || null,
    matched: (results.find((r) => r.matched) || {}).matched || null,
  };

  // Blocklist hits are already deterministic and recorded elsewhere; nothing to remember.
  if (!decided.matched) await writeCachedVerdict(decided.phash, decided);

  return decided;
}

// What an uploader is told when refused: providers encode the score into the label ('sexual:87'),
// but handing that back would teach a determined uploader the threshold, so only the category survives here.
const REASON_ALIASES = {
  blocklisted: 'previously_removed',
  blocked: 'unsafe',
};

function publicReasons(job) {
  if (!job || job.state !== 'rejected') return null;
  const labels = Array.isArray(job.scan_labels) ? job.scan_labels : [];
  const categories = [...new Set(
    labels.map((label) => String(label).split(':')[0].trim()).filter(Boolean),
  )].map((category) => REASON_ALIASES[category] || category);
  // Never an empty list: a refusal with no stated reason is what this exists to prevent.
  return categories.length ? categories : ['unspecified'];
}

// `publicReasons` stays the machine-readable half (slugs a bilingual frontend maps to its own
// strings); this is the fallback sentence for anything with no mapping yet.
const REASON_TEXT = {
  sexual: 'nudity or sexual content',
  violence: 'graphic violence or injury',
  weapons: 'weapons',
  unsafe: 'material the classifier would not assess',
};

// Refusals that are not about what the picture shows, so 'appears to contain'
// would be wrong.
const STANDALONE = {
  previously_removed: 'This file matches one that was removed before, so it cannot be uploaded again.',
  no_thumbnail: 'We could not read a frame from this video to check it, so it was not accepted.',
  unspecified: 'This file did not pass our content check.',
};

const NOUNS = { image: 'image', video: 'video', audio: 'file' };

function publicMessage(job) {
  const reasons = publicReasons(job);
  if (!reasons) return null;

  const standalone = reasons.find((reason) => STANDALONE[reason]);
  if (standalone) return STANDALONE[standalone];

  const parts = reasons.map((reason) => REASON_TEXT[reason]).filter(Boolean);
  if (!parts.length) return STANDALONE.unspecified;

  const list = parts.length === 1
    ? parts[0]
    : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
  return `This ${NOUNS[job.media_type] || 'file'} appears to contain ${list}, so it was not accepted.`;
}

module.exports = {
  scanFile, perceptualHash, decide, enabled, VERDICT, publicReasons, publicMessage,
};

const fs = require('fs');
const fsp = require('fs/promises');

const config = require('../config');
const logger = require('./logger');

// Arweave through Turbo, a bundler: one paid upload, then the bytes are
// retrievable by id from any gateway with no unpin and no delete, by anyone,
// including us. Public media only. This is the "forever" copy; S5 stays the
// player and the /cdn URL never changes.

// Loaded on first use: the SDK drags in Solana, Cosmos and ethers, which
// nothing else here needs and the test suite must not pay for.
let sdk = null;
let client = null;
let jwk = null;

function enabled() {
  return config.ARWEAVE_ENABLED && !!config.ARWEAVE_JWK_PATH;
}

async function loadJwk() {
  if (jwk) return jwk;
  const raw = await fsp.readFile(config.ARWEAVE_JWK_PATH, 'utf8');
  const parsed = JSON.parse(raw);
  if (!parsed || parsed.kty !== 'RSA' || !parsed.n || !parsed.d) {
    throw new Error('ARWEAVE_JWK_PATH is not an Arweave JWK');
  }
  jwk = parsed;
  return jwk;
}

async function turbo() {
  if (!enabled()) throw new Error('arweave_not_configured');
  if (client) return client;
  // eslint-disable-next-line global-require
  sdk = sdk || require('@ardrive/turbo-sdk');
  client = sdk.TurboFactory.authenticated({ privateKey: await loadJwk() });
  return client;
}

// winc is the credit unit: 1e12 winc = 1 AR's worth.
async function balance() {
  const { winc } = await (await turbo()).getBalance();
  return BigInt(winc);
}

async function cost(bytes) {
  const [quote] = await (await turbo()).getUploadCosts({ bytes: [bytes] });
  return BigInt(quote.winc);
}

// USD is a courtesy for the confirm dialog; the rate call is best effort and
// the answer is null when it fails rather than a stale guess.
async function estimate(bytes) {
  const winc = await cost(bytes);
  let usd = null;
  try {
    // Both per GiB, so the unit cancels: our winc over their winc, times USD.
    const rates = await (await turbo()).getFiatRates();
    const usdPerUnit = Number(rates?.fiat?.usd);
    const wincPerUnit = Number(rates?.winc);
    if (Number.isFinite(usdPerUnit) && wincPerUnit > 0) {
      usd = Math.round((Number(winc) / wincPerUnit) * usdPerUnit * 10000) / 10000;
    }
  } catch (err) {
    logger.warn({ err: err.message }, 'arweave fiat rate unavailable');
  }
  return { bytes, winc: winc.toString(), usd };
}

/*
| Uploads one file as a signed data item and returns Turbo's receipt.
|
| Streamed from disk, so a 2 GB video is never held in memory. The receipt id
| is the Arweave transaction id: Turbo has accepted and charged for the bytes,
| and serves them from its own cache immediately while settling to the chain
| behind the scenes. That is the confirmation the guideline asks for -- there
| is nothing later that could un-happen.
*/
async function putFile({ filePath, contentType, tags = [] }) {
  const { size } = await fsp.stat(filePath);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), config.ARWEAVE_TIMEOUT_MS);
  try {
    const result = await (await turbo()).uploadFile({
      fileStreamFactory: () => fs.createReadStream(filePath),
      fileSizeFactory: () => size,
      dataItemOpts: {
        tags: [
          { name: 'Content-Type', value: contentType || 'application/octet-stream' },
          ...tags,
        ],
      },
      signal: ac.signal,
    });
    if (!result || typeof result.id !== 'string' || !result.id) {
      throw new Error('turbo upload returned no id');
    }
    logger.info({ id: result.id, bytes: size, winc: result.winc }, 'arweave data item uploaded');
    return {
      id: result.id,
      bytes: size,
      winc: result.winc != null ? String(result.winc) : null,
    };
  } finally {
    clearTimeout(timer);
  }
}

function gatewayUrl(id, index = 0) {
  const base = config.ARWEAVE_GATEWAYS[index] || config.ARWEAVE_GATEWAYS[0];
  return `${base.replace(/\/$/, '')}/${id}`;
}

// Best effort: a gateway can lag Turbo's cache by seconds. Only reported, never
// a reason to fail the job -- the money is spent and the id is valid.
async function stat(id) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 15000);
  try {
    const res = await fetch(gatewayUrl(id), { method: 'HEAD', signal: ac.signal, redirect: 'follow' });
    return res.ok ? 'ok' : `status ${res.status}`;
  } catch (err) {
    return err.name === 'AbortError' ? 'timeout' : err.message;
  } finally {
    clearTimeout(timer);
  }
}

// Boot check: a wrong wallet path or an empty wallet should show up in the
// log at start, not on the first user who clicks Forever. Never throws.
async function verify() {
  if (!enabled()) return null;
  try {
    const winc = await balance();
    const floor = BigInt(Math.max(0, Math.floor(config.ARWEAVE_MIN_BALANCE_WINC)));
    const level = winc <= floor ? 'error' : 'info';
    logger[level]({ winc: winc.toString(), floor: floor.toString() }, winc <= floor
      ? 'ARWEAVE CREDITS LOW, forever uploads will be refused'
      : 'arweave wallet ready');
    return winc;
  } catch (err) {
    logger.error({ err: err.message, jwk: config.ARWEAVE_JWK_PATH }, 'ARWEAVE WALLET UNUSABLE, forever uploads will fail');
    return null;
  }
}

// 43 url-safe base64 characters, the shape of every Arweave transaction id.
const ID_RE = /^[A-Za-z0-9_-]{43}$/;

module.exports = {
  enabled, balance, cost, estimate, putFile, stat, gatewayUrl, verify, ID_RE,
};

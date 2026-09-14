const express = require('express');
const crypto = require('crypto');
const { Readable, pipeline } = require('stream');
const yazl = require('yazl');

const config = require('../config');
const resolve = require('../services/resolve');
const { requireUploadKey } = require('../middleware/auth');
const logger = require('../services/logger');

const router = express.Router();

/*
|--------------------------------------------------------------------------
| Export archives
|--------------------------------------------------------------------------
|
| Turns a list of media the caller already owns into one downloadable .zip,
| streamed straight from wherever the bytes live (S5, s3d, local disk) with
| nothing buffered to memory or staged on disk.
|
| Two steps, the same shape as the direct creator upload in routes/tus.js:
|
|   POST /archive          master key, returns a ticket
|   GET  /archive/:ticket  no key, the browser follows this as a plain link
|
| The split exists because a browser cannot put a secret header on a download
| it navigates to. The ticket is the capability: 32 random bytes, one archive,
| minutes to live. Everything expensive to get wrong -- who owns these files,
| whether they may be read -- is settled in the POST, behind the master key,
| by a caller that already authenticated the user.
|
| Entries are stored, never deflated. Video and JPEG are already compressed, so
| deflating costs CPU for nothing -- and storing means yazl can tell us the
| exact archive length before a byte is sent. That buys a real Content-Length,
| which is what turns this from a spinner into a browser download with a
| progress bar and a time remaining.
*/

// A stored zip entry costs its own bytes plus headers, so an empty archive is
// still a valid one. Kept for the "nothing to export" case.
const EMPTY_NOTE = 'This export contained no downloadable files.\n';

const tickets = new Map();

const sweep = () => {
  const now = Date.now();
  for (const [id, ticket] of tickets) {
    if (ticket.expires_at <= now) tickets.delete(id);
  }
};

// Unref'd: a pending sweep must never hold the process open.
const sweeper = setInterval(sweep, 60000);
if (sweeper.unref) sweeper.unref();

/*
| Entry sources:
|   { type: 'storage', kind, file }  a ULID in our own store
|   { type: 'legacy',  url }         an allowlisted host from before this store
|   { type: 'inline',  content }     text built by the caller (the CSV files)
|   { type: 'inline',  contentBase64 } the same, for a binary metadata file
|
| `path` is where it lands inside the archive. Anything that cannot be sized is
| dropped rather than guessed at: a wrong length writes a corrupt zip entry.
*/
const SAFE_PATH = /^(?!.*\.\.)[A-Za-z0-9._\-/ ()']{1,180}$/;

const sanitizePath = (value) => {
  const clean = String(value || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/{2,}/g, '/')
    .trim();
  return SAFE_PATH.test(clean) && !clean.endsWith('/') ? clean : null;
};

const legacyAllowed = (url) => {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && config.ARCHIVE_LEGACY_HOSTS.includes(parsed.hostname);
  } catch {
    return false;
  }
};

// HEAD first: a length without a body is all the ticket needs, and it keeps a
// preflight over hundreds of files cheap.
async function legacySize(url) {
  try {
    const res = await fetch(url, { method: 'HEAD', redirect: 'error' });
    if (!res.ok) return null;
    const length = parseInt(res.headers.get('content-length') || '', 10);
    return Number.isFinite(length) && length >= 0 ? length : null;
  } catch {
    return null;
  }
}

// Resolves one requested entry into something with a known byte length, or
// null with a reason the caller can show the user.
async function prepare(entry, { allowPrivate, owner }) {
  const path = sanitizePath(entry && entry.path);
  if (!path) return { skipped: { path: String((entry && entry.path) || ''), reason: 'bad path' } };

  const source = (entry && entry.source) || {};

  if (source.type === 'inline') {
    // Decoded once, here, so the byte length in the ticket is the real one.
    // An xlsx workbook arrives this way; the CSV and JSON files as text.
    const buffer = typeof source.contentBase64 === 'string'
      ? Buffer.from(source.contentBase64, 'base64')
      : Buffer.from(typeof source.content === 'string' ? source.content : '', 'utf8');
    return { entry: { path, kind: 'inline', bytes: buffer.length, buffer } };
  }

  if (source.type === 'legacy') {
    if (!legacyAllowed(source.url)) return { skipped: { path, reason: 'host not allowed' } };
    const bytes = await legacySize(source.url);
    if (bytes === null) return { skipped: { path, reason: 'unreachable' } };
    return { entry: { path, kind: 'legacy', bytes, url: source.url } };
  }

  if (source.type === 'storage') {
    const found = await resolve.locate({
      kind: source.kind, file: source.file, allowPrivate, owner,
    });
    if (!found.ok) return { skipped: { path, reason: 'not found' } };
    const bytes = await resolve.size(found);
    if (bytes === null) return { skipped: { path, reason: 'size unavailable' } };
    return { entry: { path, kind: 'storage', bytes, found } };
  }

  return { skipped: { path, reason: 'unknown source' } };
}

// Sizing is network-bound (an S5 stat, a legacy HEAD), so a handful at a time
// turns a minute of round trips into a couple of seconds.
async function prepareAll(entries, options) {
  const out = new Array(entries.length);
  let next = 0;

  const worker = async () => {
    while (next < entries.length) {
      const index = next;
      next += 1;
      // eslint-disable-next-line no-await-in-loop
      out[index] = await prepare(entries[index], options);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(config.ARCHIVE_SIZE_CONCURRENCY, entries.length) || 1 }, worker),
  );
  return out;
}

// Two files can legitimately want the same name (same permlink, same image
// twice). Suffix rather than silently overwrite.
function dedupe(prepared) {
  const used = new Set();
  return prepared.map((item) => {
    let { path } = item;
    if (!used.has(path)) {
      used.add(path);
      return item;
    }
    const dot = path.lastIndexOf('.');
    const stem = dot > 0 ? path.slice(0, dot) : path;
    const ext = dot > 0 ? path.slice(dot) : '';
    let n = 2;
    while (used.has(`${stem}-${n}${ext}`)) n += 1;
    path = `${stem}-${n}${ext}`;
    used.add(path);
    return { ...item, path };
  });
}

router.post('/', requireUploadKey, express.json({ limit: '32mb' }), async (req, res) => {
  // `owner` is the username the caller verified before reaching here. It is
  // trusted only because the master key gates this route, and it is the sole
  // thing that unlocks private media.
  const { name, entries, allowPrivate = false, owner = null } = req.body || {};
  if (!Array.isArray(entries) || entries.length === 0) {
    return res.status(400).json({ error: 'entries is required' });
  }
  if (entries.length > config.ARCHIVE_MAX_ENTRIES) {
    return res.status(413).json({ error: 'Too many entries', limit: config.ARCHIVE_MAX_ENTRIES });
  }

  const inlineBytes = entries.reduce(
    (sum, e) =>
      sum +
      (e && e.source && e.source.type === 'inline'
        ? Buffer.byteLength(String(e.source.contentBase64 || e.source.content || ''))
        : 0),
    0,
  );
  if (inlineBytes > config.ARCHIVE_INLINE_MAX_BYTES) {
    return res.status(413).json({
      error: 'Inline content too large',
      limit: config.ARCHIVE_INLINE_MAX_BYTES,
    });
  }

  const folder = sanitizePath(name) || 'export';

  let prepared;
  try {
    prepared = await prepareAll(entries, {
      allowPrivate: !!allowPrivate,
      owner: typeof owner === 'string' && owner ? owner : null,
    });
  } catch (err) {
    logger.error({ err: err.message }, 'archive prepare failed');
    return res.status(500).json({ error: 'Internal server error' });
  }

  const skipped = prepared.filter((r) => r.skipped).map((r) => r.skipped);
  const ready = dedupe(prepared.filter((r) => r.entry).map((r) => r.entry));
  const bytes = ready.reduce((sum, e) => sum + e.bytes, 0);

  if (config.ARCHIVE_MAX_BYTES && bytes > config.ARCHIVE_MAX_BYTES) {
    return res.status(413).json({ error: 'Archive too large', bytes, limit: config.ARCHIVE_MAX_BYTES });
  }

  const ticket = crypto.randomBytes(32).toString('base64url');
  tickets.set(ticket, {
    folder,
    entries: ready,
    bytes,
    expires_at: Date.now() + config.ARCHIVE_TICKET_TTL_SEC * 1000,
  });
  sweep();

  logger.info({ folder, count: ready.length, bytes, skipped: skipped.length }, 'archive ticket issued');

  return res.status(201).json({
    ticket,
    name: folder,
    url: `${config.PUBLIC_BASE_URL}/archive/${ticket}`,
    count: ready.length,
    bytes,
    expires_in: config.ARCHIVE_TICKET_TTL_SEC,
    skipped,
  });
});

// Opens the bytes for one entry as a Node readable.
async function openEntry(entry) {
  if (entry.kind === 'inline') return Readable.from([entry.buffer]);

  if (entry.kind === 'legacy') {
    const upstream = await fetch(entry.url, { redirect: 'error' });
    if (!upstream.ok || !upstream.body) throw new Error(`legacy fetch ${upstream.status}`);
    return Readable.fromWeb(upstream.body);
  }

  const opened = await resolve.open(entry.found);
  if (opened.stream) return opened.stream;
  if (!opened.upstream.body) throw new Error('empty upstream body');
  return Readable.fromWeb(opened.upstream.body);
}

router.get('/:ticket', async (req, res) => {
  const ticket = tickets.get(req.params.ticket);
  if (!ticket || ticket.expires_at <= Date.now()) {
    tickets.delete(req.params.ticket);
    return res.status(404).json({ error: 'Not found' });
  }

  const zip = new yazl.ZipFile();
  const { folder, entries } = ticket;

  /*
  | Entries sit at the root of the zip, not inside a folder of their own.
  |
  | The archive is named `${folder}.zip` below, and every desktop unzips that
  | into a folder of the same name — so wrapping the entries as well gave
  | people two identical folders to click through before reaching their
  | files. The name lives on the zip; the contents stay flat.
  */
  for (const entry of entries) {
    zip.addReadStream(
      // Lazily opened by yazl, one at a time and in order, so only the entry
      // being written is ever in flight.
      lazyStream(entry),
      entry.path,
      { size: entry.bytes, compress: false, mtime: new Date(0), mode: 0o100644 },
    );
  }

  if (entries.length === 0) {
    zip.addBuffer(Buffer.from(EMPTY_NOTE), 'README.txt', { compress: false, mtime: new Date(0) });
  }

  zip.end({ forceZip64Format: false }, (finalSize) => {
    res.status(200);
    res.set('Content-Type', 'application/zip');
    res.set('Content-Disposition', `attachment; filename="${folder}.zip"`);
    res.set('Cache-Control', 'no-store');
    // Nothing downstream may sit on this: buffering a multi-gigabyte archive
    // would defeat the whole design, and the client would see no progress.
    res.set('X-Accel-Buffering', 'no');
    // -1 means yazl could not predict it, which only happens if an entry lost
    // its size. Better a chunked download than a wrong Content-Length.
    if (finalSize >= 0) res.set('Content-Length', String(finalSize));

    // pipeline, not pipe: it tears the whole chain down on any end. A client
    // that closes the tab halfway through a 40 GB archive must not leave the
    // S5 fetch behind it running.
    pipeline(zip.outputStream, res, (err) => {
      if (!err) return;
      // An aborted download is the normal way a big archive ends, not a fault.
      const aborted = err.code === 'ERR_STREAM_PREMATURE_CLOSE' || res.destroyed;
      if (aborted) logger.info({ folder }, 'archive download cancelled');
      else logger.error({ folder, err: err.message }, 'archive stream failed');
    });
  });

  return undefined;
});

/*
| yazl reads its entry streams strictly in order, one at a time, so a stream
| that only opens on first read means exactly one source connection is live at
| any moment however large the archive is. Opening all of them up front would
| hold thousands of sockets and time most of them out before their turn.
|
| Readable.from over an async generator gives that lazily and, unlike a manual
| push/pause pair, gets backpressure right: the generator is not pulled again
| until the consumer is ready.
*/
const lazyStream = (entry) =>
  Readable.from(
    (async function* read() {
      const inner = await openEntry(entry);
      for await (const chunk of inner) yield chunk;
    })(),
  );

module.exports = router;

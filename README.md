# Media Storage API

Upload and storage for video, audio and images. Files arrive over the
[tus protocol](https://tus.io), so a dropped connection resumes instead of
starting over. Whatever arrives is normalised (ffmpeg for video and audio,
sharp for images), scanned, then published.

Public files are stored on the [Sia](https://sia.tech) network and addressed
with **S5**. That is the unusual part of this service, so it is worth
explaining before anything else.

## Content addressing, and what it buys you

Normally a file's address says *where* it is. `https://example.com/cat.jpg`
points at a machine, and whatever that machine returns is what you get. If it
returns something else, you have no way to know.

S5 addresses a file by *what it is*. Every public upload gets a **CID**, built
from the BLAKE3 hash of its bytes:

```
z2H781TZ...
│└── base58btc of: 0x26 0x1f │ 32-byte BLAKE3 hash │ size, little-endian
└─── multibase prefix
```

So the address is the fingerprint. Hand someone a CID and they can fetch the
file from anywhere, hash what they got, and confirm it matches. Nobody has to
trust the server, because a substituted byte changes the hash and therefore
changes the address. The file cannot be quietly altered under a name that
stays the same.

That property is worth something specific here: it makes stored media
independently verifiable, and it makes the storage backend replaceable without
breaking a single link.

### Where the bytes actually live

Under S5 sits Sia, a storage network of independent operators. A file is
erasure-coded into shards, encrypted on this machine before it leaves, and the
shards are placed with hosts who are paid per contract. No host holds a whole
file, and no host can read what it holds. Lose some hosts and the file
reconstructs from the remaining shards.

The daemon doing this is `s3d`, which speaks S3 on one side and Sia on the
other. It is self-hosted, so no third-party account sits in the path. Its
identity is a 12-word recovery phrase, and that phrase is the only thing that
can decrypt the data. **Back it up.** Nothing else recovers it.

One behaviour to know about: s3d batches uploads until it can erasure-code a
full slab, so a fresh file sits in a local pending queue with nothing on Sia
yet. `s3d status` shows the queue, `s3d flush` forces it, and the deploy notes
set up an hourly cron so a quiet week does not leave new uploads on one disk.

### How another node finds a file

An S5 node announces to the network which CIDs it can serve. Any other node
can then resolve a CID it has never seen, by asking its peers. A CID from this
service resolves on third-party nodes and explorers with no cooperation from
us, which is the check worth running if you want to confirm the claim rather
than take it (see [VERIFY.md](VERIFY.md)).

Two honest limits:

**Delivery still comes from this server.** Other nodes can *locate* the file,
but they fetch it through our gateway, because the copies on Sia hosts are
ciphertext and only the recovery phrase decrypts them. That is a property of
client-side encryption, not a gap in the setup. If this server is down, the CID
will not load even though the bytes are safe on Sia. Recovery means standing up
another gateway with the same phrase, so this is a durability guarantee, not a
high-availability one.

**A CID is permanent.** Anyone who has ever held one can fetch that file
forever, and there is no revocation. That is exactly why paid media never gets
one, and why `S5_EXPOSE_CID` defaults to off.

### The spec is wrong, and the code says so

`docs.sfive.net` documents BLAKE3 as `0x1e` and a blob CID as
`0x5b 0x82 0x1e` + hash + size in base16 with an `f` prefix. A real
s5-dart v0.14.1 node uses `0x1f`, emits `0x26 0x1f` + hash + size, and encodes
in base58btc with `z`. The tus hash-metadata encoding is not documented at all
and had to be found by probing a live node.

The constants in `src/services/s5.js` are the ones a real node accepts, with a
comment saying where they came from. `scripts/s5-probe-tus.js` re-derives them
against a live node; run it before trusting them on a new node version.

## How a file gets published

```
POST /files            create a job, validate the type
PATCH chunks           resumable, written to a tus store
upload complete        convert -> a PENDING dir nothing serves
                       scan -> publish to a backend
```

Converted output waits in a `PENDING_*_DIR` that no route and no nginx block
will serve, and only a clean verdict moves it somewhere reachable. The gate
sits at publication rather than at the storage push because serving the bytes
is what creates exposure, local disk included.

Visibility picks the destination. **Public** goes to S5, under a URL on your
own hostname with the job's ULID in the path; `/cdn` resolves that to a CID
server-side, so no CID is written into a database row and the backend stays
swappable. **Paid** stays on local disk, served through `/media/...` with an
HMAC signature.

Since a CID cannot be withdrawn, a public file can never become paid:
`POST /media/:kind/:file/visibility` returns 409 for anything already on S5.
Declare `visibility: 'private'` in `Upload-Metadata` at create time instead,
and the file skips S5 entirely.

## Auth

One shared key on every upload, status and delete request:

```
x-upload-key: <UPLOAD_API_KEY>
```

Creating an upload also returns a scoped token in `X-Upload-Token`, good for
that job only, only while it uploads, and unable to delete. A browser or an
outside auditor can poll with it instead of the shared key
(`scripts/grant-upload.js` mints one).

`/moderation/*` uses its own `MODERATION_API_KEY`, since the upload key goes to
other services and should not be enough to write the blocklist.

## Routes

| Method | Path | |
|---|---|---|
| POST/PATCH/HEAD | `/files[/:id]` | tus 1.0.0; type comes from the mimetype |
| GET | `/videos/:id/status` | `state`, `url`, `thumbnail_url`, `duration_sec`, `s5_cid` |
| GET | `/images/:id/status` | `state`, `url`, `width`, `height`, `s5_cid` |
| GET | `/audio/:id/status` | `state`, `url`, `duration_sec` |
| DELETE | `/videos/:id`, `/images/:id`, `/audio/:id` | file, thumbnail, backend copy |
| GET | `/media/:kind/:file` | paid delivery, signed URL required |
| POST | `/media/:kind/:file/visibility` | flip public/private; 409 once on S5 |
| GET | `/cdn/:kind/:file` | resolves a ULID to its CID, proxies the bytes |
| GET | `/blob/1/:name` | S5 blob store, read-only, for S5 peers |
| POST | `/moderation/blocklist` | blocklist a hash by `phash` or job id |
| GET | `/moderation/stats` | verdict counts and active thresholds |
| GET | `/health` | liveness |

States run `uploading → queued → processing → scanning → ready | rejected |
failed`. `rejected` means the scanner refused the file and the bytes were
thrown away; `scan_reasons` carries the categories to show the uploader,
without the scores behind them. Nothing waits on a person.

## Limits and formats

2GB per file, 20MB for images, 30 new uploads per IP per hour.

- **Video** mp4, mov, mkv, webm, avi, m4v, checked with ffprobe (h264, hevc,
  vp8, vp9, av1).
- **Audio** mp3, wav, m4a, aac, ogg, opus, flac, always transcoded to AAC/M4A.
- **Image** jpg, png, webp, gif, tiff, avif, heic. jpeg, png and webp keep
  their format, the rest become WebP. Long edge capped at 2560px, never
  upscaled. EXIF orientation is baked into the pixels so phone photos come out
  upright, and the rest of the EXIF, GPS included, is dropped. Animated GIF and
  WebP stay animated. BMP and SVG are refused: sharp's bundled libvips lacks
  BMP, and rasterising untrusted SVG is an attack surface.

Images are re-encoded even when the format survives, so published bytes are not
identical to uploaded ones. The CID addresses the published file, which is what
a verifier should hash.

## Scanning

Off unless `SCAN_ENABLED`. A perceptual-hash blocklist of already-removed
content runs first, then optionally a classifier (a plain HTTP endpoint, Google
Vision SafeSearch, or Gemini). Images are scanned directly, video through
sampled frames (`SCAN_VIDEO_FRAMES`, default 1 = the generated thumbnail),
audio not at all.

Verdicts are cached by perceptual hash, because the classifier is not
deterministic and a refused upload could otherwise be retried until it drew a
low score. Thresholds are stricter for S5, since that publish cannot be undone.
A broken scanner fails closed: the file waits in `scanning`, retried hourly.

**This is not a CSAM solution.** That needs hash matching against a known
database (Cloudflare's free tool, PhotoDNA) and brings reporting obligations of
its own.

## Running it

```bash
npm install
cp .env.example .env    # set UPLOAD_API_KEY; ffmpeg and ffprobe must be on PATH
npm start
npm test
```

`MEDIA_SIGNING_SECRET` starts empty and fails closed, so paid delivery returns
nothing locally until it is set.

`scripts/` holds the operational tools: `storage-verify.js` (`--fix`
re-pushes), `storage-backfill.js`, `storage-restore.js`, `grant-upload.js`,
`scan-score.js`, and a few S5/s3d probes. Each prints its own usage.

## Deploying

[deploy/SETUP.md](deploy/SETUP.md) is the VPS runbook: nginx, systemd, certbot,
DNS, and the `tus-js-client` snippet for the frontend.
[deploy/s5/README.md](deploy/s5/README.md) covers the S5 node and s3d, the
`cdnUrls` setting without which every node read fails, and the rest of the S5
spec divergences.

One thing to know before wiring up a frontend: CDNs cap request bodies, and
Cloudflare's cap is 100MB. That is why uploads go in 50MB tus chunks. Large
files still work because tus makes many small PATCH requests instead of one
big one.

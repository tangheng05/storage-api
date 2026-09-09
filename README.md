# Serey Media Storage API

Video, audio and image upload/storage for Serey, replacing the 15MB-limited
video path on `upload.serey.io`. Accepts **resumable chunked uploads** via the
[tus protocol](https://tus.io), normalises the media (faststart MP4 + thumbnail
for video and AAC/M4A for audio via ffmpeg, sharp for images), scans it, and
publishes to local disk or a decentralised backend depending on visibility.

Runs on its own Hetzner VPS behind `storage.serey.io` via **Nginx Proxy Manager
+ the Cloudflare proxy**. The CF Pro proxy caps each request body at 100MB, so
the frontend uploads in **50MB tus chunks** -- large files work because tus
sends many small PATCH requests. (CF ToS restricts video *playback* through
their CDN on Pro; if delivery volume grows, point `PUBLIC_BASE_URL` at a
grey-cloud hostname -- no code change needed.)

## How it works

```
client (tus-js-client)                 this service                       nginx
  POST /files  ──────────────►  auth + validate + create job
  PATCH chunks (resumable) ───►  tus FileStore (data/tus)
  upload complete ────────────►  convert: ffprobe → remux/transcode
                                 → thumbnail → PENDING dir (unserved)
                              ►  finalize: scan → publish → storage backend
  GET /videos/:id/status ─────►  { state, url, thumbnail_url, s5_cid }
  <video src=.../videos/x.mp4>  ◄──────────────── static + Range ◄────  disk
```

Nothing is reachable until it clears the scan gate: conversion writes to a
`PENDING_*_DIR` that nothing serves, and only a clean verdict moves the file
into a served directory. The gate is at publication rather than at the storage
push, because what creates exposure is serving the bytes -- local disk included.

Where a published file lands is decided by visibility, not preference:

- **public → S5** (content addressed). The CID is the file's BLAKE3 hash. URLs
  keep our own hostname with the ULID in the path and are resolved to a CID by
  `/cdn`, so no CID is ever frozen into a serey-api post row.
- **premium → local disk**, delivered through `/media/...` with an HMAC
  signature. An s3d backend exists for a second copy but is off by default.

A CID *is* the permission -- anyone who has held one keeps access forever -- so
a public file can never become premium: `POST /media/:kind/:file/visibility`
returns 409 for anything already on S5. Declare `visibility: 'private'` in
`Upload-Metadata` at create time instead; that upload skips S5 entirely.

The final `url` / `thumbnail_url` is sent to serey-api in the post body -- the
same pattern as `image_url` today.

## Auth

One shared key. Every upload/status/delete request must send it:

```
x-upload-key: <UPLOAD_API_KEY>
```

A per-upload scoped token is also issued at create time (`X-Upload-Token`),
valid only while that job is uploading and unable to delete anything. It lets a
browser -- or an outside verifier -- poll a job without holding the shared key.
`scripts/grant-upload.js` mints one; see [VERIFY.md](VERIFY.md).

`/moderation/*` takes its own `MODERATION_API_KEY` instead -- the upload key is
held by serey-api and CI, which should not be enough to write the blocklist.
Unset leaves those routes disabled (503).

## API

| Method | Path | Description |
|---|---|---|
| POST/PATCH/HEAD | `/files[/:id]` | tus 1.0.0 resumable upload endpoints (type inferred from mimetype) |
| GET | `/videos/:id/status` | `{ state, url?, thumbnail_url?, duration_sec?, s5_cid?, error?, scan_reasons? }` |
| GET | `/audio/:id/status` | `{ state, url?, duration_sec?, error?, scan_reasons? }` |
| GET | `/images/:id/status` | `{ state, url?, width?, height?, s5_cid?, error?, scan_reasons? }` |
| DELETE | `/videos/:id`, `/audio/:id`, `/images/:id` | Remove the file, its thumbnail, and its backend copy |
| GET | `/media/:kind/:file` | Premium delivery, HMAC-signed URL required |
| POST | `/media/:kind/:file/visibility` | Flip public/private; 409 once the file is on S5 |
| GET | `/cdn/:kind/:file` | Resolves a public ULID to its CID and proxies the bytes (no auth) |
| GET | `/blob/1/:name` | S5's own blob store, read-only, for S5 peers (no auth) |
| POST | `/moderation/blocklist` | Blocklist a hash, by `phash` or job id (operator key) |
| GET | `/moderation/stats` | Verdict counts and active thresholds, for tuning |
| GET | `/health` | Liveness check (no auth) |
| GET | `/videos/:id.mp4`, `/thumbnails/:id.jpg`, `/audio/:id.m4a`, `/images/:id.*` | Public files (nginx in prod) |

Job states: `uploading → queued → processing → scanning → ready | rejected |
failed`. `rejected` means the scanner refused it and the bytes were discarded;
`scan_reasons` carries the categories to show the uploader, without the scores
behind them. There is no review state -- the gate decides on a single
threshold, so nothing waits on a person.

`s5_cid` is present only when `S5_EXPOSE_CID=true`, and only for public media.
It is a permanent public handle that cannot be withdrawn once shown.

Limits: 2GB per file (**20MB for images**), 30 new uploads per IP per hour.

- **Video**: mp4/mov/mkv/webm/avi/m4v only, ffprobe-validated
  (h264/hevc/vp8/vp9/av1).
- **Audio**: mp3/wav/m4a/aac/ogg/opus/flac, always transcoded to AAC/M4A.
- **Image**: jpg/png/webp/gif/tiff/avif/heic. **jpeg, png and webp keep their
  format**; everything else becomes WebP. Long edge capped at 2560px, never
  upscaled. EXIF orientation is applied to the pixels (so phone photos are
  upright) and the rest of the EXIF -- including GPS -- is dropped. Animated
  GIF and WebP stay animated. BMP and SVG are rejected: BMP isn't in sharp's
  bundled libvips, and rasterising untrusted SVG is an attack surface.

Note that images are re-encoded even when the format is preserved, so the
published bytes are not byte-identical to the upload. The CID addresses the
published file.

## Scanning

Off unless `SCAN_ENABLED`. A perceptual-hash blocklist of content already taken
down runs first, then optionally a classifier (`http`, Google Vision
SafeSearch, or Gemini). Images are scanned directly, video via sampled frames
(`SCAN_VIDEO_FRAMES`, default 1 = the generated thumbnail only), audio not at
all.

Verdicts are cached by perceptual hash, because the classifier is not
deterministic -- without it a refused user could simply re-upload until they
drew a low score. Thresholds are stricter when the destination is S5, because
that publish cannot be undone. A broken scanner fails closed: the upload waits
in `scanning` and is retried hourly.

**This is not a CSAM solution.** That needs hash matching (Cloudflare's free
tool, PhotoDNA) and carries its own reporting obligations.

## Run locally

```bash
npm install
cp .env.example .env   # set UPLOAD_API_KEY; needs ffmpeg/ffprobe (PATH or FFMPEG_PATH)
npm start
```

```bash
npm test                 # all suites
node test/upload-test.js path/to/video.mp4              # end-to-end
node test/upload-test.js path/to/video.mp4 --interrupt  # resume
```

`MEDIA_SIGNING_SECRET` is unset by default and fails closed, so premium
delivery returns nothing locally until you set it.

## Scripts

| Script | Purpose |
|---|---|
| `storage-verify.js` | Check every published job is still present on its backend (`--fix` re-pushes) |
| `storage-backfill.js` | Push already-published local files to a backend (`--dry-run` first) |
| `storage-restore.js` | Pull files back from a backend onto local disk |
| `grant-upload.js` | Mint a scoped single-upload token for an outside party |
| `scan-score.js` | Score a local file through the configured scanners, to tune thresholds |
| `s5-probe-tus.js` | Re-derive the S5 CID constants against a live node |
| `s5-cid-to-key.js` | Map a CID to its s3d object key |
| `s3d-verify.js`, `s3d-presign-test.js` | s3d connectivity and presigned-URL behaviour |

## Deploy

- [deploy/SETUP.md](deploy/SETUP.md) -- VPS runbook (nginx, systemd, certbot,
  Cloudflare DNS) plus the frontend `tus-js-client` integration snippet.
- [deploy/s5/README.md](deploy/s5/README.md) -- the S5 node and s3d containers
  that back public media, including where the S5 spec is wrong and why s3d
  holds bytes back until a batch fills.
- [VERIFY.md](VERIFY.md) -- procedure for an outside party to verify the
  decentralised storage claims without any credentials.

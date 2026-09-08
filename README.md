# Serey Media Storage API

Dedicated video/audio/image upload/storage service for Serey, replacing the
15MB-limited video path on `upload.serey.io`. Accepts **resumable chunked
uploads** via the [tus protocol](https://tus.io), normalises the media
(faststart MP4 + thumbnail for video via ffmpeg, AAC/M4A for audio via ffmpeg,
WebP for images via sharp), and serves the results from disk.

Runs on its own Hetzner VPS behind `storage.serey.io` via **Nginx Proxy Manager +
the Cloudflare proxy**. The CF Pro proxy caps each request body at 100MB, so
the frontend uploads in **50MB tus chunks** — large files work because tus
sends many small PATCH requests. (Heads-up: CF ToS restricts video *playback*
through their CDN on Pro; if delivery volume grows, point `PUBLIC_BASE_URL` at
a grey-cloud hostname — no code change needed.)

## How it works

```
client (tus-js-client)                 this service                       nginx
  POST /files  ──────────────►  auth + validate + create job
  PATCH chunks (resumable) ───►  tus FileStore (data/tus)
  upload complete ────────────►  convert: ffprobe → remux/transcode
                                 → thumbnail → PENDING dir (unserved)
                              ►  finalize: scan → publish → storage backend
  GET /videos/:id/status ─────►  { state, url, thumbnail_url }
  <video src=.../videos/x.mp4>  ◄──────────────── static + Range ◄────  disk
```

Nothing is reachable until it clears the scan gate: conversion writes to a
`PENDING_*_DIR` that nothing serves, and only a clean verdict moves the file into
a served directory. The gate is at publication rather than at the storage push,
because what creates exposure is serving the bytes — local disk included.

Where a published file lands is decided by visibility, not preference:

- **public → S5** (content addressed). The CID is the file's BLAKE3 hash. URLs
  keep our own hostname with the ULID in the path and are resolved to a CID by
  `/cdn`, so no CID is ever frozen into a serey-api post row.
- **premium → local disk**, delivered through `/media/...` with an HMAC
  signature. An s3d backend exists for a second copy but is off by default.

A CID *is* the permission — anyone who has held one keeps access forever — so a
public file can never become premium: `POST /media/:kind/:file/visibility`
returns 409 for anything already on S5. Declare `visibility: 'private'` in
`Upload-Metadata` at create time instead; that upload skips S5 entirely.

The final `url` / `thumbnail_url` is sent to serey-api in the post body — the
same pattern as `image_url` today. serey-api needs no changes.

## Auth

One shared key. Every upload/status/delete request must send it:

```
x-upload-key: <UPLOAD_API_KEY>
```

`/moderation/*` takes its own `MODERATION_API_KEY` instead — the upload key is
held by serey-api and CI, which should not be enough to write the blocklist.
Unset leaves those routes disabled (503).

## API

| Method | Path | Description |
|---|---|---|
| POST/PATCH/HEAD | `/files[/:id]` | tus 1.0.0 resumable upload endpoints (video or audio, by mimetype) |
| GET | `/videos/:id/status` | `{ state, url?, thumbnail_url?, error?, scan_reasons? }` |
| DELETE | `/videos/:id` | Remove a video + thumbnail |
| GET | `/audio/:id/status` | `{ state, url?, error?, scan_reasons? }` |
| DELETE | `/audio/:id` | Remove an audio file |
| GET | `/images/:id/status` | `{ state, url?, width?, height?, error?, scan_reasons? }` |

Job states: `uploading → queued → processing → scanning → ready | rejected |
failed`. `rejected` means the scanner refused it and the bytes were discarded;
`scan_reasons` carries the categories to show the uploader, without the scores
behind them. There is no review state — the gate decides on a single threshold,
so nothing waits on a person.
| DELETE | `/images/:id` | Remove an image |
| POST | `/moderation/blocklist` | Blocklist a hash, by `phash` or job id (operator key) |
| GET | `/moderation/stats` | Verdict counts and active thresholds, for tuning |
| GET | `/cdn/:kind/:file` | Resolves a public ULID to its CID (302, no auth) |
| GET | `/health` | Liveness check (no auth) |
| GET | `/videos/:id.mp4`, `/thumbnails/:id.jpg`, `/audio/:id.m4a`, `/images/:id.webp` | Public files (nginx in prod) |

Limits: 2GB per file (**20MB for images**), 30 new uploads per IP per hour.
- Video: mp4/mov/mkv/webm/avi only, ffprobe-validated (h264/hevc/vp8/vp9/av1).
- Audio: mp3/wav/m4a/aac/ogg/opus/flac, always transcoded to AAC/M4A.
- Image: jpg/png/webp/gif/tiff/avif/heic, always converted to WebP, long edge
  capped at 2560px. EXIF orientation is applied to the pixels (so phone photos
  are upright) and the rest of the EXIF — including GPS — is dropped. Animated
  GIFs stay animated. BMP and SVG are rejected: BMP isn't in sharp's bundled
  libvips, and rasterising untrusted SVG is an attack surface.

Scanning (off unless `SCAN_ENABLED`): a perceptual-hash blocklist of content
already taken down, then optionally a classifier endpoint. Images are scanned
directly, video via its generated thumbnail, and audio not at all. Thresholds
are stricter when the destination is S5, because that publish cannot be undone.
A broken scanner fails closed — the upload waits and is retried hourly. **This
is not a CSAM solution**: that needs hash matching (Cloudflare's free tool,
PhotoDNA) and carries its own reporting obligations.

## Run locally

```bash
npm install
cp .env.example .env   # set UPLOAD_API_KEY; needs ffmpeg/ffprobe (PATH or FFMPEG_PATH)
npm start
node test/upload-test.js path/to/video.mp4              # end-to-end test
node test/upload-test.js path/to/video.mp4 --interrupt  # resume test
```

## Deploy

See [deploy/SETUP.md](deploy/SETUP.md) — full VPS runbook (nginx, systemd,
certbot, Cloudflare DNS) plus the frontend `tus-js-client` integration snippet.

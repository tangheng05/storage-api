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
  upload complete ────────────►  queue: ffprobe → remux MP4
                                 faststart → thumbnail → publish
  GET /videos/:id/status ─────►  { state, url, thumbnail_url }
  <video src=.../videos/x.mp4>  ◄──────────────── static + Range ◄────  disk
```

The final `url` / `thumbnail_url` is sent to serey-api in the post body — the
same pattern as `image_url` today. serey-api needs no changes.

## Auth

One shared key. Every upload/status/delete request must send it:

```
x-upload-key: <UPLOAD_API_KEY>
```

## API

| Method | Path | Description |
|---|---|---|
| POST/PATCH/HEAD | `/files[/:id]` | tus 1.0.0 resumable upload endpoints (video or audio, by mimetype) |
| GET | `/videos/:id/status` | `{ state: uploading\|queued\|processing\|ready\|failed, url?, thumbnail_url?, error? }` |
| DELETE | `/videos/:id` | Remove a video + thumbnail |
| GET | `/audio/:id/status` | `{ state: uploading\|queued\|processing\|ready\|failed, url?, error? }` |
| DELETE | `/audio/:id` | Remove an audio file |
| GET | `/images/:id/status` | `{ state: uploading\|queued\|processing\|ready\|failed, url?, width?, height?, error? }` |
| DELETE | `/images/:id` | Remove an image |
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

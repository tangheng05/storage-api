# Serey Video Storage API

Dedicated video upload/storage service for Serey, replacing the 15MB-limited
video path on `upload.serey.io`. Accepts **resumable chunked uploads** via the
[tus protocol](https://tus.io), validates and remuxes videos with ffmpeg
(faststart MP4 + thumbnail), and serves them from disk.

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
| POST/PATCH/HEAD | `/files[/:id]` | tus 1.0.0 resumable upload endpoints |
| GET | `/videos/:id/status` | `{ state: uploading\|queued\|processing\|ready\|failed, url?, thumbnail_url?, error? }` |
| DELETE | `/videos/:id` | Remove a video + thumbnail |
| GET | `/health` | Liveness check (no auth) |
| GET | `/videos/:id.mp4`, `/thumbnails/:id.jpg` | Public files (nginx in prod) |

Limits: 2GB per file, mp4/mov/mkv/webm/avi only, ffprobe-validated
(h264/hevc/vp8/vp9/av1), 30 new uploads per IP per hour.

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

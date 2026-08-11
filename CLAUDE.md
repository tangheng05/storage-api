# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Dedicated video/audio/image upload/storage service for Serey, replacing the 15MB-limited video path on `upload.serey.io`. Accepts resumable chunked uploads via the tus protocol, normalises the media (ffmpeg for video/audio, sharp for images), and serves them from disk. Runs standalone on a Hetzner VPS behind `storage.serey.io` (Nginx Proxy Manager + Cloudflare proxy).

The Cloudflare Pro proxy caps request bodies at 100MB, so the frontend must upload in tus chunks ≤50MB — large files work because tus sends many small PATCH requests, not one big one. This constraint drives client-side chunk sizing; don't assume larger chunks will "just work" through prod.

## Commands

```bash
npm install
cp .env.example .env          # set UPLOAD_API_KEY; needs ffmpeg/ffprobe on PATH or via FFMPEG_PATH/FFPROBE_PATH
npm start                     # or: npm run dev (same command, no watch mode)

node test/upload-test.js path/to/video.mp4              # end-to-end upload test against a running server
node test/upload-test.js path/to/video.mp4 --interrupt   # aborts mid-upload once and resumes, proving tus resumability
```

There is no build step, linter, or automated test suite — `test/upload-test.js` is a manual integration script that talks to a live instance (`ENDPOINT`, default `http://localhost:8080`). There are no unit tests.

## Architecture

Request flow: `client (tus-js-client) → this service → nginx (prod, static file serving)`.

1. `POST /files` (rate-limited, `x-upload-key` required) creates a tus upload; `PATCH` sends chunks; both are handled by the `@tus/server` instance in `src/tus.js`, backed by `@tus/file-store` writing to `TUS_DIR`. `onUploadCreate` classifies the upload as `video`, `audio` or `image` by mimetype/extension (see `ALLOWED_VIDEO_*`/`ALLOWED_AUDIO_*`/`ALLOWED_IMAGE_*` in `src/tus.js`) and stores `media_type` on the job — this single field is what routes it through the rest of the pipeline. Images also get a much tighter size cap (`MAX_IMAGE_BYTES`, 20MB) enforced here at create time, because the tus store's global `maxSize` is sized for 2GB video.
2. On upload completion (`onUploadFinish` in `src/tus.js`), the job is marked `queued` and handed to `src/services/processor.js` via `src/services/queue.js`. The `X-Status-Url` response header points at `/videos/:id/status` or `/audio/:id/status` depending on `media_type`.
3. `src/services/queue.js` is an in-process FIFO with concurrency 1 **per lane** — deliberately serial, because remux/transcode is CPU/I/O heavy and the app runs as a single PM2 instance (see `ecosystem.config.js`: `instances: 1`, cluster mode would corrupt uploads since the tus store and queue are in-process state, not shared). There are two lanes: `media` (ffmpeg) and `image` (sharp). Lanes exist purely to stop head-of-line blocking — a 200ms WebP conversion must not sit behind a 30-minute HEVC transcode — and are *not* extra processes; it is all one event loop.
4. `src/services/processor.js` validates the upload is real playable media via `ffprobe`, then dispatches on `job.media_type`:
   - **Video** (`processVideo`): branches by codec — `vp8`/`vp9`/`av1` in a webm container pass through unchanged (copied, not remuxed); `h264` is stream-copy remuxed into faststart MP4 (`ffmpeg.remuxToMp4`) — fast, lossless; `hevc` gets a full transcode to H.264/AAC (`ffmpeg.transcodeToH264`) since it's the iPhone default since iOS 11 but has no browser decoder outside Safari. Anything else is rejected. A thumbnail is generated from the published file.
   - **Audio** (`processAudio`): every input codec (mp3/wav/m4a/aac/ogg/opus/flac) is unconditionally transcoded to AAC in an M4A container (`ffmpeg.transcodeToAac`) for universal, consistent playback — no passthrough, unlike video's webm case. No thumbnail.
   - **Image** (`processImage`): ffmpeg/ffprobe are not involved at all — `src/services/image.js` wraps **sharp**. Every input (jpg/png/webp/gif/tiff/avif/heic) is unconditionally converted to WebP, same rationale as audio→AAC. The long edge is capped at `MAX_IMAGE_DIMENSION` (2560, never upscaled), EXIF orientation is baked into the pixels via `.rotate()` before resizing (without it every portrait phone photo publishes sideways, since WebP has no orientation tag), and the remaining EXIF — including GPS — is dropped. Animated GIFs stay animated. BMP and SVG are rejected at create time: BMP isn't in sharp's bundled libvips, and rasterising untrusted SVG is an attack surface. No thumbnail.
5. Tus temp files are cleaned up and job state moves to `ready` (or `failed` with an error code).
6. Job state lives in `src/services/jobs.js` — one JSON file per id under `JOBS_DIR`, keyed by ULID. States: `uploading → queued → processing → ready | failed`. This is the source of truth polled by `GET /videos/:id/status`, `GET /audio/:id/status` or `GET /images/:id/status` — `src/routes/videos.js`, `audio.js` and `images.js` are near-identical siblings that just point at different storage dirs/extensions.
7. On boot (`src/index.js`), `processor.recoverOnBoot()` re-enqueues any job stuck in `queued`/`processing` (crash recovery) — jobs still `uploading` are left alone since tus itself handles resuming those.

Auth is a single shared master key (`UPLOAD_API_KEY`), sent as `x-upload-key` or `Authorization: Bearer <key>` — see `src/middleware/auth.js`. There is no per-user auth; any holder of the key can upload/delete/create.

The master key must never reach a browser or shipped app package. The frontend's own backend holds it and calls `POST /files` server-to-server to create each tus upload; `onUploadCreate` in `src/tus.js` then mints a random per-upload token (`crypto.randomBytes(24)`, returned as the `X-Upload-Token` response header and stored on the job as `upload_token`), scoped to that one upload id. The client uses that token — not the master key — to PATCH chunks directly to this service (see `onIncomingRequest`: master key, or a token matching the job for that `uploadId` while it is still `state: 'uploading'`) and to poll `GET /videos/:id/status` / `/audio/:id/status` for its own job (the status routes accept master key or matching token; unauthenticated callers get 401 even for nonexistent ids so real ids can't be probed). `DELETE` requires the master key only — a scoped token can never delete. Jobs also record an `owner` (verified username passed as `owner` in Upload-Metadata by the trusted creator); when a DELETE carries an `x-delete-owner` header (the frontend backend always sends the session's verified username) and the job's owner differs, it's rejected with 403 — ids are public in every media URL, so login alone must not authorize deleting someone else's file. Master-key DELETEs without the header (admin/ops) are unrestricted. All secret comparisons go through `safeEqual` (`crypto.timingSafeEqual`) in `src/middleware/auth.js`.

CORS (`src/app.js`) supports exact origins, wildcard-subdomain patterns (`https://*.serey.io`, needed because Serey communities live on many subdomains like `bookclub.serey.io`), or `*`. A hard-reject middleware runs before the `cors` package and before tus's own handler, because `@tus/server`'s built-in CORS would otherwise reflect any origin on `/files` routes.

In production, nginx serves `/videos/*` and `/thumbnails/*` directly from disk; the `express.static` mounts in `src/app.js` are a local/dev fallback only.

The final `url`/`thumbnail_url` returned by the status endpoint is sent to serey-api in the post body — same pattern as `image_url` today, so serey-api itself needs no changes.

## Key constraints to preserve when changing code

- Never move the app to PM2 cluster mode / multiple instances — the tus `FileStore` and the processing `queue` are in-process and would corrupt uploads across instances.
- `onIncomingRequest` in `src/tus.js` must keep exempting `OPTIONS` from auth (CORS preflight) but nothing else.
- No body parsers on `/files` and `/files/*` — tus needs the raw request stream.
- Video ids are ULIDs; `src/services/jobs.js`'s `ULID_REGEX` is used both for job file paths (prevents path traversal via `id`) and for request validation — keep both in sync if the id scheme ever changes.
- `PUBLIC_BASE_URL` is baked into generated upload/status/video URLs; if delivery volume grows, Cloudflare Pro's ToS restricts video *playback* through their CDN, so the intended mitigation is pointing `PUBLIC_BASE_URL` at a grey-cloud hostname — no code change needed for that.

## Deploy

See `deploy/SETUP.md` for the full VPS runbook (nginx config in `deploy/nginx-storage.serey.io.conf`, systemd unit in `deploy/storage-api.service`, certbot, Cloudflare DNS) and the frontend `tus-js-client` integration snippet.

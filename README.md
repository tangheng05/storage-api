# Media Storage API

Resumable upload and storage for video, audio and images. Files arrive over
[tus](https://tus.io) so a dropped connection resumes, get normalised (ffmpeg,
sharp), get scanned, then published.

Public files go to **S5**, a content-addressing layer over
[Sia](https://sia.tech). Sia splits and encrypts a file across independent
hosts; S5 names it with a **CID**, the file's BLAKE3 hash. The hash is the
address, so anyone can verify the bytes they received. Change one byte and the
address changes, so a file cannot be swapped under a name that stays the same.

Paid files stay on local disk behind HMAC-signed URLs and never get a CID.

## Pipeline

```
POST /files       create a job, validate the type
PATCH chunks      resumable, written to a tus store
complete          convert -> a PENDING dir nothing serves
                  scan -> publish
```

The gate is at publication, not the storage push: serving the bytes is what
creates exposure, local disk included. Converted output waits in a
`PENDING_*_DIR` no route and no nginx block will serve, and only a clean
verdict moves it.

Public media publishes to S5 under a URL on your own hostname with the job's
ULID in the path; `/cdn` resolves that to a CID server-side, so no CID lands in
a database row and the backend stays swappable. Since a CID cannot be
withdrawn, a public file can never become paid — the visibility route returns
409 once it is on S5. Declare `visibility: 'private'` in `Upload-Metadata` at
create time instead.

An upload sending `defer_publish` in its tus metadata stays on local disk after
the scan and reaches S5 only when `/promote` is called. The URL is the `/cdn`
one from the start, so an editor can embed it in a draft and promoting on
publish rewrites nothing. Use it on surfaces that have a draft step; without
it, an abandoned draft is on S5 permanently and cannot be withdrawn.

Only the uploading surface knows whether a publish step is coming, which is why
this is per-upload rather than a deployment setting. A surface that saves as it
goes must not defer: nothing would ever call `/promote` and its files would
never reach Sia. `S5_PROMOTE_ON_PUBLISH` sets the default for uploads that say
nothing, and should stay off for that reason.

## Auth

`x-upload-key: <UPLOAD_API_KEY>` on every upload, status and delete.

Creating an upload also returns `X-Upload-Token`, scoped to that one job and
unable to delete, so a browser or an auditor can poll without the shared key
(`scripts/grant-upload.js` mints one). `/moderation/*` needs its own
`MODERATION_API_KEY`.

## Routes

| Method | Path | |
|---|---|---|
| POST/PATCH/HEAD | `/files[/:id]` | tus 1.0.0; type from the mimetype |
| GET | `/{videos,images,audio}/:id/status` | `state`, `url`, `s5_cid`, plus per-type fields |
| DELETE | `/{videos,images,audio}/:id` | file, thumbnail, backend copy |
| GET | `/media/:kind/:file` | paid delivery, signed URL required |
| POST | `/media/:kind/:file/visibility` | flip public/private; 409 once on S5 |
| POST | `/media/:kind/:file/promote` | queue the S5 push (202); idempotent |
| GET | `/cdn/:kind/:file` | resolves a ULID to its CID, proxies the bytes |
| GET | `/blob/1/:name` | S5 blob store, read-only, for S5 peers |
| POST | `/moderation/blocklist` | blocklist a hash by `phash` or job id |
| GET | `/moderation/stats` | verdict counts and thresholds |
| GET | `/health` | liveness |

States: `uploading → queued → processing → scanning → ready | rejected |
failed`. `scan_reasons` is populated only on `rejected`. `s5_cid` needs
`S5_EXPOSE_CID=true` and is permanent once shown.

## Limits

2GB per file, 20MB images, 30 uploads per IP per hour.

- **Video** mp4, mov, mkv, webm, avi, m4v, ffprobe-checked.
- **Audio** mp3, wav, m4a, aac, ogg, opus, flac → AAC/M4A.
- **Image** jpeg, png and webp keep their format, the rest become WebP. Long
  edge 2560px, never upscaled. EXIF orientation baked in, the rest including
  GPS dropped. BMP and SVG refused.

Images are re-encoded even when the format survives, so the CID addresses the
published file, not the upload.

## Scanning

Off unless `SCAN_ENABLED`. A perceptual-hash blocklist first, then optionally a
classifier (HTTP endpoint, Google Vision, or Gemini). Video is scanned through
`SCAN_VIDEO_FRAMES` sampled frames — the default of 1 only sees the thumbnail,
so raise it before putting video on S5.

Verdicts are cached by perceptual hash: the classifier is not deterministic, so
otherwise a refusal could be retried until it drew a low score. Thresholds are
stricter for S5. A broken scanner fails closed and the file waits in
`scanning`.

**Not a CSAM solution** — that needs hash matching against a known database and
brings its own reporting obligations.

## Running it

```bash
npm install
cp .env.example .env    # set UPLOAD_API_KEY; ffmpeg and ffprobe on PATH
npm start
npm test
```

`MEDIA_SIGNING_SECRET` starts empty and fails closed, so paid delivery is dead
locally until set. `scripts/` holds the operational tools; each prints its own
usage.

## Notes

- [deploy/SETUP.md](deploy/SETUP.md) — VPS runbook.
- [deploy/s5/README.md](deploy/s5/README.md) — the S5 node and s3d, the
  `cdnUrls` setting without which every node read fails, and where the S5 spec
  disagrees with a real node. The constants in `src/services/s5.js` follow the
  node, not the docs; `scripts/s5-probe-tus.js` re-derives them.
- [VERIFY.md](VERIFY.md) — how an outsider verifies the storage claims with no
  credentials.

Delivery comes from this server: other nodes can locate a file but not serve
it, since the Sia copies are ciphertext. That is durability, not high
availability.

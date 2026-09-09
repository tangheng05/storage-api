# Media Storage API

Upload and storage for video, audio and images. Files arrive over the
[tus protocol](https://tus.io), so a dropped connection resumes instead of
starting over. Whatever arrives is normalised (ffmpeg for video and audio,
sharp for images), scanned, then published.

Public files go to **S5**, a content-addressing layer over the
[Sia](https://sia.tech) network. Sia splits and encrypts a file across many
independent hosts; S5 names it with a **CID**, the file's BLAKE3 hash. The hash
is the address, so anyone can verify the bytes they received are the bytes that
were stored. Paid files stay on local disk behind signed URLs and never get a
CID.

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

A CID cannot be withdrawn once it exists, so a public file can never become
paid: `POST /media/:kind/:file/visibility` returns 409 for anything already on
S5. Declare `visibility: 'private'` in `Upload-Metadata` at create time
instead, and the file skips S5 entirely.

## Auth

One shared key on every upload, status and delete request:

```
x-upload-key: <UPLOAD_API_KEY>
```

Creating an upload also returns a scoped token in `X-Upload-Token`, good for
that job only, only while it uploads, and unable to delete. A browser or an
outside auditor can poll with it instead of the shared key
(`scripts/grant-upload.js` mints one; see [VERIFY.md](VERIFY.md)).

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

`s5_cid` appears only with `S5_EXPOSE_CID=true`, and only for public files.
Treat it as permanent once shown.

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
identical to uploaded ones. The CID addresses the published file.

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

`scripts/` holds the operational tools: `storage-verify.js` (`--fix` re-pushes),
`storage-backfill.js`, `storage-restore.js`, `grant-upload.js`,
`scan-score.js`, and a few S5/s3d probes. Each prints its own usage.

## Deploying

[deploy/SETUP.md](deploy/SETUP.md) is the VPS runbook: nginx, systemd, certbot,
DNS, and the `tus-js-client` snippet for the frontend.
[deploy/s5/README.md](deploy/s5/README.md) covers the S5 node and the s3d
daemon that puts bytes on Sia, including where the S5 spec is wrong and why s3d
holds files back until a batch fills.

One thing to know before wiring up a frontend: CDNs cap request bodies, and
Cloudflare's cap is 100MB. That is why uploads go in 50MB tus chunks. Large
files still work because tus makes many small PATCH requests instead of one
big one.

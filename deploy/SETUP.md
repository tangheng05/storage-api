# VPS Setup Runbook — storage.serey.io

Target: fresh Hetzner VPS, Ubuntu 24.04, using **Nginx Proxy Manager (NPM)**
for TLS/reverse-proxy and the **Cloudflare proxy (orange cloud)** in front.
~4 vCPU / 8GB is plenty (processing is stream-copy remux, I/O-bound).
Attach a **Hetzner Volume** mounted at `/var/www/serey-videos` from day one —
it is resizable, so video storage can grow without migrating the server.

> **Two Cloudflare constraints on the Pro plan** (both handled below):
> 1. The CF proxy caps each request body at **100MB** → the frontend must use
>    a tus `chunkSize` **below 100MB** (we use 50MB). Uploads still work for
>    files up to 2GB because tus sends many small PATCH requests.
> 2. Cloudflare's ToS **restricts serving video files through their CDN proxy**
>    on non-Enterprise plans (video must be on CF Stream/R2). Uploading through
>    the proxy is fine; it's the *playback* traffic that can trigger
>    enforcement (throttling or being asked to move). If playback volume gets
>    meaningful, the safe move is a second hostname for delivery only, set to
>    DNS-only (grey cloud), e.g. `video-cdn.serey.io` → same VPS. The app
>    supports this via `PUBLIC_BASE_URL` — no code change needed.

## 1. Base system

```bash
apt update && apt upgrade -y
apt install -y ffmpeg ufw fail2ban unattended-upgrades

ufw allow 22/tcp && ufw allow 80/tcp && ufw allow 443/tcp
ufw enable
```

(If NPM runs in Docker on this VPS, also install Docker and run the standard
`jc21/nginx-proxy-manager` compose setup with ports 80/443/81.)

## 2. Node.js 22 LTS

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs
```

## 3. App user + directories

```bash
useradd --system --home /opt/serey-storage-api --shell /usr/sbin/nologin serey-storage

mkdir -p /var/lib/serey-storage/{tus,jobs}
mkdir -p /var/www/serey-videos/{videos,thumbnails,audio,images}   # on the Hetzner Volume
# Paywalled media. nginx must NOT serve these publicly — they are reachable
# only through /media/... with a valid signature (see section on nginx below).
mkdir -p /var/www/serey-videos/private/{videos,audio,images}
# Conversion output waits here for the scan gate. Must be on the same mount as
# the published dirs, or the pending -> published move becomes a cross-device
# copy. nginx must not serve it.
mkdir -p /var/www/serey-videos/pending/{videos,audio,images,thumbnails}
chown -R serey-storage:serey-storage /var/lib/serey-storage /var/www/serey-videos
```

## 4. Deploy the app

```bash
git clone <this-repo> /opt/serey-storage-api
cd /opt/serey-storage-api && npm ci --omit=dev
chown -R serey-storage:serey-storage /opt/serey-storage-api
```

Image conversion uses **sharp**, which ships prebuilt libvips binaries for
linux-x64 — `npm ci` pulls them automatically and there is nothing extra to
`apt install`. HEIC/HEIF and AVIF decoding are bundled too, so iPhone photos
work out of the box (unlike HEVC *video*, which needs the ffmpeg toolchain).

Config (systemd reads it from `/etc/serey-storage/.env`):

```bash
mkdir -p /etc/serey-storage
cat > /etc/serey-storage/.env <<'EOF'
PORT=8080
PUBLIC_BASE_URL=https://storage.serey.io
UPLOAD_API_KEY=<GENERATE: openssl rand -hex 32>
TUS_DIR=/var/lib/serey-storage/tus
JOBS_DIR=/var/lib/serey-storage/jobs
VIDEOS_DIR=/var/www/serey-videos/videos
THUMBS_DIR=/var/www/serey-videos/thumbnails
AUDIO_DIR=/var/www/serey-videos/audio
IMAGES_DIR=/var/www/serey-videos/images
MAX_UPLOAD_BYTES=2147483648
MAX_DURATION_SEC=14400
MAX_IMAGE_BYTES=20971520
MAX_IMAGE_DIMENSION=2560
UPLOAD_EXPIRY_MS=86400000
ALLOWED_ORIGINS=https://serey.io,https://www.serey.io
CREATES_PER_HOUR=30
TRUST_PROXY_HOPS=2
EOF
chmod 600 /etc/serey-storage/.env
```

Auth is just this one key: put the **same `UPLOAD_API_KEY` value in the
frontend's .env** and send it as the `x-upload-key` header. Rotate it by
changing both sides.

## 5. systemd

```bash
cp deploy/storage-api.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now storage-api
journalctl -u storage-api -f   # check it started
```

## 6. Cloudflare DNS

In the Cloudflare dashboard for serey.io:

- Add an **A record**: name `storage`, value = VPS public IP, **Proxied (orange
  cloud)**.
- SSL/TLS mode: **Full (strict)** once NPM has its certificate.
- Cloudflare → Rules → Cache Rules → *Bypass cache* for
  `storage.serey.io/files/*` (upload traffic should never be cached) **and for
  `storage.serey.io/media/*`**. The paywall relies on Cloudflare honouring
  `private, no-store`; one "ignore query string" rule would turn a subscriber's
  signed URL into a public one.

## 7. Nginx Proxy Manager

> **Reality check for the current deployment (storage.serey.io):** the NPM
> "Custom Nginx Configuration" (Advanced) box is **empty**, and NPM forwards
> everything to the app. Media is therefore served by `express.static` in
> `src/app.js`, not by nginx from disk. Verified: an existing file returns 206
> with `Accept-Ranges: bytes`, a missing one returns the app's JSON 404.
>
> That means **none of the `location` blocks below are currently applied**, and
> paywalled media needs no NPM change at all — set `USE_X_ACCEL=false` and
> Express serves private files through `/media/` after checking the signature.
> The private dirs have no `express.static` mount, so nothing else can reach
> them.
>
> The blocks below are the intended setup if static serving is ever moved to
> nginx for performance. Only then set `USE_X_ACCEL=true` and add the
> `/media/`, `/internal-media/` and `/private/` locations.


Create a **Proxy Host**:

- Domain: `storage.serey.io`
- Forward to: `http://127.0.0.1:8080`. **If NPM itself runs in Docker it cannot
  reach the host's loopback** -- use the bridge gateway (`172.18.0.1:8080`, or
  whatever `docker network inspect` reports) or the forward returns 502.
- SSL tab: request a Let's Encrypt cert — use a **DNS challenge** with your
  Cloudflare API token (HTTP challenge is unreliable behind the CF proxy).
  Enable "Force SSL".
- **Advanced tab** — paste this custom config (critical for large uploads and
  video seeking):

The intended `location` blocks live in
[`nginx-storage.serey.io.conf`](nginx-storage.serey.io.conf) — that file is the
single source, so paste from it rather than from a copy here. It previously
existed twice and the copies drifted.

Two things in it that matter whenever static serving does move to nginx:

- `location /pending/ { deny all; }` — the scan gate stages conversion output
  there. Serving it would defeat the gate entirely.
- `location /cdn/` and `location /moderation/` must be proxied to the app, not
  served from disk. An S5-published file has no local copy.

The `cdn.serey.io` server block at the bottom of that file is **commented out**:
`listen ... ssl` with no `ssl_certificate` is a hard error and would stop nginx
loading the whole file. Uncomment it only after certbot has issued the cert. With
NPM you do not need it at all — add `cdn.serey.io` as a second Proxy Host
pointing at the same app, or leave `MEDIA_CDN_BASE_URL` empty and public media
resolves through `storage.serey.io/cdn/`.

If NPM runs in Docker, mount the video dirs into the NPM container
(`-v /var/www/serey-videos:/var/www/serey-videos:ro`) so the static
`location` blocks can read them, and use the host gateway IP instead of
`127.0.0.1` in `proxy_pass` (in the `/media/` block too, not just `/files`).

That one mount already covers `/var/www/serey-videos/private/`, so
`/internal-media/` needs nothing extra. Read-only is correct: nginx only reads,
and the public/private move is done by the app on the host, not by nginx.

Verify the private tree is genuinely unreachable after applying this — a plain
request must 403/404 even though the file exists:

```bash
curl -sI https://storage.serey.io/private/videos/<ulid>.mp4   # expect 404
curl -sI https://storage.serey.io/media/videos/<ulid>.mp4     # expect 403 (unsigned)
```

## 7b. New env for the scan gate and S5

```bash
# Operator key for /moderation. Separate from UPLOAD_API_KEY on purpose: that
# one is held by serey-api and CI. Unset leaves the routes disabled (503).
MODERATION_API_KEY=$(openssl rand -hex 32)

# The gate itself. phash alone only catches re-uploads of content already taken
# down; a classifier endpoint is what scores new content.
SCAN_ENABLED=true
SCAN_PROVIDERS=phash
SCAN_BLOCKLIST_PATH=/var/www/serey-videos/blocklist.txt

# Public media on S5. Leave S5_ENABLED=false until a node is reachable and one
# real upload has round-tripped — putFile verifies the CID is retrievable before
# reporting success, so a misconfigured node fails loudly rather than writing a
# dead URL into a post row.
S5_ENABLED=false
S5_NODE_URL=http://127.0.0.1:5050
S5_AUTH_TOKEN=
```

The S5 node and s3d run as containers. Compose file and the full annotated
reference live in [`deploy/s5/`](s5/), which is the source of truth for this
part -- read it before changing anything here:

```bash
cd /opt/serey-storage-api/deploy/s5
docker compose up -d
docker compose logs -f s5        # config.toml is generated on first boot
```

State lives outside the checkout, at `/var/lib/s5/config/config.toml` and
`/var/lib/s3d/s3d.yml`. **Back both up.** The s3d file holds the 12-word
recovery phrase, and losing it loses access to everything on Sia.

Three settings in the node's `config.toml` that are not optional:

- `[http.api] domain` must match the hostname the proxy serves. The node builds
  its own URLs from it, and a mismatch gives broken links that look like a
  caching problem.
- `[store.s3]` pointed at `http://s3d:8000` over the compose network, using a
  key minted with `docker compose run --rm s3d keys create s5`. With the default
  local filesystem store the blobs sit on this same VPS disk -- two copies on
  one volume, and no protection against the failure the second copy exists for.
- `cdnUrls` pointed at `https://storage.serey.io/blob`. **Without it every read
  fails.** S5's S3 store reads only through presigned URLs, which s3d treats as
  anonymous and refuses; the node then reports an integrity error because it
  hashed the 403 body. `deploy/s5/README.md` has the full account.

`docker compose restart s5` after editing, then mint a token for
`S5_AUTH_TOKEN`.

The node does **not** need to be publicly reachable. `/cdn` proxies the bytes
through this app rather than redirecting, because S5's download route requires
the bearer token -- so there is no second proxy host to create and no browser
ever talks to the node directly.

Two more env vars once a real upload has round-tripped:

```bash
# Lets a client read the CID of its own public media. One-way: a CID shown once
# is a permanent public handle and cannot be withdrawn.
S5_EXPOSE_CID=false
# Serves S5's blobs back to the node and its peers. Required by cdnUrls above.
S5_BLOB_ENABLED=true
```

Keep `USE_X_ACCEL=false` unless you have pasted the `/internal-media/` location
into NPM's Advanced box — nothing else honours `X-Accel-Redirect`, and premium
delivery would return empty responses.

## 8. Safety-net cleanup cron

The app removes expired incomplete uploads hourly on its own. Belt-and-braces:

```bash
cat > /etc/cron.daily/serey-storage-cleanup <<'EOF'
#!/bin/sh
find /var/lib/serey-storage/tus -type f -mtime +2 -delete
EOF
chmod +x /etc/cron.daily/serey-storage-cleanup
```

## 8b. Flush s3d to Sia hourly

s3d batches uploads until it can erasure-code a full slab, so a fresh object
sits in its local pending queue with nothing on Sia yet. On a quiet week that
leaves the newest uploads on one disk. `s3d flush` is a no-op when nothing is
pending, so run it hourly:

```bash
( crontab -l 2>/dev/null; echo '0 * * * * /usr/bin/docker exec s3d s3d flush >/dev/null 2>&1' ) | crontab -
docker exec s3d s3d status     # Uploaded should climb, Pending stay small
```

## 9. Smoke test

```bash
curl https://storage.serey.io/health
# → {"ok":true}

curl -X POST https://storage.serey.io/files \
  -H "Tus-Resumable: 1.0.0" -H "Upload-Length: 10"
# → 401 (no key) — auth is working
```

Then run a real upload with the frontend snippet below or
`ENDPOINT=https://storage.serey.io UPLOAD_API_KEY=<key> node test/upload-test.js video.mp4`.

## Frontend integration (tus-js-client)

```js
import * as tus from 'tus-js-client';

const UPLOAD_KEY = import.meta.env.VITE_UPLOAD_API_KEY; // same value as server .env

function uploadVideo(file, { onProgress, onReady, onError }) {
  const upload = new tus.Upload(file, {
    endpoint: 'https://storage.serey.io/files',
    chunkSize: 50 * 1024 * 1024,            // MUST stay < 100MB (Cloudflare Pro cap)
    retryDelays: [0, 3000, 10000, 30000, 60000],
    headers: { 'x-upload-key': UPLOAD_KEY },
    metadata: { filename: file.name, filetype: file.type },
    onProgress: (sent, total) => onProgress(Math.round((sent / total) * 100)),
    onError,
    onSuccess: async () => {
      const id = upload.url.split('/').pop();
      // Poll until processing finishes (usually seconds).
      for (;;) {
        const res = await fetch(`https://storage.serey.io/videos/${id}/status`, {
          headers: { 'x-upload-key': UPLOAD_KEY },
        });
        const job = await res.json();
        if (job.state === 'ready') return onReady(job);   // { url, thumbnail_url, ... }
        if (job.state === 'failed') return onError(new Error(job.error));
        await new Promise((r) => setTimeout(r, 2000));
      }
    },
  });

  // Resume an interrupted upload of the same file if one exists.
  upload.findPreviousUploads().then((prev) => {
    if (prev.length) upload.resumeFromPreviousUpload(prev[0]);
    upload.start();
  });
  return upload; // caller can upload.abort()
}
```

On `onReady`, send `job.url` (and `job.thumbnail_url`) to serey-api in the post
body — the same pattern as `image_url` today. serey-api needs no changes.

Note: `getVideoPlatform` in serey-api's `src/utils/general_util.js` detects
Serey-hosted videos by hostname; add `https://storage.serey.io/videos/` to that
list so embeds are treated as SEREY videos.

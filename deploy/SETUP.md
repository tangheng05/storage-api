# VPS Setup Runbook — video.serey.io

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
mkdir -p /var/www/serey-videos/{videos,thumbnails}   # on the Hetzner Volume
chown -R serey-storage:serey-storage /var/lib/serey-storage /var/www/serey-videos
```

## 4. Deploy the app

```bash
git clone <this-repo> /opt/serey-storage-api
cd /opt/serey-storage-api && npm ci --omit=dev
chown -R serey-storage:serey-storage /opt/serey-storage-api
```

Config (systemd reads it from `/etc/serey-storage/.env`):

```bash
mkdir -p /etc/serey-storage
cat > /etc/serey-storage/.env <<'EOF'
PORT=8080
PUBLIC_BASE_URL=https://video.serey.io
UPLOAD_API_KEY=<GENERATE: openssl rand -hex 32>
TUS_DIR=/var/lib/serey-storage/tus
JOBS_DIR=/var/lib/serey-storage/jobs
VIDEOS_DIR=/var/www/serey-videos/videos
THUMBS_DIR=/var/www/serey-videos/thumbnails
MAX_UPLOAD_BYTES=2147483648
MAX_DURATION_SEC=14400
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

- Add an **A record**: name `video`, value = VPS public IP, **Proxied (orange
  cloud)**.
- SSL/TLS mode: **Full (strict)** once NPM has its certificate.
- Optional but recommended: Cloudflare → Rules → Cache Rules → *Bypass cache*
  for `video.serey.io/files/*` (upload traffic should never be cached).

## 7. Nginx Proxy Manager

Create a **Proxy Host**:

- Domain: `video.serey.io`
- Forward to: `http://127.0.0.1:8080` (or the app container/IP)
- SSL tab: request a Let's Encrypt cert — use a **DNS challenge** with your
  Cloudflare API token (HTTP challenge is unreliable behind the CF proxy).
  Enable "Force SSL".
- **Advanced tab** — paste this custom config (critical for large uploads and
  video seeking):

```nginx
# ---- tus uploads: don't buffer, don't cap body size ----
location /files {
    proxy_pass http://127.0.0.1:8080;
    client_max_body_size 0;
    proxy_request_buffering off;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Host $host;
    proxy_read_timeout 300s;
    proxy_send_timeout 300s;
}

# ---- published videos + thumbnails straight from disk ----
# nginx serves Range requests (seeking) natively for static files.
location /videos/ {
    root /var/www/serey-videos;
    add_header Cache-Control "public, max-age=31536000, immutable";
    add_header Access-Control-Allow-Origin "*";
}
location /thumbnails/ {
    root /var/www/serey-videos;
    add_header Cache-Control "public, max-age=31536000, immutable";
    add_header Access-Control-Allow-Origin "*";
}

# ---- API routes (status/delete) back to node ----
# Regex beats the /videos/ prefix above; API paths have no file extension.
location ~ ^/videos/[0-9A-HJKMNP-TV-Z]{26}(/status)?$ {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

If NPM runs in Docker, mount the video dirs into the NPM container
(`-v /var/www/serey-videos:/var/www/serey-videos:ro`) so the static
`location` blocks can read them, and use the host gateway IP instead of
`127.0.0.1` in `proxy_pass`.

## 8. Safety-net cleanup cron

The app removes expired incomplete uploads hourly on its own. Belt-and-braces:

```bash
cat > /etc/cron.daily/serey-storage-cleanup <<'EOF'
#!/bin/sh
find /var/lib/serey-storage/tus -type f -mtime +2 -delete
EOF
chmod +x /etc/cron.daily/serey-storage-cleanup
```

## 9. Smoke test

```bash
curl https://video.serey.io/health
# → {"ok":true}

curl -X POST https://video.serey.io/files \
  -H "Tus-Resumable: 1.0.0" -H "Upload-Length: 10"
# → 401 (no key) — auth is working
```

Then run a real upload with the frontend snippet below or
`ENDPOINT=https://video.serey.io UPLOAD_API_KEY=<key> node test/upload-test.js video.mp4`.

## Frontend integration (tus-js-client)

```js
import * as tus from 'tus-js-client';

const UPLOAD_KEY = import.meta.env.VITE_UPLOAD_API_KEY; // same value as server .env

function uploadVideo(file, { onProgress, onReady, onError }) {
  const upload = new tus.Upload(file, {
    endpoint: 'https://video.serey.io/files',
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
        const res = await fetch(`https://video.serey.io/videos/${id}/status`, {
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
Serey-hosted videos by hostname; add `https://video.serey.io/videos/` to that
list so embeds are treated as SEREY videos.

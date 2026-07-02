# VPS Setup Runbook — video.serey.io

Target: fresh Hetzner VPS, Ubuntu 24.04. ~4 vCPU / 8GB is plenty (processing is
stream-copy remux, I/O-bound). Attach a **Hetzner Volume** mounted at
`/var/www/serey-videos` from day one — it is resizable, so video storage can
grow without migrating the server.

## 1. Base system

```bash
apt update && apt upgrade -y
apt install -y nginx ffmpeg ufw fail2ban unattended-upgrades

ufw allow 22/tcp && ufw allow 80/tcp && ufw allow 443/tcp
ufw enable
```

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
chmod 755 /var/www/serey-videos /var/www/serey-videos/videos /var/www/serey-videos/thumbnails
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
EOF
chmod 600 /etc/serey-storage/.env
```

The same `UPLOAD_API_KEY` value must be given to every client that uploads
(frontend/serey-api). Rotate it by changing it here and in the clients.

## 5. systemd

```bash
cp deploy/storage-api.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now storage-api
journalctl -u storage-api -f   # check it started
```

## 6. Cloudflare DNS

In the Cloudflare dashboard for serey.io:

- Add an **A record**: name `video`, value = VPS public IP.
- Set it to **DNS only (grey cloud)** — NOT proxied. This avoids the 100MB
  request cap and the ToS restriction on serving video via the CF proxy.

## 7. TLS + nginx

```bash
cp deploy/nginx-video.serey.io.conf /etc/nginx/sites-available/video.serey.io
ln -s /etc/nginx/sites-available/video.serey.io /etc/nginx/sites-enabled/

# Get the cert first (needs DNS already pointing here):
apt install -y certbot python3-certbot-nginx
certbot certonly --nginx -d video.serey.io

nginx -t && systemctl reload nginx
```

Certbot's systemd timer auto-renews.

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

Then run a real upload with the frontend snippet below or `test/upload-test.js`.

## Frontend integration (tus-js-client)

```js
import * as tus from 'tus-js-client';

const UPLOAD_KEY = '<same UPLOAD_API_KEY as the server>';

function uploadVideo(file, { onProgress, onReady, onError }) {
  const upload = new tus.Upload(file, {
    endpoint: 'https://video.serey.io/files',
    chunkSize: 64 * 1024 * 1024,            // grey cloud: no CF 100MB cap
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

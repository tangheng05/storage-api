# Operations and server moves

What breaks, how to see it, and what has to come with you. Companion to
[SETUP.md](SETUP.md), which covers a first install.

Everything here is a real incident, not a precaution.

## The failure mode to understand first

Media is served from local disk when a backend is unavailable (`/cdn` falls
back). That is deliberate — users never see an outage. It also means **a broken
backend looks exactly like a healthy one from the outside.**

Both production incidents so far were this: the site worked perfectly while
nothing reached Sia for a day. Neither was noticed by anyone using the site.

So health is measured from the job store, never from the front end.

## Health check

Run this weekly, and after any deploy or move:

```bash
cd ~/storage-api
JOBS=$(grep '^JOBS_DIR=' .env | cut -d= -f2-)

# 1. publishes that failed -- should be 0
grep -l '"mirror_state": "failed"' "$JOBS"/*.json 2>/dev/null | wc -l

# 2. bytes still waiting to reach Sia -- Pending should be small, Failed 0
docker exec s3d s3d status

# 3. the S5 node's file handles -- see below
PID=$(docker inspect -f '{{.State.Pid}}' s5-node)
grep -i 'open files' /proc/$PID/limits
ls /proc/$PID/fd | wc -l

# 4. disk
df -h /
```

A non-zero count in (1) means media exists in one place only.

## Known failures

| Symptom | Cause | Fix |
|---|---|---|
| `s5 stat failed: 500`, node logs `Too many open files, errno = 24` | Docker's default `nofile` soft limit is 1024; the node holds a file per cached blob | `ulimits.nofile: 65536` in `deploy/s5/docker-compose.yml`, then `docker compose up -d s5` |
| `ENOSPC`, pm2 cannot write, builds killed | disk at 100% | `journalctl --vacuum-size=200M`, `npm cache clean --force`, `truncate -s 0 /var/log/nginx/*.log`, `pm2 flush` |
| `s3d status` shows Pending climbing, Uploaded flat | s3d batches until a slab fills | hourly `s3d flush` cron; see [s5/README.md](s5/README.md) |
| Every read fails, node reports an integrity error | `cdnUrls` unset, so S5 reads via presigned URLs that s3d refuses | set `cdnUrls` in the node's `config.toml`, `S5_BLOB_ENABLED=true` |
| Build killed, exit 137 | out of memory, no swap | add swap, `NODE_OPTIONS=--max-old-space-size=3072` |

A ulimit change needs `docker compose up -d`, not `restart` — a restart keeps
the old limit.

After fixing any backend outage, restart the storage API. Its boot sweep
republishes every slot left in `failed`; nothing has to be done by hand.

## What must survive a move

Two files. Lose either and the data is unrecoverable — no backup of anything
else substitutes.

| | |
|---|---|
| `/var/lib/s3d/s3d.yml` | the 12-word recovery phrase. Everything on Sia is encrypted to it. |
| `/var/lib/s5/config/config.toml` | the node's keypair seed |

Keep a copy off the server. Losing the phrase loses every stored file, not just
the ability to serve them.

Also worth carrying, but rebuildable: `JOBS_DIR` (the job records, which hold
every CID and s3d key), the media directories, and `.env`.

## Moving to a new server

1. **Set the limits before anything else** — swap, and `nofile` in the compose
   file. Both incidents above were limits nobody set.
2. Install per [SETUP.md](SETUP.md), then stop the app on the old box so no new
   uploads land mid-copy.
3. Copy `/var/lib/s3d/`, `/var/lib/s5/`, `JOBS_DIR`, the media directories and
   `.env`.
4. Bring up s3d and the S5 node. Confirm `docker exec s3d s3d status` reports
   the same Uploaded count as the old box.
5. Start the storage API. Run the health check above.
6. Publish one test upload and confirm it gets a CID before pointing DNS over.
7. `node scripts/storage-verify.js` — checks every published job is still
   present on its backend. `--fix` re-pushes anything missing.

If the media directories are too large to copy, `scripts/storage-restore.js`
pulls files back from the backend instead. That is what the second copy exists
for.

## Things that are meant to look wrong

- `mirror_state: deferred` — a draft waiting for `/promote`, not a failure.
- `s5:shared` on a delete — another job uses the same bytes. S5 names blobs by
  their hash, so identical uploads are one file.
- `Pending Objects` above zero in `s3d status` — normal between flushes.
- `blob: 400` from `/blob/1/AAAA` — the key is too short for the route's
  pattern. The route is fine; 404 is what a valid but absent key returns.

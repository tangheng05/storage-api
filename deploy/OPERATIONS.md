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

# 5. forever uploads that failed -- ARWEAVE CREDITS LOW in the log means top up
grep -l '"arweave_state": "failed"' "$JOBS"/*.json 2>/dev/null | wc -l
```

A non-zero count in (1) means media exists in one place only. A non-zero count
in (5) is a user who asked for Forever and did not get it; the job's
`arweave_error` says why, and asking again (`POST .../arweave`) retries it.
Nothing retries on its own, because every attempt costs credits.

## Known failures

| Symptom | Cause | Fix |
|---|---|---|
| `s5 stat failed: 500`, node logs `Too many open files, errno = 24` | Docker's default `nofile` soft limit is 1024; the node holds a file per cached blob | `ulimits.nofile: 65536` in `deploy/s5/docker-compose.yml`, then `docker compose up -d s5` |
| `ENOSPC`, pm2 cannot write, builds killed | disk at 100% | `journalctl --vacuum-size=200M`, `npm cache clean --force`, `truncate -s 0 /var/log/nginx/*.log`, `pm2 flush` |
| `s3d status` shows Pending climbing, Uploaded flat | s3d batches until a slab fills | hourly `s3d flush` cron; see [s5/README.md](s5/README.md) |
| Every read fails, node reports an integrity error | `cdnUrls` unset, so S5 reads via presigned URLs that s3d refuses | set `cdnUrls` in the node's `config.toml`, `S5_BLOB_ENABLED=true` |
| Build killed, exit 137 | out of memory, no swap | add swap, `NODE_OPTIONS=--max-old-space-size=3072` |
| A deleted file still returns 200 while the origin returns 404 | Nginx Proxy Manager's **Cache Assets** toggle | turn it off on the proxy host; see below |

A ulimit change needs `docker compose up -d`, not `restart` — a restart keeps
the old limit.

After fixing any backend outage, restart the storage API. Its boot sweep
republishes every slot left in `failed`; nothing has to be done by hand.

## Taking content down

Deleting media removes the local file, the backend copy, and -- when
`CLOUDFLARE_ZONE_ID` and `CLOUDFLARE_PURGE_TOKEN` are set -- the edge copy. The
response says what happened to each:

```json
{"deleted":"<id>","storage":{"main":"s5:deleted"},"cdn":"purged"}
```

`cdn: failed` or `not-configured` means the bytes are gone but the edge is
still serving them until the entry expires. Purge by URL in the Cloudflare
dashboard (Caching -> Purge Cache) and treat the takedown as unfinished until
then.

A purge failure never fails the delete: the bytes are already gone by then, so
the right answer is to report it, not to unwind.

### A fresh Forever copy 404s on arweave.net

Normal for minutes to an hour after upload. Turbo confirms and charges at
once; public gateways only serve an item once its bundle is posted to the
chain and indexed. The job's `arweave_gateway` field records both answers
(`turbo:confirmed gateway:status 404`); `turbo:confirmed` or `finalized` is
the one that means the copy exists. Check
`https://upload.ardrive.io/v1/tx/<id>/status` if in doubt.

### Forever media cannot be taken down

A job with an `arweave_id` has a copy on Arweave that nobody can remove, us
included. Delete still works and still removes every copy we hold; the report
adds `"arweave":"permanent:<id>"` so the caller can say so. A legal request
gets exactly that answer: our copies are gone, the site no longer serves it,
the Arweave copy is outside anyone's control. Write that down for trust and
safety before Forever is switched on, and never build a tool that pretends
otherwise.

### Cache Assets must stay off

Nginx Proxy Manager's **Cache Assets** toggle (proxy host -> Details -> Options)
holds its own copy of anything ending in an image, font or script extension,
and its generated block sets `proxy_ignore_headers Cache-Control Expires` with
`proxy_cache_valid 200 1M`. Two consequences, both silent:

- **Takedowns cannot work.** Purging Cloudflare evicts the edge, Cloudflare
  refetches, and NPM answers from its month-old copy -- so the edge refills with
  the file you just deleted. This is not a Cloudflare problem and no purge fixes
  it. Diagnosed once by hitting each layer separately; that is the only way to
  see it, since every layer reports success.
- **Premium images leak.** They are served from `/media/<kind>/<ulid>.<ext>`, so
  they match the extension rule, and the `private, no-store` that protects them
  is one of the headers being ignored. An expired signed URL replayed verbatim
  is then served from cache without the signature ever being checked.

To check which layer is actually answering:

```bash
curl -s -o /dev/null -D- http://127.0.0.1:8080/cdn/images/<id>.<ext>   # the app
curl -sk -o /dev/null -D- --resolve storage.serey.io:443:127.0.0.1 \
  https://storage.serey.io/cdn/images/<id>.<ext>                      # the proxy
curl -sI https://storage.serey.io/cdn/images/<id>.<ext>               # the edge
```

The app 404ing while either layer above it returns 200 is the signature of this
failure. `x-served-by` in a response means the proxy answered.

## What must survive a move

Two files. Lose either and the data is unrecoverable — no backup of anything
else substitutes.

| | |
|---|---|
| `/var/lib/s3d/s3d.yml` | the 12-word recovery phrase. Everything on Sia is encrypted to it. |
| `/var/lib/s5/config/config.toml` | the node's keypair seed |
| `ARWEAVE_JWK_PATH` (if Forever is on) | the platform Arweave wallet. Holds the Turbo credits; anyone with it can spend them. |

Keep a copy off the server. Losing the phrase loses every stored file, not just
the ability to serve them. The wallet is the opposite case: nothing already on
Arweave depends on it, but it is money, so keep it in a secrets store and out
of `.env`, and give it two-person access.

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
5. Start the storage API. Run the health check above. On the new proxy host,
   confirm **Cache Assets is off** -- it defaults on for new hosts and breaks
   takedowns.
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

# Public media storage: S5 + s3d

```
storage API -> S5 node -> [store.s3] -> s3d -> Sia network
```

S5 gives content addressing: a blob's CID is its BLAKE3 hash, so integrity is
verifiable rather than trusted. It holds nothing itself — `[store]` decides
where bytes land. Pointed at s3d they go onto Sia, erasure-coded across
independent hosts and **encrypted client-side**, so neither a host nor a gateway
ever sees plaintext.

Premium media never comes here. A CID is the permission: anyone who has ever
held one keeps access forever, from any node. Paywalled media stays on local
disk behind signed URLs.

## Bring it up

```bash
mkdir -p /var/lib/s5/{config,db,cache,data} /var/lib/s3d
cd deploy/s5

# 1. s3d: log in to Sia. Leave the phrase blank to generate a new one, then
#    open the URL it prints and approve the connection.
docker compose run --rm s3d login

# 2. credentials for S5 to use
docker compose run --rm s3d users create s5
docker compose run --rm s3d keys create s5      # secret is shown ONCE

# 3. start both
docker compose up -d
docker compose logs -f s5     # config.toml is generated on first boot
```

Then edit `/var/lib/s5/config/config.toml`:

```toml
[http.api]
domain = 's5.serey.io'      # must match what the proxy serves. The node routes
port = 5050                 # on Host, and a mismatch gives "No valid S5
bind = '0.0.0.0'            # dnslink record found".

[store.s3]
accessKey = "<from step 2>"
secretKey = "<from step 2>"
bucket = "media"
endpointUrl = "http://s3d:8000"
# REQUIRED. Without it every read fails -- see "S5 cannot read from s3d" below.
cdnUrls = ["https://storage.serey.io/blob/"]
```

`docker compose restart s5`, then mint a token for `S5_AUTH_TOKEN` and set
`S5_ENABLED=true` in the app's `.env`.

## Back these up

| Path | Why |
|---|---|
| `/var/lib/s3d/s3d.yml` | the 12-word recovery phrase. **Lose it and everything on Sia is gone.** |
| `/var/lib/s5/config/config.toml` | the node keypair seed, which cannot be regenerated |

## S5 cannot read from s3d without `cdnUrls`

The two projects do not fit together on their own, and the symptom names the
wrong culprit: the node reports **"integrity verification failed"** on every
read, which reads like corrupted bytes but is not.

- S5's S3 store serves every read through a **presigned URL**
  (`lib/store/s3.dart`, `provide()`).
- s3d authenticates on the **`Authorization` header only**. A query-signed
  request carries none, so `authMiddleware` treats it as anonymous, and
  `sia/objects.go` refuses anonymous reads outright.

So the node fetches a 119-byte `AccessDenied` XML body, hashes *that*, and
reports a hash mismatch. Writes were never affected — those go through the SDK,
which signs in the header — which is why uploads succeeded the whole time.

`cdnUrls` is the way out. With it set, `provide()` returns a plain
`<cdnUrl><key>` URL instead of signing one, and the storage API serves that
prefix from s3d with proper header auth (`/blob`, gated on `S5_BLOB_ENABLED`).
The node needs no other change. Two details make it work:

- A `cdnUrls` location carries **one** part, so lib5 derives the outboard URL by
  appending `.obao` to it (`StorageLocation.outboardBytesUrl`). That is exactly
  the key layout in the bucket, so both land on the same route.
- Blobs over 256KB are read in ranged 256KB windows and the node rejects
  anything but 200/206, so the route must pass `Range` through.

**The URL must be the public one.** `node.dart` signs it and broadcasts it to
peers, so it is the address by which anyone else fetches these blobs by CID.
Before this, the node was announcing `http://s3d:8000/...` — a container name
that resolves nowhere outside the host — so fetch-by-CID by others could never
have worked, presigning bug or not.

`npm run test:blob` covers our side of it. Only a live node proves the rest.

## s3d holds bytes back until a batch fills

`s3d status` reports an upload pipeline, and a fresh object lands in
**Pending**, not on Sia. s3d waits for enough data to erasure-code a full slab,
so on a quiet week the newest uploads sit on this one disk with no Sia copy --
the exact loss the Sia copy exists to survive. `Failed Uploads: 0` alongside
`Uploaded Objects: 0` is this, not a fault.

`s3d flush` forces it, and is a no-op when nothing is pending, so an hourly
cron closes the window:

    0 * * * * /usr/bin/docker exec s3d s3d flush >/dev/null 2>&1

Check with `docker exec s3d s3d status` -- Uploaded should climb and Pending
should stay small.

## Things that cost us time

**Do not enable `[accounts]`.** It stops the admin key working on the download
route (401) and the account-token flow that replaces it is challenge/response
that the docs never give a request body for. Not needed anyway: the storage API
proxies public media through `/cdn` with the token server-side, so the node
needs no anonymous access and no public hostname.

**`[store.local]` needs `[store.local.http]`** (bind/port/url) as well as a
path, or the node resets the connection on upload. Only relevant if you switch
back to the local store for a test — and note it writes a second copy of every
file to the same disk as the originals, which is no durability at all.

**The node routes on the Host header.** Requests arriving with any other Host
fail with a dnslink error, which is why `S5_NODE_URL` uses the public hostname
rather than localhost.

**NPM is containerised**, so a proxy host pointing at `127.0.0.1:5050` gets a
502. Use the bridge gateway (`172.18.0.1`) — confirm yours with
`docker network inspect`.

## Where the spec is wrong

Verified against a live s5-dart v0.14.1 node with `scripts/s5-probe-tus.js`.
Re-run it before trusting these on a new node version.

| | docs.sfive.net | reality |
|---|---|---|
| CID magic | `0x5b 0x82 0x1e` | `0x26 0x1f` |
| CID encoding | base16, `f` | base58btc, `z` |
| BLAKE3 id | `0x1e` | `0x1f` |
| Upload response | undocumented | `{"cid":"z…"}` |
| Download by CID | undocumented | `GET /<cid>`, needs the token |
| Unpin | abstract `unpinHash` | no route at all |

The hash itself and the little-endian size bytes do match the spec.

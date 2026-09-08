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
```

`docker compose restart s5`, then mint a token for `S5_AUTH_TOKEN` and set
`S5_ENABLED=true` in the app's `.env`.

## Back these up

| Path | Why |
|---|---|
| `/var/lib/s3d/s3d.yml` | the 12-word recovery phrase. **Lose it and everything on Sia is gone.** |
| `/var/lib/s5/config/config.toml` | the node keypair seed, which cannot be regenerated |

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

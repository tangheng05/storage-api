# Independent verification: decentralised media storage

Hand this to anyone — an outside engineer, an AI agent with a shell, an auditor —
and they can verify Serey's public media claims without any credentials and
without trusting Serey's own systems.

The verifier uploads their own file, obtains its identifier themselves, and
then proves the stored bytes match it. Nothing is taken on Serey's word.

> **Serey's master key is never shared.** The verifier is issued a token scoped
> to a single upload, which expires when that upload completes and cannot delete
> anything.

## One handshake, then it is self-service

The verifier picks a file and reports its **name, byte size and type**. Serey
runs one command and returns three values:

```bash
UPLOAD_API_KEY=<master key> node scripts/grant-upload.js <filename> <bytes> <mimetype>
```

It prints `UPLOAD_URL`, `TOKEN` and `STATUS_URL`. Hand those over. Everything
after that the verifier does alone.

Serey must also have `S5_EXPOSE_CID=true` set, or the status endpoint withholds
the CID by design.

---

## What is being claimed

1. The file is stored on the **Sia network**, split and encrypted across many
   independent hosts.
2. Its identifier is a **CID** — a BLAKE3 hash of the content — so the bytes can
   be proven unaltered by anyone.
3. **Any S5 node can locate it by CID**, not only Serey's.

Step 3 below is the one that actually proves something. The rest is context.

---

## Step 1 — Upload the file and read back its own CID

Send the bytes with a single tus request, using the scoped token:

```bash
FILE=<your file>

curl -s -X PATCH "$UPLOAD_URL" \
  -H "x-upload-key: $TOKEN" \
  -H "tus-resumable: 1.0.0" \
  -H "upload-offset: 0" \
  -H "content-type: application/offset+octet-stream" \
  --data-binary "@$FILE" \
  -o /dev/null -w 'patch: %{http_code}\n'
```

`204` means accepted. Now poll until processing finishes — the file is
converted, scanned, and published:

```bash
for i in $(seq 1 40); do
  curl -s "$STATUS_URL" -H "x-upload-key: $TOKEN" | tee /tmp/status.json; echo
  grep -q '"state":"ready"\|"state":"rejected"\|"state":"failed"' /tmp/status.json && break
  sleep 2
done
```

Record from the final response: `state`, `url`, and **`s5_cid`**.

**Pass condition:** `state` is `ready` and `s5_cid` is a string beginning with
`z`. That CID was produced by the storage system from the bytes you supplied —
you did not receive it from anyone.

## Step 2 — Resolve that CID on a node Serey does not control

Open **https://cid.one/** and paste the `s5_cid` from Step 1.

Record:

- **Size** in bytes
- **Multihash type** — expect `BLAKE3 256-bits (0x1f)`
- **Hash** — the 64-character hex string
- **Available Storage Locations** — the URL listed
- The line at the very bottom, e.g. `// fetched from https://s5.garden`

**Pass condition:** the bottom line names a node that is *not*
`storage.serey.io`. That means an independent node in the S5 network resolved
the identifier.

---

## Step 3 — Fetch the bytes and verify the hash yourself

This is the proof. Download from the storage location Step 2 reported, then hash
what you received:

```bash
curl -sL "<storage location URL from Step 2>" -o /tmp/blob.bin
ls -l /tmp/blob.bin
```

```bash
b3sum /tmp/blob.bin
b3sum "$FILE"          # the file you uploaded; both must be identical
```

If `b3sum` is unavailable:

```bash
pip install blake3 -q
python3 -c "
import blake3,sys
for f in ['/tmp/blob.bin', sys.argv[1]]:
    print(f, blake3.blake3(open(f,'rb').read()).hexdigest())" "$FILE"
```

**Pass conditions:**

- the file size matches the **Size** from Step 2
- the hash matches the **Hash** from Step 2
- the hash also matches BLAKE3 of the file you uploaded, which you still have

A match means the bytes are provably the exact content the CID names. It cannot
be faked: changing one byte changes the hash. No trust in Serey is required for
this step.

---

## Step 4 — Confirm ordinary web delivery

```bash
curl -sI "<the url field from Step 1>"
```

**Pass condition:** `200` with `content-type: image/webp`.

This is the path a normal visitor's browser uses. It resolves the ULID to the
CID server-side, so the address stays stable even if the storage backend
changes later.

---

## Step 5 — Report

State plainly, with the values observed:

1. The CID the system produced for your own file.
2. Which node resolved it, and was it independent of Serey?
3. Did the fetched bytes hash to the value the CID claims, and to your original?
4. Did normal web delivery return the image?

---

## What this does and does not prove

**Proved:** the content is addressed by its own hash, verifiable by anyone; an
independent node can find it; the bytes are on the Sia network.

**Not proved, and worth being honest about:** the bytes are *delivered* from
Serey's server. Other nodes can locate the file, but they fetch it through
Serey's gateway. This is a consequence of client-side encryption — the copies on
Sia hosts are ciphertext, and only the holder of the recovery phrase can decrypt
them, so no third party can serve the file on Serey's behalf.

If Serey's server is offline, the CID will not load, even though the bytes remain
safe on Sia. Recovery means standing up another gateway with the same recovery
phrase. That is a durability guarantee, not a high-availability one.

**Also worth stating:** a CID, once shared, is permanent. Anyone holding it can
fetch the file indefinitely and there is no way to revoke it. This is why only
public media is stored this way; paid content is served from local disk behind
expiring signed URLs and never gets a CID.

---

## Moderation, verified separately

Content scanning cannot be tested without an account, so it is a separate
exercise.

### Anyone with a Serey account

Upload an ordinary photo through the site — it should publish normally. Then
upload one containing weapons or injury and report what happens.

**Expected, and it surprises people:** a legitimate photo of a firearm publishes
**normally**. Weapons are deliberately not a rejection category — a gun in a
photograph is not grounds for removal on a social platform, and counting it
would bury the review queue in ordinary pictures. Only sexual content and
violence are scored, and only a high-confidence result is refused outright;
anything borderline is held for a human rather than deleted.

### Serey staff only — the deterministic demonstration

This is the better demonstration because it cannot fail ambiguously.

1. Upload an image. It publishes.
2. Record its fingerprint on the blocklist (staff endpoint, requires the
   operator key).
3. Upload the identical image again.

**Expected:** the second upload is refused with `rejected_by_scan`, and no file
is published. This shows that a takedown also prevents the same content from
being re-uploaded — using a local fingerprint comparison, with no AI involved
and no per-upload cost.

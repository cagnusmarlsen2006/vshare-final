# Vshare: résumé material

All facts below come from the code in this repository and from tests and benchmarks that
were actually run (see `docs/test-results.txt` and `docs/benchmark.txt`). Nothing here
claims production traffic or users. Cloudinary, Docker and AWS deployment were **not**
verified in the build sandbox; verify them yourself before claiming them as done.

## Title

**Vshare: Self-Destructing Encrypted File Sharing** (Node.js, Express, SQLite, Cloudinary, Docker, AWS EC2)

## One-line description

A secure file-sharing web app whose links self-destruct after a time or download limit,
with per-file AES-256-GCM envelope encryption so the storage provider only ever holds ciphertext.

## Résumé bullets

- Built a self-destructing file-sharing web app (**Node.js / Express 5, SQLite, Cloudinary**)
  with time- and download-based expiry, optional password protection and private delete
  links, served from a single port with a dependency-free vanilla-JS frontend.
- Implemented **envelope encryption**: a random 256-bit key per file, **AES-256-GCM streamed**
  before upload and wrapped with a master key, with the file id bound as AAD, so the storage
  provider only stores ciphertext; tamper detection aborts the download and rolls back the count.
- Prevented over-downloading under concurrency with a **single atomic SQL `UPDATE`** plus
  rollback on aborted or failed transfers; verified that **6 simultaneous requests for a
  1-download file yield exactly one success**.
- Designed a **fully streaming** upload/download pipeline (busboy → size meter → cipher →
  storage) with mid-stream size enforcement and partial-object cleanup; server peak memory
  stayed **~113 MB for both 100 MB and 500 MB files** in a local benchmark.
- Hardened the app with **scrypt + constant-time comparison**, a 5-attempt / 15-minute
  lockout, per-IP rate limiting, a **strict CSP with no inline code**, hashed delete tokens and
  log redaction; wrote **31 end-to-end tests** (Node's built-in test runner) passing on
  Node 18, 20 and 22, and containerised it (non-root multi-stage Dockerfile, health check)
  with GitHub Actions CI and an EC2 + EBS + Caddy HTTPS + SSM deployment guide.

*(Pick 3 to 4 bullets for a one-page résumé. If you deploy it on AWS yourself, you can add
"Deployed on AWS EC2 behind Caddy HTTPS with secrets in SSM Parameter Store".)*

## Interview questions and answers

**1. Why AES-256-GCM rather than AES-CBC or AES-CTR?**
GCM is *authenticated* encryption: besides confidentiality it produces a 16-byte tag, so any
modification of the ciphertext (or of the bound AAD, here the file id) is detected. CBC and
CTR alone are malleable and would need a separate HMAC (encrypt-then-MAC) done correctly. GCM
is also a stream mode with no padding, so the ciphertext has exactly the plaintext length and
I can send `Content-Length` = original size. It's hardware-accelerated (AES-NI) and built into
Node's `crypto`. The trade-off is that the tag is only checked at the end of a stream, so I
withhold the last chunk until `final()` verifies it, and I document the remaining gap.

**2. Why envelope encryption instead of one key for everything?**
Each file has its own random data key; only the small wrapped key depends on the master key.
That limits the blast radius (one leaked data key exposes one file), makes per-file deletion
meaningful (drop the wrapped key and the ciphertext is useless), avoids GCM IV-reuse risk across
huge numbers of files under one key, and enables key rotation by re-wrapping 32-byte keys
instead of re-encrypting every file. It also maps directly to AWS KMS
(`GenerateDataKey`/`Decrypt`) if the master key moves there.

**3. Why an atomic `UPDATE … WHERE downloads < max` instead of read-check-write?**
Read-check-write has a race window: two requests both read `downloads = 0`, both pass the
check, both download. Putting the condition in the `WHERE` clause of a single statement
makes the database the arbiter: SQLite serialises writers, so only one statement sees the
row matching and gets `changes = 1`. The same pattern works in PostgreSQL (row lock) or
DynamoDB (conditional update), so it scales with the architecture. I tested it with 6
concurrent requests.

**4. What happens if a download fails halfway?**
The claim is made before streaming starts. If the pipeline errors (client abort, storage
error, GCM tag failure) I decrement `downloads` again. A separate `completed_downloads`
counter decides when a file is used up and gets purged, so a file is never deleted while a
parallel download is still streaming. Both paths are covered by tests (interrupted download
and tampered ciphertext).

**5. Why stream everything instead of buffering?**
Memory. Buffering means every concurrent upload or download holds the whole file in RAM:
ten 100 MB transfers would need about 1 GB on a 1 GB free-tier instance. With streams and
backpressure, memory is bounded by buffer sizes, not file sizes: my benchmark showed the
same ~113 MB peak for 100 MB and 500 MB files. It also means plaintext never has to be
written to a temp file, and I can enforce the size limit mid-stream and abort early.

**6. Why does opening the link not count as a download?**
Chat apps and email scanners fetch links to build previews. If GET counted, a preview bot
would consume a one-time link before the human ever saw it. Only a POST from the Download
button counts. HEAD is handled explicitly because Express otherwise routes HEAD to the GET
handler, and GET on the download URL just redirects to the page.

**7. How do you protect password-protected files from brute force without letting attackers
destroy them?**
scrypt makes each guess expensive in CPU and memory, and comparisons use
`timingSafeEqual`. After 5 consecutive wrong attempts the file is locked for 15 minutes,
recorded atomically with `UPDATE … RETURNING`, plus a per-IP rate limit. I deliberately
never delete on failures: "delete after N wrong guesses" would let anyone with the link
destroy someone else's file.

**8. Why SQLite, and how would you scale it?**
For a single instance, SQLite (WAL mode) is fast, transactional and needs no separate
server, which keeps the free-tier deployment simple. Its limit is one host with one writer
process, and I also keep in-flight transfer bookkeeping in memory. To scale out: metadata in
RDS PostgreSQL or DynamoDB with the same conditional-update pattern, blobs in S3, shared rate
limiting in Redis, a single scheduled cleanup job, and stateless containers behind an ALB.

**9. How does the delete link stay secure?**
The token is `nanoid(32)` (~190 bits), shown once, and only its SHA-256 hash is stored, so a
database leak doesn't reveal working delete links. Comparison is constant-time. GET only
shows a confirmation page; deletion requires a POST with the token in the body, so link
scanners can't trigger it. The token is redacted from request logs and pages send
`Referrer-Policy: no-referrer`.

**10. What are the honest limitations?**
The server sees plaintext while it encrypts and decrypts, so users must trust the operator;
client-side encryption with the key in the URL fragment would fix that. The master key sits on
the same host as the database (KMS would improve it). There's no virus scanning, the
Cloudinary free plan caps raw files at 10 MB, and SQLite pins it to one instance.

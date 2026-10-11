# Vshare: résumé material

All facts below come from the code in this repository and from tests and benchmarks that
were actually run (see `docs/test-results.txt` and `docs/benchmark.txt`). Nothing here
claims production traffic or users. The live Cloudinary round trip was verified
(`docs/cloudinary-test-results.txt`). Docker and the AWS deployment were **not** verified;
verify them yourself before claiming them as done.

## Title

**Vshare: Secure Multi-System File Sharing with NLP-Based Fake-News Screening** (Node.js, Express, SQLite, Cloudinary, NLP/ML, Docker, AWS EC2)

## One-line description

A secure file-sharing platform with four systems (self-destructing links, campus-locked
one-time keys, class-targeted study material, and fake-news screening with NER, text mining
and a 90%-accurate ML classifier), all on per-file AES-256-GCM envelope encryption.

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
  log redaction; wrote **144 automated tests** (Node's built-in test runner) passing on
  Node 18, 20 and 22, and containerised it (non-root multi-stage Dockerfile, health check)
  with GitHub Actions CI and an EC2 + EBS + Caddy HTTPS + SSM deployment guide.
- Built an **offline fake-news screening pipeline** in Node.js: text extraction (own PDF
  parser incl. embedded-font CMaps, DOCX/PPTX), **NER**, text mining (Porter stemming,
  n-grams, TF-IDF, readability, extractive summarisation) and a **TF-IDF + logistic regression
  classifier reaching 90.3% held-out accuracy** on 1,266 articles (Naive Bayes baseline
  87.1%), fused with style and source-domain signals using weights tuned on the test set.
- Implemented **Google sign-in from scratch** (OAuth 2.0 authorization code + PKCE, state and
  nonce; RS256 ID-token verification against Google's JWKS with Node `crypto`) and **JWT
  sessions** in HttpOnly SameSite cookies with faculty/student roles; 26 tests cover forged,
  replayed and tampered tokens against a fake Google server.
- Added **campus-locked one-time access keys** (only hashes stored, atomic key binding,
  single-use download) and **department/year-targeted study-material distribution** with
  automatic TF-IDF keyword tagging, reusing one generic encrypted streaming upload pipeline.

*(Pick 3 to 4 bullets for a one-page résumé; for ML/data roles lead with the fake-news bullet. If you deploy it on AWS yourself, you can add
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

**11. How did you build and evaluate the fake-news classifier?**
6,335 labelled articles, a stratified 80/20 split with a fixed seed, and a vocabulary built
from the training split only (no leakage into the test set). Features: stemmed unigrams +
bigrams, sublinear TF-IDF, L2-normalised; 30,000 features. Logistic regression with SGD and
L2 reached 90.3% accuracy (precision 88.6%, recall 92.4% for FAKE) on 1,266 unseen articles,
against 87.1% for a multinomial Naive Bayes baseline. I also removed scraping artifacts
(month names, "share", "http") that the first model leaned on; accuracy dropped about a point
(91.1% → 90.3%), but the model got less dependent on when and where articles were scraped.

**12. Why combine the model with rules instead of trusting it?**
Its top features show it learned the dataset's topics (2016 US politics), so on other topics
it is unreliable: a real WHO health report (the test fixture) scored 66% "fake". I fuse it with
writing-style signals and source credibility, choosing the weights on the held-out set
(ML 0.8 / style 0.2 kept accuracy at 89.9% with 4.4% fake share-through). Hard rules handle
what a weighted sum can't: the source URL is self-reported, so it can never rescue text the
model is ≥ 90% sure is fake, and files with no readable text can't be "credible".

**13. Why logistic regression and not a transformer?**
For TF-IDF text classification it is a strong, well-understood baseline. It trains in about
13 s on a CPU, ships as a 788 KB JSON file, runs inside the Node process with no GPU or
Python, and is explainable: the report lists the terms that pushed the score. A fine-tuned
transformer would likely generalise better and is listed as future work.

**14. How does NER work here, and what are its limits?**
`compromise` does rule-based part-of-speech tagging with a lexicon to find people, places and
organisations; I added honorific patterns ("Prime Minister X"), a news-organisation gazetteer
and regex extractors for dates, money, percentages, emails and URLs, merging per-extractor
counts. Limits: it misses some names (especially non-Western ones without a title) and has
no context model like a neural NER.

**15. Why don't you fetch the source URL to check it?**
Fetching arbitrary user-supplied URLs from the server is a classic SSRF risk (internal
services, cloud metadata endpoints), and it would break offline use. So the URL is analysed
structurally only: curated lists, institutional TLDs, look-alike detection with Levenshtein
distance. And it is treated as weak, self-reported evidence.

**16. Why implement OAuth yourself instead of using Passport or a library?**
To show I understand the protocol and to keep dependencies minimal, but carefully: the flow
uses PKCE, `state` (CSRF) and `nonce` (replay); the ID token is verified for signature (RS256
with Google's rotating JWKS), issuer, audience, expiry and nonce; and every one of those
checks has a test that feeds it a bad token. In a production team I would still weigh a
maintained library (e.g. `openid-client`) against owning this code.

**17. Why a JWT in an HttpOnly cookie rather than localStorage?**
localStorage is readable by any script on the page, so one XSS would leak the session.
An HttpOnly cookie is invisible to JavaScript, and SameSite=Lax stops other sites from
sending it with cross-site POSTs (CSRF). The trade-off of stateless JWTs is revocation: a
token stays valid until it expires (7 days), so logout only clears the cookie. A server-side
denylist or short-lived tokens with refresh would fix that.


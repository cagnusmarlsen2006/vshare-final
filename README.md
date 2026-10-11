# Vshare: secure file sharing, four ways

Vshare is one Node.js app with **four file-sharing systems** behind a common hub, plus an
offline help **chatbot** on every page:

| System | What it does |
|---|---|
| **Self-Destructing File Sharing** | A link that destroys itself after a time limit (10 min to 7 days) and/or N downloads (1 to 10), optional password, private delete link |
| **Context-Based File Sharing** | Faculty upload with a **one-time access key locked to a campus**; students download only with the key **and** the right campus, once |
| **Study Material Smart Distribution** | Faculty upload once for a **department + year**; students list their class's material; documents are auto-tagged with **TF-IDF keywords** |
| **Fake News Proof File Sharing** | **NER + text mining + a machine-learning classifier + source checks** score a document's credibility; only credible files get a share link, the rest are deleted |

Every file in every system is encrypted with its own AES-256-GCM key **before it leaves the
server**, so the storage provider (Cloudinary) only ever holds ciphertext.

Built as an AWS course project and portfolio piece: one Node.js process serves the API
and the frontend, with SQLite for metadata and Cloudinary for (encrypted) blobs. The NLP
and ML run **inside the app, offline** (no external AI service).

![Hub](docs/screenshots/09-hub.png)

---

## Contents

- [Features](#features)
- [The three additional systems](#the-three-additional-systems)
- [NLP and machine learning (fake-news detection)](#nlp-and-machine-learning-fake-news-detection)
- [Tech stack](#tech-stack)
- [Quick start on Windows (PowerShell)](#quick-start-on-windows-powershell)
- [Quick start on macOS / Linux](#quick-start-on-macos--linux)
- [Configuration](#configuration)
- [Architecture](#architecture)
- [Security design](#security-design)
- [Testing and real results](#testing-and-real-results)
- [Docker](#docker)
- [Deploy on AWS](#deploy-on-aws)
- [Limitations (honest)](#limitations-honest)
- [Future work](#future-work)
- [Project structure](#project-structure)
- [Screenshots](#screenshots)

---

## Features

Self-destructing sharing (the original core, reused by every system):

| | Feature |
|---|---|
| ⬆️ | Drag-and-drop or click upload of any file type, with **real upload progress** (XHR) and clear messages for too-large or failed uploads |
| ⏱️ | Destruction rules, **combinable**: expire after 10 min / 1 h / 1 day / 7 days, and/or after N downloads (1 to 10) |
| 🔑 | Optional password per file (scrypt + constant-time comparison) |
| 🔗 | Share link with copy button + a **private "delete now" link** |
| 📄 | Download page with file name, size, remaining downloads, **live countdown**, password field. **Opening the page never uses up a download** |
| 💨 | Expired, used-up or deleted files show a friendly *"This file has self-destructed"* page (**HTTP 410**) with a CSS-only "poof" |
| 🔐 | **Envelope encryption**: random 256-bit key per file, AES-256-GCM, streamed; key wrapped with a `MASTER_KEY` |
| 🧹 | Cleanup every minute (node-cron) and at startup: expired, used-up and abandoned partial uploads are removed from storage **and** DB; files are deleted right after their final allowed download |
| ❤️ | `GET /healthz` → `ok` for Docker / AWS health checks |
| 🎨 | Claymorphism UI: plain HTML/CSS/vanilla JS, no build step, no CDN, works offline; responsive to 360 px; keyboard + screen-reader friendly; respects `prefers-reduced-motion` |
| 💬 | **Help chatbot** (bottom-right on every page): offline intent classifier (stemming + TF-IDF + cosine similarity) that answers how-to, security and ML questions with links. Nothing is stored |

## The three additional systems

### Context-Based (campus-locked) File Sharing · `/context.html`

1. **Faculty** choose a campus and press **Generate key** → a one-time key like
   `VS-7KQM-2XWD-9FHT-4RNC` (16 symbols from a 31-character alphabet without look-alikes,
   ≈79 bits). Only its SHA-256 is stored, with the campus, as a reservation valid for 1 hour.
2. Faculty upload the file with the key. The key is **atomically bound** to exactly one file
   (`UPDATE … WHERE file_id IS NULL`), so the same key can never carry two uploads.
3. **Students** pick their campus and paste the key. A check endpoint shows the file name
   first (uses nothing up); the real download is a normal form POST that goes through the
   same **atomic one-download claim** as share links, so the key dies after one download.
   Wrong campus → *"This key is locked to a different campus"* (403).
4. These files are **not reachable by their `/f/:id` link**, only by key + campus.

![Campus sharing](docs/screenshots/11-campus-faculty.png)

> Campus verification is "key + selected campus" (your chosen design). A student could
> select the campus without being there; IP-range or GPS checks are listed under future work.

### Study Material Smart Distribution · `/study.html`

- Faculty choose **department** (CSE, IT, ECE, EEE, MECH, CIVIL, AI & DS; configurable),
  **year** (1 to 4), **subject**, **material type** (Notes, Question Bank, Assignment,
  Syllabus, Reference) and how long to keep it (30 / 90 / 180 days), then upload.
- Text documents (PDF, DOCX, PPTX, TXT, HTML) are **auto-tagged with TF-IDF keywords**
  extracted from their content (text mining), e.g. *measles, immunity, europe…*
- Students pick department + year (and optionally a type) and get their class's list; each
  item opens the normal download page with class badges. No download limit.

![Study material](docs/screenshots/13-study.png)

### Fake News Proof File Sharing · `/verify.html`

Upload a document (PDF, DOCX, PPTX, TXT, HTML; max 10 MB because it is analysed in memory)
with its **source URL** and optionally your **trusted domains**. The file is encrypted and
stored as usual while a plaintext copy in RAM (never on disk) goes through the NLP pipeline
below. **Credible (≥ 65/100)** → a self-destructing share link + the full report.
**Uncertain or likely fake** → HTTP 422 with the report, and the stored file is **deleted**.
The share page of a verified file shows *"✓ Verified · credibility N/100 · Source: …"*.

| Credible (shared) | Likely fake (rejected) |
|---|---|
| ![Credible](docs/screenshots/14-verify-credible.png) | ![Rejected](docs/screenshots/15-verify-rejected.png) |

## NLP and machine learning (fake-news detection)

All of it runs inside the Node.js process, offline. Code: [`src/nlp/`](src/nlp/).

```mermaid
flowchart LR
  F["Uploaded file<br/>(RAM copy only)"] --> X["Text extraction<br/>PDF (incl. CID fonts) · DOCX · PPTX · HTML · TXT"]
  X --> T["Text mining<br/>normalise · tokenise · stop words · Porter stemming<br/>uni+bigrams · TF-IDF · readability · style signals"]
  X --> N["NER<br/>people · organisations · places (compromise)<br/>+ titles/gazetteer · dates · money · % · emails · URLs (regex)"]
  T --> M["ML classifier<br/>TF-IDF + logistic regression<br/>P(fake)"]
  T --> S["Style score<br/>clickbait words · ALL-CAPS · '!' ·<br/>attribution · quotes · named sources"]
  N --> S
  U["Source URL<br/>(never fetched)"] --> C["Source credibility<br/>trusted list · reputable / unreliable / satire lists ·<br/>.gov/.edu/.ac.in · look-alike domains · IP hosts"]
  M --> FU["Fusion + rules<br/>→ credibility 0-100 + verdict + reasons"]
  S --> FU
  C --> FU
  T --> K["Keywords (TF-IDF) +<br/>extractive summary"]
```

**Concepts used (all implemented in this repo, tested in `test/nlp.test.js`):**

| Area | What | Where |
|---|---|---|
| Text extraction | ZIP reader for DOCX/PPTX, PDF content-stream parser (FlateDecode, `Tj`/`TJ`, ToUnicode CMaps for embedded/CID fonts), HTML stripping; zip-bomb limits | `extract.js` |
| Text mining | Unicode normalisation, sentence splitting (abbreviation-aware), tokenisation, stop-word removal, **Porter stemmer** (verified against reference outputs), **n-grams**, **TF-IDF**, keyword extraction, **extractive summarisation**, Flesch readability, stylometric signals | `text.js`, `analyze.js` |
| NER | `compromise` (offline rule-based POS tagging + lexicon) for PERSON / PLACE / ORGANIZATION, plus honorific patterns, a news-organisation gazetteer and regex extractors for DATE / MONEY / PERCENT / EMAIL / URL; per-extractor counts merged | `ner.js` |
| ML | **TF-IDF + logistic regression** (SGD, L2, sublinear TF, L2-normalised vectors) vs a **multinomial Naive Bayes** baseline; stratified 80/20 split with a fixed seed; vocabulary built from training data only (no leakage) | `classifier.js`, `scripts/train-fake-news.js` |
| Source analysis | Registrable-domain parsing, curated lists, institutional TLDs, **look-alike detection** (Levenshtein distance, brand + extra words, `.com.co`) | `source.js` |
| Chatbot | Intent classification with stemming + TF-IDF + **cosine similarity** | `chatbot.js` |

### Real model results

Dataset: **`fake_or_real_news.csv`** (G. McIntire; 6,335 labelled English news articles,
2015-2016, balanced FAKE/REAL; mirrored at github.com/lutzhamel/fake-news). It is downloaded
by `npm run train:model` and **not** redistributed here. Held-out test set: **1,266
articles** never seen in training. Output in [`docs/ml-metrics.json`](docs/ml-metrics.json).

| Model (30,000 features) | Accuracy | Precision (FAKE) | Recall (FAKE) | F1 (FAKE) |
|---|---|---|---|---|
| **TF-IDF + logistic regression** (shipped) | **90.3%** | 88.6% | 92.4% | 90.5% |
| Multinomial Naive Bayes (baseline) | 87.1% | 87.1% | 87.2% | 87.1% |

Confusion matrix (logistic regression): 584 fake caught, 559 real passed, 75 real wrongly
flagged, 48 fake missed. Training takes ~13 s on a 4-vCPU machine; the model file is 788 KB.

**Fusion weights were chosen on the same held-out set** (`npm run eval:fusion`,
[`docs/ml-fusion-eval.txt`](docs/ml-fusion-eval.txt)). Without a source URL the score is
0.8 × (1 − P(fake)) + 0.2 × style; with one, 0.5 / 0.15 / 0.35 (ML / style / source).
At the chosen 0.8 / 0.2, accuracy is 89.9% and **4.4% of the files that would be shared are
fake** (vs 3.3% for ML alone), while fewer real articles are wrongly rejected (35 vs 57).

**Rules on top of the weighted score:**
- A known unreliable, satire, look-alike, IP-address or invalid source caps the score at 35.
- P(fake) ≥ 0.9 caps the score at 40: the source URL is **self-reported** (never fetched),
  so it can never rescue text the model is sure is fake.
- *Provenance rule:* a reputable or trusted source + sober, attributed writing
  (style ≥ 75) + P(fake) < 0.8 lifts the score to the sharing threshold.
- No readable text (e.g. a scanned image) → at most "uncertain": it cannot be verified.

**Honest caveat.** The model learned the dataset's world: 2015-2016 US politics. Its top
"fake" indicators include topical words (*hillary, wikileaks, russia*), so on other topics
(health, science, campus news) it is much less reliable. Example: the genuine WHO measles
report in `test/fixtures/real-article.txt` scores P(fake) = 0.66 from the model alone. That is why the verdict also uses style and source
signals, why the thresholds are conservative, and why the report always shows its reasons.
It is a **screening aid, not a fact-checker**.

## Tech stack

| Layer | Choice |
|---|---|
| Runtime | Node.js 18+ (tested on 18.20.8, 20.20.2 and 22.22.0), CommonJS |
| Web | Express 5 (API **and** static frontend on one port), helmet (strict CSP), express-rate-limit |
| Uploads | busboy (streaming multipart parser) |
| Database | SQLite via better-sqlite3 (WAL mode), auto-created on first run |
| Storage | Cloudinary (`resource_type: "raw"`, `type: "authenticated"`, `upload_stream`, signed downloads streamed through the server). Local mock storage with `STORAGE=mock` |
| Crypto | Node `crypto`: AES-256-GCM, scrypt, `timingSafeEqual`, SHA-256 |
| Jobs | node-cron |
| IDs | nanoid v3 (CommonJS-compatible) |
| Config | dotenv |
| NLP / ML | `compromise` (offline NER) + own code: text extraction, Porter stemmer, TF-IDF, logistic regression, Naive Bayes, source analysis, chatbot |
| Tests | Node's built-in `node:test` + `assert` (no test framework dependency) |

---

## Quick start on Windows (PowerShell)

Requires **Node.js 20 or 22 LTS** (x64). `better-sqlite3` ships prebuilt binaries for these.

### Offline mode (no Cloudinary account needed): three commands

```powershell
npm install
npm run start:mock
Start-Process http://localhost:3000
```

`start:mock` stores encrypted files in `.mock_storage\` instead of Cloudinary.

### With Cloudinary: three commands

```powershell
npm install
Copy-Item .env.example .env ; notepad .env   # fill in the 3 CLOUDINARY_* values
npm start
```

Then open <http://localhost:3000> (the hub; each system has its own page). If the port is busy you get a clear message; use
`$env:PORT=3001; npm start`.

> If Cloudinary credentials are missing and `STORAGE` is not `mock`, the server prints
> what is missing and exits cleanly instead of crashing.

## Quick start on macOS / Linux

```bash
npm install
npm run start:mock          # offline, or: cp .env.example .env && npm start
open http://localhost:3000  # xdg-open on Linux
```

---

## Configuration

All variables are optional except the Cloudinary credentials when `STORAGE=cloudinary`.
The size limit is defined in exactly one place: [`src/config.js`](src/config.js)
(`MAX_FILE_SIZE_BYTES`).

| Variable | Default | Description |
|---|---|---|
| `STORAGE` | `cloudinary` | `cloudinary` or `mock` (local folder, offline) |
| `CLOUDINARY_CLOUD_NAME` | | Cloudinary cloud name (required for `cloudinary`) |
| `CLOUDINARY_API_KEY` | | Cloudinary API key (required for `cloudinary`) |
| `CLOUDINARY_API_SECRET` | | Cloudinary API secret (required for `cloudinary`) |
| `CLOUDINARY_FOLDER` | `vshare` | Folder prefix for stored objects |
| `MASTER_KEY` | *(generated)* | 32-byte key as 64 hex chars (or base64). If empty, one is generated **once** and saved to `DATA_DIR/.master.key` (git-ignored, mode 600). **Losing it makes all stored files unreadable.** Never logged. |
| `PORT` | `3000` | HTTP port |
| `HOST` | `0.0.0.0` | Bind address |
| `DATA_DIR` | `./data` | SQLite database (`vshare.db`) and `.master.key` |
| `MOCK_STORAGE_DIR` | `./.mock_storage` | Where mock storage writes ciphertext objects |
| `MAX_FILE_SIZE_BYTES` | 10 MB (cloudinary) / 100 MB (mock) | Upload limit. Cloudinary's **free plan caps raw uploads at 10 MB**, hence the default |
| `TRUST_PROXY` | `false` | Set to `1` behind exactly one reverse proxy (Caddy/nginx) so rate limiting sees real client IPs |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`, `silent` |
| `CAMPUSES` | `Main Campus,North Campus,South Campus,City Campus` | Comma-separated campus names for context-based sharing |
| `DEPARTMENTS` | `CSE,IT,ECE,EEE,MECH,CIVIL,AI & DS` | Comma-separated departments for study-material distribution |
| `NODE_ENV` | `development` | `production` in Docker. `test` (with `STORAGE=mock` only) enables test hooks |

Generate a master key:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

**Test-only hooks.** `expiry_seconds` (short expiry), `TEST_MAX_FILE_SIZE_BYTES` (tiny
limit) and `POST /__test__/cleanup` exist **only** when `STORAGE=mock` **and**
`NODE_ENV=test`. There is no other switch; a test verifies they are rejected/absent
otherwise.

---

## Architecture

```mermaid
flowchart LR
  subgraph Client["Browser"]
    UI["Upload page<br/>(vanilla JS, XHR progress)"]
    DL["Download page<br/>(HTML form POST)"]
  end

  subgraph Server["Node.js / Express (single process, one port)"]
    H["helmet CSP + rate limits"]
    UP["POST /api/upload<br/>busboy → size meter → AES-256-GCM"]
    D["POST /f/:id/download<br/>atomic claim → decrypt → stream"]
    PG["GET /f/:id, delete pages<br/>(server-rendered, no side effects)"]
    C["node-cron cleanup<br/>every minute + at startup"]
    K["MASTER_KEY<br/>(.env or DATA_DIR/.master.key)"]
  end

  DB[("SQLite (WAL)<br/>metadata, wrapped keys,<br/>IVs, auth tags, counters")]
  CL[("Cloudinary<br/>raw + authenticated<br/>ciphertext only")]

  UI -- multipart --> H --> UP
  DL -- form POST --> H --> D
  DL -- GET --> PG
  UP -- ciphertext stream --> CL
  D -- signed URL stream --> CL
  UP & D & PG & C --> DB
  C -- delete --> CL
  K -. wraps / unwraps file keys .-> UP & D
```

### Upload sequence

```mermaid
sequenceDiagram
  autonumber
  participant B as Browser
  participant S as Express + busboy
  participant DB as SQLite
  participant CL as Cloudinary

  B->>S: POST /api/upload (expiry, max_downloads, password, THEN file)
  S->>S: validate settings (reject if any field arrives after the file)
  S->>S: dataKey = random 32 bytes, wrap with MASTER_KEY (AES-256-GCM, AAD = id)
  S->>DB: INSERT row status = 'pending' (wrapped key, IVs, token hash)
  loop for every chunk (never buffered, never written to disk in plaintext)
    S->>S: size meter (abort over limit) → AES-256-GCM encrypt
    S->>CL: upload_stream(ciphertext chunk)
  end
  CL-->>S: stored (raw, authenticated)
  S->>DB: UPDATE status = 'active', size, auth tag, scrypt(password), expires_at
  S-->>B: 201 { sharePath, deletePath (token shown once) }
  Note over S,CL: On abort / over-size / storage error: destroy the streams,<br/>delete the partial object and the pending row
```

### Download sequence

```mermaid
sequenceDiagram
  autonumber
  participant B as Browser
  participant S as Express
  participant DB as SQLite
  participant CL as Cloudinary

  B->>S: GET /f/:id (link previews too)
  S->>DB: SELECT (read only, never counts)
  S-->>B: page: name, size, remaining, countdown, password field
  B->>S: POST /f/:id/download (password in body)
  S->>S: verify scrypt (timingSafeEqual); 5 failures → lock 15 min
  S->>DB: UPDATE downloads = downloads + 1 WHERE active AND not expired<br/>AND not locked AND downloads < max (one atomic statement)
  alt 0 rows changed
    S-->>B: 410 "This file has self-destructed"
  else claimed
    S->>CL: GET signed URL (streamed)
    CL-->>S: ciphertext stream
    S->>S: unwrap key → AES-256-GCM decrypt (last chunk held until tag verifies)
    S-->>B: 200 stream, Content-Length = original size, Content-Disposition (RFC 5987)
    alt finished
      S->>DB: completed_downloads + 1 → purge storage + row if it was the last one
    else client abort / auth-tag failure / storage error
      S->>DB: downloads - 1 (rollback, the download was not used up)
    end
  end
```

---

## Security design

### Envelope encryption (AES-256-GCM)
- Each upload gets a fresh random **256-bit data key** and a random 96-bit IV.
- The file is encrypted **as a stream** (busboy → size meter → `createCipheriv('aes-256-gcm')`
  → storage). Plaintext is never written to disk and never buffered as a whole.
- The data key is **wrapped** with the `MASTER_KEY` (AES-256-GCM, its own IV). SQLite stores
  only the wrapped key, the two IVs and the auth tags.
- The file id is bound as **AAD** into both GCM operations, so a wrapped key or ciphertext
  copied onto another row fails authentication.
- GCM is a stream mode with no padding, so `Content-Length` = original size.
- **Tamper handling:** GCM can only verify the tag at the very end. The decrypt stream
  **withholds the most recent plaintext chunk** until `final()` verifies the tag. On a
  mismatch the connection is cut before the full `Content-Length` arrives (the browser marks
  the download as failed) and the download count is rolled back. Tested.

### Passwords
- `crypto.scrypt` (N = 2¹⁵, r = 8, p = 1, 16-byte random salt, 32-byte output), compared
  with `crypto.timingSafeEqual`. Unicode is NFKC-normalised.
- **Lockout:** 5 consecutive wrong attempts lock the file for 15 minutes (`locked_until`),
  in a single `UPDATE … RETURNING` statement. A correct password resets the counter.
  **Files are never deleted because of wrong passwords.** Plus a per-IP rate limit.
- The password travels in the POST body only, never in a URL.

### Atomic download counter
```sql
UPDATE files SET downloads = downloads + 1
WHERE id = ? AND status = 'active' AND expires_at > :now
  AND (locked_until IS NULL OR locked_until <= :now)
  AND (max_downloads IS NULL OR downloads < max_downloads)
```
One statement, so SQLite serialises it: 6 simultaneous downloads of a 1-download file
→ exactly one succeeds (tested). If the stream does not finish (client abort, decryption or
auth-tag failure, storage error) the claim is rolled back. A separate `completed_downloads`
counter decides when a file is used up, so a file is never purged while a parallel download is
still streaming.

### Only POST counts
`GET /f/:id` (and link-preview bots) only render the page. `HEAD` is handled **explicitly**
(Express would otherwise route it to GET): `HEAD /f/:id` returns the status with no body,
`HEAD /f/:id/download` returns 405. `GET /f/:id/download` redirects to the page.

### Delete links
`/f/:id/delete?token=…`: the token is `nanoid(32)` (~190 bits); only its **SHA-256** is
stored and compared with `timingSafeEqual`. `GET` shows a confirmation page; deletion only
happens on `POST` (token in a hidden form field). The token is redacted from request logs.

### Web hardening
- **helmet** with a strict CSP: `default-src 'self'; script-src 'self'; style-src 'self';
  frame-ancestors 'none'; form-action 'self'; object-src 'none'; base-uri 'none'`.
  No inline scripts or styles anywhere; dynamic data goes through `data-*` attributes and
  every value in server-rendered HTML is escaped.
- `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, `Cache-Control: no-store`
  and `X-Robots-Tag: noindex` on share pages. Risky stored MIME types (HTML, SVG, XML, JS)
  are served as `application/octet-stream`, always with `Content-Disposition: attachment`.
- **Rate limits per IP** (15-minute window): 1000 requests overall, 30 uploads,
  60 download POSTs, 30 delete requests. Relaxed only under `NODE_ENV=test`.
- Storage object ids are random `nanoid(21)` (~126 bits), validated by regex in every adapter,
  so there is no path traversal. Original file names are sanitised and used only as metadata.
- Upload size enforced **mid-stream**; partial objects are deleted on abort or error.
  Settings fields must precede the file, or the upload is rejected.
- Errors: friendly HTML for browser forms, `{ "error": "…" }` for `Accept: application/json`
  callers, correct status codes, **no stack traces** (custom final error handler).
- Secrets, keys, passwords and delete tokens are never logged. Graceful shutdown on SIGTERM.

### Threat model

| Threat | Protected? | How / why not |
|---|---|---|
| Storage provider breach (Cloudinary) | ✅ Yes | Cloudinary holds only AES-256-GCM ciphertext; keys never leave the server |
| Database file leaked on its own | ✅ Yes, for file contents | File keys are wrapped by `MASTER_KEY`; passwords are scrypt hashes; delete tokens are SHA-256 hashes |
| Guessing share links | ✅ Yes | 126-bit random ids; unknown ids return 410 |
| Password brute force | ✅ Mitigated | scrypt cost, 5-attempt / 15-minute lock per file, per-IP rate limit |
| Race to download more than allowed | ✅ Yes | Single atomic `UPDATE … WHERE downloads < max` (tested with 6 parallel requests) |
| Link previews / scanners burning a one-time link | ✅ Yes | Only `POST` counts; `GET`/`HEAD` never do |
| Tampered ciphertext in storage | ✅ Detected | GCM auth tag + AAD; last chunk withheld; count rolled back |
| XSS / clickjacking | ✅ Mitigated | Output escaping, strict CSP without `unsafe-inline`, `frame-ancestors 'none'` |
| Eavesdropping on the network | ⚠️ Only with HTTPS | Deploy behind Caddy/nginx with TLS (see AWS section) |
| Full server compromise (DB **and** `MASTER_KEY`) | ❌ No | The master key lives on the same host (use KMS to improve) |
| Malicious server operator | ❌ No | The server sees plaintext while streaming; there is no client-side encryption |
| Malware distribution | ❌ No | No virus scanning |
| Volumetric DoS | ⚠️ Partially | Rate and size limits only; no WAF / CDN in front |
| Guessing a campus access key | ✅ Yes | ≈79-bit random keys, only SHA-256 stored, per-IP rate limit on key checks |
| A key leaked to the wrong campus | ⚠️ Partially | The key also needs the matching campus, but campus is *selected*, not proven (no IP/GPS check) |
| One key carrying two uploads / two downloads | ✅ Yes | Atomic key binding and the atomic one-download claim |
| Fake document with a fake "reuters.com" source | ✅ Mitigated | Source URLs are self-reported, so P(fake) ≥ 0.9 caps the score at 40 and look-alike domains are caught |
| Carefully written misinformation in sober style | ❌ No | The model scores wording and provenance, not facts; adversarial text can pass |

---

## Testing and real results

```bash
npm test                  # starts the real server (STORAGE=mock, NODE_ENV=test) and tests it over HTTP
npm run test:cloudinary   # MANUAL: live upload/download/delete round trip against Cloudinary (needs .env)
npm run cloudinary:diagnose  # MANUAL: shows Cloudinary's exact answer if uploads fail (e.g. 403)
npm run bench             # streaming benchmark (prints server peak memory)
npm run train:model       # download the dataset (if needed) and retrain the fake-news model
npm run eval:fusion       # evaluate the fused credibility score on the held-out test set
node scripts/race-demo.js http://localhost:3000/f/<id>   # 6 parallel downloads of a live link
```

`npm test` covers: upload + download of **pdf, pptx, docx, zip, png, txt and a 20 MB file**
with byte-for-byte SHA-256 comparison; first-download-only; N downloads; expiry with a 1 s
expiry; correct / missing / wrong password; the 15-minute lockout; **6 simultaneous
downloads of a 1-download file (exactly one succeeds)**; cleanup of expired files and
abandoned partial uploads (storage + DB); oversize uploads (with `Content-Length` **and**
chunked, rejected mid-stream); HEAD/GET never count; interrupted downloads roll back;
the delete flow (GET only confirms, wrong token rejected, POST deletes); tampered ciphertext
fails and rolls back the count; settings-after-file rejected; test hooks impossible outside
test mode.

**113 tests** in four files: `vshare.test.js` and `limits.test.js` (the self-destructing core,
31 tests), `systems.test.js` (hub, campus keys, study distribution, fake-news-proof sharing,
chatbot API, DB migration; 30 tests) and `nlp.test.js` (stemmer, NER, source checks, text
extraction incl. a real Chrome-generated PDF with embedded fonts, classifier, fusion rules,
chatbot intents; 52 tests).

Real output (Node 22.22.0, Linux sandbox; durations trimmed; full output in
[`docs/test-results.txt`](docs/test-results.txt)):

```text
▶ context-based (campus-locked) sharing
  ✔ rejects an unknown campus when generating a key
  ✔ generates a one-time key for a campus (only its hash is stored)
  ✔ refuses an upload whose campus does not match the key
  ✔ refuses an upload without a generated key
  ✔ faculty upload binds the file to the key
  ✔ the same key cannot be used for a second upload
  ✔ student check: wrong campus 403, unknown key 410, malformed key 400, right campus 200 (uses nothing up)
  ✔ the file is NOT reachable through its public /f/:id link
  ✔ wrong campus on the download form gives a friendly 403 page
  ✔ student downloads with key + campus, byte-for-byte; the key then expires
▶ study-material distribution
  ✔ validates department, year, material type and subject
  ✔ distributes a document and auto-tags it with TF-IDF keywords
  ✔ binary files are distributed without keywords
  ✔ other classes do not see it; the right class does
  ✔ students download through the normal page, with class badges, any number of times
▶ fake-news-proof sharing
  ✔ credible content from a reputable source is shared, with a full report
  ✔ trusted domains given by the uploader count as a good source
  ✔ misinformation is rejected with a 422 report and nothing is kept
  ✔ a file without readable text cannot be verified
  ✔ enforces the 10 MB analysis limit
▶ download limits (self-destructing core)
  ✔ 6 simultaneous downloads of a 1-download file: exactly one succeeds
  ✔ an interrupted download is rolled back and does not count
  … (see docs/test-results.txt for all 113)
ℹ tests 113
ℹ suites 23
ℹ pass 113
ℹ fail 0
```

All 113 tests also passed on **Node 18.20.8** and **Node 20.20.2** in the sandbox.
The PDF/PNG/ZIP/DOCX/PPTX fixtures are generated in memory with correct signatures and
container structure ([`test/fixtures.js`](test/fixtures.js)).

**Streaming benchmark** (`npm run bench`, mock storage, loopback, 4-vCPU sandbox), in
[`docs/benchmark.txt`](docs/benchmark.txt). Server peak memory stays about the same
whether the file is 100 MB or 500 MB, which shows the server streams instead of buffering:

| File | Upload | Download | Server peak RSS (idle ≈ 73 MB) | SHA-256 match |
|---|---|---|---|---|
| 100 MB | 0.35 s | 0.28 s | 114.0 MB | ✅ |
| 500 MB | 2.14 s | 1.47 s | 112.9 MB | ✅ |

(Loopback numbers with local storage; real-world speed is bounded by the network and Cloudinary.)

**Live Cloudinary: verified.** `npm run test:cloudinary` PASSED against a real Cloudinary
account (run on the author's Windows machine; the sandbox cannot reach Cloudinary): 1 MB
uploaded in 3.2 s, Cloudinary held 1,048,576 bytes of **ciphertext**, the download through
the app matched SHA-256, and the delete link worked. Output in
[`docs/cloudinary-test-results.txt`](docs/cloudinary-test-results.txt).

> **Cloudinary API key role:** use a key whose role can upload (e.g. **Master Admin**). A key
> with the restricted **Media Library User** role makes every upload fail with HTTP 403
> *"missing permissions (actions=["create"])"*. Run `npm run cloudinary:diagnose` to see
> Cloudinary's exact answer (it checks the credentials and tries tiny uploads, no secrets printed).

**Not verified:** the Docker image build and the AWS deployment.

---

## Docker

```bash
cp .env.example .env            # fill in Cloudinary credentials and a MASTER_KEY
docker compose up -d --build
curl http://localhost:3000/healthz   # -> ok
```

- Multi-stage build on `node:22-bookworm-slim`; the runtime image runs as the **non-root
  `node` user**, contains only production dependencies, and has a `HEALTHCHECK` on `/healthz`.
- `/data` is a **volume** holding the SQLite DB and `.master.key`, so they survive container
  restarts and upgrades.
- `init: true` gives the container a proper PID 1 so `SIGTERM` reaches Node for a graceful shutdown.
- Docker Hub rate limits? Build from the AWS ECR Public mirror instead:
  `docker build --build-arg NODE_IMAGE=public.ecr.aws/docker/library/node:22-bookworm-slim -t vshare .`

> **Not verified in sandbox.** `docker build --check` (Dockerfile lint) reported *no warnings*
> and `docker compose config` validated the compose file, but a full image build could not
> run in the sandbox (registry rate limits and restricted egress). Please run
> `docker compose up --build` once locally.

---

## Deploy on AWS

> ⚠️ **Everything in this section is not verified in sandbox.** It is a step-by-step guide
> written for the course submission; follow it on your own AWS account.

### Target architecture

```mermaid
flowchart LR
  U["Users"] -->|HTTPS 443| SG["Security group<br/>80, 443 open; 22 from your IP only"]
  SG --> EC2
  subgraph EC2["EC2 t2.micro / t3.micro (free-tier eligible), Amazon Linux 2023"]
    CADDY["Caddy (automatic HTTPS, Let's Encrypt)"] -->|127.0.0.1:3000| APP["vshare container<br/>(non-root, HEALTHCHECK /healthz)"]
    APP --> VOL[("EBS gp3 volume<br/>mounted at /srv/vshare-data → /data<br/>SQLite + .master.key")]
  end
  APP -->|ciphertext| CLD[("Cloudinary")]
  SSM["SSM Parameter Store<br/>SecureString secrets"] -. read at boot via instance role .-> EC2
```

### 1. Launch the instance
1. EC2 → Launch instance → **Amazon Linux 2023**, **t2.micro or t3.micro** (whichever is
   free-tier eligible in your account/region), 8–20 GB gp3 root volume.
2. Add a **second EBS gp3 volume** (e.g. 5 GB) for data, so you can snapshot and re-attach it
   independently of the instance.
3. **Security group:** inbound `80/tcp` and `443/tcp` from `0.0.0.0/0` (and `::/0`), `22/tcp`
   from **your IP only**. Do **not** open 3000.
4. Attach an **IAM instance role** allowing `ssm:GetParametersByPath` on
   `arn:aws:ssm:<region>:<account>:parameter/vshare/*` (+ `kms:Decrypt` for the key used by
   SecureString).
5. Allocate an **Elastic IP** and point a DNS `A` record (e.g. `vshare.example.com`) at it.

### 2. Prepare the host
```bash
sudo dnf install -y docker git
sudo systemctl enable --now docker
sudo usermod -aG docker ec2-user && newgrp docker
# Docker Compose v2 plugin
sudo mkdir -p /usr/local/lib/docker/cli-plugins
sudo curl -sSL "https://github.com/docker/compose/releases/latest/download/docker-compose-linux-$(uname -m)" \
  -o /usr/local/lib/docker/cli-plugins/docker-compose
sudo chmod +x /usr/local/lib/docker/cli-plugins/docker-compose

# Data volume (check the device name with lsblk; often /dev/nvme1n1)
sudo mkfs -t xfs /dev/nvme1n1
sudo mkdir -p /srv/vshare-data
echo '/dev/nvme1n1 /srv/vshare-data xfs defaults,nofail 0 2' | sudo tee -a /etc/fstab
sudo mount -a
sudo chown 1000:1000 /srv/vshare-data     # the container's non-root "node" user
```

### 3. Secrets in SSM Parameter Store
Create the parameters once (from your machine or CloudShell):
```bash
aws ssm put-parameter --name /vshare/CLOUDINARY_CLOUD_NAME --type SecureString --value "<cloud>"
aws ssm put-parameter --name /vshare/CLOUDINARY_API_KEY    --type SecureString --value "<key>"
aws ssm put-parameter --name /vshare/CLOUDINARY_API_SECRET --type SecureString --value "<secret>"
aws ssm put-parameter --name /vshare/MASTER_KEY            --type SecureString \
  --value "$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
```
On the instance, render them into `.env` (re-run after rotating a secret):
```bash
git clone <your-repo-url> vshare && cd vshare
aws ssm get-parameters-by-path --path /vshare/ --with-decryption \
  --query 'Parameters[*].[Name,Value]' --output text \
  | awk '{ sub("/vshare/", "", $1); print $1 "=" $2 }' > .env
printf 'STORAGE=cloudinary\nTRUST_PROXY=1\n' >> .env
chmod 600 .env
```
*(Simpler alternative for a demo: create `.env` on the instance by hand with `chmod 600`.)*

### 4. Run the container (bound to localhost only, data on EBS)
Create `docker-compose.override.yml` next to `docker-compose.yml`:
```yaml
services:
  vshare:
    ports: !override
      - "127.0.0.1:3000:3000"
    volumes: !override
      - /srv/vshare-data:/data
```
```bash
docker compose up -d --build
docker compose ps            # STATUS shows "(healthy)" once /healthz answers
curl -s http://127.0.0.1:3000/healthz   # -> ok
```

### 5. HTTPS with Caddy
```bash
sudo dnf install -y 'dnf-command(copr)' && sudo dnf copr enable -y @caddy/caddy && sudo dnf install -y caddy
sudo tee /etc/caddy/Caddyfile >/dev/null <<'EOF'
vshare.example.com {
    encode gzip
    request_body {
        max_size 12MB
    }
    reverse_proxy 127.0.0.1:3000
}
EOF
sudo systemctl enable --now caddy
```
Caddy obtains and renews a Let's Encrypt certificate automatically (port 80 must be
reachable). With nginx instead: `proxy_pass http://127.0.0.1:3000;`,
`client_max_body_size 12m;`, `proxy_request_buffering off;`, then `certbot --nginx`.
Keep `TRUST_PROXY=1` so rate limits see the real client IP.

### 6. Health checks and operations
- **Container:** Docker `HEALTHCHECK` hits `/healthz` every 30 s; `restart: unless-stopped`
  restarts it after a crash or reboot.
- **External:** add a Route 53 health check (HTTPS, path `/healthz`) and/or a CloudWatch
  alarm on the EC2 status checks.
- **Backups:** schedule EBS snapshots of the data volume with Amazon Data Lifecycle Manager.
  The DB is useless without `MASTER_KEY` (kept in SSM), and vice versa.
- **Updates:** `git pull && docker compose up -d --build`.

### Why a single instance?
SQLite is a file on local disk with a single writer, and the app keeps in-flight download
and upload bookkeeping in memory. That is simple, fast and correct for one instance, and
fits the free tier, but **it cannot be shared by several instances**.

**What changes to scale out:**
1. Move metadata to **RDS PostgreSQL** (the atomic `UPDATE … WHERE downloads < max` maps
   directly) or **DynamoDB** (conditional `UpdateItem`).
2. Replace in-memory in-flight tracking with DB columns or leases; run cleanup in exactly one
   place (a scheduled ECS task / EventBridge + Lambda, or an advisory lock).
3. Move rate-limit counters to a shared store (ElastiCache Redis).
4. Put stateless containers behind an **Application Load Balancer** with the ALB health check
   on `/healthz`; terminate TLS at the ALB with ACM.
5. Keep `MASTER_KEY` in Secrets Manager or, better, wrap data keys with **AWS KMS**.

### Alternatives: App Runner or ECS Fargate
Both run the same container image with less server management, but **their local disk is
ephemeral**: the SQLite DB and a generated `.master.key` are lost on every redeploy or
scale event. To use them, provide `MASTER_KEY` from Secrets Manager **and** move metadata to
RDS/DynamoDB (SQLite on EFS is not recommended because of file-locking behaviour). App Runner
health checks would use `/healthz`.

---

## Limitations (honest)

- **Cloudinary raw size limit:** free plans cap raw uploads at **10 MB** (the default
  `MAX_FILE_SIZE_BYTES` for Cloudinary). Paid plans allow more; raise the variable accordingly.
- **Single-instance SQLite:** see *Why a single instance?* above.
- **`MASTER_KEY` lives on the same host** as the database (in `.env` or `.master.key`).
  Someone who compromises the server gets both. A KMS-backed key would improve this.
- **No virus/malware scanning** of uploaded files.
- **The server sees plaintext in transit**: it encrypts and decrypts on the user's behalf.
  There is **no client-side (end-to-end) encryption**; you must trust the operator.
- **GCM tag is checked at the end of a stream:** the client receives most of the plaintext
  before the tag is verified. Vshare withholds the last chunk and aborts on failure, so the
  browser marks the download as failed, but a custom client could keep the partial bytes.
  Chunked authenticated encryption (e.g. per-chunk GCM) would close this.
- Download counting happens when the server **finishes sending** the response; bytes still in
  flight to a client that disconnects at the very last moment would count.
- Time limits are fixed choices; "downloads only" (no time limit) is not offered, so every
  file has a maximum life of 7 days.
- **Fake-news model scope:** trained on 2015-2016 English political news; weaker on other
  topics and languages (see the caveat in the ML section). It estimates credibility from
  wording and provenance; it does **not** check facts against the world.
- **Source URLs are self-reported and never fetched** (by design: no SSRF, works offline), so
  they are weak evidence; the hard rules above limit how much they can help.
- **Verification keeps a plaintext copy in RAM** (max 10 MB) while analysing; never on disk.
- **Campus check = key + selected campus**, not location: a student with the key could pick
  the right campus from anywhere.
- **NER** is lexicon/rule based (`compromise` + patterns): it misses some names, especially
  non-Western ones without a title, and can mislabel capitalised words.
- **PDF extraction** handles typical generated PDFs (incl. Chrome/Word embedded fonts) but not
  scanned images (no OCR), encrypted PDFs, or exotic encodings.
- The Docker image build and the AWS deployment were **not verified** (see above). Live
  Cloudinary was verified with `npm run test:cloudinary`.

## Future work

- A transformer model (e.g. a fine-tuned DistilBERT via ONNX) and a more diverse, recent
  dataset for fake-news detection; claim-level fact-checking against trusted sources.
- Campus verification by network (IP ranges) or location; SSO login for faculty/students.
- OCR for scanned documents.

- **S3 storage adapter** (same three-method interface: `upload`, `download`, `delete`) with
  SSE-KMS, and presigned multipart uploads for large files.
- **CloudFront** in front of the app (static assets cached, TLS at the edge, AWS WAF).
- **CloudWatch** Logs (awslogs driver), metrics and alarms (5xx rate, cleanup failures, disk).
- **RDS / DynamoDB** for metadata to scale horizontally; **KMS** for key wrapping.
- Optional client-side encryption (key in the URL fragment) for end-to-end confidentiality.

---

## Project structure

```text
vshare/
├── .github/workflows/ci.yml      # npm ci + npm test (STORAGE=mock) on Node 20 and 22
├── docs/
│   ├── benchmark.txt             # real output of npm run bench
│   ├── cloudinary-test-results.txt  # live Cloudinary round trip (passed)
│   ├── ml-metrics.json           # real model metrics (held-out test set)
│   ├── ml-fusion-eval.txt        # fusion-weight evaluation (npm run eval:fusion)
│   ├── test-results.txt          # real output of npm test (113 tests)
│   └── screenshots/              # real screenshots taken in the sandbox (Chromium)
├── public/                       # frontend: no build step, no CDN
│   ├── index.html                # hub: the four systems
│   ├── share.html                # self-destructing sharing
│   ├── context.html              # campus-locked sharing (faculty + student)
│   ├── study.html                # study-material distribution
│   ├── verify.html               # fake-news-proof sharing + report
│   ├── favicon.svg
│   ├── css/style.css             # the only stylesheet (claymorphism design tokens)
│   └── js/
│       ├── common.js             # shared helpers (XHR progress, copy, drop tray…)
│       ├── upload.js  download.js
│       ├── context.js  study.js  verify.js
│       └── chat.js               # help chatbot widget (every page)
├── scripts/
│   ├── start-mock.js             # npm run start:mock (offline, cross-platform)
│   ├── train-fake-news.js        # npm run train:model (downloads dataset, trains, writes metrics)
│   ├── eval-fusion.js            # npm run eval:fusion
│   ├── test-cloudinary.js        # npm run test:cloudinary (manual live test)
│   ├── cloudinary-diagnose.js    # npm run cloudinary:diagnose (explains upload failures)
│   ├── bench-stream.js           # npm run bench (streaming/memory benchmark)
│   └── race-demo.js              # fire N parallel downloads at a share link (demo)
├── src/
│   ├── server.js                 # entry: startup checks, cron, graceful shutdown
│   ├── app.js                    # Express app: helmet/CSP, rate limits, routes, chatbot API
│   ├── config.js                 # ALL configuration (sizes, campuses, departments, limits)
│   ├── crypto.js                 # envelope encryption, streaming GCM, scrypt, tokens
│   ├── db.js                     # SQLite schema, migrations, atomic statements
│   ├── download.js               # shared decrypt-and-stream with rollback
│   ├── files.js                  # purge, in-flight tracking, cleanup sweep
│   ├── http.js  logger.js  views.js
│   ├── nlp/
│   │   ├── text.js               # text mining: normalise, sentences, Porter stemmer, n-grams, style
│   │   ├── ner.js                # named-entity recognition
│   │   ├── extract.js            # text from PDF / DOCX / PPTX / HTML / TXT
│   │   ├── classifier.js         # TF-IDF, logistic regression, Naive Bayes, metrics
│   │   ├── source.js             # source-URL credibility
│   │   ├── analyze.js            # fusion → credibility, verdict, reasons, keywords, summary
│   │   ├── chatbot.js            # intent-matching help bot
│   │   └── fake-news-model.json  # trained model (788 KB)
│   ├── routes/
│   │   ├── upload.js             # generic encrypted streaming upload (per-system profiles)
│   │   ├── files.js              # /f/:id page, download, delete
│   │   ├── context.js            # campus keys, upload, check, download
│   │   ├── study.js              # distribute + list materials
│   │   └── verify.js             # analyse, then share or reject
│   └── storage/  index.js  cloudinary.js  mock.js  id.js
├── test/
│   ├── vshare.test.js  limits.test.js   # self-destructing core
│   ├── systems.test.js           # hub, campus, study, verify, chatbot, migration
│   ├── nlp.test.js               # NLP / ML unit tests
│   ├── helpers.js  fixtures.js
│   └── fixtures/                 # sample articles + a Chrome-generated PDF
├── .env.example  .dockerignore  Dockerfile  docker-compose.yml
├── DEMO_SCRIPT.md  RESUME.md  README.md
└── package.json  package-lock.json
```

## Screenshots

Real screenshots taken in the sandbox with headless Chromium (mock storage):

| Upload | Share link ready | Download page |
|---|---|---|
| ![Upload](docs/screenshots/02-file-selected.png) | ![Share link](docs/screenshots/03-share-link.png) | ![Download](docs/screenshots/04-download-page.png) |

| Wrong-password lockout | Delete confirmation | Self-destructed (410) |
|---|---|---|
| ![Locked](docs/screenshots/05-locked.png) | ![Delete](docs/screenshots/06-delete-confirm.png) | ![Gone](docs/screenshots/07-self-destructed.png) |

Mobile (360 px): ![Mobile](docs/screenshots/08-mobile-360.png)

| Hub | Help chatbot | Campus: wrong campus refused |
|---|---|---|
| ![Hub](docs/screenshots/09-hub.png) | ![Chatbot](docs/screenshots/10-chatbot.png) | ![Wrong campus](docs/screenshots/12-campus-wrong-campus.png) |

| Study materials | Verified file's download page | Campus page on a phone |
|---|---|---|
| ![Study](docs/screenshots/13-study.png) | ![Verified page](docs/screenshots/16-verified-download-page.png) | ![Mobile campus](docs/screenshots/17-mobile-campus.png) |

### Your deployment (placeholders: replace with your own)

| Screenshot | File |
|---|---|
| EC2 instance running (console) | `docs/screenshots/aws-ec2-instance.png` *(add)* |
| Security group inbound rules (80/443, 22 from my IP) | `docs/screenshots/aws-security-group.png` *(add)* |
| SSM Parameter Store parameters (values hidden) | `docs/screenshots/aws-ssm-parameters.png` *(add)* |
| `docker compose ps` showing `(healthy)` | `docs/screenshots/aws-docker-healthy.png` *(add)* |
| App over HTTPS with the padlock | `docs/screenshots/aws-https.png` *(add)* |
| Cloudinary Media Library showing the raw, authenticated (encrypted) object | `docs/screenshots/cloudinary-raw-object.png` *(add)* |
| GitHub Actions CI green on Node 20 and 22 | `docs/screenshots/ci-green.png` *(add)* |

## License

MIT

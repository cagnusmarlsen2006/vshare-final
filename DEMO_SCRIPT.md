# Vshare: 7-minute faculty demo

**Goal:** show four secure sharing systems on one encrypted core: self-destructing links
(incl. the 1-download race and the password lockout), campus-locked keys, study-material
distribution, and fake-news-proof sharing with NLP + ML, plus the help chatbot.

> Short on time? Skip the "Study" segment (4:00) and the 6-way race (1:30); it then fits in 5 minutes.

## Before the demo (not on the clock)

```powershell
npm install
npm run start:mock          # offline; or: npm start  (with Cloudinary credentials in .env)
```

- Window **A** (normal) = faculty / sender, window **B** (private/incognito) = student / recipient.
- A terminal in the project folder.
- Files ready: any small PDF, plus `test/fixtures/real-article.txt` and
  `test/fixtures/fake-article.txt` (in the project).

---

## 0:00 to 0:30: The home page, night theme and sign-in

Open <http://localhost:3000>. Click the moon button: the whole clay UI switches to the night
theme (and remembers it). If Google sign-in is configured, press **Sign in with Google**:
your name and role (Faculty / Student) appear in the header.

> "Uploading needs a Google account, verified properly (PKCE, signed ID token), and the session
> is a JWT the page's scripts can't read. Recipients never need an account.
> Vshare is four file-sharing systems on one secure core. Whatever you upload, in any of
> them, gets its own 256-bit key and is encrypted with AES-256-GCM **before** it leaves our
> server, so our storage provider, Cloudinary, only ever sees ciphertext."

## 0:30 to 1:30: Self-destructing link + password lockout

1. **Share** → drop the PDF, **1 download**, password `demo-pass` → **Encrypt & upload**
   (point at the progress capsule) → **Copy** the link.
2. Window B: open the link → name, size, "1 download left", live countdown. Refresh: still 1.
   > "Opening a link never uses it up, so chat-app link previews can't burn a one-time link."
3. Type a wrong password 5 times → *"locked for 15 minutes"*. The correct one is refused too.
   > "scrypt hashing, constant-time compare, 5-strike lock. It never deletes the file,
   > otherwise anyone could destroy your file by guessing."

## 1:30 to 2:15: The 1-download race (terminal)

Share another file with **1 download** (no password), copy its link:

```powershell
node scripts/race-demo.js http://localhost:3000/f/<id>
```

Expected: one `200 OK`, five `410 self-destructed`, `1 of 6 succeeded.`

> "Six downloads at the same instant. One atomic SQL statement,
> `UPDATE … WHERE downloads < max_downloads`, lets exactly one through. Open the link again:
> the self-destructed page, HTTP 410."

## 2:15 to 3:15: Campus-locked sharing (Campus page)

1. Faculty side: campus **North Campus** → **Generate key** → choose a file → **Upload**.
   Copy the key (`VS-XXXX-XXXX-XXXX-XXXX`).
2. Student side (same page or window B): campus **Main Campus**, paste the key → **Access file**
   → *"This key is locked to a different campus."*
3. Switch to **North Campus** → the download starts. Press again → *"already used or expired"*.

> "We store only the key's hash. A key is bound atomically to one upload, works only with its
> campus, and dies after one download, using the same atomic counter as the race."

## 3:15 to 4:00: Study material (Study page)

1. Faculty: **CSE**, **Year 2**, subject *Public Health Informatics*, type **Notes**, drop
   `real-article.txt` → **Distribute material**. The message shows auto-extracted keywords
   (*measles, immunity, europe…*).
2. Students: CSE / Year 2 → **Show materials**: it's there. ECE / Year 1: it isn't.

> "Keywords come from text mining: tokenising, stop-word removal, Porter stemming and TF-IDF."

## 4:00 to 6:00: Fake-news-proof sharing (Verify page): the NLP + ML part

1. Drop `fake-article.txt`, source `https://truth-news-now.xyz/cure` → **Verify & share**.
   → **Likely fake, ~14/100, not shared, file deleted.** Walk through the report:
   - **ML:** ~97% probability of fake; the terms that pushed it (*mainstream media, exposed…*).
   - **Style:** 21 sensational terms, 8 exclamation marks, zero attribution.
   - **Source:** `.xyz` throwaway domain.
2. **Verify another** → `real-article.txt`, source `https://www.reuters.com/world/europe/measles`.
   → **Credible, shared**, with a link. Show:
   - **NER:** people (Hans Kluge), organisations (WHO, UNICEF, Reuters), places, dates, 30 percent.
   - **Keywords + 2-sentence extractive summary.**
3. Open the share link: *"✓ Verified · credibility 65/100 · Source: reuters.com"*.

> "The classifier is TF-IDF plus logistic regression, trained on 6,335 labelled news articles:
> **90.3% accuracy** on 1,266 held-out articles, versus 87.1% for a Naive Bayes baseline.
> I combine it with writing-style and source signals, with weights chosen on the test set.
> And I'm honest about its limits: it learned 2016 US politics, so on this health article
> the model alone said 66% fake. The source and style rules are what rescue it, and a
> fake Reuters claim can't rescue text the model is sure is fake."

## 6:00 to 6:30: Chatbot

Click the chat bubble (bottom-right): ask *"how does fake news detection work?"*, then
*"what if my key says different campus?"*.

> "An offline helper bot: intent matching with stemming, TF-IDF and cosine similarity. No
> external AI service and nothing is stored."

## 6:30 to 7:00: Quality and AWS

```powershell
npm test
```

> "144 automated tests in about 6 seconds, starting the real server: byte-for-byte SHA-256
> round trips, the race, lockout, tampering, campus keys, study visibility, the verify
> verdicts, NER, the stemmer and the classifier. CI runs them on Node 20 and 22. For AWS:
> a non-root Docker image on a free-tier EC2 instance, data on EBS, HTTPS via Caddy, secrets
> in SSM. Single instance because SQLite is a local file; to scale, RDS or DynamoDB, S3 and
> an ALB."

Close: *"Limits: the server sees plaintext while streaming, the model is a screening aid,
not a fact-checker, and the campus check trusts the selected campus."*

---

## Likely questions (short answers)

| Question | Answer |
|---|---|
| Why not just make links expire? | Expiring URLs don't limit downloads, and the storage provider would hold plaintext. |
| Can the AI be fooled? | Yes, by carefully written misinformation in a sober style. It scores wording and provenance, not facts. That's why it shows its reasons. |
| Why not fetch the source URL? | Fetching user-supplied URLs from the server invites SSRF attacks and breaks offline use. So the URL is treated as a weak, self-reported signal. |
| Why logistic regression, not deep learning? | Strong on TF-IDF text features (90%), trains in 13 s on a laptop, 788 KB, explainable (term weights) and runs inside Node with no GPU. A transformer is future work. |
| How is a campus verified? | By the key + the selected campus. Real location checks (campus IP ranges, GPS) are future work. |
| What if the server crashes mid-upload? | The row stays `pending`; the startup cleanup deletes it and its partial object. |

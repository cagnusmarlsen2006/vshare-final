# Vshare: 5-minute faculty demo

**Goal:** show that files are encrypted, really self-destruct, cannot be over-downloaded
even under a race, resist password guessing, and that the whole thing is tested and
deployable on AWS.

## Before the demo (2 minutes, not on the clock)

```powershell
npm install
npm run start:mock          # or: npm start   (with Cloudinary credentials in .env)
```

- Open **two browser windows** side by side: A = <http://localhost:3000> (sender),
  B = a **private/incognito** window (recipient).
- Open a **terminal** in the project folder (for the race demo and the tests).
- Have a small PDF ready (e.g. `Quarterly report.pdf`).
- Optional: open the Cloudinary Media Library (if using Cloudinary) or the
  `.mock_storage` folder (if offline).

---

## 0:00 to 0:30: The problem and the idea

> "When we send a file by email or chat, it lives forever in inboxes and on servers.
> Vshare gives you a link that **self-destructs** after a time limit or a number of
> downloads, whichever comes first. The file is **encrypted before it leaves our server**,
> so even our storage provider, Cloudinary, only ever sees ciphertext."

Point at the README architecture diagram if projecting: browser → one Express process →
SQLite for metadata, Cloudinary for encrypted blobs.

## 0:30 to 1:30: Upload (window A)

1. Drag the PDF onto the tray: point out that it **inflates** (claymorphism UI).
2. Choose **1 hour** and **1 download**, password `demo-pass`.
3. Click **Encrypt & upload**: point out the **real progress capsule** (XHR progress events).
4. Show the result card: **Copy** the share link (success pop) and the **private delete link**.

Talking points:
- "Every file gets its own random 256-bit key. The bytes go busboy → size check →
  **AES-256-GCM** → Cloudinary as a **stream**. Plaintext never touches the disk."
- "The file key itself is encrypted with a master key: **envelope encryption**. The
  database only stores the *wrapped* key, IVs and the authentication tag."
- Show storage: in `.mock_storage` the object is unreadable bytes
  (`Format-Hex .mock_storage\<id>.bin | Select-Object -First 5`), and on Cloudinary it is a
  `raw`, `authenticated` asset that is not publicly reachable.

## 1:30 to 2:15: Opening the link does NOT use it up (window B)

1. Paste the share link in window B: name, size, **"1 download left"**, **live countdown**.
2. Refresh the page 3 times: still "1 download left".

> "Messengers like Slack or WhatsApp fetch links to build previews. If *opening* the page
> counted, a preview bot would burn a one-time link. Here only an explicit **POST** from
> the Download button counts; GET and HEAD never do. That is covered by automated tests."

## 2:15 to 3:00: The 1-download race (terminal)

Upload a second file with **1 download** (window A), copy its link, then:

```powershell
node scripts/race-demo.js http://localhost:3000/f/<id>
```

Expected output: **one** `200 OK, got the file`, **five** `410 self-destructed`, and
`1 of 6 succeeded.`

> "Six downloads arrive at the same instant. A naive *read count → check → write count*
> would let several through. We use **one atomic SQL statement**:
> `UPDATE … SET downloads = downloads + 1 WHERE … AND downloads < max_downloads`.
> SQLite serialises it, so exactly one wins. If a download is interrupted, or the
> decryption check fails, the count is **rolled back**, so the recipient doesn't lose their
> only download because their Wi-Fi dropped."

(Backup if the live run misbehaves: `node --test --test-name-pattern="6 simultaneous" test/vshare.test.js`.)

## 3:00 to 3:45: Wrong-password lockout (window B, first file)

1. Type a wrong password: *"Wrong password. 4 attempts left before a 15-minute lock."*
2. Repeat until the 5th attempt: *"Too many wrong passwords. This file is locked for 15 minutes."*
   The button is disabled.
3. Now type the **correct** password: still refused while locked.

> "Passwords are hashed with **scrypt** and compared in **constant time**. After 5 wrong
> tries the file is locked for 15 minutes. It is **never deleted** because of wrong
> passwords, otherwise an attacker could destroy someone else's file just by guessing.
> There is also a per-IP rate limit."

## 3:45 to 4:15: The self-destructed page

1. In window B, open the link of the file you raced in step 2:15 → **"This file has
   self-destructed"** with the poof animation (HTTP **410 Gone**).
2. Optional: open the **delete link** from window A → confirmation page → **Yes, destroy
   it** → the share link now shows the 410 page too.

> "The delete link uses a 32-character token; we only store its SHA-256 hash. Opening the
> link only shows a confirmation, deletion needs a POST, so link scanners can't delete files."

## 4:15 to 5:00: Quality, tests, AWS

Run in the terminal (takes about 4 seconds):

```powershell
npm test
```

> "31 automated end-to-end tests start the real server and talk to it over HTTP:
> byte-for-byte SHA-256 checks for PDF, PPTX, DOCX, ZIP, PNG, text and a 20 MB file;
> expiry; lockout; the 6-way race; interrupted downloads; tampered ciphertext; oversize
> uploads rejected mid-stream; the delete flow. They run in GitHub Actions on Node 20 and 22."

> "For AWS: a Docker image (non-root, health check on `/healthz`) on a free-tier EC2
> instance, data on an EBS volume, HTTPS via Caddy, secrets in SSM Parameter Store.
> It is a single instance on purpose because SQLite is a local file; to scale out I'd move
> metadata to RDS or DynamoDB, storage to S3 and put an ALB in front."

Close with honest limits (one sentence): *"The server does see plaintext while streaming,
there's no virus scanning, and the master key lives on the same host. Client-side
encryption and KMS are the next steps."*

---

## Likely questions (short answers)

| Question | Answer |
|---|---|
| Why not just make Cloudinary links expire? | Expiring URLs don't limit *downloads*, and Cloudinary would hold plaintext. Here the server enforces both rules and Cloudinary only stores ciphertext. |
| What if the server crashes mid-upload? | The row stays `pending`; the startup cleanup removes pending rows and their partial objects. |
| What if someone edits the stored file? | AES-GCM authentication fails, the download is aborted before the last bytes, and the count is rolled back (tested). |
| Can I lose files on restart? | No. SQLite and `.master.key` live in `DATA_DIR` (a Docker volume / EBS volume). Losing the master key would make files unreadable, so back it up (SSM). |
| Why 10 MB? | Cloudinary's free plan limits raw uploads to 10 MB. It's one setting (`MAX_FILE_SIZE_BYTES`). |

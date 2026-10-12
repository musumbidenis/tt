# The ARK — Technical Documentation

The ARK (Academic Records Keeper) is the RVNP ICT Department's attendance, marks and POE system. This document is for whoever sets it up, runs it and maintains it.
Describes app **4.16.0**, server (Worker) **6.4.0**, database schema **9**, Drive bridge **1.3.0**.
For day-to-day use of the apps, see the [User Guide](USER-GUIDE.md).

---

## Contents

1. [Architecture](#1-architecture)
2. [Repository layout](#2-repository-layout)
3. [Configuration reference](#3-configuration-reference)
4. [First-time setup](#4-first-time-setup)
5. [Deploying changes](#5-deploying-changes)
6. [Data model](#6-data-model)
7. [Data kept on devices](#7-data-kept-on-devices)
8. [API reference](#8-api-reference)
9. [How the main mechanisms work](#9-how-the-main-mechanisms-work)
10. [Load and free-plan budget](#10-load-and-free-plan-budget)
11. [Local development and testing](#11-local-development-and-testing)
12. [Operations](#12-operations)
13. [Security and privacy](#13-security-and-privacy)
14. [Troubleshooting](#14-troubleshooting)

---

## 1. Architecture

```
 Staff app (index.html)        Student app (student.html)
 Progressive web apps, served by GitHub Pages, cached by a service worker; work offline
        │  POST JSON (text/plain)             │
        ▼                                     ▼
 ┌──────────────────────────────────────────────────┐        ┌───────────────────────────────┐
 │ Cloudflare Worker  worker/worker.js              │ nudge  │ Google Apps Script web app    │
 │  • staff sign-in, roles, every app action        ├───────▶│ apps-script/DriveBridge.gs    │
 │  • verifies QR check-ins and signs Drive tickets │◀───────┤  • writes trainers' Sheets    │
 │  • sends Web Push "tickles" to student devices   │  feed  │  • stores POE PDFs in Drive   │
 └──────────────┬───────────────────────────────────┘        └──────────────┬────────────────┘
                │ D1 binding "DB"                                            │ DriveApp / SpreadsheetApp
                ▼                                                            ▼
        Cloudflare D1 (SQLite)                                   School Google Drive
```

| Part | Technology | Hosted on | Cost |
|---|---|---|---|
| Staff and student apps | Plain HTML, CSS and JavaScript (no build step); PouchDB (IndexedDB) on the device | GitHub Pages (`musumbidenis/tt`, branch `main`) | Free |
| Server | Cloudflare Worker (ES module, WebCrypto) | Cloudflare, Workers Builds deploys from `main` | Free plan |
| Database | Cloudflare D1 (SQLite) | Cloudflare | Free plan |
| Drive bridge | Google Apps Script web app | The school Google Workspace (owner **ictpoe@rvnp.ac.ke**) | Free |
| Student notifications | Standard Web Push with VAPID; empty "tickle" messages | Browser vendors' push services | Free |

**Design principles**

- **Offline first.** Every write is saved in the device's IndexedDB and synced later. The server never expires a late arrival: a check-in that syncs months later is verified like one sent the same day.
- **The database is the source of truth; Drive is a mirror.** Google Sheets are rewritten from D1; edits in the sheets are overwritten. Evidence files never pass through the Worker.
- **Stay inside the free plans**: Workers' 10 ms CPU limit and 100,000 requests a day, D1's 5 million rows read and 100,000 written a day, and Apps Script's quotas (20 triggers per script, 6-minute runs).

---

## 2. Repository layout

The git repository is the `app` folder. Everything at its root is published to GitHub Pages; only `worker/worker.js` is deployed to Cloudflare, and only `apps-script/DriveBridge.gs` (with its manifest) to Apps Script.

| Path | Purpose |
|---|---|
| `index.html` | Staff app page: tabs, dialogs, script loading order. |
| `app.js` | Staff app core: state, PouchDB, sign-in, timetable and register, sync (push and pull), merge, QR lessons, reports, tabs, roles, polling. |
| `admin.js` | **Manage** tab: approvals, overview, term, loading, class lists, staff and PINs, Drive card, archive and delete. |
| `poe-staff.js` | **POE** tab: evidence lists, preview (pdf.js), decisions, receiving, By student table. |
| `alerts.js` | **Absences** tab. |
| `marks.js` | **Report(s) → Marks**: lifetime marksheet per class and unit, offline edits, locked cells, Excel export. |
| `report.js` | `TermReport`: builds the term register (12 weeks × 3 cells, hours, %), the strip and sheet views, the printable register and export data. |
| `tables.js` | `Tables`: shared paging, sorting, Excel and PDF export of any table. |
| `xlsx.js` | Excel reading and writing on JSZip: the class register and marksheet templates, and plain one-sheet workbooks. |
| `imports.js` | Reads the loading workbook and the MIS class register PDFs (pdf.js), Excel and CSV class lists. |
| `student.html`, `student.js` | Student app: device registration, QR ID, lesson QR scanning, check-ins, Submissions, My attendance. |
| `poe-student.js` | Student POE: document scanning, drafts, PDF making, uploads, notification switch. |
| `scanner.js` | Page detection, perspective correction, the "document" filter, PDF assembly. |
| `sw.js` | Service worker: precaches every app file under the `CACHE` name; `push` and `notificationclick` handlers. |
| `config.js` | Where both apps find the server, and the Google sign-in ID (see [3.1](#31-configjs)). |
| `google.js` | Google sign-in and Drive for both apps: sign-in, folders, resumable upload, sharing, metadata, download. |
| `styles.css` | All styling, light and dark. |
| `design-notes.js` | Developer overlay loaded only with `?notes=1`. |
| `manifest.webmanifest`, `manifest-student.webmanifest` | Install metadata for the two apps. |
| `templates/` | `class-register.xlsx` and `marksheet.xlsx`, RVNP's official layouts. |
| `vendor/` | PouchDB, jsQR, qrcode, JSZip, and pdf.js (`vendor/pdfjs/`, loaded only when a PDF is read or previewed, and not cached for offline use). |
| `icons/`, `fonts/` | Crest, app icons, Lexend and Source Sans 3 (OFL). |
| `worker/worker.js` | The whole server. |
| `worker/dev.js`, `worker/wrangler.test.toml` | Local test harness only (helper endpoints); never deployed. |
| `wrangler.toml` | Cloudflare deploy configuration for Workers Builds. |
| `apps-script/DriveBridge.gs`, `apps-script/appsscript.json` | The Drive bridge and its manifest. |
| `apps-script/clasp-init.sh`, `.clasp.json.example`, `.claspignore` | Pushing the bridge with clasp. |
| `apps-script/Code.gs` | The retired Google Sheet backend. Kept for reference; **never** push it to the bridge project. |
| `wrangler.demo.toml`, `worker/demo.js`, `.assetsignore`, `demo/` | The demo copy (see [5.4](#54-the-demo-copy)): its Worker configuration, the wrapper that also serves the apps, the list of files it does not serve, and the set-up and reset script. |
| `loadtest/` | Load-testing tools and results (see [10](#10-load-and-free-plan-budget)). |
| `sample-data/` | Example CSVs. |

The browser test suite lives **outside** the repository, in `../dev-tests` (see [11.3](#113-browser-tests)).

---

## 3. Configuration reference

### 3.1 `config.js`

```js
window.ATTENDANCE_CONFIG = {
  serverUrl: 'https://rvnp-attendance.ictpoe.workers.dev/',  // the Worker
  sheetsUrl: 'https://script.google.com/macros/s/…/exec',      // retired Google Sheet backend, used only if serverUrl is empty
  vapidPublicKey: '',                                         // student notifications; empty = the switch is not offered
  googleClientId: '…apps.googleusercontent.com',              // Google sign-in; empty = evidence goes through the Drive bridge
  googleDomain: 'rvnp.ac.ke',                                 // only accounts at this domain may sign in
};
```

None of these is secret. A student link can also carry the server address as `student.html#u=<encoded Worker URL>`.

### 3.2 Worker secrets and variables

Set in Cloudflare → the Worker → **Settings → Variables and Secrets**. They survive every deploy (`keep_vars = true` in `wrangler.toml`).

| Name | Type | Required | Purpose |
|---|---|---|---|
| `DB` | D1 binding | Yes | The `rvnp-attendance` database (Settings → **Bindings**). |
| `ADMIN_PIN` | Secret | Yes, for the first sign-in | Creates the `MIS` account the first time someone signs in with staff code `MIS` on an empty database. |
| `BRIDGE_SECRET` | Secret | For Google Drive | The shared secret printed by the bridge's `setup()`. Signs nudges, tickets and the bridge's own calls. |
| `VAPID_PRIVATE_KEY` | Secret | For notifications | The VAPID private key: the bare `d` value, or a whole JWK `{"kty":"EC","crv":"P-256","d":…,"x":…,"y":…}`. |
| `VAPID_PUBLIC_KEY` | Text | With a bare private key | The VAPID public key, same as `config.js`. Not needed when `VAPID_PRIVATE_KEY` is a full JWK. |
| `GOOGLE_DOMAIN` | Text (in `wrangler.toml`) | With Google sign-in | Only accounts at this domain may connect (staff) or own evidence files (students). |
| `VAPID_SUBJECT` | Secret | For notifications | A contact for push services, for example `mailto:ict@rvnp.ac.ke`. |

### 3.3 `wrangler.toml`

```toml
name = "rvnp-attendance"
main = "worker/worker.js"
compatibility_date = "2025-09-01"
keep_vars = true
[placement]
mode = "smart"             # run next to the database
[[d1_databases]]
binding = "DB"
database_name = "rvnp-attendance"
database_id = "44a79960-ce61-4cc0-afeb-d915fcbe0ecf"
```

### 3.4 Drive bridge settings

**Script Properties** (Apps Script → Project Settings):

| Property | Value |
|---|---|
| `WORKER_URL` | The Worker address. |
| `TRAINERS_FOLDER_ID` | The Drive folder holding one folder per trainer. |
| `POE_FOLDER_ID` | The Drive folder for evidence. |
| `WEB_APP_URL` | Optional: the web app's `/exec` address, if the detected one is ever wrong. |
| `SECRET` | Created by `setup()`; must equal the Worker's `BRIDGE_SECRET`. |

The bridge also keeps its own working state in Script Properties (`CURSOR`, `PENDING`, `SHEETS`, `MATCHED`, `TRAINERS`, `INDEX_ID`, `NUDGE_*`).

**`appsscript.json`** fixes the time zone (`Africa/Nairobi`), the V8 runtime and the web app access: `executeAs: USER_DEPLOYING`, `access: ANYONE_ANONYMOUS`. OAuth scopes are left to Apps Script to infer.

**Live deployment**: the app and Worker use the web app deployment `AKfycbxRXcPpCld18nabbd31QOFOKDdm7_uY4_8DIEVeZBmhY2y2i9nIe5oNIfn12GdAmkr7`. Always update this deployment in place so its address never changes.

### 3.5 Version numbers

Bump these with every release:

| Where | Constant | Why |
|---|---|---|
| `app.js` | `APP_VERSION` | Shown under Profile; identifies the build. |
| `sw.js` | `CACHE` (`rvnp-attendance-vX.Y.Z`) | **Required** for devices to fetch new files: a new cache name installs a new service worker. |
| `worker/worker.js` | `VERSION` | Reported by `?action=ping`. |
| `worker/worker.js` | `SCHEMA_VERSION` | Bump whenever `SCHEMA`, `MIGRATIONS` or `DATA_MIGRATIONS` change, so they run once. |
| `apps-script/DriveBridge.gs` | `BRIDGE_VERSION` | Reported by the bridge's GET and in Manage → Google Drive. |

---

## 4. First-time setup

### 4.1 Cloudflare: database and Worker (about 10 minutes)

1. Sign up at https://dash.cloudflare.com/sign-up (free plan).
2. **Storage & Databases → D1 SQL Database → Create Database**, named `rvnp-attendance`.
3. **Workers & Pages → Create application → Start with Hello World!**, named `rvnp-attendance`, **Deploy**.
4. **Edit code**, replace everything with `worker/worker.js`, **Deploy** (or connect Workers Builds, step 8).
5. **Bindings → Add binding → D1 database**: variable `DB`, database `rvnp-attendance`.
6. **Settings → Variables and Secrets → Add**: Secret `ADMIN_PIN`, a 6-digit PIN.
7. Open `https://rvnp-attendance.<subdomain>.workers.dev/?action=ping`. You should see `{"ok":true,"version":"6.4.0",…}`. Put the address in `config.js` as `serverUrl`.
8. Recommended:
   - **Settings → General → Placement → Smart**, so the Worker runs next to the database.
   - **Workers Builds**: put the D1 database ID in `wrangler.toml`, then **Settings → Builds → Connect** → GitHub → `tt`, branch `main`, build command empty, deploy command `npx wrangler deploy`, root directory `/`. Every push then deploys the Worker in a minute or two.

The tables create themselves on the first request. Sign in to the staff app with staff code **`MIS`** and the `ADMIN_PIN`, then choose your own PIN.

### 4.2 GitHub Pages

Serve the repository root from branch `main` (repository Settings → Pages). The apps are then at `https://<user>.github.io/tt/` and `…/tt/student.html`.

### 4.3 Google Drive bridge (about 10 minutes)

Use the school Workspace account that owns the folders (**ictpoe@rvnp.ac.ke**).

1. In Drive, create a **Trainers** folder and a **POE** folder; copy their IDs (the part of the address after `/folders/`). Trainer folders inside Trainers are created automatically from bridge 1.3.0.
2. https://script.google.com → **New project** → paste `apps-script/DriveBridge.gs` (or push it with clasp, [5.3](#53-the-drive-bridge)).
3. Add the Script Properties `WORKER_URL`, `TRAINERS_FOLDER_ID` and `POE_FOLDER_ID`.
4. Run **`setup`** once and allow access. The log shows the **SECRET**. `setup()` also installs a single hourly `sync` trigger.
5. In Cloudflare add the Secret `BRIDGE_SECRET` with that value.
6. **Deploy → New deployment → Web app**: Execute as **Me**, Who has access **Anyone**. If *Anyone* is missing, the Workspace administrator must allow sharing outside the domain for Drive and Apps Script; students upload without a Google sign-in, but every upload and preview still needs a ticket signed by the Worker.
7. Within minutes **Manage → Google Drive** shows *Connected*.

### 4.4 Student notifications (optional, about 5 minutes)

1. `npx web-push generate-vapid-keys` on any computer with Node.js.
2. Public key → `config.js` `vapidPublicKey`; bump `APP_VERSION` and `CACHE`; commit and push.
3. Cloudflare: Secret `VAPID_PRIVATE_KEY` (the private key), Secret `VAPID_SUBJECT` (`mailto:…`), Text `VAPID_PUBLIC_KEY` (the public key).
4. `?action=ping` now reports `"push":true`.

Never commit the private key. If it is exposed, make a new pair and repeat steps 2 and 3; students simply turn the switch on again.

### 4.5 Google sign-in (evidence in students' own Drive, about 10 minutes)

As ictpoe@rvnp.ac.ke, at console.cloud.google.com:

1. Create a project (for example `the-ark`) and enable the **Google Drive API** and the **Google Sheets API**.
2. **OAuth consent screen**: User type **Internal**, app name **The ARK**. Internal apps are limited to the college's accounts and need no Google verification, even for `drive.readonly`.
3. **Credentials → Create OAuth client ID → Web application**, Authorised JavaScript origins: `https://musumbidenis.github.io` and `https://rvnp-attendance-demo.ictpoe.workers.dev`.
4. Put the client ID in `config.js` (`googleClientId`) and in `wrangler.demo.toml` (`GOOGLE_CLIENT_ID`); `GOOGLE_DOMAIN` is in both `wrangler.toml` files. Bump `APP_VERSION` and `CACHE`, commit and push.
5. In the app, the MIS Officer sets the **Backup account** in Manage → Google Drive, and every trainer, HOD and MIS Officer connects Google in Profile.

The client ID is not secret. With it empty, students send evidence through the Drive bridge as before.

---

## 5. Deploying changes

### 5.1 The apps

1. Change the files; bump `APP_VERSION` in `app.js` and `CACHE` in `sw.js`.
2. If you add a file the apps load, add it to `ASSETS` in `sw.js`, or it will not work offline.
3. Commit and `git push` to `main`. GitHub Pages publishes within about a minute.
4. Devices pick up the new version the next time the app opens online: the new service worker installs, precaches every file, takes over, and the page reloads once.

### 5.2 The Worker

Pushing to `main` deploys `worker/worker.js` through Workers Builds (the build log is under the Worker's **Deployments**). Without Workers Builds, paste the file into **Edit code** and **Deploy**. Secrets, variables and data are not touched.

Schema changes are applied on the first request after deploy:

- `SCHEMA` holds `CREATE TABLE/INDEX IF NOT EXISTS` statements, run with `DB.exec` (one statement per line).
- `MIGRATIONS` holds `ALTER TABLE … ADD COLUMN` statements; each runs in `try/catch` (an existing column is not an error).
- `DATA_MIGRATIONS` holds one-statement data moves run with `prepare().run()` (multi-line allowed), written to be safe to run twice.
- `meta.schema` records `SCHEMA_VERSION`; the steps run only when it differs.

### 5.3 The Drive bridge

With clasp (preferred). Once per computer:

```
bash apps-script/clasp-init.sh <script id or editor address>    # writes .clasp.json (git-ignored)
npx @google/clasp@3.4.1 login                                    # sign in as ictpoe@rvnp.ac.ke
```

The Apps Script API must be on for that account: https://script.google.com/home/usersettings.

Each release:

```
npx @google/clasp@3.4.1 show-file-status        # expect only appsscript.json and DriveBridge.gs
npx @google/clasp@3.4.1 push -f                  # replaces the project's files
npx @google/clasp@3.4.1 create-deployment -i AKfycbxRXcPpCld18nabbd31QOFOKDdm7_uY4_8DIEVeZBmhY2y2i9nIe5oNIfn12GdAmkr7 -d "Drive bridge X.Y.Z"
```

Then check the live address returns the new `BRIDGE_VERSION`:

```
curl -sL "https://script.google.com/macros/s/<deployment id>/exec"     # {"ok":true,"bridge":"X.Y.Z"}
```

Notes:
- `push` replaces the **whole** project. `.claspignore` is an allow-list (`appsscript.json`, `DriveBridge.gs`) so the old `Code.gs` is never sent. If unsure what is live, pull into a scratch folder first (a `.clasp.json` there with `"rootDir": "."`, then `clasp pull`).
- `push` alone changes nothing for users: the web app serves the deployed version until `create-deployment -i` points the existing deployment at a new one.
- The web app runs as whoever deploys it (`USER_DEPLOYING`), so deploy as the folder owner.
- Run `setup()` again only when a release changes the triggers; it keeps the existing SECRET.

By hand: paste the file, Save, **Deploy → Manage deployments → Edit → Version: New version → Deploy**.

### 5.4 The demo copy

A second Worker, `rvnp-attendance-demo`, with its own D1 database `rvnp-demo`, runs the same code with invented data for training (`demo/README.md` lists what is in it).

- **One Worker serves everything.** `worker/demo.js` wraps `worker/worker.js`: `/exec` is the server, `/config.js` is generated so the apps use that same address (and adds the orange DEMO tag), and every other path is the apps' files from Workers static assets (`[assets]` in `wrangler.demo.toml`, `run_worker_first`, `html_handling = "none"` so `student.html` is not redirected, which would break the service worker). `.assetsignore` keeps the server code, docs and scripts out.
- **Separate on devices.** Being a different origin from GitHub Pages, the demo apps have their own IndexedDB, `localStorage` and service worker, so a phone can hold both without mixing them.
- **Not deployed by Workers Builds.** Run `python demo/demo.py deploy` after app changes (signed in with `npx wrangler login`).
- **Reset** (`python demo/demo.py reset --pin … --mis-pin …`) deletes every row of every table named in `worker.js` except the `schema` and `auth_secret` meta keys (a warm Worker caches both), inserts the staff with salted PIN hashes (`sha256(salt|pin)`) and a new `pin_version` so earlier sign-ins stop working, then fills term, loading, class lists, registers, marks, a sign-off and a student request through the normal API.
- **No Drive bridge, no notifications** unless `BRIDGE_SECRET` (and a separate bridge) or the VAPID secrets are added to this Worker. Never point it at the real bridge.
- **Trying it on this computer:** `npx wrangler dev --config wrangler.demo.toml` watches the whole repository and reloads on its own `.wrangler` writes; use a copy of the configuration in a temporary folder with absolute `main` and `directory` paths, then `python demo/demo.py reset --local --toml <that copy> --url http://127.0.0.1:8787 …`.

---

## 6. Data model

### 6.1 D1 tables

| Table | Key | Holds |
|---|---|---|
| `meta` | `key` | Settings and markers: `schema`, `auth_secret`, `roster_v` (roster version), `last_change`, `drive_url`, `drive_report`, `drive_nudged_at`, `default_pin` (salted hash), `absence_limit`, `pub_classes` (cached student class list), `fold_at`. |
| `staff` | `code` | Accounts: name, roles, responsibility, `active`, `pin_hash` + `pin_salt` (SHA-256), `pin_version`, `must_change`, `late_pct`, `excused_pct`, `drive_folder`. |
| `login_fails` | `code` | Wrong-PIN counter and lock-until time. |
| `terms` | `id` | Name, duration, start date, breaks, `status` (one `active`), `cat_weeks`, `series`, `lesson_hours`. |
| `classes` | `code` | Streams, `mis_class` (the MIS class list they belong to), `status` (`archived` or empty), `archived_at`, `archived_by`. |
| `units` | `class_code, code` | Units per class (used only when there is no loading). |
| `loading` | `term_id, class_code, unit_code` | Who teaches what each term: trainer, lessons and hours per week. |
| `trainees` | `adm_no` | Official class lists: name, `class_code` (stream), `status`, `mis_class`, `reg_code` (CDACC). |
| `requests` | `id` | Students added by trainers and the MIS Officer's decision (`pending`, `approved`, `rejected`, `merged` with `merged_into`). |
| `sessions` | `id` | One row per register: date, class, unit, period, trainer, counts and %, `term_id`, `week`, `kind` (`lesson`, `cat`, `extra`), `slots` (2 = double), `synced_at`, and `data` (the whole register as JSON, including every student's mark and its time). |
| `checkins` | `session_id, adm_no, device_id` | Student QR check-ins: window, code, `status` (`pending`, `accepted`, `rejected`), reason. |
| `devices` | `device_id` | Which device belongs to which student. |
| `signoffs` | `id` (`term|class|unit`) | Term registers submitted to the HOD and decisions. |
| `audit` | autoincrement | Who changed what in Manage. |
| `evidence` | `id` | POE submissions: student, class, unit, item, version, Drive `file_id`, size, pages, `status`, decision, comment, `received_at`, `seen_at`; `source` (`drive` = in the student's own Drive, else the bridge), `owner_email`, `md5` and `modified_at` when sent, `shared` (JSON list of addresses given view access), `changed_at` (a trainer's device found a different fingerprint). `staff.email` and `trainees.email` are the connected Google accounts. |
| `unit_marks` | `class_code, unit_code, adm_no` | **Lifetime** marksheet rows: `cat1–3`, `prac1–3`, and `meta` JSON recording for each cell the term, staff code and time it was entered. |
| `marks` | `term_id, class_code, unit_code, adm_no` | Pre-6.0 per-term marks. No longer written; copied into `unit_marks` by a data migration. |
| `unlocks` | `term_id, class_code, unit_code` | Ended-term class-units the HOD or MIS Officer reopened, with `until`. |
| `push_subs` | `endpoint` | Student devices that turned notifications on (browser push address only). |

### 6.2 The register document

A register is identified by `session:<date>:<classCode>:<unitCode>:<period>[:<kind>]`, for example `session:2026-10-07:ICT L6CS-25SA:FOP:L1`. Periods are `L1`–`L6`, and `L7` for the lunch slot (CAT and extra attendance only).

What the app sends (`push`) and stores in `sessions.data`:

```json
{
  "sessionId": "session:2026-10-07:ICT L6CS-25SA:FOP:L1",
  "date": "2026-10-07", "classCode": "ICT L6CS-25SA", "unitCode": "FOP", "unitName": "Fundamentals of Programming",
  "period": "Lesson 1 · 7.30–9.00", "kind": "lesson", "slots": 1, "title": "",
  "trainerId": "ICT020", "trainerName": "ICT MUSUMBI .D", "deviceId": "…",
  "termId": "2026-T3", "week": 5, "notes": "", "createdAt": "…", "updatedAt": "…",
  "counts": { "P": 18, "A": 2, "L": 0, "E": 0 },
  "marks": [{ "admNo": "L6CS/25S/304001", "name": "…", "status": "Present", "explicit": true, "at": "2026-10-07T05:12:44Z" }],
  "editLog": [], "viaQr": {}, "qr": { "secret": "…", "intervals": [[…]] }
}
```

---

## 7. Data kept on devices

### 7.1 Staff app

PouchDB database `rvnp_attendance` (IndexedDB):

| Document | Holds |
|---|---|
| `session:…` | Registers (see [6.2](#62-the-register-document)); on the device, marks are a map `admNo → P/A/L/E` with `marksAt`, `explicit` and `names`. |
| `class:…`, `unit:…`, `trainee:…` | The downloaded roster. |
| `addreq:…` | Students this device added, until decided. |
| `_local/settings` | Personal settings: Late/Excused shares, lock hours, default status, minimum %, repeating slots, register sort. |
| `_local/auth` | Sign-in token and staff record. |
| `_local/meta` | Term, weeks, pending and rejected students, aliases, staff percentages, all terms, unlocks, archived classes. |
| `_local/syncLog`, `_local/sheetsSync` | When things were last sent, and which register revisions the server already has (per server address). |
| `_local/pullLog` | Cursor of registers already brought down from the trainer's other devices (per server and staff code). |
| `_local/marks:unit:<class>|<unit>`, `_local/marksIndex` | Marksheets and the list of marksheets with unsent rows. |
| `_local/report:…` | The last server copy of each report, for offline viewing. |

Caches: `rvnp-attendance-vX.Y.Z` (the app files, replaced by each new version) and `rvnp-poe-files` (the last 60 evidence files opened, kept across app updates).

### 7.2 Student app

PouchDB database `rvnp_student`: check-ins, evidence drafts and saved PDFs (`ev:…`), and `_local` documents for the device ID, profile, settings, the units list (`poeUnits`), evidence statuses (`poeMine`) and **My attendance** (`myAttendance`). The device ID, profile and unsent check-ins are also copied to `localStorage` and restored if IndexedDB is lost. Cache `rvnp-push` holds what the service worker needs to fetch notices.

---

## 8. API reference

### 8.1 Conventions

- **Endpoint**: the Worker address. CORS allows any origin.
- **GET** `?action=…` for public reads; **POST** with a JSON body sent as `Content-Type: text/plain;charset=utf-8` (a "simple" request, so there is no preflight).
- Staff requests carry `auth`: the token returned by `login`.
- Every response is JSON with `ok: true|false`. Failures carry `error` (a plain sentence) and may carry `authError: true` (sign in again) or `mustChange: true` (choose a new PIN first).

### 8.2 Public

| Request | Purpose |
|---|---|
| `GET ?action=ping` | `{ok, version, server, time, push}` |
| `GET ?action=classes` | Class groups for the student set-up list (cached until the roster changes). |
| `GET ?action=classlist&class=<group>` | Names in one class group. |
| `GET ?action=units&class=<class>` | Every unit the class has had in any term (`current` marks this term's), evidence items, whether Drive and notifications are ready. |
| `POST {action:"login", staff, pin}` | Returns `{token, staff, mustChange}`. |
| `POST {action:"register", …}` | Ties a student device to a student. |
| `POST {action:"checkin", checkins:[…]}` | Student QR check-ins; each is accepted, rejected or left pending. |

### 8.3 Student device actions

Checked against the device's registration (`deviceId` + `admNo`).

| Action | Purpose |
|---|---|
| `myAttendance` | Every lesson of the student's class with their mark (accepted QR check-ins count as Present). |
| `poeTicket` | A signed upload ticket for one item, with the next version number and file name. |
| `poeDone` | Records an upload the bridge has signed. |
| `poeMine` | The student's evidence and statuses; for files in the student's Drive, `share` lists who should have view access but has not been given it yet. |
| `poeDrivePlan` | Before saving to the student's Drive: file name, version, folder names, description and who to share with, plus a plan signed with the database's key. |
| `poeDriveDone` | Records a file in the student's Drive. The Worker reads the file from Google with the student's access token (used once, not stored): PDF, not in the bin, owned by a college account, at most 20 MB; it stores the md5 and owner. |
| `poeShared` | The device shared a file with more people; they are added to `shared`. |
| `pushSubscribe`, `pushUnsubscribe` | Notification addresses (at most 4 per student). |
| `notices` | Decisions the student has not been told about; marks them seen. |

### 8.4 Staff actions

`Any` means any signed-in staff member; access to particular classes is then checked inside the action.

| Action | Roles | Purpose |
|---|---|---|
| `setPin` | Any | Choose a new PIN; returns a new token. |
| `me` | Any | The signed-in staff record. |
| `roster` | Any | Term, weeks, units (loading), classes, trainees, pending/rejected/merged students, staff percentages, all terms, unlocks, archived classes (MIS). Pass `version` to get `{unchanged:true}` cheaply. |
| `pulse` | Any | The last-change marker (live polling). |
| `push` | Trainer, HOD | Up to 50 registers. Each result is `added`, `updated`, `merged` (with the merged register), or `locked`. |
| `mySessions` | Trainer, HOD | The trainer's registers from the server, 120 at a time, from a `{at, id}` cursor. |
| `checkins` | Trainer, HOD | Accepted check-ins for given registers. |
| `addStudents` | Trainer, HOD | Students added while marking (pending). |
| `mySettings` | Any | Late and Excused shares. |
| `report` | Any | One class-unit's term register: lessons with final marks, weeks, sign-off; `termId` for an earlier term, with `ended` and `unlocked`. |
| `termUnits` | Any | The loading of a term (own units for trainers, all for HOD/MIS). |
| `submitSignoff` | Trainer, HOD | Submit a term register to the HOD. |
| `signoffs` | Any | Submitted registers (own for trainers); `termId` optional. |
| `decideSignoff` | HOD | Approve or return. |
| `overview` | HOD, MIS | Lessons marked against due, per class-unit; `termId` optional. |
| `unlock`, `relock` | HOD, MIS | Reopen an ended term's class-unit for `days` (1–60, default 7), or close it again. |
| `absences` | HOD, MIS | Student-units with more than `limit` lessons missed; `termId` optional. |
| `setAbsenceLimit` | HOD, MIS | The shared limit. |
| `saveTerm` | MIS | Create or update the term (`lessonHours`, `catWeeks`, `series`, breaks). A new code closes the old term. |
| `uploadLoading` | MIS | Replace the term's loading and create staff accounts. |
| `importClassList` | MIS | Apply (or preview with `dryRun`) one MIS class register across its streams. |
| `students`, `updateStudent` | MIS (HOD reads) | A class group's students; move, withdraw or restore one. |
| `phones`, `resetPhone` | HOD, MIS | Students with a registered device (archived classes left out); `resetPhone` deletes the student's `devices` row(s) and their device's `push_subs`, and is audited. |
| `requests`, `decideRequest` | MIS (HOD reads) | Students added by trainers; approve, merge or reject. |
| `staff`, `updateStaff` | MIS | Staff list (with whether a first-time PIN is set); roles, switch on/off, `resetPin` (one-off PIN or `toDefault`), Drive folder. |
| `setDefaultPin` | MIS | Set or remove the first-time PIN. |
| `importRegCodes` | MIS | CDACC registration codes by admission number. |
| `archiveClasses`, `classExport`, `deleteClasses` | MIS | Archive or restore classes; everything about them as JSON; delete archived classes (needs the typed name). |
| `poeList`, `poeView` | Any | Evidence lists; for a preview, a signed ticket for the bridge, or for a file in a student's Drive its file ID and md5 (the trainer's device opens it with their own Google sign-in). |
| `poeChanged` | Any who may view | The device found a different md5 in the student's Drive: sets `changed_at` and audits it. |
| `setGoogle` | Any | Connect (checked with Google's userinfo, college domain only) or clear the staff member's Google address. |
| `setArchiveEmail` | MIS | The backup account every student file is shared with. |
| `poeDecide` | Trainer, HOD | Approve or return (sends a notification). |
| `poeReceive` | MIS | Mark approved evidence received. |
| `poeClass` | MIS, HOD | Students and units of one class for the By student view. |
| `driveStatus` | MIS, HOD | The bridge's last report. |
| `marksPull`, `marksPush` | Any reads; Trainer, HOD write | The lifetime marksheet; `locked` cells and `lockedTerms` per row; `held` counts edits refused by the lock. |

### 8.5 Bridge actions

Both directions are signed with `BRIDGE_SECRET` (HMAC-SHA-256, rejected if more than 15 minutes old).

| From → to | Action | Purpose |
|---|---|---|
| Worker → bridge | `nudge` | "Something changed": the bridge books one sync about two minutes later. |
| Bridge → Worker | `bridgeFeed` | What changed since the bridge's cursor: units with lessons, rosters, sign-offs, marksheets, trainers and new evidence (12 class-units per page). |
| Bridge → Worker | `bridgeReport` | Folders matched, sheets made, web app URL, version. |
| Device → bridge | `upload` | A student's PDF with its upload ticket. |
| Device → bridge | `file` (GET or POST) | A file for preview, with a view ticket (valid 10 minutes). |

---

## 9. How the main mechanisms work

### 9.1 Sign-in and PINs

- PINs are 4 to 8 digits, stored as SHA-256 of `salt|pin`. Repeated digits and straight runs are refused.
- A token is `code|pin_version|issued|hmac` signed with `meta.auth_secret`. Tokens do not expire by time; they end when the PIN changes or the account is switched off (`pin_version` goes up), which signs the person out everywhere.
- Five wrong PINs lock a staff code for 15 minutes.
- **First-time PIN**: when `meta.default_pin` exists, an active account with no PIN of its own can sign in with it and is forced to choose its own (`mustChange`). A reset to the first-time PIN clears the person's hash.
- **First MIS account**: signing in as `MIS` on a database with no active MIS account creates it from `ADMIN_PIN`.

### 9.2 Registers: offline, sync and merge

1. Every tap is saved to the device's register document, and each mark gets the time it was set (`marksAt`).
2. **Push** sends unsent revisions (20 per request) whenever the device is online; `_local/sheetsSync` records which revision the server has.
3. **Pull**: before pushing, the device asks `mySessions` for the trainer's registers changed since its cursor (at most every 2 minutes in the background, at once on a manual sync), and brings each into the local copy.
4. **Merge**, done the same way on the server and the device: for every student, the mark with the latest time wins; a mark without a time counts from the register's creation; ties go to the newer copy. Edit logs and QR check-ins are combined. The server answers `merged` with the combined copy when it differs from what the device sent, and the device keeps that copy.
5. **End-of-term lock**: a register whose term is not the active one is refused (`locked`) when the server already has a copy, unless an `unlocks` row is live for that term, class and unit. A first upload is always accepted.

### 9.3 QR check-ins

- The trainer's device makes a secret per lesson. The code changes every **20 seconds**: an HMAC-SHA-256 of `sessionId|window` with that secret, cut to 10 characters. The QR code is a link to the student app carrying the lesson and that code, so a normal camera app opens it too.
- The student's device checks the class offline, stores the check-in and sends it when online.
- The server accepts a check-in when the code matches a window the trainer's device recorded as shown (with one window either side), or, before that register has synced, when the code is genuine for about now. Until then it stays `pending`.
- Accepted check-ins mark the student Present unless the trainer marked them explicitly. Check-ins older than 150 days are folded into their register (`qrFolded`) to keep the table small.

### 9.4 Terms, weeks and hours

- Every term has **12 teaching weeks** from the first teaching day, skipping break weeks. CAT weeks are numbers in `cat_weeks`; in those weeks only CAT and extra registers can be taken.
- The term register has 3 cells per week (36 in all); a double fills two. Up to 3 lessons per unit per week.
- Hours per lesson = the term's `lesson_hours`, or else the unit's hours per week ÷ lessons per week. Late and Excused count for the trainer's chosen shares (50% and 100% by default).

### 9.5 Marks for a unit's whole life

`unit_marks` holds one row per class, unit and student. On `marksPush`, each changed cell is stamped with the active term, staff code and time in `meta`. A row's newer edit wins (two devices do not undo each other). A cell entered in an ended term is kept as it was unless that term, class and unit is unlocked; the response's `held` count tells the app.

### 9.6 POE evidence

**Scanning on the device** (`scanner.js`, `poe-student.js`) is built to fit in a phone's memory, because a phone that runs out closes the browser and the app reloads:
- the JPEG header is read first (size and EXIF orientation) and the photo is decoded already shrunk to at most 2400 px on its long side (`createImageBitmap` with `resizeWidth`); the decoded bitmap is closed at once;
- straightening reads only the part of the photo the page is in, and the page is kept at most 1800 px (about A4 at 200 dpi), saved as JPEG with a 320 px thumbnail beside it (`t-<page>` attachment), which is what the list of pages shows;
- every canvas is emptied (`Scanner.release`) as soon as it is used, and the PDF is built one page at a time;
- pages are taken with a **camera inside the page** (`getUserMedia`, the rear camera at up to 2560×1920; `ImageCapture.takePhoto()` where the browser has it, else the video frame). Opening the phone's camera app through `<input capture>` sends the browser to the background, where Android often closes it ("unable to complete previous operation due to low memory") and the photo is lost. The camera is stopped while a page is adjusted and reopened for the next page. If it cannot start, the device falls back to the camera app on the next tap;
- the student app does not reload for a new version while the crop screen is open, a page is being saved, or the camera may be up (`POE.busy()`); it waits until the student is idle.

1. The student device asks `poeTicket` for a signed upload ticket (6 hours), then posts the PDF to the bridge with it.
2. The bridge saves `POE / <class> / <adm - name> / <unit> - <item> - v<N>.pdf`, signs what it saved, and the device sends that to `poeDone`. The Worker cannot be told about a file that was not saved.
3. Trainers preview through `poeView` (a 10-minute view ticket) and the bridge's `file` action. Files are cached on the trainer's device afterwards.
4. Who decides: the unit's trainer this term; if the unit is not taught this term, the trainer who had it last; the HOD always. Trainers who taught the unit earlier can view.

### 9.6a Evidence in the student's own Drive (from 4.16)

With `googleClientId` set, `google.js` signs people in with Google Identity Services (token model; the access token lasts about an hour and is kept in `sessionStorage` only).

1. **Student device** (scope `drive.file`, so it sees only files it creates): `poeDrivePlan` → finds or makes `The ARK - POE / <unit>` → resumable upload → `permissions.create` (reader, no email) for each address in the plan → `poeDriveDone` with the access token. Each step is saved on the draft, so an interrupted send resumes without a second copy.
2. **Who gets access**: the unit's trainer now (if not taught this term, the last trainer), every HOD and MIS Officer, and the backup account, as far as they have connected Google. `poeMine` lists anyone missing, and the student's device shares with them on its next signed-in sync. Nobody is removed, so earlier trainers keep access for auditing.
3. **Trainer device** (scopes `drive.file` and `drive.readonly`): `poeView` gives the file ID and md5; the device reads the file's metadata, compares `md5Checksum`, downloads it with `alt=media` and caches it with its md5. A different md5 calls `poeChanged`.
4. Files sent through the bridge before 4.16 keep `source` empty and open through the bridge as before.

### 9.7 Keeping Drive up to date

- After any action in the nudge list (registers, marks, evidence, sign-offs, term, loading, class lists, staff changes, archive), the Worker posts a signed `nudge` to the bridge, at most once a minute (an atomic `INSERT … ON CONFLICT … WHERE` on `meta.drive_nudged_at`).
- The bridge books a one-off `syncOnce` trigger two minutes later, only if none is pending, and deletes it when it runs, so triggers never pile up.
- An hourly `sync` trigger catches anything missed. A long sync stops before Apps Script's 6-minute limit and books a follow-up.
- From 1.3.0, each sync first creates a folder for every trainer in the loading who has none.

### 9.8 Student notifications

On a POE decision the Worker sends an **empty** Web Push message (no payload, so nothing to encrypt) to the student's devices, signed with a VAPID JWT (ES256 via WebCrypto, cached 12 hours per push service). The student's service worker wakes, calls `notices`, and shows the decision. Addresses that answer 404/410, or fail 10 times in a row, are dropped.

### 9.9 Absences

`absences` counts in SQL, using `json_each` over `sessions.data`: per class, unit and student, lessons marked Absent (doubles count two) in the chosen term, keeping only those over the limit, plus lessons held per class-unit. Archived classes are left out.

### 9.10 Archive and delete

Archiving sets `classes.status = 'archived'`; the roster and overview then leave those classes, their loading and their students out. Deleting (archived classes only, with the typed name) removes the class's rows from every table: check-ins, sessions, marks, sign-offs, unlocks, loading, units, push addresses, devices, evidence, requests, trainees and the class itself. The app downloads `classExport` first. Drive is never touched.

---

## 10. Load and free-plan budget

How often devices ask the server:

| Situation | Interval |
|---|---|
| App off screen (another app, or the device locked) | Nothing |
| Lesson QR on screen | Every 4 seconds |
| Today's QR register open | Every 15 seconds |
| Otherwise | Every minute; every 3 minutes after 10 minutes untouched |
| QR lesson register upload | Every 2 minutes, and when the QR is closed |
| Student app | When it opens, comes back into view, after an upload, and on a notification; check-ins every minute while unsent |

`loadtest/` has the tools: a Locust model of real traffic, a saturation test, a read-only probe safe for the live server, a seeder (1,200 students by default, 10,000 with `STREAMS=334 TRAINERS=200`), a CPU-time meter, and a model of a school day against the free plan. See `loadtest/README.md` for how to run them and the results.

---

## 11. Local development and testing

### 11.1 Run the Worker locally

```
npx wrangler dev --config worker/wrangler.test.toml --local --port 8090 --persist-to .work/d1state
```

`worker/dev.js` wraps `worker.js` and adds helper endpoints (never deploy it):

| Endpoint | Does |
|---|---|
| `/__reset` | Empties the database, loads sample classes and the test MIS sign-in (`MIS` / `2468`). |
| `/__dump` | Every table as JSON. |
| `/__pin?code=&pin=&create=1&roles=&name=` | Sets a PIN, creating the account if asked. |
| `/__nudgeReset` | Clears the nudge rate limit. |
| `/__seedClass`, `/__addTrainee` | Extra sample students. |

### 11.2 Run the apps locally

Serve the repository root (for example `python -m http.server 8080`) and open `http://localhost:8080/`. Point the app at the local Worker in the browser console with `saveSettings({ serverUrl: 'http://localhost:8090/exec' })`.

### 11.3 Screenshots for the guides

`python docs/make-screenshots.py` (from the repository folder) rebuilds every image in `docs/images/` from the current code: it starts the Worker locally with a throw-away database, serves the apps, creates an invented demo department (term, loading, a class of 24 students, registers, marks, evidence, a pending student, a submitted register), and photographs both apps in Chromium at phone size, plus one desktop view. The student's camera is fed a picture of a written page, so the in-app camera and the multi-page flow run too. Needs Node.js and Python with `playwright`, `reportlab` and `Pillow`. Run it after any change to a screen, and add a step for any new screen the guides describe.

### 11.4 Browser tests

The Playwright suites, mocks (Drive bridge, Apps Script, push service) and fixture generator live in `../dev-tests`, **outside this repository**. `bash runw.sh <test>.py …` runs them against the local Worker; `all2.sh` runs the lot. They need Node, Python with `playwright`, `openpyxl` and `reportlab`, and Chromium. They have not been updated for every change since app 4.8.

---

## 12. Operations

| Task | How |
|---|---|
| **Look at data** | Cloudflare → D1 → `rvnp-attendance` → **Explore Data**, or **Console** for SQL. |
| **Undo a mistake** | D1 → **Time Travel** restores the whole database to any minute in the last 7 days. |
| **MIS locked out** | D1 Console: `DELETE FROM staff WHERE code = 'MIS';`, then sign in as `MIS` with `ADMIN_PIN` (change the secret first if forgotten). |
| **A student changed device** | The HOD or MIS Officer taps **Reset phone** in Manage → Student phones. (By hand: `DELETE FROM devices WHERE adm_no = '…';`.) They then set up the new device. |
| **Worker logs** | Cloudflare → the Worker → **Logs** (live), and **Deployments** for build logs. |
| **Bridge logs** | Apps Script → **Executions**; **Triggers** should show one hourly `sync` (plus at most one pending `syncOnce`). |
| **Check versions** | `?action=ping` on the Worker; GET on the bridge's `/exec`; Profile in the app shows `app vX.Y.Z`. |
| **Audit** | The `audit` table records sign-offs, staff and PIN changes, phone resets, term saves, imports, unlocks, archives, deletions and evidence decisions. |

---

## 13. Security and privacy

- **No secrets in the repository.** `config.js` holds only public addresses and the VAPID public key. Secrets live in Cloudflare and in Apps Script Script Properties. `.clasp.json` and clasp credentials are git-ignored.
- **Staff actions** need a signed token; roles are checked on the server for every action.
- **Student actions** are limited to the registered device-student pair. One device belongs to one student and one student to one device. The device ID is random and kept in that browser's storage (IndexedDB and `localStorage`), so each browser on a phone is a separate device; web pages cannot read a hardware ID that all browsers share. A reset (Manage → Student phones) frees the student for a new one.
- **QR codes** cannot be forged or reused: they are HMACs that change every 20 seconds and are checked against the trainer's record.
- **Drive access** is only through tickets the Worker signs (upload 6 hours, view 10 minutes), so the bridge's open web address cannot read or write anything else.
- **Google sign-in**: students grant `drive.file` (the app's own files only); staff also grant `drive.readonly`, needed to open files students shared with them. Access tokens stay in the browser tab (`sessionStorage`); the Worker receives one only to check a file or an account with Google, and never stores it. Only `GOOGLE_DOMAIN` accounts are accepted, on the device and on the server.
- **The first-time PIN** is shared by everyone without their own PIN; treat it like a password and give it out privately. It is stored only as a salted hash.
- **On devices**: registers and evidence stay on the device until sent. Trainers' devices also keep the last 60 evidence files opened. **Erase this device** removes everything.
- **The `?notes=1` overlay** never captures text typed into inputs, but it does capture text printed on the screen.

---

## 14. Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| `"The database is not connected"` | The Worker has no D1 binding named `DB`. |
| `First sign-in: add the ADMIN_PIN secret` | Set `ADMIN_PIN` and try `MIS` again. |
| Devices keep the old version | `CACHE` in `sw.js` was not bumped, or a new file is missing from `ASSETS`. |
| Manage → Google Drive not connected | `BRIDGE_SECRET` and the bridge's `SECRET` differ, `WORKER_URL` is wrong, or the web app is not deployed for **Anyone**. |
| Sheets stop updating | Apps Script → Triggers: run `setup()` once if the hourly `sync` is missing; check **Executions** for errors. |
| clasp says "The caller does not have permission" | clasp is signed in as an account without access to the project. Sign in as the owner (`clasp login`) or share the project with that account as Editor. |
| Students cannot upload evidence | The bridge's address is the school-only form (`/a/macros/…`), or the deployment is not open to Anyone; redeploy as described in [4.3](#43-google-drive-bridge-about-10-minutes). |
| No notification switch for students | `vapidPublicKey` is empty in `config.js`, `?action=ping` shows `"push":false`, or the student is on an iPhone without the app on the Home Screen. |
| A register is refused as `locked` | It belongs to an ended term; unlock it from that term's report. |
| Marks show as locked | Entered in an ended term; unlock from the Marks notice. |

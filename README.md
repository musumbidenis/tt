# Attendance Register (offline-first)

Trainers mark attendance on their phones **with no internet**. When a network appears, phones sync with **CouchDB**. Every 10 minutes a **GitHub Action** copies new registers into **Google Sheets** and brings the class lists from Sheets back to the phones.

There is no server to run and no Docker. GitHub hosts the app and runs the sync.

```
Phone (app + PouchDB) ⇄ CouchDB ⇄ GitHub Action (every 10 min) ⇄ Google Sheets
```

---

## 1. Google Sheet + key (10 min)

1. Create a Google Sheet. Copy its ID from the address: `docs.google.com/spreadsheets/d/`**`THIS-PART`**`/edit`.
2. Go to [console.cloud.google.com](https://console.cloud.google.com) and create a project. Then open **APIs & Services → Library → Google Sheets API → Enable**.
3. Go to **IAM & Admin → Service accounts → Create service account**. Any name works; skip the roles.
4. Open the service account and choose **Keys → Add key → JSON**. A key file downloads.
5. In the Google Sheet, click **Share** and add the service account's email (`…@….iam.gserviceaccount.com`) as an **Editor**.

## 2. CouchDB with an HTTPS address

The app runs on HTTPS (GitHub Pages), so CouchDB must also be reachable over HTTPS.

**Free option: any PC that is usually on (Windows, Linux or Mac)**

1. Install CouchDB 3 from [couchdb.apache.org](https://couchdb.apache.org). During setup, choose an **admin username and password** and write them down.
2. Install [Tailscale](https://tailscale.com/download) and sign in.
3. In a terminal (on Windows, run it as Administrator):
   ```
   tailscale funnel --bg 5984
   ```
   The first time, it prints a link to switch Funnel on. Then it shows your address, for example `https://my-pc.tail1234.ts.net`. That address stays the same.

Your CouchDB URL is that address + `/rvnp_attendance`, for example `https://my-pc.tail1234.ts.net/rvnp_attendance`.

If the PC is switched off, nothing is lost. Phones keep working offline and sync when it's back.

## 3. Push to GitHub

Create a **public** repository on GitHub, for example `tt`. Then, in this folder:

```bash
git init
git add .
git commit -m "Attendance register"
git branch -M main
git remote add origin https://github.com/musumbidenis/tt.git
git push -u origin main
```

In the repository on GitHub:

**a. Turn on the website:** go to **Settings → Pages → Deploy from a branch** and choose `main` with `/ (root)` → **Save**. The app will be at `https://musumbidenis.github.io/tt/`.

**b. Add the secrets:** go to **Settings → Secrets and variables → Actions → New repository secret** and add:

| Secret | Value |
|---|---|
| `COUCH_URL` | your CouchDB URL from step 2, ending in `/rvnp_attendance` |
| `COUCH_USER` | CouchDB admin username |
| `COUCH_PASSWORD` | CouchDB admin password |
| `SPREADSHEET_ID` | the Sheet ID from step 1 |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | open the downloaded key file and paste **all** of its text |
| `TRAINER_PASSWORD` | choose a password that trainers will use on their phones |

**c. Run the one-time setup:** go to **Actions → Google Sheets sync → Run workflow**, choose `setup`, and click **Run**. Wait for the green tick. This step:
- creates the database;
- allows your GitHub Pages site to reach CouchDB (CORS);
- creates the trainer login;
- adds the tabs to your Sheet.

**d. Fill in the class lists** in the Sheet:
- **Classes:** `ClassCode | ClassName`
- **Units:** `ClassCode | UnitCode | UnitName`
- **Trainees:** `AdmNo | Name | ClassCode | Active`

To have them appear right away, run the workflow once more with `sync`. Otherwise they arrive within 10 minutes.

## 4. On each phone

1. Open `https://musumbidenis.github.io/tt/` in Chrome, then choose **⋮ → Add to Home screen**.
2. In **Setup**:
   - enter the trainer's name;
   - for **Server address**, enter your CouchDB URL;
   - enter Username `trainer` and the `TRAINER_PASSWORD`;
   - tap **Save and connect**.

That's it. Marking works with or without network. The number on the **Sync** button counts registers not yet on the server.

---

## Good to know

- **Where data shows up:** each lesson becomes one row in `Sessions` and one row per trainee in `Attendance`. Edits update the same rows and never duplicate them.
- **Statuses:** P Present, A Absent, L Late, E Excused. The percentage counts Late as attended and leaves Excused out.
- **Locking:** registers lock after 48 hours. Changing one after that asks for a reason, which is recorded.
- **Two phones, same lesson, both offline:** when they reconnect, the edits merge automatically.
- **Class list changes:** edit the Sheet, then wait up to 10 minutes, or tap **Refresh class lists from Sheets** on a phone. Set `Active` to `No` for trainees who leave instead of deleting the row.
- **Sync history:** the **Actions** tab shows every run. A red run says what went wrong, for example that CouchDB is unreachable or the key is wrong.
- **Timing:** GitHub sometimes runs scheduled jobs a few minutes late. GitHub also pauses schedules in a public repository after 60 days with no commits. If that happens, open **Actions** and re-enable it, or push any small change.
- **Updating the app:** after changing files, bump `CACHE` in `sw.js` (for example `v2.1.1`) so phones pick up the new version.
- **Secrets stay secret:** the repository is public, but secrets are never shown in the code or in the logs.

# The ARK: Academic Records Keeper (RVNP ICT Department)

The ARK keeps the department's academic records: attendance registers, marks and POE evidence.

Trainers mark attendance on their phones **with no internet**. Whenever a phone is online, its registers go straight into an **online database**. Class lists, trainer loading and term dates come back from the same database.

The database is **Cloudflare D1** (a real SQL database), reached through a small **Cloudflare Worker**. Both are free on Cloudflare's free plan, with no card needed, and far beyond what one department uses:

| Free limit | What the department uses |
|---|---|
| 500 MB per database | a year of registers for the whole department is roughly 50 MB |
| 100,000 requests a day | 60 trainers marking all day is a few thousand |
| 5 million rows read a day | most requests read a handful of rows |

```
Phone (works offline) ──when online──▶ Cloudflare Worker ──▶ D1 database
```

- Trainer app: **https://ark26.pages.dev/**
- Student app: **https://ark26.pages.dev/student**
- Demo copy for training, with invented data: see [demo/README.md](demo/README.md); handout for a paired demo: **https://ark26.pages.dev/demo/demo-day**
- Landing page (to share and advertise): **https://ark26.pages.dev/welcome**

**Documentation**: the [User Guide](docs/USER-GUIDE.md) (trainers, HODs, the MIS Officer and students) and the [Technical Documentation](docs/TECHNICAL.md) (setup, deployment, data model, API and operations) describe the current version. The sections below are the original set-up notes and the change log.

## Who does what

| Role | Signs in with | Can |
|---|---|---|
| **Trainer** | staff code + PIN | Mark registers for the classes and units in their loading (offline). Add a student who isn't on the list (pending). Show a lesson QR. See and export their units' term registers. Submit them to the HOD. Preview, approve or return the POE evidence students send for their units. |
| **HOD** | staff code + PIN | Everything a trainer can for their own units. Plus: approve or return submitted term registers, see every class's register, and see the department overview (which units are behind on marking). |
| **MIS Officer** | staff code + PIN | Set up the term (12 teaching weeks, the breaks and the CAT weeks). Upload the trainer loading workbook and the class register PDFs. Approve students added by trainers. Issue PINs and give roles. Receive the POE evidence trainers approved. |

One person can have several roles; for example, an HOD who also teaches. Roles are set under **Manage → Staff and roles**.

---

## 1. Set up the database (once, about 10 minutes)

Everything is done in the Cloudflare dashboard in a browser. Nothing to install.

1. Sign up at **https://dash.cloudflare.com/sign-up** (free plan, email only).
2. **Create the database**: open **Storage & Databases → D1 SQL Database → Create Database**. Name it `rvnp-attendance` and click **Create**.
3. **Create the Worker**: open **Workers & Pages → Create application → Start with Hello World! → Get started**. Name it `rvnp-attendance` and click **Deploy**. (The first time, Cloudflare asks you to pick a `workers.dev` subdomain; any name is fine.)
4. **Put in the code**: on the Worker's page click **Edit code** (the **</>** icon), delete everything in the file, paste in everything from [`worker/worker.js`](worker/worker.js), and click **Deploy**.
5. **Connect the database**: on the Worker's page open the **Bindings** tab → **Add binding → D1 database**. Variable name: `DB` (capitals). Database: `rvnp-attendance`. Click **Add binding**.
6. **Set the first MIS PIN**: open **Settings → Variables and Secrets → Add**. Type: **Secret**, name: `ADMIN_PIN`, value: a 6-digit PIN only you know. Click **Deploy**.
7. Copy the Worker's address from its page (it looks like `https://rvnp-attendance.<your-subdomain>.workers.dev`). Open it in a browser with `?action=ping` on the end: you should see `"ok":true`. Then put it in [`config.js`](config.js), or send it to whoever maintains the app, so every phone finds the database by itself.

8. **Make it faster from Kenya** (recommended): open **Settings → General → Placement** and choose **Smart**. Cloudflare then runs the Worker next to the database instead of next to each phone, so the several database steps in each request don't each cross the distance. It decides by itself within about 15 minutes, and switches back if it would be slower.

The tables are created by themselves the first time anyone uses the app. Then sign in to the app with staff code **`MIS`** and the `ADMIN_PIN`; you'll be asked to choose your own PIN straight away.

**Updating later**: open the Worker → **Edit code**, paste the new `worker/worker.js`, click **Deploy**. The address and the data stay the same.

**Or let Cloudflare update itself from GitHub** (once, about 5 minutes): put the database ID in [`wrangler.toml`](wrangler.toml) (D1 → `rvnp-attendance` → copy its ID), then open the Worker → **Settings → Builds → Connect** → GitHub → the `tt` repository, branch `main`. Build command: empty. Deploy command: `npx wrangler deploy`. Root directory: `/`. Click **Connect**. Every push to GitHub then deploys the Worker within a minute or two; the build log is under **Deployments**. The secrets and the data are not touched.

**Locked out?** In the dashboard open the D1 database → **Console**, run `DELETE FROM staff WHERE code = 'MIS';`, and sign in again with `MIS` and the `ADMIN_PIN` (change the secret first if you've forgotten it). Nothing else is touched.

### Moving from the Google Sheet

The one-time import from the old Google Sheet has been removed from the app (the **Bring in data from the Google Sheet** card and its Worker action are gone). If you still need to bring old data across, use the version of the app from before 4.8.0.

### Connect Google Drive (once, about 10 minutes)

This puts a Google Sheet of each trainer's attendance in their Drive folder, and stores the students' POE evidence in Drive. Do it with the **school Google Workspace account** that owns the folders.

1. In that account's Drive, have one **Trainers** folder with a folder per trainer inside it (named after them, for example `Musumbi Denis` or `ICT020 Musumbi`), and a **POE** folder. Open each and copy its ID: the part of the address after `/folders/`.
2. Open **https://script.google.com → New project**. Name it `RVNP Drive bridge`. Delete what is in `Code.gs`, paste in everything from [`apps-script/DriveBridge.gs`](apps-script/DriveBridge.gs) and **Save**. (From the second time onwards there is no pasting: see [Updating the bridge later](#updating-the-bridge-later).)
3. **Project Settings** (the cog) → **Script Properties → Add script property**, three times:
   - `WORKER_URL`: the Worker's address from step 7 above
   - `TRAINERS_FOLDER_ID`: the Trainers folder ID
   - `POE_FOLDER_ID`: the POE folder ID
4. Back in the editor choose the function **setup** and click **Run**. Allow access when Google asks. The log shows a long **SECRET**: copy it.
5. In Cloudflare open the Worker → **Settings → Variables and Secrets → Add**: Type **Secret**, name `BRIDGE_SECRET`, value: the SECRET. Click **Deploy**.
6. In Apps Script click **Deploy → New deployment → Select type: Web app**. Execute as: **Me**. Who has access: **Anyone**. Click **Deploy**.
   If **Anyone** is not offered, the school's Workspace administrator has to allow sharing outside the school domain for Drive and Apps Script in the Admin console. Students upload without signing in to Google, so the web app must be open; every upload and preview still needs a ticket signed by the database.
7. Within a few minutes the sheets appear and **Manage → Google Drive** shows *Connected*, with any trainer whose folder was not found by name. Pick their folder there.

Each trainer's folder gets **Attendance register - <term>** and **Marksheets - <term>**. The attendance sheet has one tab per class and unit in the class register layout (WK1–WK12, hours and %), plus a CATs tab when CATs were taken. It is rewritten from the database, so edits made in the sheet are replaced on the next update. Evidence is stored as **POE / Class / Adm No - Name / Unit - CAT1 - v1.pdf**, and the sheet **POE - Evidence index** in the POE folder lists every file with its status.

**When the sheets are updated.** The bridge no longer asks the database every 10 minutes. The database tells it whenever something changes — a register marked, marks entered, evidence approved, a class list or the loading uploaded — and the bridge updates the sheets about two minutes later. A burst of changes still makes one update, and an **hourly** run catches anything a missed message would have left behind. So nothing happens at night or at the weekend, and a register reaches Drive within a few minutes instead of up to ten.

#### Updating the bridge later

**From this computer, with `clasp`** (no copying and pasting). Once per computer:

1. Switch the Apps Script API on for the account, once: **https://script.google.com/home/usersettings → Google Apps Script API: On**.
2. Point clasp at the project — give it the script id, or just the address of the editor:

   ```
   bash apps-script/clasp-init.sh https://script.google.com/home/projects/…/edit
   npx clasp login
   ```

   `clasp login` opens a browser; sign in with the **school Workspace account** that owns the folders. The sign-in is kept in your home folder, never in the repository.

Then, whenever `apps-script/DriveBridge.gs` changes:

```
npx clasp status            # what will be sent: appsscript.json and DriveBridge.gs, nothing else
npx clasp push -f           # replace the project's files with these
npx clasp deployments       # the web app's deployment id, the long AKfycb… one
npx clasp deploy -i <deployment id> -d "Drive bridge 1.2.0"
```

`push` replaces the whole project, so anything typed into the editor and not in git is lost — if in doubt, look first:

```
mkdir -p .clasp-inspect && echo '{"scriptId":"<the id>","rootDir":"."}' > .clasp-inspect/.clasp.json
npx clasp pull -P .clasp-inspect     # the live project, kept out of the way
```

`push` only changes the code. The address stays the same, and the running web app keeps serving the **old** version until `clasp deploy -i` points its deployment at a new one. A change to the triggers still needs **setup** run once by hand: open the editor (`npx clasp open-script`), choose **setup** and click **Run**.

[`apps-script/appsscript.json`](apps-script/appsscript.json) travels with the code: it is where the web app's own settings live (**Execute as: Me**, **Who has access: Anyone**), along with the timezone. [`.claspignore`](.claspignore) makes sure only `DriveBridge.gs` and that manifest are ever sent, so the old Google Sheet script in the same folder is never pushed into the bridge's project by mistake.

**By hand instead**, if clasp is not set up: paste the new `DriveBridge.gs` into the editor, Save, then **Deploy → Manage deployments → Edit (pencil) → Version: New version → Deploy**. The address stays the same.

There is one more optional set-up, also about 5 minutes: letting students' phones tell them when their evidence is approved or returned. It is described with the rest of POE, under [Notifications for students](#notifications-for-students-once-about-5-minutes).

> **Coming from an older bridge (before 1.2.0)?** Paste the new `DriveBridge.gs`, Save, deploy a new version as above, and then **run `setup()` once** (choose **setup** in the editor and click **Run**). That is what swaps the old 10-minute trigger for the hourly one; without it, both would run. `setup()` keeps the SECRET it already made, so nothing in Cloudflare needs changing. **Triggers** (the clock icon) should then show one hourly `sync` and nothing else.

## 2. MIS Officer: start of each term

Sign in at https://ark26.pages.dev/ with `MIS` and the PIN, then choose your own PIN. Everything below is under **Manage**.

1. **Term**:
   - enter the name (for example *Term 3 2026*), the code (*2026-T3*), the duration as printed on registers (*Sep - Dec 2026*) and the first teaching day;
   - add any break weeks;
   - tick the **CAT weeks** (for example weeks 6 and 11). In these weeks trainers can take CAT registers.

   The app makes the **12 teaching weeks** and skips the breaks. Saving a new code starts a new term and closes the old one.
2. **Trainer loading**: choose the department loading workbook (`.xlsm` or `.xlsx`). The app reads only three tabs:
   - **Subject Loading** (class, subject code and name, trainer, lessons per week, hours per week);
   - **List of Trainers** (code, name, responsibility);
   - **List of Subject**.

   Check the preview, then tap **Upload loading**. Every trainer gets an account; anyone listed as HOD gets the HOD role.
3. **Class lists**: choose one or more class register PDFs from the MIS system. The same register saved as Excel, or a CSV, also works. For each file:
   - the app reads the class code (for example *CSCL6-25-S-RS*) and every student;
   - it ticks the streams in the loading that the class belongs to (*ICT L6CS-25SA / SB / SC*);
   - tap **Check changes** to see what will happen: who is new, who is already on the list, names spelt differently, and anyone missing from the file;
   - for a class with streams, every student is listed with the stream they will go to. The first time, the whole list is divided into equal parts in list order (82 students in 3 streams: 28, 27, 27). Tap **A / B / C** next to a student to move them, or **Split the list evenly again** to start over; the counts update as you go;
   - tap **Save class list**: students are placed exactly as shown.

   Uploading a newer list later keeps everyone in the stream they are in; only new students are shared out, and you can still move anyone before saving. **Nobody is removed** unless you tick them as having left. To move a student between streams later, or withdraw or restore them, tap the class.
4. **Staff and roles**: tap **Issue PIN** for each staff member and give them the PIN privately. They choose their own PIN the first time they sign in. Here you can also tick roles, or switch an account off (it is signed out everywhere).
5. **Students added by trainers** appear at the top of Manage. For each one:
   - **Approve** adds them to the class (or moves them if they're on another list);
   - **Same as…** is for a typo or duplicate: their marks count for the student you pick;
   - **Reject** leaves them out of that class's registers and reports.

   Uploading a newer class list that includes a pending student confirms them automatically.

## 3. Trainers: every lesson

1. Open https://ark26.pages.dev/ in Chrome **while online**, then choose **⋮ → Add to Home screen**. Sign in with your staff code and the PIN from the MIS Officer, then choose your own PIN. Your classes download straight away. From then on, the phone works with or without network.
2. **Mark**:
   - pick your class and unit (only those in your loading), and the **week** (it starts on the current week, written like *Week 5 (Oct 5 - Oct 9)*);
   - a timetable for that week appears: the five days run down the side and the six lessons (7.30–9.00, 9.00–10.30, 10.30–12.00, then lunch, then 13.00–14.30, 14.30–16.00, 16.00–17.30) run across the top. Tap the slot where the class was. For a **double**, tap the next slot too. Registers already taken show in their slots; tap one to open it again;
   - tap **Open register**, then **P / A / L / E** for each student. Every tap is saved on the phone instantly, even offline.

   A unit can have up to **3 lessons a week**, matching the register's 3 cells per week; a double counts as two and fills two cells. Future days and dates outside the term's teaching weeks can't be chosen.
   - **CAT**: in a CAT week, choose **CAT** above the timetable to take the attendance of a CAT sitting (it is named *CAT 1*, *CAT 2*… in order of the CAT weeks).
   - **Extra CAT attendance**: in any week, choose it, give it a title (for example *CAT 1 make-up*) and pick the slot.

   CAT and extra CAT registers are kept separately: they are listed under the term register in Reports and don't count in its hours or percentage.
3. **Add student**: for someone attending who isn't on the list. Mark them straight away; they show as **Pending** until the MIS Officer approves.
4. **Sync** happens automatically whenever the phone is online. The number on the Sync button counts what's still waiting.
5. **Reports → class and unit** shows the **term register**:
   - **The four cards**: lessons recorded, trainees, average attendance, and how many are below the minimum.
   - **On a phone**: one row per student, with a strip of the 12 weeks × 3 lessons (green present, amber late, red absent, blue excused). It also shows the student's percentage and Actual/Possible hours. You can filter (*Below 75%*, *Pending*) and sort.
   - **Sheet view** shows the full grid like the Excel register. It's for tablets, computers, or turning the phone sideways.
   - **Export Excel register** fills RVNP's General Class Register template exactly:
     - the crest and title block;
     - lecturer, class, level, duration and subject;
     - WK1–WK12 with 3 lessons each;
     - Possible hours, Actual hours and the % formula;
     - the lecturer's and HOD's comments.

     Pending students are tagged *(pending)*. **Print or save PDF** gives the same layout.
   - **Submit to HOD**: add the lecturer's comment and submit. The HOD's decision and comment show here.
6. **Me → How attendance is counted**:
   - choose how much of a lesson a **Late** arrival and an **Excused** absence count for (50% and 100% to start);
   - set the minimum percentage.

   **Possible hours** count only lessons the student was on the register for, so someone who joins mid-term isn't penalised. A lesson's length comes from the loading (hours per week ÷ lessons per week, usually 1.5 h).

## 4. HOD

- **Manage → Registers to approve** lists submitted term registers. Open one, read it, add the HOD's comment, and **Approve** or **Return to trainer** (returning needs a comment).
- **Department overview** shows, for every class and unit in the loading:
  - the trainer;
  - lessons marked against lessons due so far, highlighted when behind;
  - the last lesson marked;
  - the attendance rate;
  - the approval status.

  Tap a row to open that register.
- **Reports** covers every class in the department, not just your own units.

## QR check-in (students mark themselves)

**One-time setup for each student (needs internet once):**
1. Students open https://ark26.pages.dev/student. Trainers can also share the link from **Me → Student app link**.
2. The student chooses their **class** (as on the MIS list, for example *CSCL6-25-S-RS*), then their **name**, and taps **Register this phone**. The app knows which stream they're in.
3. The database ties that phone to that student:
   - the phone can only check in that student;
   - that student can only check in from that phone;
   - a registered phone can't be switched to someone else.

**Every lesson (trainer and students can all be offline):**
1. Open the register and tap **Show lesson QR**. The code is made on your phone, unique to the lesson, and changes every 20 seconds. Trainees who don't scan count as **absent** unless you mark them.
2. Students scan it with the app or their normal camera. The phone checks the class straight away, so a student from another class is refused. In a combined lesson (two classes in one loading row), students of both classes can check in.
3. Whenever each phone gets internet, it syncs. The server verifies every check-in against your phone's record of which codes it showed, and when. A forged, old or other-lesson code is refused, even if it arrives months later.

Syncing is automatic on both sides. During a live lesson, the trainer's phone checks every few seconds with a tiny "anything new?" question. A student's scan shows up within about 3–5 seconds of them being online. When the trainer's app is off screen it stops asking altogether, and starts again as soon as it is opened.

## Marks (continuous assessment marksheets)

**Trainers** open **Reports → Marks**, choose the class and unit, and type each student's **CAT 1–3** and **PRAC 1–3** as percentages (0–100). Enter moves down the column. Every mark is saved on the phone straight away, also with no internet, and sent to the server when there is. **AVG** is the sum of the three divided by 3 (a CAT not done counts as 0). **Export Excel marksheet** gives RVNP's *Continuous Assessment Marks Sheet per Unit of Competency*: crest, Course Code and Name, Unit Code and Title, Assessment Series, the table and the Prepared / Received / Approved block.

**The MIS Officer** sets the **Assessment series** in **Manage → Term** (for example *Nov/Dec 2026*), and uploads the CDACC **registration codes** under **Manage → Class lists → Upload registration codes**: any Excel or CSV with admission numbers and registration codes, a filled marksheet included. Marks can be entered before the codes are in; they are matched by admission number.

With Google Drive connected, each trainer's folder also gets **Marksheets - <term>**: one tab per class and unit in the same layout, refreshed from the app within a few minutes of marks being entered. Enter marks in the app; edits in the sheet are replaced.

## POE evidence (students send, trainers approve)

**Students** open **Evidence (POE)** in the student app, choose the unit and tick one or more items (CAT1–CAT4, PRAC1–PRAC3). For each item they photograph the pages; the app finds the page edges (drag the corners if needed), straightens the page and makes it look like a clean scan. Pages can be reordered or deleted, or an existing PDF chosen instead. **Save and send** keeps the PDF on the device first (and **Save a copy** puts it in the device's downloads), then sends it to Drive when there is internet. The **Submissions** tab lists their check-ins and their evidence with the current status: *With your trainer*, *Approved* or *Returned* (with the trainer's note); **Scan again** sends a new version (v2, v3…).

**Trainers** open the **POE** tab (the dot shows how many are waiting). Each submission opens inside the app with its pages; **Approve**, or **Return to student** with a note. After each decision the next one waiting opens. The HOD sees the whole department.

**The MIS Officer** sees the approved ones under **POE → To receive**, and marks them received once filed. The **By student** toggle (MIS Officer and HOD) shows one class at a time as a table you can search and filter, ten students to a page: how many items each has sent, approved, with the trainer and returned. Tap a student to open their units and items, and tap any mark to open that file. **Export Excel** and **Save as PDF** under the table give the whole filtered list, not just the page on screen. Uploading and previewing need internet; the files themselves never pass through the database.

### Telling students when their evidence is decided

A student can ask their phone to tell them. In **Evidence (POE)**, under the Save button, there is **Notify me about my evidence**. Tapping it asks the phone for permission (nothing is ever asked when the app simply opens); from then on, when a trainer approves their work or sends it back, their phone shows a short message with the unit, the item and the trainer's note. Tapping it opens the app on Submissions.

**On Android** (Chrome, Edge, Samsung Internet) it works straight away — adding the app to the Home Screen is recommended but not required.

**On an iPhone** it only works once the app is on the Home Screen: open the student link in **Safari**, tap **Share**, choose **Add to Home Screen**, then open the app from the Home Screen and turn the switch on there. (This is Apple's rule, from iOS 16.4 onwards.) Until then the app says so instead of showing the switch.

If nothing is set up on the server (see below), the switch is not offered at all. Everything else in the app works exactly as before — notifications are an extra, never something the app depends on.

### Notifications for students (once, about 5 minutes)

This uses the phone browser's own notifications. There is nothing to pay for, no account to open, and no other company involved: the messages go from Cloudflare to the phone through the browser maker's own service (Google's for Chrome, Apple's for Safari, Mozilla's for Firefox), which every phone already uses.

1. **Make the pair of keys**, once, on any computer with Node.js:

   ```
   npx web-push generate-vapid-keys
   ```

   It prints a **Public Key** and a **Private Key**. Keep the window open.
2. **The public key** is not secret. Put it in [`config.js`](config.js) as `vapidPublicKey`, commit and push:

   ```js
   window.ATTENDANCE_CONFIG = {
     serverUrl: 'https://rvnp-attendance.<your-subdomain>.workers.dev/',
     sheetsUrl: '...',
     vapidPublicKey: 'BOZ_WOrT…',   // the Public Key, exactly as printed
   };
   ```

   Remember to bump `CACHE` in [`sw.js`](sw.js) and `APP_VERSION` in [`app.js`](app.js) as with any app change, so phones pick it up.
3. **The private key is a secret.** In Cloudflare open the Worker → **Settings → Variables and Secrets → Add**, twice:
   - Type **Secret**, name `VAPID_PRIVATE_KEY`, value: the **Private Key** as printed.
   - Type **Secret**, name `VAPID_SUBJECT`, value: a contact address the browser makers can use if something goes wrong, for example `mailto:ict@rvnp.ac.ke`.

   Then add one plain variable so the Worker can work out the full key: Type **Text**, name `VAPID_PUBLIC_KEY`, value: the same **Public Key** as in `config.js`. Click **Deploy**.

   (If you would rather keep one secret than three values: put the whole key as JSON in `VAPID_PRIVATE_KEY` — `{"kty":"EC","crv":"P-256","d":"…","x":"…","y":"…"}` — and `VAPID_PUBLIC_KEY` is then not needed.)
4. Open the Worker's address with `?action=ping`: it should now say `"push":true`. Students then see the switch in the student app.

Never commit the private key, and never put it in `config.js`. If it is ever exposed, make a new pair and repeat steps 2 and 3: every student simply turns the switch on again.

## In the database

You can look at, search or download any table from the dashboard: **D1 → rvnp-attendance → Explore Data** (or **Console** for SQL).

| Table | What it holds |
|---|---|
| `staff` | Accounts and roles. PINs are stored only as salted hashes. |
| `terms` | Term dates and breaks; one is active. |
| `loading` | Who teaches which unit to which class, per term. |
| `classes` | Streams from the loading, linked to their MIS class list (`mis_class`). |
| `trainees` | The official class lists. `status` is active or withdrawn. |
| `requests` | Students added by trainers, and the MIS Officer's decisions. |
| `sessions` | One row per register with its counts, `term_id` and `week`; `kind` is lesson, cat or extra, `slots` is 2 for a double; `data` holds every student's mark. |
| `signoffs` | Term registers submitted to the HOD, and the decisions. |
| `checkins` / `devices` | Student QR check-ins and which phone belongs to whom. Delete a `devices` row to let a student set up a new phone. |
| `push_subs` | Which phones asked to be told about their evidence. Only an address from the browser — no names, no messages. A phone that unsubscribes is removed by itself. |
| `audit` | Who changed what in Manage. |

D1 keeps its own history: **D1 → rvnp-attendance → Time Travel** can put the whole database back to any minute in the last 7 days.

## How long data stays on a phone

Registers and check-ins are stored in the phone browser's database (IndexedDB). They stay there until they're synced, **with no time limit**. Signing out keeps them too.

| Protection | What it does |
|---|---|
| **Protected storage** | The app asks the browser to keep its data permanently. Browsers usually grant this once the app is **added to the home screen**. |
| **Second copy** | The phone ID, the student's registration and all unsent check-ins are also kept in a second storage area. They're restored automatically if the main database is ever lost. |
| **Reminders** | Students see a warning when check-ins have waited 3+ days. Trainers see one when registers have waited 2+ days. |
| **No expiry at the server** | A check-in that syncs months later is verified exactly like one sent the same day. |
| **Trainer backup** | **Me → Export backup** saves everything on the phone to a file, including the lesson secrets that verify students' scans. |

What can still lose unsent data: clearing the browser's data or uninstalling the browser; on iPhones, not opening the app for 7 days unless it was added to the home screen; and losing the phone before it syncs.

## Good to know

- **Sign-in security**:
  - 5 wrong PINs lock that staff code for 15 minutes;
  - when the MIS Officer resets a PIN or switches an account off, that person is signed out on every phone;
  - easy PINs like 1234 or 0000 are refused.
- The class register PDFs, loading workbook and Excel template stay on the computer that opens them. Only the rows the MIS Officer confirms are sent to the database.
- **How often phones ask the server anything.** Nothing at all while the app is off screen (in another app, or the phone locked); it starts again the moment the app is back. While the lesson QR is on screen, a tiny "anything new?" every 4 seconds; with today's QR register open, every 15 seconds; otherwise once a minute, easing off to once every 3 minutes when nobody has touched the phone for 10 minutes — one tap and it is back to once a minute. During a QR lesson the register is uploaded every 2 minutes and when the QR is closed (the server accepts students' genuine codes straight away without waiting for it). The student app asks about its evidence only when it opens, when it comes back into view, after an upload, and when a notification arrives.
- Load tests and their results are in [`loadtest/`](loadtest/README.md).
- When you change any app file, bump `CACHE` in `sw.js` (for example `v4.1.2`) so phones fetch the new version.
- **Testing the Worker on a computer** (for developers): `npx wrangler dev` with `worker/dev.js` as the main file and a local D1 binding called `DB` adds test helpers (`/__reset`, `/__dump`). Never deploy `dev.js`.

## Asking for a change to a screen

Describing a button in words is slow, and easy to get wrong. Instead, add **`?notes=1`** to the address of either app:

- https://ark26.pages.dev/?notes=1 — the trainer / HOD / MIS app
- https://ark26.pages.dev/student?notes=1 — the student app

A strip appears at the top. While **Pick** is on, whatever you touch is outlined, and tapping it opens a box: type what you want changed there and **Save**. A row of one-tap phrases (*Bigger*, *Move it up*, *Another colour*, *Easier to tap*…) is there too, so a note need not be typed out in full on a phone — tap a few, then add anything else in your own words. The app itself does nothing while you are picking, so a tap on *Sync* leaves a note instead of syncing. Turn **Pick** off to move around the app as usual — open a register, switch tabs, open the lesson QR — then turn it back on and carry on. **Esc** does the same on a computer.

Notes are kept in that browser, so they survive a reload and build up as you go round several screens. **Copy** then gives you one block to paste wherever you are asking for the work:

```
Design notes — 2 changes asked for

## index.html (trainer / HOD / MIS app)

1. `#netBadge` — “Online”
   index.html:69, app.js:1635
   → make this bigger, and red when the phone is offline

2. `button[data-tab="reports"]` — “Report(s)”
   index.html:76
   → put Reports before Attendance Register(s)
```

Each note already says which element it is on, the words that were on it, and the lines in this project's own files that mention it — so whoever does the work starts at the right line instead of hunting for it.

Anything you have typed into a box is never taken, so a PIN or an admission number cannot travel in a note. The words *printed* on the screen are, though: if you leave a note on a register row, that row's student name goes with it — trim it out of the paste, or leave the note on the column heading instead.

**Close** puts the page back exactly as a trainer or student sees it; your notes are kept, and `?notes=1` picks them up again. **Clear** forgets them.

This is for the people building the app. [`design-notes.js`](design-notes.js) is loaded **only** when `?notes=1` is in the address, so trainers and students never download it, and it is not part of what the app keeps for offline use — so the first time on a given phone it needs internet.


## Screens and tables

- **Wide screens** (a computer or a tablet held sideways) show the trainer app's tabs as a side bar on the left; phones keep the bar along the bottom.
- **The Registers tab is gone.** A register taken earlier is reopened from the timetable on the Mark tab (choose its class, unit and week, then tap its slot). Registers are sent automatically; if one has been waiting for two days, a warning appears at the top of the app.
- **Long tables are shown ten rows at a time** (or 25 or 50, chosen under the table): the term register, the POE students table, the department overview and the class list. Exports always contain every row.
- **Manage → Department overview, Class lists and Staff** start folded away; tap the heading to open one. The app remembers which you opened until you leave the page.
- There is no CSV export any more (Excel and PDF are the formats), and **Print QR ID cards** is visible but switched off. To bring it back, delete the word `disabled` on the `printQR` button in index.html; the code is still there.

## Changes in 4.8.0

- **Repeat a slot every week.** After you tap a slot on the timetable, tick **Repeat every Wednesday at 7:30** (for example). From then on, in any week where that slot has no register yet, it is already chosen when you reach the week; just tap **Open register**. Untick it to stop repeating. This is kept on the device.
- **Registers and marks have serial numbers, search and pages of 30.**
- **Manage → Registers to approve** can be searched by class, unit or trainer and is paged (30 at a time). The department overview sorts when you tap a column heading.
- **Google Drive folders are made for you.** From bridge version 1.3.0, every trainer in the loading who has no folder gets one inside the Trainers folder the next time the Drive updates. Update the bridge with `clasp push -f` and deploy a new version of the web app (see *Updating the bridge later*).
- **Scan ID cards** is visible but switched off.

## Changes in 4.9.0 (Worker 6.0.0)

- **One trainer, several devices.** Each device now brings down the registers the trainer made on their other devices, so the timetable shows them everywhere. Every mark carries the time it was set; when two copies of a register meet (on the server or on a device), each student keeps the latest mark, so one device can no longer wipe out another's work.
- **Earlier terms.** Reports has a **Term** choice (and Manage → Department overview has one too) for looking back at a term that has ended. Earlier terms need internet.
- **Ended terms are locked.** Registers and marks entered in a term that has ended cannot be changed. The HOD or MIS Officer can open an earlier term's report and tap **Unlock for 7 days** (or **Lock again**); in Marks, locked cells show with a dashed border and the HOD or MIS Officer can unlock them from the notice above the table.
- **One marksheet per unit for its whole life.** A unit that spans terms, with different trainers, keeps CAT 1–3 and PRAC 1–3 on one sheet; each mark remembers the term it was entered in. Marks already entered are moved across automatically the first time the new Worker runs.
- **Archive and delete a class** (MIS Officer). Open a class under Manage → Class lists and tap **Archive**: it disappears from day-to-day screens, nothing is deleted, and **Bring back** undoes it. An archived class can then be **deleted for good**: you type its name to confirm, a file with everything about it is saved to the device first, and the Google Drive copies are never touched.
- **Sortable tables.** Tap a column heading to sort (tap again to reverse) in the POE students table, the class list, the marks table and the department overview.

## Changes in 4.10.0 (Worker 6.1.0)

- **Sorting everywhere.** In the term register's sheet view, tap a column heading (Admission no, Name, Possible hrs, Actual hrs, %) to sort; tap again to reverse. The Sort choice above it follows. Registers to approve, the staff list and the marking register each have a **Sort** choice (the marking register remembers yours).
- **Students send POE for any unit their class has had**, not just this term's. Units from earlier terms are marked *(earlier term)*. Evidence for a unit not taught this term is decided by the trainer who had it last (or the HOD).

## Changes in 4.11.0 (Worker 6.2.0)

- **Absences tab** (HOD and MIS Officer). Set "Tell me about students who have missed more than N lessons of a unit"; the tab's dot shows how many students are over it. The list is searchable, sortable, 30 to a page, can look back at earlier terms, and saves as **Excel** or **PDF**. A double lesson counts as two.
- **First-time PIN** (Manage → Staff and roles). The MIS Officer sets one PIN; anyone without their own PIN signs in with it and then chooses their own. Resetting a PIN (MIS Officer only) sends someone back to the first-time PIN, or issues a one-off PIN.
- **Hours per lesson** is set by the MIS Officer with the term (Manage → Term). The register legend now reads "Late counts - 50%, Excused counts - 100%".
- **Lunch** can be chosen on the timetable for a CAT or extra attendance (never a lesson).
- **Tables start at 30 rows a page.**
- **POE preview** opens faster: files are kept on the device once opened, and the next submission is fetched while you read the current one.
- **Student app**: renamed *Student-POE*; shows the student's **QR ID** (the trainer's **Scan ID cards** is switched back on); **My POE submissions**, **My scanned check-in(s)** and **My attendance** fold away and sort, and *My attendance* keeps a copy of every lesson the trainers marked; a submission needs **at least 2 pages**, and **Keep and take the next page** goes straight to the camera.

## Changes in 4.12

- The staff list shows each person's staff code in place of a serial number.
- In a CAT week, **Lesson** is switched off: the CAT register (or extra CAT attendance) is taken instead.
- The lunch column looks the same for every kind of register; for a lesson its cells cannot be chosen.
- The student profile shows the college crest with *ICT Department*, and the QR caption reads *Student QR ID: Trainer can scan it to mark attendance*.
- 4.12.2: the page footer has been removed.
- 4.12.3: scanning several pages no longer crashes the student app. Photos are decoded already shrunk and every image's memory is let go as soon as it is used; pages show small thumbnails; **Keep and take the next page** opens the camera only after the page is saved; and the app never reloads itself for a new version in the middle of a scan.

## Changes in 4.13

- **The camera for evidence is inside the student app.** Opening the phone's own camera app let Android close the browser ("unable to complete previous operation due to low memory"), losing the page. Now **Take photo of a page** shows a live camera in the app; **Keep and take the next page** goes straight back to it, and **Retake** redoes a page.
- **Screenshots in the guides** come from `docs/make-screenshots.py`, which rebuilds them from the current code with an invented demo department.
- 4.13.1: smaller text on phones (a 14 px base instead of 16 px; typing boxes stay at 16 px so iPhones do not zoom).
- 4.13.2: text on phones smaller again (13 px base), in both the staff and student apps.

## Changes in 4.14

- **Scan ID cards** starts everyone who is not already marked by hand as **Absent**; each card scanned marks that student Present (or Late).
- The **Mark Attendance** tab is now called **Att Register(s)**.

## Changes in 4.15

- **Reset phone** in **Manage → Student phones** (HOD and MIS Officer): frees a student whose phone was changed, lost or reset, or who needs another browser. The next phone they set up becomes theirs; their records stay. Each reset is audited.
- Messages to students now say a phone or browser is already registered, and to ask the HOD or MIS Officer.
- **Demo copy** for showing trainers and students: the same apps and server at their own address with their own database of invented data (3 classes, 2 units each, 10 trainers). `python demo/demo.py setup` makes it, `reset` refills it before each demo. See [demo/README.md](demo/README.md).

## Changes in 4.15.1

- **The ARK now stands for Academic Records Keeper.** The sign-in screen shows the full name under the title, and the app names on phones are now *The ARK* (staff) and *Student-POE* (students). Apps already on a home screen keep their old name until they are added again.

## Changes in 4.16 (Worker 6.4.0)

- **Students save POE evidence in their own college Google Drive.** They connect Google once (college accounts only); each document goes to *The ARK - POE* in their Drive and is shared, view only, with the unit's trainer, the HOD, the MIS Officer and the backup account. A new trainer is added automatically; earlier ones keep access.
- **Fingerprints.** The server checks each file with Google and keeps its md5; if a student changes a file after sending it, trainers see *changed after sending*.
- **Staff connect Google** in Profile to open students' documents. The MIS Officer sets the **Backup account** in Manage → Google Drive.
- Uploads no longer go through the Drive bridge, so busy moments (everyone sending after a CAT) are no longer limited by Apps Script. Documents sent earlier still open through the bridge.

## Changes in 4.17 (Worker 6.5.0, Drive bridge 1.4.0)

- **Backup of approved evidence.** Approved documents in students' Drives are copied into *The ARK - Archive* in the backup account's Drive (ictpoe), sorted by class and student. **Manage → Backup** (HOD and MIS Officer): **Back up now**, a repeat setting (daily, weekly or monthly at a chosen hour), the last backup's counts, documents waiting, and **Try these again** for ones that failed.
- **Storage gauge and warnings.** The backup account's used and total space are shown; from 80% full the HOD and MIS Officer are warned to ask IT for more space or switch to another account, and at 95% backups stop.
- Drive bridge 1.4.1: the backup reads the account's address and storage from Drive itself (1.4.0 needed a permission the bridge does not have, so backups did not run).

## Changes in 4.17.1 (Worker 6.5.1, Drive bridge 1.4.2)

- **Backup storage shows the backup account's own use** against the space the college gave it, typed in Manage → Google Drive (**Space (GB)**, default 50). Google's own figures were the whole college's pooled storage (1.3 TB of 100 TB).
- Manage: the backup and backup-account forms sit on one row; removed **Test connection** (it no longer worked), the "sheets refresh" note and the "every trainer has a folder" line.
- Student app: **My POE submissions** and **My attendance** are now tables with search, filters (status; unit and mark) and sorting by heading; the scan and save buttons are smaller; a document being scanned shows just its item and page count.

## Changes in 4.17.2

- **Landing page** at `welcome.html`: what The ARK does, who it is for, screens, and links to the demo.
- **Demo day handout** at `demo/demo-day.html`: pairs (one partner the trainer, the other the student, then swap), the steps for each role, the facilitator's part and checklist. Prints on two pages.
- **Scan ID cards** no longer turns students who already checked in with the lesson QR absent.
- **Bigger demo**: 26 demo trainers (DEMO01 the HOD; DEMO02 to DEMO26 one unit each), 5 classes of 20 students with 5 units each, so 50 people can run the paired demo as 25 pairs. The handout lists all 25.

## Changes in 4.18

- **The student app's address is now `/student`** (the old `student.html` keeps working). The Student app link and lesson QR codes use it, and with no network `/student` opens the student app from the device.
- `_redirects` lets the apps run on Cloudflare Pages, which would otherwise redirect `index.html` and `student.html` and break offline use.

## Moved to Cloudflare Pages

- The apps now live at **https://ark26.pages.dev/** (trainers, HODs, MIS Officer) and **https://ark26.pages.dev/student** (students), on Cloudflare Pages, connected to this repository: every `git push` to `main` updates them. The old GitHub Pages address still works while people move over; each phone keeps its data per address, so send all registers before switching, then add the new address to the home screen.

## Changes in 4.19

- **Loading from other departments is now a choice.** When the loading workbook has classes from other departments (shared units an ICT trainer teaches), the MIS Officer sees a tick box for each department in the preview. They are left out unless ticked, so uploading the loading no longer adds other departments' classes by itself.

## Changes in 4.20

- **Combined lessons for streams.** A trainer who teaches a unit to more than one stream can tick **Streams in this lesson** on the Mark tab and mark all of them on one register in one slot. Each student is still saved on their own stream's register, the lesson QR works for every stream, and opening the slot again from either stream opens the combined register.
- **Reports by stream.** A class with streams is listed once with a **Stream** choice: **All streams** (each student tagged with their stream) or one stream. The HOD and MIS Officer always get all streams; a trainer who teaches the unit in only some streams sees theirs, with the others locked.

## Changes in 4.21

- **Marks by stream, too.** Report(s) → Marks has the same **Stream** choice as Attendance: all streams in one table (each student with their stream letter) or one stream. A mark typed for a student is saved with that student's own stream; only the streams you teach can be changed. The Excel marksheet covers the streams on screen.
- **Your streams together.** A trainer who teaches a unit in some streams but not all (2 of 3, say) gets **Streams A + C (yours)**, showing those streams together in Attendance and Marks; the other stream stays locked.

## Changes in 4.22

- **A student in the wrong stream can be added and marked.** On a class with streams, the register's **Add student** has **From another stream**: every student on the other streams' lists, even streams the trainer doesn't teach. Picking one marks them at once as **Pending**; the MIS Officer's **Move here** moves them to that stream. (Server 6.6.0 sends trainers the names in their classes' other streams.)

## Changes in 4.23

- **Add student starts with the reason.** *In the wrong stream* turns the admission number into a list of the class's other-stream students (the name fills itself in); every other reason keeps typing the admission number and name. The separate *From another stream* box is gone.
- **Pending students are marked by every trainer of the class**, as Pending, until the decision.
- **The HOD can move a student between streams** (Move here or Reject on those requests); new students and merges stay with the MIS Officer. (Server 6.7.0.)

## Changes in 4.24

- **The loading's two ways of joining classes.** A slash (*ICT L5LIS-26S/L6LIM-26S*) is one class for every unit: both MIS lists go into it, and the second no longer marks the first list's students as missing. A comma (*ICT L6ICT-26J, ICT L6ICT-26M-CT*) is classes taught one unit together: each class gets the unit with its own register, report and marksheet, and the Mark tab offers them ticked as one combined lesson. Classes named with a comma are no longer made (old empty ones are removed). Server 6.8.0, schema 11. **Upload the loading again** to apply this to the current term.

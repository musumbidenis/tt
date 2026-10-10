# RVNP Attendance Register (ICT Department)

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

- Trainer app: **https://musumbidenis.github.io/tt/**
- Student check-in app: **https://musumbidenis.github.io/tt/student.html**

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

If you used the earlier Google Sheet version, bring everything across once:

1. In the Google Sheet open **Extensions → Apps Script**, paste in the latest [`apps-script/Code.gs`](apps-script/Code.gs) and **Save**.
2. Reload the Sheet and choose **Attendance → Export everything for the new database**. Allow access when Google asks. It saves a file in your Google Drive; download it.
3. In the app, signed in as MIS Officer, open **Manage → Bring in data from the Google Sheet** and choose that file.

Staff, their PINs, terms, loading, class lists, registers, QR check-ins, student phones and sign-offs all come across. Running it again does no harm, so you can repeat it if a few registers reached the Sheet after the first run. Once `config.js` points at the Worker, phones switch over on their own: trainers sign in once more, and every register on their phone is sent to the new database.

The Apps Script version is kept only so its data can be moved across: the 12-week terms, CAT weeks, doubles, CAT registers and the stream preview need the Cloudflare database.

### Connect Google Drive (once, about 10 minutes)

This puts a Google Sheet of each trainer's attendance in their Drive folder, and stores the students' POE evidence in Drive. Do it with the **school Google Workspace account** that owns the folders.

1. In that account's Drive, have one **Trainers** folder with a folder per trainer inside it (named after them, for example `Musumbi Denis` or `ICT020 Musumbi`), and a **POE** folder. Open each and copy its ID: the part of the address after `/folders/`.
2. Open **https://script.google.com → New project**. Name it `RVNP Drive bridge`. Delete what is in `Code.gs`, paste in everything from [`apps-script/DriveBridge.gs`](apps-script/DriveBridge.gs) and **Save**.
3. **Project Settings** (the cog) → **Script Properties → Add script property**, three times:
   - `WORKER_URL`: the Worker's address from step 7 above
   - `TRAINERS_FOLDER_ID`: the Trainers folder ID
   - `POE_FOLDER_ID`: the POE folder ID
4. Back in the editor choose the function **setup** and click **Run**. Allow access when Google asks. The log shows a long **SECRET**: copy it.
5. In Cloudflare open the Worker → **Settings → Variables and Secrets → Add**: Type **Secret**, name `BRIDGE_SECRET`, value: the SECRET. Click **Deploy**.
6. In Apps Script click **Deploy → New deployment → Select type: Web app**. Execute as: **Me**. Who has access: **Anyone**. Click **Deploy**.
   If **Anyone** is not offered, the school's Workspace administrator has to allow sharing outside the school domain for Drive and Apps Script in the Admin console. Students upload without signing in to Google, so the web app must be open; every upload and preview still needs a ticket signed by the database.
7. Within 10 minutes the sheets appear and **Manage → Google Drive** shows *Connected*, with any trainer whose folder was not found by name. Pick their folder there.

Each trainer's folder gets **Attendance register - <term>** and **Marksheets - <term>**. The attendance sheet has one tab per class and unit in the class register layout (WK1–WK12, hours and %), plus a CATs tab when CATs were taken. It is rewritten from the database, so edits made in the sheet are replaced on the next update. Evidence is stored as **POE / Class / Adm No - Name / Unit - CAT1 - v1.pdf**, and the sheet **POE - Evidence index** in the POE folder lists every file with its status.

**Updating the bridge later**: paste the new `DriveBridge.gs`, Save, then **Deploy → Manage deployments → Edit (pencil) → Version: New version → Deploy**. The address stays the same.

## 2. MIS Officer: start of each term

Sign in at https://musumbidenis.github.io/tt/ with `MIS` and the PIN, then choose your own PIN. Everything below is under **Manage**.

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

1. Open https://musumbidenis.github.io/tt/ in Chrome **while online**, then choose **⋮ → Add to Home screen**. Sign in with your staff code and the PIN from the MIS Officer, then choose your own PIN. Your classes download straight away. From then on, the phone works with or without network.
2. **Mark**:
   - pick your class and unit (only those in your loading), and the **week** (it starts on the current week);
   - a timetable for that week appears: Monday to Friday, six slots a day (7.30–9.00, 9.00–10.30, 10.30–12.00, 13.00–14.30, 14.30–16.00, 16.00–17.30). Tap the slot where the class was. For a **double**, tap the next slot too. Registers already taken show in their slots; tap one to open it again;
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
1. Students open https://musumbidenis.github.io/tt/student.html. Trainers can also share the link from **Me → Student app link**.
2. The student chooses their **class** (as on the MIS list, for example *CSCL6-25-S-RS*), then their **name**, and taps **Register this phone**. The app knows which stream they're in.
3. The database ties that phone to that student:
   - the phone can only check in that student;
   - that student can only check in from that phone;
   - a registered phone can't be switched to someone else.

**Every lesson (trainer and students can all be offline):**
1. Open the register and tap **Show lesson QR**. The code is made on your phone, unique to the lesson, and changes every 20 seconds. Trainees who don't scan count as **absent** unless you mark them.
2. Students scan it with the app or their normal camera. The phone checks the class straight away, so a student from another class is refused. In a combined lesson (two classes in one loading row), students of both classes can check in.
3. Whenever each phone gets internet, it syncs. The server verifies every check-in against your phone's record of which codes it showed, and when. A forged, old or other-lesson code is refused, even if it arrives months later.

Syncing is automatic on both sides. During a live lesson, the trainer's phone checks every few seconds with a tiny "anything new?" question. A student's scan shows up within about 3–5 seconds of them being online.

## Marks (continuous assessment marksheets)

**Trainers** open **Reports → Marks**, choose the class and unit, and type each student's **CAT 1–3** and **PRAC 1–3** as percentages (0–100). Enter moves down the column. Every mark is saved on the phone straight away, also with no internet, and sent to the server when there is. **AVG** is the sum of the three divided by 3 (a CAT not done counts as 0). **Export Excel marksheet** gives RVNP's *Continuous Assessment Marks Sheet per Unit of Competency*: crest, Course Code and Name, Unit Code and Title, Assessment Series, the table and the Prepared / Received / Approved block.

**The MIS Officer** sets the **Assessment series** in **Manage → Term** (for example *Nov/Dec 2026*), and uploads the CDACC **registration codes** under **Manage → Class lists → Upload registration codes**: any Excel or CSV with admission numbers and registration codes, a filled marksheet included. Marks can be entered before the codes are in; they are matched by admission number.

With Google Drive connected, each trainer's folder also gets **Marksheets - <term>**: one tab per class and unit in the same layout, refreshed from the app every 10 minutes. Enter marks in the app; edits in the sheet are replaced.

## POE evidence (students send, trainers approve)

**Students** open **Evidence (POE)** in the student app, choose the unit and tick one or more items (CAT1–CAT4, PRAC1–PRAC3). For each item they photograph the pages; the app finds the page edges (drag the corners if needed), straightens the page and makes it look like a scan (**Document**, **Grey** or **Colour**). Pages can be reordered or deleted, or an existing PDF chosen instead. **Save and send** keeps the PDF on the phone first (and **Save a copy** puts it in the phone's downloads), then sends it to Drive when there is internet. The list shows *With your trainer*, *Approved* or *Returned* with the trainer's note; **Scan again** sends a new version (v2, v3…).

**Trainers** open the **POE** tab (the dot shows how many are waiting). Each submission opens inside the app with its pages; **Approve**, or **Return to student** with a note. After each decision the next one waiting opens. The HOD sees the whole department.

**The MIS Officer** sees the approved ones under **POE → To receive**, and marks them received once filed. The **By student** toggle (MIS Officer and HOD) shows one class at a time: each student with every unit and item — approved, with the trainer, returned or not sent — and any mark opens that file. Uploading and previewing need internet; the files themselves never pass through the database.

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
- Phones ask for new class lists every 10 minutes, but the answer is a few bytes unless something changed. While the lesson QR is on screen they ask a tiny "anything new?" every 4 seconds; with today's QR register open, every 15 seconds; otherwise once a minute. During a QR lesson the register is uploaded every 2 minutes and when the QR is closed (the server accepts students' genuine codes straight away without waiting for it).
- Load tests and their results are in [`loadtest/`](loadtest/README.md).
- When you change any app file, bump `CACHE` in `sw.js` (for example `v4.1.2`) so phones fetch the new version.
- **Testing the Worker on a computer** (for developers): `npx wrangler dev` with `worker/dev.js` as the main file and a local D1 binding called `DB` adds test helpers (`/__reset`, `/__dump`). Never deploy `dev.js`.

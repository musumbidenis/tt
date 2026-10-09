# RVNP Attendance Register (ICT Department)

Trainers mark attendance on their phones **with no internet**. Whenever a phone is online, its registers go straight into a **Google Sheet**. Class lists, trainer loading and term dates come back from the same Sheet.

There's no server, database or card needed. It uses just GitHub Pages (for the app) and your Google account (for the data).

```
Phone (works offline) ──when online──▶ Apps Script web app ──▶ Google Sheet
```

- Trainer app: **https://musumbidenis.github.io/tt/**
- Student check-in app: **https://musumbidenis.github.io/tt/student.html**

## Who does what

| Role | Signs in with | Can |
|---|---|---|
| **Trainer** | staff code + PIN | Mark registers for the classes and units in their loading (offline). Add a student who isn't on the list (pending). Show a lesson QR. See and export their units' term registers. Submit them to the HOD. |
| **HOD** | staff code + PIN | Everything a trainer can for their own units. Plus: approve or return submitted term registers, see every class's register, and see the department overview (which units are behind on marking). |
| **MIS Officer** | staff code + PIN | Set up the term (10 teaching weeks and the breaks). Upload the trainer loading workbook and the class register PDFs. Approve students added by trainers. Issue PINs and give roles. |

One person can have several roles; for example, an HOD who also teaches. Roles are set under **Manage → Staff and roles**.

---

## 1. Set up the Google Sheet (once)

1. Create a Google Sheet, for example "RVNP ICT Attendance".
2. Open **Extensions → Apps Script**. Paste in everything from [`apps-script/Code.gs`](apps-script/Code.gs), then **Save**.
3. Choose the function **setup** and click **Run**, then approve the permissions. It:
   - creates all the tabs;
   - shows the first **MIS Officer sign-in**: staff code `MIS` and a one-time PIN. Write it down. You can make a new one any time from the **Attendance** menu in the Sheet.
4. Click **Deploy → New deployment**, set the type to **Web app**, and set:
   - Execute as: **Me**
   - Who has access: **Anyone**

   Click **Deploy** and copy the **Web app URL** (it ends in `/exec`).
5. Put that URL in [`config.js`](config.js) in this repository, so every phone finds the Sheet by itself.

If you edit `Code.gs` later, go to **Deploy → Manage deployments → Edit → Version: New version → Deploy**. That keeps the same URL.

### Upgrading from the earlier version (the one with an access token)

1. Paste the new `Code.gs` and deploy a **new version**, as above.
2. Run **setup** once. It adds the new tabs (Staff, Terms, Loading, Requests, SignOffs, AuditLog), keeps all your data, and shows the MIS sign-in.
3. The old access token is no longer used. Everyone signs in with their own staff code and PIN. Registers already on phones are kept and sent after the trainer signs in.

## 2. MIS Officer: start of each term

Sign in at https://musumbidenis.github.io/tt/ with `MIS` and the PIN, then choose your own PIN. Everything below is under **Manage**.

1. **Term**:
   - enter the name (for example *Term 3 2026*), the code (*2026-T3*), the duration as printed on registers (*Sep - Dec 2026*) and the first teaching day;
   - add any break weeks.

   The app makes the **10 teaching weeks** and skips the breaks. Saving a new code starts a new term and closes the old one.
2. **Trainer loading**: choose the department loading workbook (`.xlsm` or `.xlsx`). The app reads only three tabs:
   - **Subject Loading** (class, subject code and name, trainer, lessons per week, hours per week);
   - **List of Trainers** (code, name, responsibility);
   - **List of Subject**.

   Check the preview, then tap **Upload loading**. Every trainer gets an account; anyone listed as HOD gets the HOD role.
3. **Class lists**: choose one or more class register PDFs from the MIS system. The same register saved as Excel, or a CSV, also works. For each file:
   - the app reads the class code (for example *CSCL6-25-S-RS*) and every student;
   - it ticks the streams in the loading that the class belongs to (*ICT L6CS-25SA / SB / SC*);
   - tap **Check changes** to see what will happen: who is new, who is already on the list, names spelt differently, and anyone missing from the file;
   - tap **Save class list**.

   On the first upload, students are split between the streams in list order. Later uploads add newcomers to the smallest stream. **Nobody is removed** unless you tick them as having left. To move a student between streams, or withdraw or restore them, tap the class.
4. **Staff and roles**: tap **Issue PIN** for each staff member and give them the PIN privately. They choose their own PIN the first time they sign in. Here you can also tick roles, or switch an account off (it is signed out everywhere).
5. **Students added by trainers** appear at the top of Manage. For each one:
   - **Approve** adds them to the class (or moves them if they're on another list);
   - **Same as…** is for a typo or duplicate: their marks count for the student you pick;
   - **Reject** leaves them out of that class's registers and reports.

   Uploading a newer class list that includes a pending student confirms them automatically.

## 3. Trainers: every lesson

1. Open https://musumbidenis.github.io/tt/ in Chrome **while online**, then choose **⋮ → Add to Home screen**. Sign in with your staff code and the PIN from the MIS Officer, then choose your own PIN. Your classes download straight away. From then on, the phone works with or without network.
2. **Mark**:
   - pick the date (the app shows *Week 3 of 10*), your class and unit (only those in your loading) and the lesson;
   - tap **P / A / L / E** for each student. Every tap is saved on the phone instantly, even offline.

   A unit can have up to **3 lessons a week**, matching the register's 3 cells per week. Dates outside the term's teaching weeks are refused.
3. **Add student**: for someone attending who isn't on the list. Mark them straight away; they show as **Pending** until the MIS Officer approves.
4. **Sync** happens automatically whenever the phone is online. The number on the Sync button counts what's still waiting.
5. **Reports → class and unit** shows the **term register**:
   - **The four cards**: lessons recorded, trainees, average attendance, and how many are below the minimum.
   - **On a phone**: one row per student, with a strip of the 10 weeks × 3 lessons (green present, amber late, red absent, blue excused). It also shows the student's percentage and Actual/Possible hours. You can filter (*Below 75%*, *Pending*) and sort.
   - **Sheet view** shows the full grid like the Excel register. It's for tablets, computers, or turning the phone sideways.
   - **Export Excel register** fills RVNP's General Class Register template exactly:
     - the crest and title block;
     - lecturer, class, level, duration and subject;
     - WK1–WK10 with 3 lessons each;
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
3. The Sheet ties that phone to that student in the `Devices` tab:
   - the phone can only check in that student;
   - that student can only check in from that phone;
   - a registered phone can't be switched to someone else.

**Every lesson (trainer and students can all be offline):**
1. Open the register and tap **Show lesson QR**. The code is made on your phone, unique to the lesson, and changes every 20 seconds. Trainees who don't scan count as **absent** unless you mark them.
2. Students scan it with the app or their normal camera. The phone checks the class straight away, so a student from another class is refused.
3. Whenever each phone gets internet, it syncs. The Sheet verifies every check-in against your phone's record of which codes it showed, and when. A forged, old or other-lesson code is refused, even if it arrives months later.

Syncing is automatic on both sides. During a live lesson, the trainer's phone checks every few seconds with a tiny "anything new?" question. A student's scan shows up within about 3–5 seconds of them being online.

## In the Sheet

| Tab | What it holds |
|---|---|
| `Staff` | Accounts and roles. PINs are stored only as salted hashes. |
| `Terms` | Term dates and breaks; one is active. |
| `Loading` | Who teaches which unit to which class, per term. |
| `Classes` | Streams from the loading, linked to their MIS class list (`MisClass`). |
| `Trainees` | The official class lists. `Status` is active or withdrawn. |
| `Requests` | Students added by trainers, and the MIS Officer's decisions. |
| `Sessions` / `Attendance` | One row per lesson and one per student per lesson, with `TermID` and `Week`. `Source` is `trainer`, `qr` or `default`. |
| `SignOffs` | Term registers submitted to the HOD, and the decisions. |
| `CheckIns` / `Devices` | Student QR check-ins and which phone belongs to whom. Delete a `Devices` row to let a student set up a new phone. |
| `AuditLog` | Who changed what in Manage. |

## How long data stays on a phone

Registers and check-ins are stored in the phone browser's database (IndexedDB). They stay there until they're synced, **with no time limit**. Signing out keeps them too.

| Protection | What it does |
|---|---|
| **Protected storage** | The app asks the browser to keep its data permanently. Browsers usually grant this once the app is **added to the home screen**. |
| **Second copy** | The phone ID, the student's registration and all unsent check-ins are also kept in a second storage area. They're restored automatically if the main database is ever lost. |
| **Reminders** | Students see a warning when check-ins have waited 3+ days. Trainers see one when registers have waited 2+ days. |
| **No expiry at the Sheet** | A check-in that syncs months later is verified exactly like one sent the same day. |
| **Trainer backup** | **Me → Export backup** saves everything on the phone to a file, including the lesson secrets that verify students' scans. |

What can still lose unsent data: clearing the browser's data or uninstalling the browser; on iPhones, not opening the app for 7 days unless it was added to the home screen; and losing the phone before it syncs.

## Good to know

- **Sign-in security**:
  - 5 wrong PINs lock that staff code for 15 minutes;
  - when the MIS Officer resets a PIN or switches an account off, that person is signed out on every phone;
  - easy PINs like 1234 or 0000 are refused.
- The class register PDFs, loading workbook and Excel template stay on the computer that opens them. Only the rows the MIS Officer confirms are sent to the Sheet.
- A Google Sheet holds up to 10 million cells, enough for several hundred thousand attendance rows. Start a new Sheet each year if it gets large.
- When you change any app file, bump `CACHE` in `sw.js` (for example `v4.0.1`) so phones fetch the new version.

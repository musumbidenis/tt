# Attendance Register (offline-first, Google Sheets)

Trainers mark attendance on their phones **with no internet**. Whenever a phone is online, its registers go straight into a **Google Sheet**, and class lists come back from the same Sheet.

There's no server, database or card needed. It uses just GitHub Pages (for the app) and your Google account (for the data).

```
Phone (works offline) ──when online──▶ Apps Script web app ──▶ Google Sheet
```

Live app: **https://musumbidenis.github.io/tt/**

---

## 1. Set up the Google Sheet (10 minutes, once)

1. Create a new Google Sheet, for example "RVNP Attendance 2026".
2. Open **Extensions → Apps Script**. Delete the sample code and paste in everything from [`apps-script/Code.gs`](apps-script/Code.gs). Click **Save**.
3. In the toolbar, choose the function **setup** and click **Run**, then approve the permissions. This step:
   - creates the tabs `Classes`, `Units`, `Trainees`, `Sessions` and `Attendance`, with sample rows;
   - shows an **access token**. Copy it; you can show it again later from the **Attendance** menu in the Sheet.
4. Click **Deploy → New deployment**, set the type to **Web app**, and set:
   - Execute as: **Me**
   - Who has access: **Anyone**

   Click **Deploy** and copy the **Web app URL** (it ends in `/exec`).
5. Replace the sample rows with your real class lists:
   - **Classes:** `ClassCode | ClassName`
   - **Units:** `ClassCode | UnitCode | UnitName`
   - **Trainees:** `AdmNo | Name | ClassCode | Active`

   Set `Active` to `No` when a trainee leaves, instead of deleting the row.

If you edit `Code.gs` later, go to **Deploy → Manage deployments → Edit → Version: New version**. That keeps the same URL.

## 2. Turn on the app (once)

On GitHub, in this repository, go to **Settings → Pages → Deploy from a branch** and choose `main` with `/ (root)`, then **Save**. After a minute the app is live at https://musumbidenis.github.io/tt/.

## 3. Each trainer's phone

1. Open https://musumbidenis.github.io/tt/ in Chrome **while online**, then choose **⋮ → Add to Home screen**.
2. In **Setup**:
   - enter the trainer's name;
   - paste the **Web app URL** and **access token**;
   - tap **Save and connect**.

   The class lists download straight away.

From then on, the phone works with or without network.

## Daily use

- **Mark:** pick the date, class, unit and lesson, then tap P / A / L / E for each trainee. Every tap is saved on the phone instantly, even offline. **Scan QR** marks trainees from their cards (print the cards from **Reports**).
- **Sync:** registers go to the Sheet automatically when the phone is online: on reconnect, a few seconds after saving, and every 5 minutes. The number on the **Sync** button counts registers still waiting. You can also tap it to send now.
- **In the Sheet:** each lesson becomes one row in `Sessions` and one row per trainee in `Attendance`. Editing a register updates the same rows and never duplicates them. An older copy from a phone that was offline for a long time never overwrites a newer one.
- **Class list changes:** edit the Sheet. Phones pick up the changes automatically every 12 hours when online, or straight away with **Setup → Download class lists**. If a tab is accidentally emptied, phones keep the lists they already have.
- **Reports:** attendance percentage per trainee per unit, flagging anyone below the minimum (75% by default; adjustable). Late counts as attended and Excused is left out of the percentage. Reports export to CSV.
- **Locking:** registers lock after 48 hours. Changing one after that asks for a reason, which is recorded and sent to the Sheet.
- **No network for weeks:** use **Setup → Export backup** and import the file on another device. It merges safely and never duplicates.

## QR check-in (students mark themselves)

**One-time setup for each student (needs internet once):**
1. Share the student app.
   - Either paste your web app URL into `config.js` in this repository, so students simply open https://musumbidenis.github.io/tt/student.html;
   - or, in the trainer app, open **Setup → Student app link** and share the QR or the link (for example in the class WhatsApp group).
2. The student chooses their **class**, then their **name**, from dropdowns filled from your Sheet, and taps **Register this phone**.
3. The Sheet ties that phone to that student in the `Devices` tab. From then on:
   - the phone can only check in that student;
   - that student can only check in from that phone;
   - a registered phone can't be switched to someone else.

**Every lesson (trainer and students can all be offline):**
1. Open the register and tap **QR for students**. The code is made on your phone, unique to the lesson, and changes every 20 seconds. Trainees who don't scan count as **absent** unless you mark them.
2. Students scan it with the app or their normal camera. The phone checks the class straight away, so a student from another class is refused, and stores the check-in.
3. Whenever each phone gets internet, it syncs. The Sheet verifies every check-in against your phone's record of which codes it showed, and when. A forged, old or other-lesson code is refused, even if it arrives months later.

**Syncing is automatic on both sides, with no buttons needed:**
- **Student phones** send check-ins:
  - straight after scanning, if online;
  - the moment the internet comes back;
  - whenever the app is opened;
  - every minute.
- **Your phone** sends your registers a few seconds after any change, and the moment you show a lesson QR. **During a live lesson**, while the QR is showing or today's QR register is open, it checks the Sheet every few seconds with a tiny "anything new?" question. A student's scan shows up within about 3–5 seconds of them being online: the counter on the QR screen goes up, and the register marks them Present with a **QR** tag. At other times it checks once a minute while the app is open. Registers that aren't open are updated in the background too.
- A scan of the code currently on screen is confirmed at once. If a student's check-in reaches the Sheet before your lesson does (for example, your phone was offline), it waits as "pending". It's confirmed automatically once your phone syncs, and the student's phone keeps re-checking every few seconds while it waits.
- When a new version of the app is published, phones switch to it automatically the next time it loads.

**In the Sheet:**
- `CheckIns` lists every attempt and its result.
- `Devices` shows which phone belongs to which student. **Delete a row** to let a student set up a new phone or fix a wrong choice.
- `Attendance` → `Source` shows `trainer` (you tapped it), `qr` (student scanned) or `default`.

## How long data stays on a phone

Registers and check-ins are stored in the phone browser's database (IndexedDB). They stay there until they're synced, **with no time limit**. The app also protects them in these ways:

| Protection | What it does |
|---|---|
| **Protected storage** | The app asks the browser to keep its data permanently, so it isn't cleared when the phone is low on space. Browsers usually grant this once the app is **added to the home screen**. The app shows a reminder until it's protected. |
| **Second copy** | The phone ID, the student's registration and all unsent check-ins are also kept in a second storage area. They're restored automatically if the main database is ever lost. |
| **Reminders** | Students see a warning when check-ins have waited 3+ days. Trainers see one when registers have waited 2+ days. |
| **No expiry at the Sheet** | A check-in that syncs months later is verified exactly like one sent the same day. |
| **Tamper-proof** | Changing a stored check-in (its lesson, time or code) makes it fail verification. A student's records only count for the phone registered to them. |
| **Trainer backup** | **Setup → Export backup** saves everything on the trainer's phone to a file, including the lesson secrets that verify students' scans. |

What can still lose unsent data:
- **Clearing the browser's data, or uninstalling the browser.** This removes both copies.
- **iPhones:** Safari deletes a website's data after 7 days of not opening it, unless the app was **added to the home screen**. So on iPhones, adding it to the home screen is essential.
- **Losing or breaking the phone** before it syncs. Sync whenever there's a connection.

The trainer's phone matters most: it holds each lesson's secret. Until that lesson reaches the Sheet, students' scans for it wait as "pending". So trainers should sync after class whenever possible, and export a backup if they'll be offline for long.

## Good to know

- **After updating `Code.gs`**, use **Deploy → Manage deployments → Edit → Version: New version → Deploy**. That keeps the same URL, and phones pick up the change. New tabs (`CheckIns`, `Devices`) are created automatically. Then tap **Setup → Download class lists** on your phone.
- The access token is shared with trainers. Anyone who has it can send registers to the Sheet. If it leaks, use **Attendance → Generate a new access token** in the Sheet and update the phones. 
- A Google Sheet holds up to 10 million cells. At 14 columns per trainee record, that's several hundred thousand attendance rows. When a year's Sheet gets large, start a new Sheet for the next year and deploy the script there.
- When you change any app file, bump `CACHE` in `sw.js` (for example `v3.0.1`) so phones fetch the new version.

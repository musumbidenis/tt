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

## Good to know

- The access token is shared with trainers. Anyone who has it can send registers to the Sheet. If it leaks, use **Attendance → Generate a new access token** in the Sheet and update the phones.
- A Google Sheet holds up to 10 million cells. At 14 columns per trainee record, that's several hundred thousand attendance rows. When a year's Sheet gets large, start a new Sheet for the next year and deploy the script there.
- When you change any app file, bump `CACHE` in `sw.js` (for example `v3.0.1`) so phones fetch the new version.

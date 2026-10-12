# The demo copy

A practice copy of The ARK (Academic Records Keeper) for showing trainers and students how it works. It runs the **same code** as the real app, at its own address, with its **own database** full of invented data. Nothing in it touches the real department, and the real app's data never appears in it.

- Staff app: `https://rvnp-attendance-demo.<subdomain>.workers.dev/`
- Student app: `https://rvnp-attendance-demo.<subdomain>.workers.dev/student.html`

Both show an orange **DEMO** tag beside the app name.

## What is in it

| | |
|---|---|
| Term | *Demo term*, started three weeks before the last reset (so it is week 4) |
| Classes | ICT L4CS-26SA, ICT L5CS-26SA, ICT L6CS-26SA, 15 students each (invented names) |
| Units | 2 per class: CE and DDL (L4), DBM and WD (L5), FOP and NET (L6) |
| Trainers | DEMO01 to DEMO10, all with the same trainer PIN. DEMO01 to DEMO06 teach one unit each; DEMO07 to DEMO10 have no units, so the MIS Officer can show giving them some. **DEMO01 is also the HOD.** |
| MIS Officer | Staff code `MIS`, with its own PIN |
| Registers | Two lessons a week for weeks 1 to 3 (NET only weeks 1 and 2, so the HOD's overview shows it behind) |
| Also | CAT 1 and PRAC 1 marks for the first unit of each class, a DBM register waiting for the HOD's approval, a student waiting for the MIS Officer |

Students set up a phone by choosing a class and any name on its list. The HOD or MIS Officer can free a name again with **Manage → Student phones → Reset phone**.

## Running a paired demo

`demo/demo-day.html` (on GitHub Pages: https://musumbidenis.github.io/tt/demo/demo-day.html) is a printable handout: five pairs on DEMO02 to DEMO06, one partner the trainer and the other the student, then they swap; the facilitator shows the HOD (DEMO01) and MIS parts on the projector. Hold it on a weekday, after a `reset`.

## Commands

Run from the repository folder, signed in to Cloudflare once with `npx wrangler login`. Choose the PINs when you run the command: they are not stored in the repository.

```
python demo/demo.py setup  --pin 1234 --mis-pin 9876    # first time: database, deploy, fill
python demo/demo.py reset  --pin 1234 --mis-pin 9876    # wipe and fill again: before each demo
python demo/demo.py deploy                              # send the latest app code to the demo
```

- **Reset** puts everything back as described above, with dates moved to the current week. Everyone has to sign in again. A trainer phone used in an earlier demo still holds that demo's registers and sends them back when it syncs, so tap **Profile → Erase this device** on demo phones before a reset, or use them in a private window.
- **Deploy** is needed after a change to the app, because the demo is not updated by the push to GitHub. Run `reset` after it if the database layout changed.

## Google, backup and notifications in the demo

- **POE evidence works** with real college Google accounts: the student partner's documents go to their own Drive and are shared with whoever connected Google on the demo trainer account. There is no backup: the demo has no Drive bridge, so **Manage → Backup** never runs.
- **Student notifications** are off (no notification keys).

Everything else (timetable, registers, Lesson QR check-ins, ID card scanning, reports, marks, approvals, absences, Manage) works as in the real app, online and offline.

## Cost

Stays on the free plan: one more Worker and one more D1 database (the free plan allows 10), in the same Cloudflare account.

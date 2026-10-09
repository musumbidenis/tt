# Load tests

Tools for testing how the server copes with many phones. Results from the first run are in the
section below.

| File | What it is |
|---|---|
| `locustfile.py` | Real phone traffic: trainers in live QR lessons, trainers with the app open, students scanning, HOD/MIS. Local server only. |
| `hammer.py` | Saturation test: live trainers with no pauses. Local server only. |
| `live_probe.py` | **Safe for the live server**: read-only, measures real network and database delays. |
| `seed.py` | Fills the local test database (1,200 students by default; `STREAMS=334 TRAINERS=200` for 10,000). |
| `cpu.mjs` | The Worker's own CPU time per request (the free plan allows 10 ms). |
| `wrangler.load.toml` | Local server with a meter of database rows read and written per request. |

## Running locally

```
npx wrangler dev --config loadtest/wrangler.load.toml --local --port 8090 --persist-to .load-d1
curl localhost:8090/__reset && python3 loadtest/seed.py
cd loadtest && locust -f locustfile.py --host http://localhost:8090 --headless -u 662 -r 30 -t 5m
curl localhost:8090/__meter            # D1 queries, rows read, rows written per request type
node cpu.mjs ../.load-d1/v3/d1/miniflare-D1DatabaseObject/<file>.sqlite seed.json
```

`-u` must equal the users in the mix: 20 live trainers, 40 idle trainers, 600 students, 2 office
(662). `LOAD_SCALE=2` doubles each (then `-u 1324`).

## Against the live server

Only `live_probe.py`, from your own computer:

```
pip install locust
STAFF=MIS PIN=your-pin locust -f live_probe.py --host https://rvnp-attendance.ictpoe.workers.dev --headless -u 10 -r 2 -t 3m
```

## First results (9 Oct 2026, local server, 2-core machine)

- No errors at any load. Peak lesson start, twice the department (40 live lessons, 1,200 students
  scanning): 35 requests/s, median 160 ms, 95% under 540 ms.
- Saturation: about 230 requests/s on 2 cores, still no errors; delays grow as requests queue.
- Worker CPU per request: under 4 ms at department size. At 10,000 students the full class-list
  download takes about 18 ms (over the 10 ms free limit).
- Daily free-plan use for the ICT department: about a third of the 100,000 requests if a QR
  register stays open 15 minutes, nearly all of it at 60 minutes (the 4-second "anything new?" check).
  Rows read: about 11% normally, but **156% on a day when every student sets up their phone**
  (the class and name lists read the whole student table on every phone).

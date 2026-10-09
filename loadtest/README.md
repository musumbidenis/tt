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
| `wrangler.load.toml` | Local server with a meter of database trips, rows read and rows written per request. |
| `summarize.py`, `compare.py`, `daymodel.py` | Read a run's results, compare two runs, and estimate a school day's use of the free plan. |

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

## Results

Local server on a 2-core machine, twice the ICT department at a lesson start: 40 QR lessons, 1,200
students setting up their phones and scanning, 80 more trainers with the app open. 4 minutes each.

| | Before (9 Oct) | After (10 Oct) |
|---|---|---|
| Errors | 0 | 0 |
| Replies within (95%) | 540 ms | 220 ms |
| Database trips | 27,970 | 10,603 |
| Rows read | 7.4 million | 0.26 million |
| Register uploads | 476 | 84 |

Database trips per request (each trip crosses from the Worker to the database):

| Request | Before | After |
|---|---|---|
| Student check-in | 11 | 2 |
| Register upload | 6 | 2 |
| "Anything new?" | 2 | 1 |
| Trainer's check-in download | 2 | 1 |
| Term register, HOD overview | 5 | 1 |
| Phone setup: class list / names | 1 (3,612 and 2,438 rows read) | 1 (5 and 95 rows read) |

A school day for the ICT department on the free plan (96 QR lessons, `daymodel.py`):

| Day | Requests before → after | Rows read before → after |
|---|---|---|
| Register open 15 min per lesson | 33% → 21% | 14% → 13% |
| Register open 60 min per lesson | 98% → 39% | 17% → 15% |
| First day of term, 1,200 phones set up | 37% → 25% | **160% → 16%** |

Worker CPU per request stays under 4 ms (median) at department size; the free plan allows 10 ms.
At 10,000 students (a whole institution) the full class-list download for the HOD/MIS takes about
18 ms and would need to come in parts.

Saturation (before): about 230 requests/s on 2 cores with no errors; replies slow down as requests queue.

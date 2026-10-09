"""Daily free-plan use for the ICT department from measured per-request rows (meter JSON).
96 lessons a day, all with QR, 30 students each, 60 trainers with the app open ~1 h a day each."""
import json, sys
m = json.load(open(sys.argv[1])); new = sys.argv[2] == 'new'
per = {k: (v['read'] / v['n'], v['written'] / v['n']) for k, v in m.items()}
def day(live_min, setup=0, lessons=96, students=30, trainers=60, full_rosters=300):
    n = {}
    if new:   # QR on screen 5 min (4 s checks, upload every 2 min + on close), then 15 s checks while the register stays open
        n['pulse'] = lessons * (5 * 15 + max(0, live_min - 5) * 4) + trainers * 60
        n['push'] = lessons * 4
    else:     # old app: 4 s checks the whole time, upload every 20 s for the first 5 min
        n['pulse'] = lessons * live_min * 15 + trainers * 60
        n['push'] = lessons * 15
    n['checkins'] = n['checkin'] = lessons * students
    n['roster'] = trainers * 6 + full_rosters
    n['login'] = 20
    n['classes'] = n['classlist'] = n['register'] = setup
    req = sum(n.values())
    rd = sum(c * per.get(k, (0, 0))[0] for k, c in n.items()); wr = sum(c * per.get(k, (0, 0))[1] for k, c in n.items())
    return req, rd, wr
for label, kw in [('normal day, QR register open 15 min per lesson', dict(live_min=15)),
                  ('normal day, QR register open 60 min per lesson', dict(live_min=60)),
                  ('first day of term: 1,200 phones set up', dict(live_min=15, setup=1200))]:
    req, rd, wr = day(**kw)
    print(f'{label:48} requests {req:7,.0f} ({req/1e5:4.0%})  rows read {rd:10,.0f} ({rd/5e6:5.0%})  rows written {wr:7,.0f} ({wr/1e5:4.0%})')

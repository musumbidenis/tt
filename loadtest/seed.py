"""Fills the LOCAL test database with a department-sized setup through the real API:
40 streams x 30 students (1,200), 60 trainers, 6 units per stream (240 loading rows).
Bigger: STREAMS=334 TRAINERS=200 python3 seed.py  (about 10,000 students, a whole institution).
Never run this against the live server."""
import json, os, sys, datetime, urllib.request, urllib.parse
B = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:8090'
if not B.startswith(('http://localhost', 'http://127.0.0.1')): raise SystemExit('seed.py is for the local test server only')
def post(body):
    r = urllib.request.Request(B + '/exec', data=json.dumps(body).encode(), headers={'Content-Type': 'text/plain;charset=utf-8'})
    out = json.load(urllib.request.urlopen(r))
    if not out.get('ok'): raise SystemExit(f"{body.get('action')}: {out}")
    return out
M = post({'action': 'login', 'staff': 'MIS', 'pin': '2468'})['token']
today = datetime.date.today(); monday = today - datetime.timedelta(days=today.weekday())
post({'action': 'saveTerm', 'auth': M, 'termId': 'T3-2026', 'name': 'Term 3 2026', 'duration': 'Sep - Dec 2026', 'startDate': (monday - datetime.timedelta(days=21)).isoformat()})
progs = ['CS', 'ICT', 'SE', 'NET']; intakes = ['25S', '26J', '26M', '24S', '25J']; streams = []
for p in progs:
    for i in intakes:
        for s in 'AB':
            streams.append(f'ICT L6{p}-{i}{s}')
if os.environ.get('STREAMS'): streams = [f'ICT L6X{i:03d}' for i in range(int(os.environ['STREAMS']))]
units = ['FOP', 'OOP', 'NET', 'DBS', 'WEB', 'ICT']
NT = int(os.environ.get('TRAINERS', '60')); trainers = [f'ICT{n:03d}' for n in range(1, NT + 1)]
rows, k = [], 0
for st in streams:
    for u in units:
        t = trainers[k % NT]; k += 1
        rows.append({'classCode': st, 'unitCode': u, 'unitName': f'Unit {u}', 'trainerCode': t, 'trainerName': f'Trainer {t}', 'lessonsPerWeek': 2, 'hoursPerWeek': 3, 'population': 30})
post({'action': 'uploadLoading', 'auth': M, 'rows': rows, 'trainers': [{'code': trainers[0], 'name': 'Trainer ICT001', 'responsibility': 'HOD'}]})
students, n = {}, 300000
for st in streams:
    lst = [{'admNo': f'L6/26/{n + i:06d}', 'name': f'Student {n + i}'} for i in range(30)]; n += 30
    post({'action': 'importClassList', 'auth': M, 'misClass': st.replace('ICT ', '') + '-RS', 'streams': [st], 'students': lst})
    students[st] = [s['admNo'] for s in lst]
for t in trainers:
    urllib.request.urlopen(B + '/__pin?' + urllib.parse.urlencode({'code': t, 'pin': '4826'})).read()
load = {}
for r in rows: load.setdefault(r['trainerCode'], []).append([r['classCode'], r['unitCode']])
json.dump({'streams': streams, 'students': students, 'loading': load, 'trainers': trainers}, open(sys.argv[2] if len(sys.argv) > 2 else 'seed.json', 'w'))
print(f'{len(streams)} streams, {sum(len(v) for v in students.values())} students, {len(trainers)} trainers, {len(rows)} loading rows')

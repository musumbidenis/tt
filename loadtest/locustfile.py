"""Load test for the RVNP attendance server (Cloudflare Worker + D1).

Models what the phones really send (see app.js / student.js):
  LiveTrainer   a trainer in a QR lesson. For the first QR_MIN minutes the QR is on screen: "anything new?"
                every 4 s and a register upload every 2 min; then the QR is closed (one upload) and the
                register stays open: a check every 16 s. Check-ins are downloaded when the check says
                something changed. Class-list check every 10 min; a new lesson every LESSON_MIN minutes.
  IdleTrainer   app open but no live lesson: pulse every 60 s, class-list check every 10 min.
  Student       registers the phone once, then scans the lesson QR of their class (valid codes).
  Office        HOD / MIS: overview, requests, a term register now and then.

Run against the local test server (seed first with seed.py):
  locust -f locustfile.py --host http://localhost:8090 --headless -u 700 -r 20 -t 5m
User mix comes from the class weights below (fixed_count), scaled with LOAD_SCALE.
"""
import hashlib, hmac, json, os, random, threading, time, datetime
from locust import HttpUser, task, constant, between, events

SEED = json.load(open(os.environ.get('SEED', os.path.join(os.path.dirname(__file__), 'seed.json'))))
SCALE = float(os.environ.get('LOAD_SCALE', '1'))
PIN = os.environ.get('TRAINER_PIN', '4826')
LESSON_MIN = float(os.environ.get('LESSON_MIN', '10'))
QR_MIN = float(os.environ.get('QR_MIN', '5'))
TODAY = datetime.date.today().isoformat()
HDR = {'Content-Type': 'text/plain;charset=utf-8'}

# Shared between users in this process: the live lesson of each stream and its QR secret.
live = {}            # stream -> {'sid', 'secret', 'w0'}
lock = threading.Lock()
trainer_pool = list(SEED['trainers']); random.shuffle(trainer_pool)
student_pool = [(st, adm) for st, adms in SEED['students'].items() for adm in adms]
random.shuffle(student_pool)

def window(): return int(time.time() // 20)
def now_iso(): return datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00', 'Z')
def token(secret, sid, w): return hmac.new(secret.encode(), f'{sid}|{w}'.encode(), hashlib.sha256).hexdigest()[:10]

class Api(HttpUser):
    abstract = True
    def post(self, body, name=None):
        with self.client.post('/exec', data=json.dumps(body), headers=HDR, name=name or body['action'], catch_response=True) as r:
            try:
                out = r.json()
            except Exception:
                r.failure(f'not JSON ({r.status_code}): {r.text[:120]}'); return {}
            if not out.get('ok') and not out.get('unchanged'):
                r.failure(out.get('error', 'not ok'))
            return out
    def sign_in(self):
        with lock:
            code = trainer_pool.pop() if trainer_pool else random.choice(SEED['trainers'])
        self.code = code
        self.tok = self.post({'action': 'login', 'staff': code, 'pin': PIN}).get('token', '')
        ro = self.post({'action': 'roster', 'auth': self.tok}, name='roster (full)')
        self.version = ro.get('version', '')
        self.mine = SEED['loading'].get(code) or [random.choice(sum(SEED['loading'].values(), []))]
    def roster_check(self):
        out = self.post({'action': 'roster', 'auth': self.tok, 'version': self.version}, name='roster (version check)')
        if out.get('version'): self.version = out['version']

class LiveTrainer(Api):
    weight = 20
    fixed_count = max(1, int(20 * SCALE))
    wait_time = constant(4)
    def on_start(self):
        self.sign_in(); self.ticks = 0; self.last = None; self.since = ''; self.new_lesson()
    def new_lesson(self):
        self.stream, self.unit = random.choice(self.mine)
        period = random.choice(['L1', 'L2', 'L3', 'L4', 'L5', 'L6'])
        self.sid = f'session:{TODAY}:{self.stream}:{self.unit}:{period}:{random.randint(0, 1 << 30)}'
        self.secret = hashlib.sha256(os.urandom(16)).hexdigest()[:32]
        self.w0 = window(); self.started = time.time(); self.closed = False
        self.marks = [{'admNo': a, 'name': a, 'status': 'Absent', 'explicit': False} for a in SEED['students'].get(self.stream, [])]
        self.push()
        with lock: live[self.stream] = {'sid': self.sid, 'secret': self.secret}
    def push(self):
        s = {'sessionId': self.sid, 'date': TODAY, 'classCode': self.stream, 'unitCode': self.unit, 'unitName': 'Unit ' + self.unit, 'period': 'Lesson',
             'trainerId': self.code, 'trainerName': 'Trainer ' + self.code, 'updatedAt': now_iso(),
             'marks': self.marks, 'qr': {'secret': self.secret, 'intervals': [[self.w0, window()]]}}
        self.post({'action': 'push', 'auth': self.tok, 'deviceId': 'dev-' + self.code, 'sessions': [s]})
    @task
    def tick(self):
        self.ticks += 1
        qr_on = time.time() - self.started < QR_MIN * 60
        if not qr_on and not self.closed:
            self.closed = True; self.push()                  # QR closed: upload the full register
        if qr_on or self.ticks % 4 == 0:                     # every 4 s with the QR on screen, else every 16 s
            p = self.post({'action': 'pulse', 'auth': self.tok})
            if p.get('last') != self.last:
                self.last = p.get('last')
                out = self.post({'action': 'checkins', 'auth': self.tok, 'sessionIds': [self.sid], 'since': self.since})
                if out.get('serverTime'): self.since = out['serverTime']
        if qr_on and self.ticks % 30 == 0: self.push()       # every 2 minutes while the QR is shown
        if self.ticks % 150 == 0: self.roster_check()        # every 10 minutes
        if time.time() - self.started > LESSON_MIN * 60: self.new_lesson()

class IdleTrainer(Api):
    weight = 40
    fixed_count = max(1, int(40 * SCALE))
    wait_time = constant(60)
    def on_start(self):
        self.sign_in(); self.ticks = 0
    @task
    def tick(self):
        self.ticks += 1
        self.post({'action': 'pulse', 'auth': self.tok})
        if self.ticks % 10 == 0: self.roster_check()

class Student(HttpUser):
    weight = 600
    fixed_count = max(1, int(600 * SCALE))
    wait_time = between(15, 60)
    def on_start(self):
        with lock:
            self.stream, self.adm = student_pool.pop()
        self.dev = 'stu-' + hashlib.md5(self.adm.encode()).hexdigest()[:12]
        self.client.get('/exec?action=classes', name='classes (setup)')
        self.client.get('/exec?action=classlist&class=' + self.stream.replace('ICT ', '') + '-RS', name='classlist (setup)')
        self.post({'action': 'register', 'admNo': self.adm, 'deviceId': self.dev})
        self.done = set()
    def post(self, body, name=None):
        with self.client.post('/exec', data=json.dumps(body), headers=HDR, name=name or body['action'], catch_response=True) as r:
            try: out = r.json()
            except Exception: r.failure(f'not JSON ({r.status_code})'); return {}
            if not out.get('ok'): r.failure(out.get('error', 'not ok'))
            return out
    @task
    def scan(self):
        with lock: l = live.get(self.stream)
        if not l or l['sid'] in self.done: return
        w = window()
        out = self.post({'action': 'checkin', 'checkins': [{'sessionId': l['sid'], 'admNo': self.adm, 'deviceId': self.dev, 'w': w, 'token': token(l['secret'], l['sid'], w), 'scannedAt': now_iso()}]})
        st = (out.get('results') or [{}])[0].get('status')
        if st in ('accepted', 'pending'): self.done.add(l['sid'])
        if st == 'rejected': events.request.fire(request_type='CHECK', name='check-in refused', response_time=0, response_length=0, exception=Exception((out.get('results') or [{}])[0].get('reason')))

class Office(Api):
    weight = 2
    fixed_count = max(1, int(2 * SCALE))
    wait_time = between(60, 120)
    def on_start(self):
        self.code = 'MIS'; self.tok = self.post({'action': 'login', 'staff': 'MIS', 'pin': '2468'}).get('token', '')
    @task(3)
    def overview(self): self.post({'action': 'overview', 'auth': self.tok})
    @task(2)
    def requests(self): self.post({'action': 'requests', 'auth': self.tok})
    @task(1)
    def report(self):
        st = random.choice(SEED['streams'])
        self.post({'action': 'report', 'auth': self.tok, 'classCode': st, 'unitCode': random.choice(['FOP', 'OOP', 'NET', 'DBS', 'WEB', 'ICT'])})

"""Safe test of the LIVE server: read-only requests, so nothing is added to the real database.

Measures what local tests cannot: the real network and D1 round trips from where you are.
Each user signs in once with your staff code and PIN, then behaves like a trainer's phone in a
live lesson: "anything new?" every 4 seconds, plus a class-list check and a term register now and then.

  pip install locust
  STAFF=MIS PIN=your-pin locust -f live_probe.py --host https://rvnp-attendance.ictpoe.workers.dev \
      --headless -u 10 -r 2 -t 3m

10 users for 3 minutes is about 500 requests and a few thousand rows read: well under 1% of the
free daily limits. Don't run it with hundreds of users against the live server.
"""
import json, os, random
from locust import HttpUser, task, constant

STAFF = os.environ.get('STAFF', 'MIS')
PIN = os.environ['PIN']
HDR = {'Content-Type': 'text/plain;charset=utf-8'}

class Phone(HttpUser):
    wait_time = constant(4)
    def post(self, body, name=None):
        with self.client.post('/', data=json.dumps(body), headers=HDR, name=name or body['action'], catch_response=True) as r:
            try:
                out = r.json()
            except Exception:
                r.failure(f'not JSON ({r.status_code}): {r.text[:120]}'); return {}
            if not out.get('ok') and not out.get('unchanged'):
                r.failure(out.get('error', 'not ok'))
            return out
    def on_start(self):
        out = self.post({'action': 'login', 'staff': STAFF, 'pin': PIN})
        if out.get('mustChange'):
            raise SystemExit('Choose your own PIN in the app first, then run this again.')
        self.tok = out.get('token', '')
        ro = self.post({'action': 'roster', 'auth': self.tok}, name='roster (full)')
        self.version = ro.get('version', '')
        self.units = [(u['classCode'], u['code']) for u in ro.get('units', [])]
        self.n = 0
    @task
    def tick(self):
        self.n += 1
        self.post({'action': 'pulse', 'auth': self.tok})
        if self.n % 15 == 0:
            self.post({'action': 'roster', 'auth': self.tok, 'version': self.version}, name='roster (version check)')
        if self.n % 20 == 0 and self.units:
            c, u = random.choice(self.units)
            self.post({'action': 'report', 'auth': self.tok, 'classCode': c, 'unitCode': u})

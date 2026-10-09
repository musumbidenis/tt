"""Saturation test: trainers in a live lesson with no pauses, each also sending students' check-ins.
locust -f hammer.py --host http://localhost:8090 --headless -u N -r N -t 2m"""
import random
from locust import constant
from locustfile import LiveTrainer, SEED, window, token, now_iso

class Hammer(LiveTrainer):
    fixed_count = 0
    weight = 1
    wait_time = constant(0)
    def on_start(self):
        super().on_start(); self.n = 0
    def tick(self):
        self.n += 1
        self.post({'action': 'pulse', 'auth': self.tok})
        adm = random.choice(SEED['students'].get(self.stream) or ['x'])
        w = window()
        self.post({'action': 'checkin', 'checkins': [{'sessionId': self.sid, 'admNo': adm, 'deviceId': 'stu-ham-' + adm, 'w': w, 'token': token(self.secret, self.sid, w), 'scannedAt': now_iso()}]}, name='checkin')
        self.post({'action': 'checkins', 'auth': self.tok, 'sessionIds': [self.sid], 'since': ''})
        if self.n % 10 == 0: self.push()
        if self.n % 20 == 0: self.new_lesson()
    tasks = [tick]

"""The demo copy of The ARK (Academic Records Keeper): the same apps and server with invented data, for showing trainers and students.

    python demo/demo.py setup  --pin 1234 --mis-pin 9876    first time: makes the database, deploys, fills it
    python demo/demo.py deploy                              sends the current code to the demo (after app changes)
    python demo/demo.py reset  --pin 1234 --mis-pin 9876    wipes the demo and fills it again (before each demo)

Run from the repository folder, signed in to Cloudflare (npx wrangler login). PINs can also come from the
environment (DEMO_PIN, DEMO_MIS_PIN); they are never written to the repository.

What goes in (all invented): a term that started three weeks ago, 5 classes of 20 students with 5 units each,
26 trainers and the MIS Officer (MIS), three weeks of registers, some CAT 1 marks, a register waiting for the HOD's
approval and a student waiting for the MIS Officer. DEMO01 is the HOD (the facilitator's account; its one unit, PRJ, is taught to both L5 streams together);
DEMO02 to DEMO26 teach one unit each, so 50 people can run a paired demo as 25 pairs (demo/demo-day.html).
This week is left empty, so each pair can mark its own lessons on the day (a unit takes up to 3 a week).
"""
import argparse, datetime, hashlib, json, os, pathlib, re, secrets, shutil, subprocess, sys, tempfile, time, urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
TOML = ROOT / 'wrangler.demo.toml'
DB = 'rvnp-demo'
WHERE = ['--remote']                    # --local when trying the demo on this computer (wrangler dev)

SURNAMES = ['AKINYI', 'BARASA', 'CHEBET', 'KAMAU', 'MUTUA', 'NJERI', 'ODHIAMBO', 'WAFULA', 'WANJIRU', 'KIBET', 'OTIENO', 'WEKESA', 'JEPTOO',
            'KIPROP', 'WAIRIMU', 'NJOROGE', 'ROTICH', 'MUSYOKA', 'NDUKU', 'WAMBUI', 'OMONDI', 'SIMIYU', 'LANGAT', 'MORAA', 'NEKESA', 'ONYANGO']
TRAINERS = [(f'DEMO{i + 1:02d}', f'ICT {s} .{"ABCDEFGHJKLMNPRSTVW"[(i * 7) % 19]}') for i, s in enumerate(SURNAMES)]
HOD = 'DEMO01'
# Five units for each class: (code, name). The two streams of a level have the same units.
UNITS = {
    '4': [('CE', 'Computer Essentials'), ('DDL', 'Demonstrate Digital Literacy'), ('OHS', 'Occupational Safety and Health'), ('COM', 'Communication Skills'), ('ENT', 'Entrepreneurship')],
    '5': [('DBM', 'Database Management'), ('WD', 'Web Design'), ('OS', 'Operating Systems'), ('CNW', 'Computer Networks'), ('MAT', 'Business Mathematics')],
    '6': [('FOP', 'Fundamentals of Programming'), ('NET', 'Network Administration'), ('SAD', 'Systems Analysis and Design'), ('OOP', 'Object-Oriented Programming'), ('CYB', 'Cyber Security')],
}
# class code, MIS class, admission prefix, name; units and trainers (DEMO02 onwards, one unit each) are filled in below
_CLASSES = [('ICT L4CS-26SA', 'CSCL4-26-S-RS', 'L4CS/26S/40', 'ICT Artisan L4 (demo)'),
            ('ICT L5CS-26SA', 'CSCL5-26-S-RSA', 'L5CS/26S/50', 'ICT Certificate L5 stream A (demo)'),
            ('ICT L5CS-26SB', 'CSCL5-26-S-RSB', 'L5CS/26S/55', 'ICT Certificate L5 stream B (demo)'),
            ('ICT L6CS-26SA', 'CSCL6-26-S-RSA', 'L6CS/26S/60', 'ICT Diploma L6 stream A (demo)'),
            ('ICT L6CS-26SB', 'CSCL6-26-S-RSB', 'L6CS/26S/65', 'ICT Diploma L6 stream B (demo)')]
CLASSES, CLASS_NAMES, _t = [], {}, 1
for _code, _mis, _prefix, _name in _CLASSES:
    _units = []
    for _u, _n in UNITS[_code.split()[1][1]]:
        _units.append((_u, _n, TRAINERS[_t][0])); _t += 1
    CLASSES.append((_code, _mis, _prefix, _units)); CLASS_NAMES[_code] = _name
PER_CLASS = 20
JOINT = ('ICT L5CS-26SA, ICT L5CS-26SB', 'PRJ', 'Project')   # DEMO01 teaches it to both L5 streams together
BEHIND = ('ICT L6CS-26SB', 'CYB')        # one unit a week behind on marking, for the HOD's overview
FIRST = ['Achieng', 'Barasa', 'Chebet', 'Cheruiyot', 'Gathoni', 'Kamau', 'Kiprono', 'Kosgei', 'Mutua', 'Mwende', 'Njeri', 'Nyambura', 'Odhiambo', 'Ouma', 'Wafula',
         'Wanjiru', 'Atieno', 'Jepkemoi', 'Kibet', 'Moraa', 'Nekesa', 'Onyango', 'Rotich', 'Wambui', 'Langat', 'Owino', 'Muthoni', 'Kerubo', 'Simiyu', 'Kendi',
         'Juma', 'Adhiambo', 'Kiplagat', 'Nduku', 'Omondi', 'Wekesa', 'Wairimu', 'Chepkoech', 'Musyoka', 'Akinyi', 'Ochieng', 'Nafula', 'Njoroge', 'Jeptoo', 'Mwangi']
GIVEN = ['Mary', 'Kevin', 'Faith', 'Brian', 'Ruth', 'Peter', 'Collins', 'Allan', 'Dennis', 'Lucy', 'Esther', 'Joy', 'Sharon', 'Felix', 'Sam', 'Ivy', 'Victor', 'Grace']
LAST = ['Otieno', 'Wekesa', 'Jeptoo', 'Kiprop', 'Wairimu', 'Njoroge', 'Rotich', 'Kipchumba', 'Musyoka', 'Nduku', 'Wambui', 'Wanjiku', 'Omondi', 'Simiyu', 'Kamau']
SLOTS = [('7.30', '9.00'), ('9.00', '10.30'), ('10.30', '12.00'), ('13.00', '14.30'), ('14.30', '16.00'), ('16.00', '17.30')]
# Two lessons a week for each of a class's five units, never two at once: (day 0 = Monday, lesson slot).
WHEN = [[(0, 1), (2, 3)], [(1, 2), (3, 4)], [(0, 4), (3, 1)], [(1, 5), (4, 2)], [(2, 1), (4, 5)]]
TOPICS = {'CE': 'Parts of a computer', 'DDL': 'Using e-mail safely', 'OHS': 'Safety in the lab', 'COM': 'Writing a memo', 'ENT': 'Business ideas',
          'DBM': 'Tables and keys', 'WD': 'HTML basics', 'OS': 'Files and folders', 'CNW': 'Network cables', 'MAT': 'Percentages',
          'FOP': 'Variables and loops', 'NET': 'IP addressing', 'SAD': 'Gathering requirements', 'OOP': 'Classes and objects', 'CYB': 'Strong passwords'}
_NAMES = []
for _k in range(400):
    _n = f'{FIRST[_k % 45]} {GIVEN[(_k * 7 + _k // 45) % len(GIVEN)]} {LAST[(_k * 4 + _k // 15) % 15]}'
    if _n not in _NAMES: _NAMES.append(_n)
    if len(_NAMES) == PER_CLASS * len(_CLASSES): break


def students(cls_i):
    prefix = CLASSES[cls_i][2]
    return [{'admNo': f'{prefix}{i + 1:02d}', 'name': _NAMES[cls_i * PER_CLASS + i]} for i in range(PER_CLASS)]


def trainer_of(code, unit):
    return next(t for c, _, _, units in CLASSES if c == code for u, _, t in units if u == unit)


def npx(*args, capture=True):
    exe = shutil.which('npx') or shutil.which('npx.cmd')
    if not exe: sys.exit('Node.js (npx) is needed.')
    r = subprocess.run([exe, 'wrangler', *args], cwd=ROOT, capture_output=capture, text=True, encoding='utf-8', errors='replace')
    if r.returncode:
        sys.exit(f'wrangler {" ".join(args[:3])} failed:\n{(r.stdout or "")[-1500:]}\n{(r.stderr or "")[-1500:]}')
    return r.stdout or ''


def database_id():
    m = re.search(r'database_id = "([^"]+)"', TOML.read_text(encoding='utf-8'))
    return m.group(1) if m and m.group(1) != 'REPLACE_ME' else ''


def create_database():
    if database_id(): return
    print('making the demo database…')
    out = npx('d1', 'create', DB)
    m = re.search(r'([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})', out)
    if not m:
        out = npx('d1', 'info', DB, '--json')
        m = re.search(r'"uuid":\s*"([0-9a-f-]{36})"', out)
    if not m: sys.exit('Could not read the new database ID:\n' + out)
    TOML.write_text(TOML.read_text(encoding='utf-8').replace('REPLACE_ME', m.group(1)), encoding='utf-8')
    print('  database', m.group(1), '(saved in wrangler.demo.toml)')


def stage_assets():
    """A clean copy of the apps' files for the demo: everything .assetsignore does not leave out, and never _redirects
    (that file is for Cloudflare Pages; the demo's file serving would read it too and break every page)."""
    import fnmatch
    skip = [l.strip() for l in (ROOT / '.assetsignore').read_text(encoding='utf-8').splitlines() if l.strip() and not l.startswith('#')] + ['_redirects']
    out = pathlib.Path(tempfile.mkdtemp(prefix='ark-demo-'))
    for f in ROOT.rglob('*'):
        rel = f.relative_to(ROOT).as_posix()
        if f.is_dir() or any(fnmatch.fnmatch(part, pat) for part in rel.split('/') for pat in skip): continue
        dest = out / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(f, dest)
    return out


def deploy():
    print('deploying the demo…')
    assets = stage_assets()
    try:
        out = npx('deploy', '--config', str(TOML), '--assets', str(assets))
    finally:
        shutil.rmtree(assets, ignore_errors=True)
    m = re.search(r'https://[a-z0-9.-]+\.workers\.dev', out)
    if not m: sys.exit('Deployed, but the address was not in the output:\n' + out[-1500:])
    url = m.group(0)
    (ROOT / 'demo' / '.url').write_text(url, encoding='utf-8')
    print('  ', url)
    return url


class Api:
    def __init__(self, url):
        self.url = url.rstrip('/') + '/exec'

    def call(self, body, ok=True):
        req = urllib.request.Request(self.url, data=json.dumps(body).encode(), headers={'Content-Type': 'text/plain;charset=utf-8', 'User-Agent': 'rvnp-demo-seed'})
        for attempt in range(4):
            try:
                out = json.load(urllib.request.urlopen(req, timeout=90)); break
            except Exception:
                if attempt == 3: raise
                time.sleep(3)
        if ok and not out.get('ok', True): raise RuntimeError(f"{body.get('action')}: {out.get('error')}")
        return out

    def ping(self):
        req = urllib.request.Request(self.url + '?action=ping', headers={'User-Agent': 'rvnp-demo-seed'})
        for _ in range(20):
            try: return json.load(urllib.request.urlopen(req, timeout=60))
            except Exception: time.sleep(3)
        sys.exit('The demo server does not answer at ' + self.url)

    def login(self, code, pin):
        return self.call({'action': 'login', 'staff': code, 'pin': pin})['token']


def tables():
    """Every table the server makes, read from worker.js so a new table is wiped too."""
    src = (ROOT / 'worker' / 'worker.js').read_text(encoding='utf-8')
    return sorted(set(re.findall(r'CREATE TABLE IF NOT EXISTS (\w+)', src)) - {'meta'})


def wipe_and_staff(pin, mis_pin):
    """Empties the demo database (keeping its schema and its sign-in key) and adds the staff with their PINs."""
    version = int(time.time())          # new PIN version: sign-ins from an earlier demo stop working
    def staff(code, name, roles, resp, p):
        salt = secrets.token_hex(16)
        h = hashlib.sha256(f'{salt}|{p}'.encode()).hexdigest()
        q = lambda s: "'" + str(s).replace("'", "''") + "'"
        return f"({q(code)},{q(name)},{q(roles)},{q(resp)},1,{q(h)},{q(salt)},{version},0,{q(datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.000Z'))})"
    rows = [staff('MIS', 'MIS Officer (demo)', 'MIS', '', mis_pin)]
    rows += [staff(c, n, 'TRAINER, HOD' if c == HOD else 'TRAINER', 'HOD' if c == HOD else '', pin) for c, n in TRAINERS]
    sql = [f'DELETE FROM {t};' for t in tables()]
    sql.append("DELETE FROM meta WHERE key NOT IN ('schema','auth_secret');")
    # The classes with their names (the loading and class lists that follow keep them).
    sql.append('INSERT INTO classes (code,name,level,mis_class) VALUES ' + ','.join(f"('{c}','{CLASS_NAMES[c]}','{c.split()[1][1]}','{m}')" for c, m, _, _ in CLASSES) + ';')
    sql.append('INSERT INTO staff (code,name,roles,responsibility,active,pin_hash,pin_salt,pin_version,must_change,updated_at) VALUES ' + ','.join(rows) + ';')
    with tempfile.NamedTemporaryFile('w', suffix='.sql', delete=False, encoding='utf-8') as f:
        f.write('\n'.join(sql)); path = f.name
    try:
        npx('d1', 'execute', DB, *WHERE, '--file', path, '--config', str(TOML), '--yes')
    finally:
        os.unlink(path)


def fill(api, pin, mis_pin):
    M = api.login('MIS', mis_pin)
    today = datetime.date.today()
    monday = today - datetime.timedelta(days=today.weekday())
    start = monday - datetime.timedelta(days=21)                        # this week is week 4
    term = f'{today.year}-DEMO'
    api.call({'action': 'saveTerm', 'auth': M, 'termId': term, 'name': f'Demo term {today.year}', 'duration': 'Demo', 'startDate': start.isoformat(),
              'catWeeks': [5, 11], 'series': f'Nov/Dec {today.year}', 'lessonHours': 1.5})
    names = dict(TRAINERS)
    rows = [{'classCode': c, 'unitCode': u, 'unitName': n, 'trainerCode': t, 'trainerName': names[t], 'lessonsPerWeek': 2, 'hoursPerWeek': 3}
            for c, _, _, units in CLASSES for u, n, t in units]
    # The facilitator's own unit: both L5 streams learn it together (a comma in the loading), to show a combined lesson.
    rows.append({'classCode': JOINT[0], 'unitCode': JOINT[1], 'unitName': JOINT[2], 'trainerCode': HOD, 'trainerName': names[HOD], 'lessonsPerWeek': 2, 'hoursPerWeek': 3})
    api.call({'action': 'uploadLoading', 'auth': M, 'rows': rows,
              'trainers': [{'code': c, 'name': n, 'responsibility': 'HOD' if c == HOD else ''} for c, n in TRAINERS]})
    for i, (code, mis, _, _) in enumerate(CLASSES):
        api.call({'action': 'importClassList', 'auth': M, 'misClass': mis, 'streams': [code], 'students': students(i)})
    print(f'  term, loading, {len(TRAINERS)} trainers and {PER_CLASS * len(CLASSES)} students')

    now = datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.000Z')
    tokens = {}
    for ci, (code, _, _, units) in enumerate(CLASSES):
        roster = students(ci)
        for ui, (unit, uname, trainer) in enumerate(units):
            tok = tokens.get(trainer) or tokens.setdefault(trainer, api.login(trainer, pin))
            weeks = 2 if (code, unit) == BEHIND else 3                 # one unit behind on marking, for the HOD's overview
            sessions, n = [], 0
            for wk in range(weeks):
                for day, slot in WHEN[ui]:
                    date = (start + datetime.timedelta(days=wk * 7 + day)).isoformat()
                    at = f'{date}T05:00:00.000Z'
                    marks = []
                    for i, s in enumerate(roster):
                        st = 'Present'
                        if (i * 3 + n + ci) % 13 == 0 or (i == 4 and n % 2 == 0): st = 'Absent'
                        elif (i + n + ui) % 9 == 0: st = 'Late'
                        elif (i + n) % 19 == 0: st = 'Excused'
                        marks.append({'admNo': s['admNo'], 'name': s['name'], 'status': st, 'explicit': True, 'at': at})
                    n += 1
                    counts = {k: sum(1 for m in marks if m['status'] == v) for k, v in (('P', 'Present'), ('A', 'Absent'), ('L', 'Late'), ('E', 'Excused'))}
                    a, b = SLOTS[slot - 1]
                    sessions.append({'sessionId': f'session:{date}:{code}:{unit}:L{slot}', 'date': date, 'classCode': code, 'className': code,
                                     'unitCode': unit, 'unitName': uname, 'period': f'Lesson {slot} · {a}–{b}', 'kind': 'lesson', 'slots': 1, 'title': '',
                                     'trainerId': trainer, 'trainerName': names[trainer], 'deviceId': 'demo-seed', 'termId': term, 'week': wk + 1,
                                     'notes': TOPICS[unit], 'createdAt': at, 'updatedAt': at, 'edits': 0, 'counts': counts, 'marks': marks})
            api.call({'action': 'push', 'auth': tok, 'deviceId': 'demo-seed', 'sessions': sessions})
            if ui == 0:                                                 # CAT 1 and a practical for the first unit of each class
                api.call({'action': 'marksPush', 'auth': tok, 'classCode': code, 'unitCode': unit, 'rows': [
                    {'admNo': s['admNo'], 'cat1': 45 + (i * 7 + ci * 5) % 50, 'prac1': 55 + (i * 5) % 40, 'updatedAt': now} for i, s in enumerate(roster)]})
    print('  registers for weeks 1 to 3, and marks')

    api.call({'action': 'addStudents', 'auth': tokens[trainer_of('ICT L6CS-26SA', 'FOP')], 'students': [
        {'admNo': 'L6CS/26S/6099', 'name': 'Example Late Joiner', 'classCode': 'ICT L6CS-26SA', 'reason': 'Late admission'}]})
    api.call({'action': 'submitSignoff', 'auth': tokens[trainer_of('ICT L5CS-26SA', 'DBM')], 'classCode': 'ICT L5CS-26SA', 'unitCode': 'DBM', 'unitName': 'Database Management',
              'comment': 'Registers for weeks 1 to 3 are complete.'})
    print('  a register waiting for approval and a student waiting for the MIS Officer')


def pins(a):
    pin, mis = a.pin or os.environ.get('DEMO_PIN', ''), a.mis_pin or os.environ.get('DEMO_MIS_PIN', '')
    for p in (pin, mis):
        if not re.fullmatch(r'[0-9]{4,8}', p or ''): sys.exit('Give --pin and --mis-pin (4 to 8 digits), or set DEMO_PIN and DEMO_MIS_PIN.')
    return pin, mis


def reset(url, pin, mis_pin):
    api = Api(url)
    print('server', api.ping().get('version'), 'at', url)              # the first request also makes the tables
    print('emptying the demo database…')
    wipe_and_staff(pin, mis_pin)
    print('filling it…')
    fill(api, pin, mis_pin)
    print(f'\nDemo ready.\n  Staff app:   {url}/\n  Student app: {url}/student.html\n'
          f'  Trainers DEMO02 to {TRAINERS[-1][0]} (one unit each) and DEMO01 (HOD) with PIN {pin}; MIS Officer: MIS with the MIS PIN.')


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('command', choices=['setup', 'deploy', 'reset'])
    p.add_argument('--pin', help='PIN for the 10 demo trainers')
    p.add_argument('--mis-pin', help='PIN for the demo MIS Officer')
    p.add_argument('--url', help='the demo address, if not the one from the last deploy')
    p.add_argument('--local', action='store_true', help='reset a demo running on this computer (wrangler dev), with --toml and --url')
    p.add_argument('--toml', help='another copy of wrangler.demo.toml (for --local: the one wrangler dev was started with)')
    a = p.parse_args()
    global TOML
    if a.toml: TOML = pathlib.Path(a.toml).resolve()
    if a.local: WHERE[:] = ['--local']
    saved = ROOT / 'demo' / '.url'
    if a.command == 'deploy':
        deploy(); return
    pin, mis = pins(a)
    if a.command == 'setup':
        create_database(); url = deploy()
    else:
        url = a.url or (saved.read_text(encoding='utf-8').strip() if saved.exists() else '')
        if not url: sys.exit('Give --url, or run setup or deploy first.')
    reset(url.rstrip('/'), pin, mis)


if __name__ == '__main__':
    main()

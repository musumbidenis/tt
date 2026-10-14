"""Takes the screenshots in docs/images/ from the current code, with an invented demo department (no real data).

    python docs/make-screenshots.py            (from the repository folder)

Needs Node.js (npx wrangler) and Python with playwright, reportlab and Pillow:
    pip install playwright reportlab pillow && python -m playwright install chromium
It starts the Worker locally (worker/dev.js, a throw-away database), serves the apps, fills in a term, loading,
a class, registers, marks and evidence, then opens both apps at phone size (and one desktop view) in Chromium.
The student's camera is Chromium's fake camera, so the in-app camera and the multi-page flow are exercised too.
Run it again after any change to a screen, so the guides always show the app as it is.
"""
import base64, datetime, io, json, os, pathlib, shutil, socket, subprocess, sys, tempfile, time, urllib.parse, urllib.request, uuid

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / 'docs' / 'images'
WPORT, SPORT = 8790, 8781
W, APP = f'http://127.0.0.1:{WPORT}/exec', f'http://127.0.0.1:{SPORT}/'
PHONE = {'width': 390, 'height': 844}
SCALE = 1.5
TERM = '2026-T3'
NAMES = ['Achieng Mary Otieno', 'Barasa Kevin Wekesa', 'Chebet Faith Jeptoo', 'Cheruiyot Brian Kiprop', 'Gathoni Ruth Wairimu', 'Kamau Peter Njoroge',
         'Kiprono Collins Rotich', 'Kosgei Allan Kipchumba', 'Mutua Dennis Musyoka', 'Mwende Lucy Nduku', 'Njeri Esther Wambui', 'Nyambura Joy Wanjiku',
         'Odhiambo Brian Otieno', 'Ouma Kevin Omondi', 'Wafula Sam Simiyu', 'Wanjiru Grace Kamau', 'Atieno Sharon Akinyi', 'Jepkemoi Mercy Chepkoech',
         'Kibet Victor Langat', 'Moraa Diana Kerubo', 'Nekesa Linet Nafula', 'Onyango Felix Ochieng', 'Rotich Ian Kiplagat', 'Wambui Ann Muthoni']
STUDENTS = [{'admNo': f'L6CS/25S/3040{i + 1:02d}', 'name': n} for i, n in enumerate(NAMES)]
# Stream B of the same class: FOP is taught to both streams together (a combined lesson).
NAMES_B = ['Adhiambo Rose Owino', 'Biwott Daniel Kibet', 'Chelangat Mercy Ruto', 'Gitau James Mwangi', 'Jeruto Alice Kemboi', 'Kariuki Paul Ndungu',
           'Lagat Eric Kirui', 'Muthoni Jane Wanjiku', 'Nafula Agnes Wekesa', 'Ochieng Tom Odhiambo', 'Wairimu Cynthia Njeri', 'Yego Kelvin Kiprotich']
STUDENTS_B = [{'admNo': f'L6CS/25S/3041{i + 1:02d}', 'name': n} for i, n in enumerate(NAMES_B)]
shots = []


def free(port):
    with socket.socket() as s:
        return s.connect_ex(('127.0.0.1', port)) != 0


def get(path):
    return urllib.request.urlopen(f'http://127.0.0.1:{WPORT}{path}', timeout=60).read()


def post(body):
    r = urllib.request.Request(W, data=json.dumps(body).encode(), headers={'Content-Type': 'text/plain;charset=utf-8'})
    out = json.load(urllib.request.urlopen(r, timeout=60))
    if not out.get('ok', True):
        raise RuntimeError(f"{body.get('action')}: {out.get('error')}")
    return out


def sql(statement):
    r = urllib.request.Request(f'http://127.0.0.1:{WPORT}/__sql', data=statement.encode(), method='POST')
    return json.load(urllib.request.urlopen(r, timeout=60))


def token(code, pin):
    return post({'action': 'login', 'staff': code, 'pin': pin})['token']


def demo_pdf():
    from reportlab.lib.pagesizes import A4
    from reportlab.pdfgen import canvas
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=A4)
    for n in (1, 2):
        c.setFont('Helvetica-Bold', 20); c.drawString(60, 780, 'Fundamentals of Programming - CAT 1')
        c.setFont('Helvetica', 13); c.drawString(60, 750, f'Example answers, page {n} of 2 (demo)')
        for i in range(14):
            c.drawString(60, 700 - i * 36, f'{i + 1 + (n - 1) * 14}. ' + 'Sample written answer for the demo screenshot.')
        c.showPage()
    c.save()
    return base64.b64encode(buf.getvalue()).decode()


def seed():
    get('/__reset')
    get('/__pin?' + urllib.parse.urlencode({'code': 'ICT020', 'pin': '4826', 'create': '1', 'roles': 'TRAINER,HOD,MIS', 'name': 'ICT MUSUMBI .D'}))
    get('/__pin?' + urllib.parse.urlencode({'code': 'ICT063', 'pin': '4826', 'create': '1', 'roles': 'TRAINER', 'name': 'ICT CYPRIAN .K'}))
    M = token('MIS', '2468')
    today = datetime.date.today()
    monday = today - datetime.timedelta(days=today.weekday())
    start = monday - datetime.timedelta(days=21)                        # this week is week 4
    post({'action': 'saveTerm', 'auth': M, 'termId': TERM, 'name': 'Term 3 2026', 'duration': 'SEP-DEC 2026', 'startDate': start.isoformat(),
          'catWeeks': [6, 11], 'series': 'Nov/Dec 2026', 'lessonHours': 1.5})
    rows = [('ICT L6CS-25SA', 'FOP', 'Fundamentals of Programming', 'ICT020', 'ICT MUSUMBI .D'),
            ('ICT L6CS-25SA', 'CE', 'Computer Essentials', 'ICT020', 'ICT MUSUMBI .D'),
            ('ICT L6CS-25SA', 'DDL', 'Demonstrate Digital Literacy', 'ICT063', 'ICT CYPRIAN .K'),
            ('ICT L6CS-25SB', 'FOP', 'Fundamentals of Programming', 'ICT020', 'ICT MUSUMBI .D')]
    post({'action': 'uploadLoading', 'auth': M, 'trainers': [], 'rows': [
        {'classCode': c, 'unitCode': u, 'unitName': n, 'trainerCode': t, 'trainerName': tn, 'lessonsPerWeek': 2, 'hoursPerWeek': 3} for c, u, n, t, tn in rows]})
    post({'action': 'importClassList', 'auth': M, 'misClass': 'CSCL6-25-S-RS', 'streams': ['ICT L6CS-25SA'], 'students': STUDENTS})
    post({'action': 'importClassList', 'auth': M, 'misClass': 'CSCL6-25-S-RS', 'streams': ['ICT L6CS-25SB'], 'students': STUDENTS_B})
    post({'action': 'setDefaultPin', 'auth': M, 'pin': '2580'})
    T = token('ICT020', '4826')
    # registers: two lessons a week for weeks 1-3, a few students often away
    away = {'L6CS/25S/304013': 5, 'L6CS/25S/304008': 4, 'L6CS/25S/304021': 2}
    sessions, n = [], 0
    streams = [('ICT L6CS-25SA', STUDENTS), ('ICT L6CS-25SB', STUDENTS_B)]
    for wk in range(3):
        for day, period, slot in ((0, 'L1', 'Lesson 1 · 7.30–9.00'), (2, 'L3', 'Lesson 3 · 10.30–12.00')):
            date = (start + datetime.timedelta(days=wk * 7 + day)).isoformat()
            at = f'{date}T06:30:00.000Z'
            for code, roster in streams:                               # both streams marked together: one register each
                marks = []
                for i, s in enumerate(roster):
                    st = 'Present'
                    if away.get(s['admNo'], 0) > n: st = 'Absent'
                    elif (i + n) % 11 == 0: st = 'Late'
                    elif (i + n) % 17 == 0: st = 'Excused'
                    marks.append({'admNo': s['admNo'], 'name': s['name'], 'status': st, 'explicit': True, 'at': at})
                counts = {k: sum(1 for m in marks if m['status'] == v) for k, v in (('P', 'Present'), ('A', 'Absent'), ('L', 'Late'), ('E', 'Excused'))}
                sessions.append({'sessionId': f'session:{date}:{code}:FOP:{period}', 'date': date, 'classCode': code, 'className': code,
                                 'unitCode': 'FOP', 'unitName': 'Fundamentals of Programming', 'period': slot, 'kind': 'lesson', 'slots': 1, 'title': '',
                                 'trainerId': 'ICT020', 'trainerName': 'ICT MUSUMBI .D', 'deviceId': 'demo', 'termId': TERM, 'week': wk + 1,
                                 'combined': [c for c, _ in streams], 'notes': 'Variables, loops and functions', 'createdAt': at, 'updatedAt': at,
                                 'edits': 0, 'counts': counts, 'marks': marks})
            n += 1
    post({'action': 'push', 'auth': T, 'deviceId': 'demo', 'sessions': sessions})
    post({'action': 'marksPush', 'auth': T, 'classCode': 'ICT L6CS-25SA', 'unitCode': 'FOP', 'rows': [
        {'admNo': s['admNo'], 'cat1': 55 + (i * 7) % 40, 'cat2': 50 + (i * 11) % 45, 'prac1': 60 + (i * 5) % 35, 'updatedAt': datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.000Z')}
        for i, s in enumerate(STUDENTS)]})
    post({'action': 'addStudents', 'auth': T, 'students': [{'admNo': 'L6CS/25S/309901', 'name': 'Example Late Joiner', 'classCode': 'ICT L6CS-25SA', 'reason': 'Late admission'}]})
    post({'action': 'submitSignoff', 'auth': token('ICT063', '4826'), 'classCode': 'ICT L6CS-25SA', 'unitCode': 'DDL', 'unitName': 'Demonstrate Digital Literacy',
          'comment': 'All lessons marked for the term.'})
    # evidence (normally sent by students through the Drive bridge), and a connected bridge
    now = datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None)
    ev = []
    for i, (s, item, status) in enumerate([(STUDENTS[0], 'CAT1', 'returned'), (STUDENTS[0], 'PRAC1', 'approved'), (STUDENTS[1], 'CAT1', 'submitted'),
                                            (STUDENTS[2], 'CAT1', 'submitted'), (STUDENTS[3], 'CAT1', 'approved'), (STUDENTS[4], 'CAT1', 'submitted'),
                                            (STUDENTS[5], 'PRAC1', 'submitted'), (STUDENTS[6], 'CAT1', 'returned')]):
        at = (now - datetime.timedelta(hours=30 - i * 3)).isoformat() + 'Z'
        unit = 'Fundamentals of Programming'
        decided = status != 'submitted'
        comment = 'Page 2 is missing. Scan both pages again.' if status == 'returned' else ''
        ev.append("('%s','%s','%s','ICT L6CS-25SA','FOP','%s','%s',1,'demo-file','%s - %s - v1.pdf',182000,2,'%s','%s',%s,%s,%s,'%s',NULL,'%s')" % (
            uuid.uuid4(), s['admNo'], s['name'], unit, item, unit, item, at, status,
            "'ICT020'" if decided else 'NULL', "'ICT MUSUMBI .D'" if decided else 'NULL', f"'{at}'" if decided else 'NULL', comment, at))
    sql('INSERT INTO evidence (id,adm_no,name,class_code,unit_code,unit_name,item,version,file_id,file_name,bytes,pages,submitted_at,status,decided_by,decided_name,decided_at,comment,received_at,updated_at) VALUES ' + ','.join(ev))
    # a verification panel, approved, with FOP given to a member who does not teach it
    get('/__pin?' + urllib.parse.urlencode({'code': 'ICT071', 'pin': '4826', 'create': '1', 'roles': 'TRAINER', 'name': 'Wekesa Janet'}))
    # Panels are approved as they are saved; each class-unit has two verifiers, neither teaching the unit.
    panel = post({'action': 'savePanel', 'auth': M, 'name': 'Term 3 panel A', 'chair': 'ICT063', 'members': ['ICT063', 'ICT071', 'ICT020']})['panel']
    post({'action': 'assignVerification', 'auth': M, 'panelId': panel['id'], 'classCode': 'ICT L6CS-25SA', 'unitCode': 'FOP', 'verifier': 'ICT063', 'verifier2': 'ICT071'})
    report = {'matched': 2, 'unmatched': [], 'sheets': {}, 'url': 'https://bridge.demo/exec', 'folders': [], 'bridge': '1.3.0', 'at': now.isoformat() + 'Z'}
    sql("INSERT OR REPLACE INTO meta (key,value) VALUES ('drive_url','https://bridge.demo/exec'),('drive_report','%s')" % json.dumps(report).replace("'", "''"))
    # a backup account that has made one backup and is 82% full (shows the gauge and the warning)
    backup = {'email': 'ictpoe@rvnp.ac.ke', 'used': int(41 * 1024 ** 3), 'limit': 50 * 1024 ** 3, 'checkedAt': now.isoformat() + 'Z', 'startedAt': (now - datetime.timedelta(hours=20)).isoformat() + 'Z',
              'finishedAt': (now - datetime.timedelta(hours=19)).isoformat() + 'Z', 'copied': 18, 'changed': 0, 'failed': 0, 'running': False}
    sql("INSERT OR REPLACE INTO meta (key,value) VALUES ('archive_email','ictpoe@rvnp.ac.ke'),('backup_report','%s'),('backup_plan','%s')" % (
        json.dumps(backup), json.dumps({'repeat': 'weekly', 'hour': 18})))


def camera_feed(folder):
    """A fake camera picture for Chromium: a written page on a desk, as a few MJPEG frames."""
    from PIL import Image, ImageDraw, ImageFont
    img = Image.new('RGB', (1200, 1600), (74, 58, 44))
    d = ImageDraw.Draw(img)
    d.polygon([(150, 170), (1050, 140), (1080, 1460), (120, 1480)], fill=(246, 244, 236))
    try: font = ImageFont.truetype('arial.ttf', 30); big = ImageFont.truetype('arialbd.ttf', 40)
    except Exception: font = big = ImageFont.load_default()
    d.text((220, 230), 'CAT 2 - Fundamentals of Programming', fill=(30, 30, 60), font=big)
    for i in range(22):
        d.text((220, 320 + i * 48), f'{i + 1}. ' + ('Answer written by the student in blue ink.' if i % 3 else 'A loop repeats a block of code while a condition holds.'), fill=(25, 45, 120), font=font)
    out = folder / 'page.mjpeg'
    buf = io.BytesIO(); img.save(buf, 'JPEG', quality=85)
    out.write_bytes(buf.getvalue() * 20)
    return out


def shot(page, name, what=None, full=False):
    try:
        page.wait_for_timeout(400)
        (page.locator(what).first.screenshot(path=str(OUT / name)) if what else page.screenshot(path=str(OUT / name), full_page=full))
        shots.append(name); print('  ✓', name)
    except Exception as e:
        print('  ✗', name, '-', str(e).splitlines()[0])


def staff(pw, browser, pdf64):
    ctx = browser.new_context(viewport=PHONE, device_scale_factor=SCALE, locale='en-US', accept_downloads=True)
    ctx.add_init_script('window.__liveSlowMs = 600000; window.__liveFastMs = 600000;')
    ctx.route('https://bridge.demo/**', lambda r: r.fulfill(status=200, content_type='application/json',
              body=json.dumps({'ok': True, 'data': pdf64, 'mime': 'application/pdf', 'name': 'Fundamentals of Programming - CAT1 - v1.pdf'})))
    pg = ctx.new_page(); pg.on('dialog', lambda d: d.dismiss())
    pg.goto(APP); pg.wait_for_function('typeof state === "object" && state.deviceId')
    pg.evaluate('(u) => saveSettings({serverUrl: u})', W)
    pg.wait_for_selector('#signin:not([hidden])')
    shot(pg, 'staff-signin.png')
    pg.fill('#siCode', 'ICT020'); pg.fill('#siPin', '4826'); pg.click('#siBtn')
    pg.wait_for_selector('#signin', state='hidden', timeout=20000)
    pg.wait_for_function("state.units.length > 0 && state.trainees.length >= 36", timeout=30000)
    pg.evaluate('syncSheets({silent: true})'); pg.wait_for_timeout(2500)
    # Mark: last week, with its registers, and a free slot chosen
    pg.select_option('#fClass', 'ICT L6CS-25SA'); pg.select_option('#fUnit', 'FOP')
    weeks = pg.evaluate("[...document.querySelectorAll('#fWeek option')].map(o => o.value)")
    cur = pg.input_value('#fWeek')
    prev = weeks[max(0, weeks.index(cur) - 1)] if cur in weeks else weeks[0]
    pg.select_option('#fWeek', prev); pg.wait_for_selector('.tt-cell.have', timeout=10000)
    pg.locator('#fStreamsBox input[value="ICT L6CS-25SB"]').check()
    free_cell = pg.locator('.tt-cell[data-slot="2"]:not([disabled])').first
    free_cell.click()
    shot(pg, 'mark-timetable.png', '#sessionForm')
    pg.evaluate('state.pick = null; renderTimetable()')
    pg.locator('.tt-cell.have').first.click(); pg.wait_for_selector('#register:not([hidden])')
    pg.wait_for_timeout(800)   # the register scrolls into view; put its title just under the sticky header
    pg.evaluate("window.scrollTo(0, document.querySelector('#register').getBoundingClientRect().top + window.scrollY - document.querySelector('.chrome').offsetHeight - 8)")
    shot(pg, 'register.png')
    pg.click('#closeReg')
    # today's lesson, with its QR code
    pg.select_option('#fWeek', cur); pg.wait_for_timeout(600)
    today_cell = pg.locator('.tt-cell[data-slot="1"]:not([disabled]):not(.have)').last
    today_cell.click(); pg.click('#openBtn'); pg.wait_for_selector('#register:not([hidden])')
    pg.click('#lessonQrBtn'); pg.wait_for_selector('#lessonQrDialog[open] svg', timeout=10000)
    shot(pg, 'lesson-qr.png')
    pg.click('#closeLessonQr'); pg.click('#closeReg')
    # Reports
    pg.click('.tabs button[data-tab=reports]')
    pg.select_option('#rClass', 'streams:ICT L6CS-25S'); pg.select_option('#rUnit', 'FOP')
    pg.wait_for_selector('#reportBody .rrow .stag', timeout=15000)
    pg.evaluate("document.querySelector('#toast').className = ''")   # no leftover message over the list
    shot(pg, 'report-list.png')
    pg.click('#reportMode [data-rmode=marks]'); pg.wait_for_selector('#marksCard input.mk', timeout=15000)
    shot(pg, 'marks.png')
    pg.click('#reportMode [data-rmode=attendance]')
    # POE
    pg.click('.tabs button[data-tab=poe]'); pg.wait_for_selector('#poe .poe-unit-table tbody tr', timeout=15000)
    pg.click('#poe [data-status=""]'); pg.wait_for_timeout(500)
    shot(pg, 'poe-list.png')
    pg.locator('#poe [data-open]').first.click(); pg.wait_for_selector('#poePages canvas', timeout=20000)
    shot(pg, 'poe-preview.png')
    pg.click('#poeDialog [data-act=close]')
    pg.click('#poe [data-mode=verify]'); pg.wait_for_selector('#poe .panel', timeout=15000)
    shot(pg, 'poe-verify.png')
    pg.click('#poe [data-mode=student]'); pg.wait_for_selector('#poeStudents table.poe-table', timeout=15000)
    pg.locator('#poeStudents tr.stu-row').first.click()
    shot(pg, 'poe-by-student.png')
    # Absences
    pg.click('.tabs button[data-tab=alerts]'); pg.wait_for_selector('#alerts table, #alerts .empty-state', timeout=15000)
    shot(pg, 'absences.png')
    # Manage
    pg.click('.tabs button[data-tab=manage]'); pg.wait_for_selector('#m-overview details.fold', timeout=20000)
    shot(pg, 'manage.png')
    pg.locator('#m-term').scroll_into_view_if_needed(); shot(pg, 'manage-term.png', '#m-term')
    pg.wait_for_selector('#m-phones details.fold', timeout=15000)
    pg.click('details.fold[data-sec=phones] > summary')
    pg.wait_for_selector('#phoneList table, #phoneList p', timeout=5000)
    shot(pg, 'manage-phones.png', '#m-phones')
    pg.wait_for_selector('#m-backup .gauge', timeout=15000)
    pg.locator('#m-backup').scroll_into_view_if_needed()
    shot(pg, 'manage-backup.png', '#m-backup')
    pg.wait_for_selector('#m-staff details.fold', timeout=15000)
    pg.click('details.fold[data-sec=staff] > summary')
    shot(pg, 'manage-staff.png', '#m-staff')
    # Tools (coming soon)
    pg.click('.tabs button[data-tab=tools]'); pg.wait_for_timeout(400)
    shot(pg, 'tools.png')
    # Profile
    pg.click('.tabs button[data-tab=me]'); pg.wait_for_timeout(500)
    shot(pg, 'profile.png')
    ctx.close()


def desktop(browser):
    ctx = browser.new_context(viewport={'width': 1366, 'height': 820}, device_scale_factor=1, locale='en-US')
    ctx.add_init_script('window.__liveSlowMs = 600000; window.__liveFastMs = 600000;')
    pg = ctx.new_page(); pg.on('dialog', lambda d: d.dismiss())
    pg.goto(APP); pg.wait_for_function('typeof state === "object" && state.deviceId')
    pg.evaluate('(u) => saveSettings({serverUrl: u})', W)
    pg.wait_for_selector('#signin:not([hidden])')
    pg.fill('#siCode', 'ICT020'); pg.fill('#siPin', '4826'); pg.click('#siBtn')
    pg.wait_for_selector('#signin', state='hidden', timeout=30000)
    pg.wait_for_function("state.units.length > 0", timeout=30000)
    pg.click('.tabs button[data-tab=reports]')
    pg.select_option('#rClass', 'streams:ICT L6CS-25S'); pg.select_option('#rUnit', 'FOP')
    pg.wait_for_selector('#reportBody .rrow, #reportBody .sheet-table', timeout=15000)
    if pg.locator('#reportBody .sheet-table').count() == 0: pg.click('#viewToggle')
    pg.wait_for_selector('#reportBody .sheet-table', timeout=10000)
    shot(pg, 'desktop-register.png')
    ctx.close()


def student(browser):
    ctx = browser.new_context(viewport=PHONE, device_scale_factor=SCALE, locale='en-US', permissions=['camera'])
    pg = ctx.new_page(); pg.on('dialog', lambda d: d.accept())
    errors = []; pg.on('pageerror', lambda e: errors.append(str(e)))
    pg.goto(APP + 'student.html#u=' + urllib.parse.quote(W))
    pg.wait_for_selector('#setupClass option[value="CSCL6-25-S-RS"]', state='attached', timeout=20000)
    pg.select_option('#setupClass', 'CSCL6-25-S-RS')
    pg.wait_for_selector(f'#setupName option[value="{STUDENTS[0]["admNo"]}"]', state='attached', timeout=15000)
    pg.select_option('#setupName', STUDENTS[0]['admNo'])
    shot(pg, 'student-setup.png')
    pg.click('#setupSave'); pg.wait_for_selector('#viewTabs:not([hidden])', timeout=20000)
    pg.wait_for_selector('#pQr svg', timeout=10000); pg.evaluate("document.querySelector('#result').hidden = true")
    shot(pg, 'student-checkin.png')
    # evidence: the camera inside the app, two pages, "keep and take the next page"
    pg.click('#viewTabs [data-view=poe]')
    pg.wait_for_selector('#poeUnit option[value="FOP"]', state='attached', timeout=20000)
    pg.select_option('#poeUnit', 'FOP')
    pg.click('#poeItems [data-item=CAT2]'); pg.wait_for_selector('[data-doc=CAT2] [data-camera]')
    pg.click('[data-doc=CAT2] [data-camera]')
    pg.wait_for_selector('#docCamDialog[open]', timeout=15000)
    pg.wait_for_function("document.querySelector('#docCamVideo').videoWidth > 0", timeout=15000); pg.wait_for_timeout(800)
    shot(pg, 'student-camera.png')
    pg.click('#docCamShot'); pg.wait_for_selector('#cropDialog[open]', timeout=20000); pg.wait_for_timeout(500)
    shot(pg, 'student-crop.png')
    pg.click('#cropNext')
    pg.wait_for_selector('#docCamDialog[open]', timeout=20000)          # straight back to the camera for page 2
    pg.wait_for_function("document.querySelector('#docCamVideo').videoWidth > 0", timeout=15000)
    title = pg.inner_text('#docCamTitle')
    pg.click('#docCamShot'); pg.wait_for_selector('#cropDialog[open]', timeout=20000)
    pg.click('#cropKeep'); pg.wait_for_selector('#cropDialog', state='hidden', timeout=20000)
    pg.wait_for_function("document.querySelectorAll('[data-doc=CAT2] .poe-pages li').length === 2", timeout=15000)
    pg.wait_for_timeout(4500)   # let the "Page added" message fade
    shot(pg, 'student-evidence.png')
    print(f'    camera came back for "{title}"; pages now', pg.locator('[data-doc=CAT2] .poe-pages li').count(), '; save button:', pg.inner_text('#poeSave'))
    # submissions, with all three blocks open
    pg.click('#viewTabs [data-view=subs]'); pg.wait_for_timeout(2500)
    pg.evaluate("document.querySelectorAll('.view-subs details').forEach(d => { d.open = true; })"); pg.wait_for_timeout(400)
    shot(pg, 'student-submissions.png', full=True)
    if errors: print('    page errors:', errors[:3])
    ctx.close()


def main():
    from playwright.sync_api import sync_playwright
    if not (free(WPORT) and free(SPORT)):
        sys.exit(f'Ports {WPORT} and {SPORT} must be free.')
    OUT.mkdir(parents=True, exist_ok=True)
    tmp = pathlib.Path(tempfile.mkdtemp(prefix='ark-shots-'))
    npx = 'npx.cmd' if os.name == 'nt' else 'npx'
    worker = subprocess.Popen([npx, 'wrangler', 'dev', '--config', str(ROOT / 'worker' / 'wrangler.test.toml'), '--local', '--port', str(WPORT), '--ip', '127.0.0.1',
                               '--persist-to', str(tmp / 'd1'), '--var', 'BRIDGE_SECRET:demo-bridge-secret-for-screenshots'],
                              cwd=str(ROOT), stdout=open(tmp / 'wrangler.log', 'w'), stderr=subprocess.STDOUT)
    site = subprocess.Popen([sys.executable, '-m', 'http.server', str(SPORT), '--bind', '127.0.0.1'], cwd=str(ROOT), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(180):
            try: urllib.request.urlopen(W + '?action=ping', timeout=3); break
            except Exception: time.sleep(1)
        else: sys.exit('The local Worker did not start; see ' + str(tmp / 'wrangler.log'))
        print('seeding the demo department'); seed()
        with sync_playwright() as pw:
            browser = pw.chromium.launch(args=['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
                                                f'--use-file-for-fake-video-capture={camera_feed(tmp)}'])
            # Desktop and student first: the staff run opens a QR lesson today, which marks non-scanners absent.
            print('desktop'); desktop(browser)
            print('student app'); student(browser)
            print('staff app'); staff(pw, browser, demo_pdf())
            browser.close()
    finally:
        for proc in (worker, site):           # on Windows npx starts the Worker in a child process: stop the whole tree
            if os.name == 'nt': subprocess.run(['taskkill', '/T', '/F', '/PID', str(proc.pid)], capture_output=True)
            else: proc.terminate()
        time.sleep(1); shutil.rmtree(tmp, ignore_errors=True)
    print(f'{len(shots)} screenshots in {OUT}')


if __name__ == '__main__':
    main()

/* System health (Manage > System, MIS Officer only): how the server is doing today against Cloudflare's free-plan
 * limits, how fast it answers, the errors from the server, the phones and the Drive bridge, and Google's side
 * (Drive space, emails). Uses app.js (api, $, esc, toast, hasRole, fmtTime) and Tables. */
'use strict';

const Health = (() => {
  let last = null, busy = false;
  const allowed = () => hasRole('MIS');
  // Plain names for what the phones ask the server; anything else shows as it is.
  const LABEL = {
    push: 'Registers sent', mySessions: 'Registers to other devices', roster: 'Class lists', pulse: 'Checks for changes',
    checkin: 'Student check-ins', checkins: 'QR check-ins fetched', report: 'Reports', login: 'Sign-ins', marksPull: 'Marks fetched',
    marksPush: 'Marks sent', poeList: 'POE lists', poeView: 'POE opened', poeDecide: 'POE decisions', bridgeFeed: 'Drive bridge updates',
    bridgeReport: 'Drive bridge reports', bridgeHealth: 'Drive bridge reports', backupJob: 'Backup', backupDone: 'Backup',
    'GET classes': 'Student app - classes', 'GET classlist': 'Student app - class list', 'GET ping': 'Connection checks',
    'GET check': 'Approval checks (QR)', appError: 'Error reports from phones', signoffs: 'Term registers', overview: 'Department overview',
    systemHealth: 'System health', myNotices: 'Messages', sendNotice: 'Messages sent', deleteSessions: 'Registers deleted',
    register: 'Student phone set-up', studentSessions: 'Student attendance', poeUpload: 'POE uploads',
  };
  const SOURCE = { server: 'Server', app: 'Staff app', student: 'Student app', bridge: 'Drive bridge' };
  const num = (n) => Number(n || 0).toLocaleString();
  const size = (b) => (b >= 1024 ** 3 ? (b / 1024 ** 3).toFixed(1) + ' GB' : b >= 1024 ** 2 ? (b / 1024 ** 2).toFixed(1) + ' MB' : Math.max(0, Math.round(b / 1024)) + ' KB');
  const pct = (a, b) => (b ? Math.min(100, Math.round((a / b) * 1000) / 10) : 0);
  const level = (p) => (p >= 95 ? 'full' : p >= 80 ? 'warn' : '');
  const ms = (n) => (n >= 1000 ? (n / 1000).toFixed(1) + ' s' : Math.round(n) + ' ms');
  const ago = (iso) => { if (!iso) return 'never'; const m = Math.round((Date.now() - Date.parse(iso)) / 60e3); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`; };

  function gauge(label, used, limit, fmt = num, note = '') {
    const p = pct(used, limit);
    return `<div class="hg"><div class="hg-top"><b>${label}</b><span>${fmt(used)} of ${fmt(limit)} - ${p}%</span></div>
      <div class="gauge ${level(p)}" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${p}" aria-label="${esc(label)}"><span style="width:${p}%"></span></div>
      ${note ? `<small class="muted">${note}</small>` : ''}</div>`;
  }
  /** What needs a look, worst first. */
  function problems(h) {
    const out = [], L = h.limits, t = h.today, g = h.google;
    const check = (name, used, limit) => { const p = pct(used, limit); if (p >= 80) out.push([p >= 95 ? 'full' : 'warn', `${name} at ${p}% of the daily limit`]); };
    check('Server requests', t.requests, L.requests); check('Database reads', t.reads, L.reads); check('Database writes', t.writes, L.writes);
    if (pct(h.db.bytes, L.dbBytes) >= 80) out.push(['warn', `The database is ${pct(h.db.bytes, L.dbBytes)}% full`]);
    if (g.driveLimit && pct(g.driveUsed, g.driveLimit) >= 80) out.push(['warn', `Backup Drive ${pct(g.driveUsed, g.driveLimit)}% full`]);
    if (t.errors) out.push(['warn', `${t.errors} server error${t.errors === 1 ? '' : 's'} today`]);
    if (g.bridgeAt && Date.now() - Date.parse(g.bridgeAt) > 3 * 3600e3) out.push(['warn', `The Drive bridge last ran ${ago(g.bridgeAt)}`]);
    if (g.bridgeErrors?.length) out.push(['warn', 'The Drive bridge had a problem on its last run']);
    if (g.mailFailed) out.push(['warn', `${g.mailFailed} email${g.mailFailed === 1 ? '' : 's'} could not be sent`]);
    if (g.mailLeft !== null && g.mailLeft !== undefined && g.mailLeft < 150) out.push(['warn', `Only ${g.mailLeft} emails left today`]);
    return out.sort((a, b) => (a[0] === 'full' ? -1 : 0) - (b[0] === 'full' ? -1 : 0));
  }

  function html() {
    const h = last;
    if (!h) return '<p class="muted">Loading…</p>';
    const L = h.limits, t = h.today, g = h.google, todo = problems(h);
    const head = todo.length
      ? `<div class="h-status warn"><b>${todo.length} thing${todo.length === 1 ? '' : 's'} to look at</b><ul>${todo.map(([k, s]) => `<li class="${k}">${esc(s)}</li>`).join('')}</ul></div>`
      : '<div class="h-status ok"><b>All good</b><span>Within every limit, no errors today.</span></div>';
    const actions = Tables.slice('health', h.actions);
    const days = [...h.days].reverse();
    const errs = h.errors || [];
    return `${head}
      <p class="muted small">Today so far (since 3.00 am, when Cloudflare's daily limits start again) - checked ${esc(fmtTime(h.now))} - server ${esc(h.version)}${g.bridgeVersion ? ` - Drive bridge ${esc(g.bridgeVersion)}` : ''}</p>
      <h3 class="h-sub">Daily limits</h3>
      <div class="h-gauges">
        ${gauge('Server requests', t.requests, L.requests, num, 'Over the limit, the apps stop reaching the server until 3.00 am.')}
        ${gauge('Database reads', t.reads, L.reads, num, 'Rows the database looked through.')}
        ${gauge('Database writes', t.writes, L.writes, num, 'Over either limit, saving and loading stop until 3.00 am.')}
        ${gauge('Database size', h.db.bytes, L.dbBytes, size, h.db.bytes ? '' : 'Shown after the next few requests.')}
        ${g.driveLimit ? gauge('Backup Drive space', g.driveUsed, g.driveLimit, size, g.driveAt ? `Checked ${esc(ago(g.driveAt))}.` : '') : ''}
        ${g.mailLeft !== null && g.mailLeft !== undefined ? gauge('Emails today', Math.max(0, L.mail - g.mailLeft), L.mail, num, `${num(g.mailLeft)} left today${g.mailWaiting ? ` - ${num(g.mailWaiting)} waiting to go` : ''}.`) : ''}
      </div>
      <h3 class="h-sub">Speed</h3>
      <div class="h-stats">
        <div><b>${ms(t.avgMs)}</b><span>Average answer today</span></div>
        <div><b>${num(t.requests)}</b><span>Requests today</span></div>
        <div><b>${num(t.refused)}</b><span>Refused (wrong PIN, no permission…)</span></div>
        <div><b>${num(t.errors)}</b><span>Server errors today</span></div>
      </div>
      ${h.actions.length ? `<div class="table-wrap"><table class="report-table h-table"><thead><tr><th>What</th><th class="num">Times</th><th class="num">Average</th><th class="num">Slowest</th><th class="num">Errors</th></tr></thead>
        <tbody>${actions.map((a) => `<tr${a.errors ? ' class="h-bad"' : ''}><td>${esc(LABEL[a.action] || a.action)}</td><td class="num">${num(a.n)}</td><td class="num">${ms(a.avgMs)}</td><td class="num${a.maxMs > 5000 ? ' warn-text' : ''}">${ms(a.maxMs)}</td><td class="num">${a.errors || ''}</td></tr>`).join('')}</tbody></table></div>${Tables.bar('health', h.actions)}` : '<p class="muted">Nothing counted yet today.</p>'}
      ${days.length > 1 ? `<details class="fold"><summary>Last ${days.length} days</summary><div class="table-wrap"><table class="report-table h-table"><thead><tr><th>Day</th><th class="num">Requests</th><th class="num">Errors</th><th class="num">Average</th><th class="num">Reads</th><th class="num">Writes</th></tr></thead>
        <tbody>${days.map((d) => `<tr><td>${esc(fmtShort(d.day))}</td><td class="num">${num(d.requests)} <small class="muted">${pct(d.requests, L.requests)}%</small></td><td class="num">${d.errors || ''}</td><td class="num">${ms(d.avgMs)}</td><td class="num">${num(d.reads)}</td><td class="num">${num(d.writes)}</td></tr>`).join('')}</tbody></table></div></details>` : ''}
      <h3 class="h-sub">Errors</h3>
      ${errs.length ? `<ul class="h-errors">${errs.map((e) => `<li><div><b>${esc(SOURCE[e.source] || e.source)}</b> - ${esc(fmtTime(e.at))}${e.who ? ` - ${esc(e.who)}` : ''}<small class="muted"> - ${esc(LABEL[e.action] || e.action)}</small></div>
        <p>${esc(e.message)}</p>${e.detail ? `<details><summary>Details</summary><pre>${esc(e.detail)}</pre></details>` : ''}</li>`).join('')}</ul>
        <div class="row-actions"><button type="button" class="btn small ghost" data-hclear>Clear the list</button></div>` : '<p class="muted">No errors recorded.</p>'}
      <h3 class="h-sub">Other</h3>
      <ul class="h-facts">
        <li>Drive bridge - last run ${esc(ago(g.bridgeAt))}${g.bridgeMs ? `, took ${ms(g.bridgeMs)}` : ''}${g.bridgeErrors?.length ? ` - <span class="warn-text">${esc(g.bridgeErrors[0])}</span>` : ''}</li>
        <li>Emails - ${num(g.mailToday)} sent today${g.mailFailed ? ` - <span class="warn-text">${num(g.mailFailed)} failed</span>` : ''}</li>
        <li>Phone notifications - ${num(h.push.phones)} phone${h.push.phones === 1 ? '' : 's'} signed up${h.push.failing ? ` - ${num(h.push.failing)} not answering` : ''}</li>
        <li>Stored - ${num(h.db.counts.registers)} registers - ${num(h.db.counts.students)} students - ${num(h.db.counts.staff)} staff - ${num(h.db.counts.evidence)} POE files - ${num(h.db.counts.phones)} student phones</li>
      </ul>
      <div class="row-actions"><button type="button" class="btn small" data-hrefresh${busy ? ' disabled' : ''}>Refresh</button>
        <a class="btn small ghost" href="https://dash.cloudflare.com/" target="_blank" rel="noopener">Cloudflare dashboard</a></div>`;
  }
  const draw = () => { const s = $('#m-health'); if (s) { [...s.children].slice(1).forEach((c) => c.remove()); s.insertAdjacentHTML('beforeend', html()); } };
  async function load() {
    if (!allowed() || busy) return;
    busy = true;
    try { const r = await api('systemHealth'); if (!r.ok) throw new Error(r.error || 'Could not read the system health'); last = r; draw(); }
    catch (e) { const s = $('#m-health'); if (s) { [...s.children].slice(1).forEach((c) => c.remove()); s.insertAdjacentHTML('beforeend', `<p class="err-text">${esc(e.message)}</p>`); } }
    finally { busy = false; }
  }
  /** How many things need a look (for the Manage badge). */
  const alerts = () => (last ? problems(last).length : 0);

  document.addEventListener('click', async (e) => {
    if (!e.target.closest('#m-health')) return;
    if (e.target.closest('[data-hrefresh]')) { load(); return; }
    if (e.target.closest('[data-hclear]') && confirm('Clear the list of errors? The counts stay.')) {
      const r = await api('clearErrors'); if (!r.ok) toast(r.error, 'err'); else { toast('Error list cleared', 'ok'); load(); }
    }
  });
  Tables.on('health', draw);
  return { allowed, load, html, alerts };
})();
window.Health = Health;

/* Errors the staff app runs into go to the System health list (a few per page load, each one once). */
(() => {
  const seen = new Set();
  function report(message, detail, where) {
    const key = String(message).slice(0, 120);
    // Lost connections are normal on phones, not faults.
    if (/Failed to fetch|NetworkError|Load failed|No connection|AbortError|took too long|ResizeObserver/i.test(key)) return;
    if (seen.has(key) || seen.size >= 5 || !navigator.onLine) return;
    seen.add(key);
    try {
      const url = typeof serverUrl === 'function' ? serverUrl() : '';
      if (!url) return;
      fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, keepalive: true,
        body: JSON.stringify({ action: 'appError', app: 'staff', version: typeof APP_VERSION === 'string' ? APP_VERSION : '', where,
          message: String(message).slice(0, 400), detail: String(detail || '').slice(0, 1500), who: (typeof me === 'function' && me()?.code) || '' }) }).catch(() => {});
    } catch { /* never let reporting break the app */ }
  }
  window.addEventListener('error', (e) => report(e.message || 'Error', `${e.filename || ''}:${e.lineno || ''}:${e.colno || ''}\n${e.error?.stack || ''}`, location.hash || 'page'));
  window.addEventListener('unhandledrejection', (e) => report(e.reason?.message || String(e.reason), e.reason?.stack || '', 'promise'));
})();

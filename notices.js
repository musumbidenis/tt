/* Messages: the bell in the header. Inbox (messages to me), Sent, and New message.
 * Anyone with a staff role but the External Assessment Officer can write one. Who it can reach follows their access (the
 * server checks): a trainer their own classes, their class reps and their panels; the HOD, MIS Officer and Internal
 * Assessment Officer anyone. A message shows in the app, wakes students' phones (once notifications are set up) and goes by
 * email to the class and staff groups the Drive bridge keeps (one email per group, sent as a hidden copy).
 * Uses app.js (api, $, $$, esc, toast, hasRole, me, fmtTime). */
'use strict';

const Notices = (() => {
  const ns = { inbox: [], sent: [], unread: 0, tab: 'inbox', opts: null, at: 0 };
  const canSend = () => ['TRAINER', 'HOD', 'MIS', 'IAO'].some(hasRole);
  const TEMPLATES = [
    ['', 'Write my own'],
    ['CAT next week', 'Your CAT is next week. Revise the work covered so far and come on time with your ID.'],
    ['POE deadline', 'Send your POE evidence (CATs and practicals) from the Student app by Friday. Check that every page is clear.'],
    ['Evidence returned', 'Some of your evidence was returned. Open the Student app, read your trainer\'s note, fix it and send it again.'],
    ['Registers this week', 'Please mark and send this week\'s attendance registers before Friday.'],
    ['Verification', 'Your class-unit has been given out for internal verification. Make sure the approved evidence and marks are complete.'],
  ];

  function badge() {
    const dot = $('#bellCount'); if (!dot) return;
    dot.hidden = !ns.unread; dot.textContent = ns.unread > 99 ? '99+' : String(ns.unread);
  }
  async function refresh(read) {
    if (!me() || !navigator.onLine) return;
    const r = await api('myNotices', read?.length ? { read } : {});
    if (!r.ok) throw new Error(r.error);
    Object.assign(ns, { inbox: r.inbox, sent: r.sent, unread: r.unread, at: Date.now() });
    badge();
  }
  /** On sign-in, and now and then while the app is open. */
  async function tick() { if (Date.now() - ns.at > 5 * 60e3) { try { await refresh(); } catch { /* next time */ } } }
  function show() { $('#bellBtn').hidden = !me(); }

  async function open() {
    const d = $('#noticeDialog');
    draw('<p class="muted">Loading messages…</p>');
    if (!d.open) d.showModal();
    if (!navigator.onLine) { draw('<div class="notice"><h2>Messages need internet</h2><p class="muted">Connect and open this again.</p></div>'); return; }
    try {
      await refresh();
      const unread = ns.inbox.filter((n) => !n.read).map((n) => n.id);
      draw(body());
      if (unread.length) refresh(unread).then(() => { for (const n of ns.inbox) n.read = true; }).catch(() => {});
    } catch (e) { draw(`<p class="err-text">${esc(e.message)}</p>`); }
  }
  const draw = (inner) => {
    $('#noticeBody').innerHTML = `<div class="scan-head"><strong>Messages</strong><button type="button" class="btn small ghost" data-nclose>Close</button></div>
      <div class="view-tabs" role="group" aria-label="Show"><button type="button" data-ntab="inbox" aria-pressed="${ns.tab === 'inbox'}">Inbox${ns.unread ? ` (${ns.unread})` : ''}</button>
      ${canSend() ? `<button type="button" data-ntab="sent" aria-pressed="${ns.tab === 'sent'}">Sent</button><button type="button" data-ntab="new" aria-pressed="${ns.tab === 'new'}">New message</button>` : ''}</div>${inner}`;
  };
  function body() {
    if (ns.tab === 'sent') {
      return ns.sent.length ? `<ul class="mlist notice-list">${ns.sent.map((n) => `<li><div><b>${esc(n.title)}</b><small>To ${esc(n.to)} - ${esc(fmtTime(n.at))}</small>
        <p class="small">${esc(n.body)}</p><small class="muted">${[n.counts.students ? `${n.counts.students} student${n.counts.students === 1 ? '' : 's'}` : '', n.counts.staff ? `${n.counts.staff} staff` : '',
          n.email ? `email ${n.email.status === 'sent' ? 'sent' : n.email.status === 'failed' ? 'not sent: ' + n.email.error : 'waiting to go'}` : ''].filter(Boolean).join(' - ')}</small></div></li>`).join('')}</ul>`
        : '<p class="muted">You have not sent any messages yet.</p>';
    }
    if (ns.tab === 'new') return composer();
    return ns.inbox.length ? `<ul class="mlist notice-list">${ns.inbox.map((n) => `<li class="${n.read ? '' : 'unread'}"><div><b>${esc(n.title)}</b><small>From ${esc(n.from)} - to ${esc(n.to)} - ${esc(fmtTime(n.at))}</small>
      <p class="small">${esc(n.body)}</p></div></li>`).join('')}</ul>` : '<p class="muted">No messages yet.</p>';
  }
  function composer() {
    const o = ns.opts;
    if (!o) { loadOpts(); return '<p class="muted">Loading who you can write to…</p>'; }
    const chip = (val, label, sub = '') => `<label class="kchip"><input type="checkbox" name="to" value="${esc(val)}"><span>${esc(label)}${sub ? ` <small class="muted">${esc(sub)}</small>` : ''}</span></label>`;
    return `<form id="noticeForm" class="notice-form">
      <label>Ready message<select id="nTemplate">${TEMPLATES.map(([t], i) => `<option value="${i}">${esc(t || 'Write my own')}</option>`).join('')}</select></label>
      <label>Title<input name="title" maxlength="120" required></label>
      <label>Message<textarea name="body" rows="5" maxlength="4000" required></textarea></label>
      <fieldset class="to-box"><legend>To</legend>
        ${o.classes.length ? `<p class="small muted">Classes (students)</p><div class="chips-wrap">${o.classes.map((c) => chip('class:' + c.code, c.code, `${c.students}`)).join('')}</div>` : ''}
        <div class="chips-wrap">${o.trainers ? chip('trainers', 'All trainers') : ''}${o.reps ? chip('reps', 'Class reps') : ''}${o.coordinators ? chip('coordinators', 'Class coordinators') : ''}
        ${o.panels.map((p) => chip('panel:' + p.id, p.name)).join('')}</div>
      </fieldset>
      <fieldset class="to-box"><legend>Send by</legend><div class="chips-wrap">
        <label class="kchip"><input type="checkbox" checked disabled><span>In the app</span></label>
        <label class="kchip"><input type="checkbox" name="push" ${o.push ? 'checked' : 'disabled'}><span>Phone notification${o.push ? '' : ' (not set up)'}</span></label>
        <label class="kchip"><input type="checkbox" name="email" ${o.email ? 'checked' : 'disabled'}><span>Email${o.email ? '' : ' (not set up)'}</span></label></div>
        ${o.email ? `<p class="muted tiny">Email goes to the class and staff groups, which hold everyone who has connected their college Google account. Replies come to you.</p>` : ''}
      </fieldset>
      <button class="btn primary">Send</button></form>`;
  }
  async function loadOpts() {
    try { const r = await api('noticeOptions', {}); if (!r.ok) throw new Error(r.error); ns.opts = r; if (ns.tab === 'new') draw(body()); }
    catch (e) { draw(`<p class="err-text">${esc(e.message)}</p>`); }
  }
  async function send(form) {
    const fd = new FormData(form);
    const to = fd.getAll('to').map((v) => { const [t, ...rest] = String(v).split(':'); const id = rest.join(':'); return t === 'class' ? { t, code: id } : t === 'panel' ? { t, id } : { t }; });
    if (!to.length) { toast('Choose who the message is for', 'err'); return; }
    const btn = form.querySelector('button.primary'); btn.disabled = true;
    try {
      const r = await api('sendNotice', { title: fd.get('title'), body: fd.get('body'), to, push: !!fd.get('push'), email: !!fd.get('email') });
      if (!r.ok) throw new Error(r.error);
      const x = r.reached;
      toast(`Sent: ${[x.students && `${x.students} student${x.students === 1 ? '' : 's'}`, x.staff && `${x.staff} staff`, x.groups && `${x.groups} email group${x.groups === 1 ? '' : 's'}`].filter(Boolean).join(' - ') || 'sent'}`, 'ok');
      ns.tab = 'sent'; await refresh(); draw(body());
    } catch (e) { toast(e.message, 'err'); btn.disabled = false; }
  }
  function wire() {
    $('#bellBtn').addEventListener('click', open);
    document.addEventListener('click', (e) => {
      if (!e.target.closest('#noticeDialog')) return;
      if (e.target.closest('[data-nclose]')) { $('#noticeDialog').close(); return; }
      const t = e.target.closest('[data-ntab]'); if (t) { ns.tab = t.dataset.ntab; draw(body()); }
    });
    document.addEventListener('change', (e) => {
      if (e.target.id !== 'nTemplate') return;
      const [title, text] = TEMPLATES[Number(e.target.value)] || ['', ''];
      const f = $('#noticeForm'); if (title) { f.title.value = title; f.body.value = text; }
    });
    document.addEventListener('submit', (e) => { if (e.target.id === 'noticeForm') { e.preventDefault(); send(e.target); } });
  }
  const reset = () => { Object.assign(ns, { inbox: [], sent: [], unread: 0, tab: 'inbox', opts: null, at: 0 }); badge(); };
  return { wire, refresh, tick, show, reset, state: ns };
})();

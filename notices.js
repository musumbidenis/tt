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
    $('#noticeBody').innerHTML = `<div class="nt-top"><div class="scan-head"><strong>Messages</strong><button type="button" class="btn small ghost" data-nclose>Close</button></div>
      <div class="view-tabs" role="group" aria-label="Show"><button type="button" data-ntab="inbox" aria-pressed="${ns.tab === 'inbox'}">Inbox${ns.unread ? ` (${ns.unread})` : ''}</button>
      ${canSend() ? `<button type="button" data-ntab="sent" aria-pressed="${ns.tab === 'sent'}">Sent</button><button type="button" data-ntab="new" aria-pressed="${ns.tab === 'new'}">New message</button>` : ''}</div></div>
      <div class="nt-scroll">${inner}</div>`;
  };
  const plural = (n, one) => `${n} ${one}${n === 1 ? '' : 's'}`;
  const card = (n, who, pills = '', extra = '') => {
    const cls = [n.read === false ? 'unread' : '', n.board ? 'board' : '', n.board && n.priority === 'urgent' ? 'urgent' : ''].filter(Boolean).join(' ');
    const tag = n.board ? `<span class="board-tag${n.priority === 'urgent' ? ' urgent' : ''}">${n.priority === 'urgent' ? 'Urgent' : 'Board'}</span>` : '';
    return `<li class="${cls}"><div class="msg-card" role="button" tabindex="0" aria-expanded="false">
      <div class="msg-meta"><span class="who">${who}</span><time>${esc(fmtTime(n.at))}</time></div>
      <div class="msg-title">${tag}${esc(n.title)}</div><p class="msg-body">${esc(n.body)}</p>${pills}${extra}</div></li>`;
  };
  function body() {
    if (ns.tab === 'sent') {
      return ns.sent.length ? `<ul class="msg-list notice-list">${ns.sent.map((n) => {
        const c = n.counts || {}, em = n.email;
        const pills = [c.students ? plural(c.students, 'student') : '', c.staff ? `${c.staff} staff` : '', c.groups ? plural(c.groups, 'group') : ''].filter(Boolean).map((t) => `<span>${esc(t)}</span>`);
        if (em) pills.push(`<span class="${em.status === 'failed' ? 'bad' : ''}">${esc(em.status === 'sent' ? 'Email sent' : em.status === 'failed' ? 'Email not sent: ' + em.error : 'Email waiting to go')}</span>`);
        if (n.needAck) pills.push(`<span class="${n.ackCount >= n.ackOf && n.ackOf ? '' : 'bad'}">${n.ackCount || 0} of ${n.ackOf || 0} confirmed read</span>`);
        return card(n, `To ${esc(n.to)}`, pills.length ? `<div class="msg-pills">${pills.join('')}</div>` : '');
      }).join('')}</ul>` : '<p class="msg-empty">Nothing sent yet. Write your first message in New message.</p>';
    }
    if (ns.tab === 'new') return composer();
    return ns.inbox.length ? `<ul class="msg-list notice-list">${ns.inbox.map((n) => card(n, `${esc(n.from)} <span class="muted">- to ${esc(n.to)}</span>`, '',
      n.needAck ? (n.acked ? '<p class="msg-ack done">✓ You confirmed you read this</p>' : `<div class="msg-ack"><button type="button" class="btn small primary" data-nack="${esc(n.id)}">Confirm I have read this</button></div>`) : '')).join('')}</ul>`
      : '<p class="msg-empty">No messages yet. When someone writes to you, it shows here.</p>';
  }
  function composer() {
    const o = ns.opts;
    if (!o) { loadOpts(); return '<p class="muted">Loading who you can write to…</p>'; }
    const chip = (val, label, sub = '') => `<label class="kchip"><input type="checkbox" name="to" value="${esc(val)}"><span>${esc(label)}${sub ? ` <small class="muted">${esc(sub)}</small>` : ''}</span></label>`;
    const staffChips = `${o.trainers ? chip('trainers', 'All trainers') : ''}${o.reps ? chip('reps', 'Class reps') : ''}${o.coordinators ? chip('coordinators', 'Class coordinators') : ''}`;
    return `<form id="noticeForm" class="notice-form">
      <label>Ready message<select id="nTemplate">${TEMPLATES.map(([t], i) => `<option value="${i}">${esc(t || 'Write my own')}</option>`).join('')}</select></label>
      <label>Title<input name="title" maxlength="120" required></label>
      <label>Message<textarea name="body" rows="5" maxlength="4000" required></textarea><span class="hint" id="nCount">0 / 4000</span></label>
      <fieldset class="to-box"><legend>Who is it for?</legend>
        ${o.classes.length ? `<div class="to-group"><h4>Classes (students)</h4><div class="chips-wrap">${o.classes.map((c) => chip('class:' + c.code, c.code, `${c.students}`)).join('')}</div></div>` : ''}
        ${staffChips ? `<div class="to-group"><h4>Staff</h4><div class="chips-wrap">${staffChips}</div></div>` : ''}
        ${o.panels.length ? `<div class="to-group"><h4>Panels</h4><div class="chips-wrap">${o.panels.map((p) => chip('panel:' + p.id, p.name)).join('')}</div></div>` : ''}
      </fieldset>
      <fieldset class="to-box"><legend>Send by</legend><div class="chips-wrap">
        <label class="kchip"><input type="checkbox" checked disabled><span>In the app</span></label>
        <label class="kchip"><input type="checkbox" name="push" ${o.push ? 'checked' : 'disabled'}><span>Phone notification${o.push ? '' : ' (not set up)'}</span></label>
        <label class="kchip"><input type="checkbox" name="email" ${o.email ? 'checked' : 'disabled'}><span>Email${o.email ? '' : ' (not set up)'}</span></label></div>
        ${o.email ? `<p class="muted tiny">Email goes to the class and staff groups, which hold everyone who has connected their college Google account. Replies come to you.</p>` : ''}
      </fieldset>
      <fieldset class="to-box"><legend>Notice board</legend><div class="chips-wrap">
        <label class="kchip"><input type="checkbox" name="board" id="nBoard"><span>Pin to the notice board</span></label>
        <label class="kchip"><input type="checkbox" name="urgent"><span>Mark urgent</span></label>
        <label class="kchip"><input type="checkbox" name="needAck"><span>Ask readers to confirm they have read it</span></label></div>
        <label class="board-until">Keep pinned until <input type="date" name="pinnedUntil"></label>
        <p class="muted tiny">A pinned notice sits at the top of the app and on the Notice board; urgent ones stand out. "Confirm" makes each reader tap to say they have read it, and you see how many have.</p>
      </fieldset>
      <div class="send-row"><button class="btn primary">Send</button></div></form>`;
  }
  /** A staff recipient confirms they have read a board notice (students do the same in their app). */
  async function confirmRead(id, btn) {
    btn.disabled = true;
    try {
      const r = await api('noticeAck', { id });
      if (!r.ok) throw new Error(r.error);
      const n = ns.inbox.find((x) => x.id === id); if (n) n.acked = true;
      draw(body()); toast('Confirmed - thank you', 'ok');
    } catch (e) { toast(e.message, 'err'); btn.disabled = false; }
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
      const r = await api('sendNotice', { title: fd.get('title'), body: fd.get('body'), to, push: !!fd.get('push'), email: !!fd.get('email'),
        board: !!fd.get('board'), priority: fd.get('urgent') ? 'urgent' : 'normal', needAck: !!fd.get('needAck'), pinnedUntil: fd.get('pinnedUntil') || '' });
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
      const t = e.target.closest('[data-ntab]'); if (t) { ns.tab = t.dataset.ntab; draw(body()); return; }
      const ack = e.target.closest('[data-nack]'); if (ack) { confirmRead(ack.dataset.nack, ack); return; }
      const c = e.target.closest('.msg-card'); if (c) c.setAttribute('aria-expanded', String(c.getAttribute('aria-expanded') !== 'true'));
    });
    document.addEventListener('keydown', (e) => {
      const c = e.target.closest?.('#noticeDialog .msg-card');
      if (c && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); c.click(); }
    });
    document.addEventListener('input', (e) => {
      if (e.target.name === 'body' && e.target.closest('#noticeForm')) { const h = $('#nCount'); if (h) h.textContent = `${e.target.value.length} / 4000`; }
    });
    document.addEventListener('change', (e) => {
      if (e.target.id !== 'nTemplate') return;
      const [title, text] = TEMPLATES[Number(e.target.value)] || ['', ''];
      const f = $('#noticeForm'); if (title) { f.title.value = title; f.body.value = text; f.body.dispatchEvent(new Event('input', { bubbles: true })); }
    });
    document.addEventListener('submit', (e) => { if (e.target.id === 'noticeForm') { e.preventDefault(); send(e.target); } });
  }
  const reset = () => { Object.assign(ns, { inbox: [], sent: [], unread: 0, tab: 'inbox', opts: null, at: 0 }); badge(); };
  return { wire, refresh, tick, show, reset, state: ns };
})();

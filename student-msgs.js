/* Student app → Messages: what the student's trainers, the HOD and the college office sent to their class (or to them).
 * Opening the list marks the messages read; the tab shows how many are new. Needs internet; the last list is kept on the
 * device so it can be read offline. Uses student.js (st, api, esc, $, $$). */
'use strict';

(() => {
  const KEY = 'ark-messages';
  const fmt = (iso) => new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const saved = () => { try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { return []; } };
  function draw(list) {
    const box = $('#msgList'); if (!box) return;
    const sorted = [...list].sort((x, y) => String(y.at).localeCompare(String(x.at)));
    box.innerHTML = sorted.length ? `<ul class="msg-list notice-list">${sorted.map((m) => `<li class="${m.read ? '' : 'unread'}"><div class="msg-card" role="button" tabindex="0" aria-expanded="false">
      <div class="msg-meta"><span class="who">${esc(m.from)}</span><time>${esc(fmt(m.at))}</time></div>
      <div class="msg-title">${esc(m.title)}</div><p class="msg-body">${esc(m.body)}</p></div></li>`).join('')}</ul>`
      : '<p class="msg-empty">No messages yet. When your trainers write to you, they show here.</p>';
  }
  function count(list) { const n = list.filter((m) => !m.read).length, dot = $('#msgCount'); if (dot) { dot.hidden = !n; dot.textContent = String(n); } }
  async function load(markRead) {
    const p = st.profile;
    if (!p || !navigator.onLine || !st.sheetsUrl) { const l = saved(); draw(l); count(l); return; }
    try {
      const prev = saved(), read = markRead ? prev.filter((m) => !m.read).map((m) => m.id) : [];
      const r = await api('POST', {}, { action: 'messages', deviceId: st.deviceId, admNo: p.admNo, read });
      if (!r.ok) throw new Error(r.error);
      const list = markRead ? r.messages.map((m) => ({ ...m, read: true })) : r.messages;
      try { localStorage.setItem(KEY, JSON.stringify(list.slice(0, 60))); } catch { /* storage full or private */ }
      draw(list); count(list);
      // Messages that arrived while the list was open are marked read next time.
      if (markRead && r.messages.some((m) => !m.read)) api('POST', {}, { action: 'messages', deviceId: st.deviceId, admNo: p.admNo, read: r.messages.filter((m) => !m.read).map((m) => m.id) }).catch(() => {});
    } catch { const l = saved(); draw(l); count(l); }
  }
  document.addEventListener('click', (e) => { const c = e.target.closest('#msgList .msg-card'); if (c) c.setAttribute('aria-expanded', String(c.getAttribute('aria-expanded') !== 'true')); });
  document.addEventListener('keydown', (e) => { const c = e.target.closest?.('#msgList .msg-card'); if (c && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); c.click(); } });
  document.addEventListener('click', (e) => { const b = e.target.closest('#viewTabs [data-view=msgs]'); if (b) load(true); });
  window.addEventListener('online', () => load(document.body.dataset.view === 'msgs'));
  // A notification for a message brings the student here; otherwise just keep the count fresh.
  const start = () => { if (location.hash === '#msgs') $('#viewTabs [data-view=msgs]')?.click(); else load(false); };
  if (document.readyState === 'complete') setTimeout(start, 1500); else window.addEventListener('load', () => setTimeout(start, 1500));
  setInterval(() => { if (document.visibilityState === 'visible') load(document.body.dataset.view === 'msgs'); }, 10 * 60e3);
})();

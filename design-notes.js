/* Design notes — for saying what should change on a screen, by pointing at it.
 *
 * Open either app with ?notes=1 on the end of the address, for example
 *   https://ark26.pages.dev/?notes=1
 *   https://ark26.pages.dev/student?notes=1
 * A strip appears at the top. While Pick is on, tapping anything opens a box: type what you want
 * changed and Save. Turn Pick off to move around the app normally, then back on. Tap Copy and paste
 * the result wherever the change is being asked for.
 *
 * Each note carries the element it was left on, the words on it, and the lines in this project's own
 * files that mention it — so "make the count red" arrives already pointing at index.html and app.js.
 * Notes are kept in this browser, so they survive a reload and build up across several screens.
 *
 * Nothing here runs unless ?notes=1 is in the address: the two apps load this file only then, so it
 * costs students and trainers nothing. It is a tool for the people building the app, not a feature.
 */
'use strict';

(() => {
  if (!/[?&]notes=1(&|$)/.test(location.search)) return;

  const KEY = 'rvnp_design_notes';
  const PAGE = /\/student(\.html)?$/.test(location.pathname) ? 'student.html' : 'index.html';
  const PAGE_NAME = PAGE === 'student.html' ? 'student app' : 'trainer / HOD / MIS app';
  /* Where to look for whatever a note was left on. Fetched through the service worker, so this works
   * with no internet too (these are the files it keeps). */
  const FILES = ['index.html', 'student.html', 'styles.css', 'app.js', 'admin.js', 'poe-staff.js',
    'marks.js', 'report.js', 'imports.js', 'student.js', 'poe-student.js', 'scanner.js'];
  // Classes that say what state something is in, not what it is: no use in a selector.
  const STATE_CLASS = /^(dn-|on|active|show|shown|open|hidden|syncing|selected|disabled|err|ok|is-|js-|f-)/;
  const DATA_KEYS = ['tab', 'view', 'mode', 'item', 'status', 'sfilter', 'filter', 'act', 'decide', 'open',
    'nav', 'pick', 'preview', 'apply', 'remove', 'copy', 'retry', 'redo', 'del', 'move', 'camera',
    'gallery', 'clear', 'close', 'receive', 'reload', 'group', 'code', 'adm', 'doc', 'page', 's', 'h'];
  /* The things most often asked for, one tap each, so a note on a phone need not be typed out in full.
   * Whatever is added can then be edited or added to. */
  const QUICK = ['Bigger', 'Smaller', 'Move it up', 'Move it down', 'Another colour', 'More room around it',
    'Hide it', 'Reword it', 'Easier to tap', 'Wrong on a phone'];

  /* The shapes inside an icon, and anything marked as decoration: tapping one of these means the
   * button or row that holds it, which is what someone is actually pointing at. */
  const THROUGH = new Set(['svg', 'use', 'path', 'g', 'circle', 'rect', 'line', 'polyline', 'polygon', 'ellipse', 'tspan', 'br', 'symbol']);
  const meant = (el) => {
    while (el && el !== document.body
      && (THROUGH.has(el.tagName.toLowerCase()) || el.getAttribute('aria-hidden') === 'true')) el = el.parentElement;
    return el && el !== document.body ? el : null;
  };

  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const load = () => { try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { return []; } };
  const save = (list) => { try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* private mode */ } };

  let notes = load(), picking = true, hovered = null;

  /* ---------- naming what was tapped ---------- */
  const attrOf = (el) => {
    for (const k of DATA_KEYS) {
      const v = el.dataset?.[k];
      if (v === undefined) continue;
      return v === '' ? `[data-${k}]` : `[data-${k}="${v}"]`;
    }
    return '';
  };
  function step(el) {
    if (el.id) return '#' + el.id;
    const tag = el.tagName.toLowerCase();
    const attr = attrOf(el);
    if (attr) return tag + attr;
    const cls = [...el.classList].filter((c) => !STATE_CLASS.test(c)).slice(0, 2);
    return tag + cls.map((c) => '.' + c).join('');
  }
  /** The shortest way to say which element this is: as soon as it is the only match, stop. */
  function selectorFor(el) {
    const parts = [];
    for (let n = el; n && n !== document.body && parts.length < 4; n = n.parentElement) {
      const s = step(n);
      parts.unshift(s);
      if (s.startsWith('#')) break;
      if (document.querySelectorAll(parts.join(' ')).length === 1) break;
    }
    let sel = parts.join(' ') || el.tagName.toLowerCase();
    if (document.querySelectorAll(sel).length > 1 && el.parentElement) {
      const same = [...el.parentElement.children].filter((x) => x.tagName === el.tagName);
      if (same.length > 1) sel += `:nth-of-type(${same.indexOf(el) + 1})`;
    }
    return sel;
  }
  /** The words on it, so it can be found by eye as well as by selector. What someone has typed is
   *  never taken: a note must not carry away a PIN, an admission number or a name from a box. */
  function labelOf(el) {
    const tag = el.tagName.toLowerCase();
    let own = el.getAttribute('aria-label') || '';
    if (!own && tag === 'select') own = el.selectedOptions?.[0]?.textContent || '';
    else if (!own && (tag === 'input' || tag === 'textarea')) own = el.placeholder || el.type || '';
    else if (!own) own = el.textContent || '';
    own = own.replace(/\s+/g, ' ').trim();
    return own.slice(0, 80) + (own.length > 80 ? '…' : '');
  }
  /** The part of the screen it sits in (the nearest thing above it with a name). */
  function whereIn(el) {
    for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) if (n.id) return '#' + n.id;
    return '';
  }
  /** What to search the project's files for. An id or a data-attribute names this one element, so those
   * come first; class names are a fallback, because a class is shared and brings in places that have
   * nothing to do with what was tapped. */
  function needles(el) {
    const strong = [], weak = [];
    if (el.id) strong.push(el.id);
    for (const k of DATA_KEYS) {
      const v = el.dataset?.[k];
      if (v !== undefined && v !== '') strong.push(`data-${k}="${v}"`, `dataset.${k} === '${v}'`);
    }
    for (const c of [...el.classList].filter((x) => !STATE_CLASS.test(x))) weak.push('.' + c, `'${c}'`);
    return { strong, weak };
  }

  /* ---------- the strip, the box and the list ---------- */
  const style = document.createElement('style');
  style.textContent = `
    #dn-bar, #dn-pop, #dn-list { font: 500 14px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; box-sizing: border-box; }
    #dn-bar * , #dn-pop *, #dn-list * { box-sizing: border-box; }
    #dn-bar { position: fixed; inset: 0 0 auto 0; z-index: 2147483000; display: flex; align-items: center; gap: .5rem;
      padding: .4rem .6rem; background: #14202b; color: #fff; box-shadow: 0 2px 10px rgba(0,0,0,.35); flex-wrap: wrap; }
    #dn-bar b { font-weight: 700; margin-right: .2rem; }
    #dn-bar .sp { flex: 1 1 auto; }
    #dn-bar button { font: inherit; padding: .3rem .6rem; border-radius: 6px; border: 1px solid #40596e;
      background: #1f3040; color: #fff; cursor: pointer; }
    #dn-bar button[aria-pressed="true"] { background: #4fcd84; border-color: #4fcd84; color: #0b2017; font-weight: 700; }
    #dn-bar button:disabled { opacity: .45; cursor: default; }
    /* How tall the strip turned out to be — it wraps onto two lines on a narrow phone, so it is
       measured rather than guessed. Both apps keep their heading and tabs in a sticky .chrome at the
       very top, which would otherwise sit under the strip and be impossible to tap. */
    body.dn-on { padding-top: var(--dn-h, 46px) !important; }
    body.dn-on .chrome { top: var(--dn-h, 46px) !important; }
    .dn-hover { outline: 2px solid #4fcd84 !important; outline-offset: 1px; cursor: crosshair !important; }
    .dn-noted { outline: 2px dashed #ffb02e !important; outline-offset: 1px; }
    #dn-pop, #dn-list { position: fixed; z-index: 2147483001; background: #fff; color: #14202b; border-radius: 10px;
      box-shadow: 0 10px 40px rgba(0,0,0,.4); padding: .75rem; width: min(380px, calc(100vw - 20px)); }
    #dn-pop code, #dn-list code { font: 600 12px/1.4 ui-monospace, Consolas, monospace; color: #0b5d33; word-break: break-all; }
    #dn-pop .said { font-size: 12px; color: #5a6b7a; margin: .2rem 0 .5rem; }
    #dn-pop textarea { width: 100%; font: inherit; padding: .5rem; border: 1px solid #c2ccd4; border-radius: 6px; resize: vertical; }
    #dn-pop .quick { display: flex; flex-wrap: wrap; gap: .3rem; margin: .1rem 0 .5rem; }
    #dn-pop .quick button { font-size: 12px; padding: .2rem .45rem; border-radius: 99px; background: #eef3f6; }
    #dn-pop .row { display: flex; gap: .5rem; justify-content: flex-end; margin-top: .5rem; }
    #dn-pop button, #dn-list button { font: inherit; padding: .35rem .7rem; border-radius: 6px; border: 1px solid #c2ccd4; background: #f4f7f9; cursor: pointer; }
    #dn-pop button.go { background: #0b5d33; border-color: #0b5d33; color: #fff; font-weight: 700; }
    #dn-list { top: calc(var(--dn-h, 46px) + 6px); right: 10px; max-height: calc(100vh - var(--dn-h, 46px) - 20px); overflow: auto; }
    #dn-list ol { margin: .3rem 0 0; padding-left: 1.3rem; }
    #dn-list li { margin-bottom: .6rem; }
    #dn-list .note { white-space: pre-wrap; }
    #dn-list .del { float: right; border: 0; background: none; color: #c42830; font-weight: 700; cursor: pointer; }
    #dn-toast { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); z-index: 2147483002;
      background: #14202b; color: #fff; padding: .6rem 1rem; border-radius: 99px; box-shadow: 0 6px 20px rgba(0,0,0,.4); }
  `;
  document.head.appendChild(style);

  const bar = document.createElement('div');
  bar.id = 'dn-bar';
  bar.innerHTML = `<b>✎ Design notes</b>
    <button id="dn-pick" aria-pressed="true" title="Tap things to leave a note (Esc turns it off)">Pick: on</button>
    <span class="sp"></span>
    <button id="dn-show">0 noted</button>
    <button id="dn-copy">Copy</button>
    <button id="dn-clear">Clear</button>
    <button id="dn-off" title="Leave the page as it normally is">Close</button>`;
  document.body.appendChild(bar);
  document.body.classList.add('dn-on');
  const measure = () => document.documentElement.style.setProperty('--dn-h', bar.offsetHeight + 'px');
  measure();
  window.addEventListener('resize', measure);
  new ResizeObserver(measure).observe(bar);

  let toastTimer;
  function toast(msg) {
    let t = $('#dn-toast');
    if (!t) { t = document.createElement('div'); t.id = 'dn-toast'; document.body.appendChild(t); }
    t.textContent = msg;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.remove(), 2600);
  }
  const mine = (el) => !!el?.closest?.('#dn-bar, #dn-pop, #dn-list, #dn-toast');

  function refresh() {
    $('#dn-show').textContent = `${notes.length} noted`;
    $('#dn-copy').disabled = $('#dn-clear').disabled = $('#dn-show').disabled = !notes.length;
    $('#dn-pick').setAttribute('aria-pressed', String(picking));
    $('#dn-pick').textContent = 'Pick: ' + (picking ? 'on' : 'off');
    document.querySelectorAll('.dn-noted').forEach((el) => el.classList.remove('dn-noted'));
    for (const n of notes) {
      if (n.page !== PAGE) continue;
      try { document.querySelectorAll(n.selector).forEach((el) => el.classList.add('dn-noted')); } catch { /* gone */ }
    }
  }

  /* ---------- picking ---------- */
  function unhover() { hovered?.classList.remove('dn-hover'); hovered = null; }
  window.addEventListener('pointerover', (e) => {
    if (!picking || mine(e.target)) return;
    const el = meant(e.target);
    if (el === hovered) return;
    unhover();
    hovered = el;
    hovered?.classList.add('dn-hover');   // outlines exactly what a tap would leave a note on
  }, true);

  for (const ev of ['pointerdown', 'mousedown', 'click', 'touchstart']) {
    window.addEventListener(ev, (e) => {
      if (!picking || mine(e.target) || !(e.target instanceof Element)) return;
      e.preventDefault();
      e.stopImmediatePropagation();     // the app must not act on a tap meant for a note
      if (ev === 'click') { const el = meant(e.target); if (el) openBox(el); }
    }, true);
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#dn-pop')) { picking = !picking; unhover(); refresh(); toast('Pick: ' + (picking ? 'on' : 'off')); }
  }, true);

  function closeBox() { $('#dn-pop')?.remove(); }
  function openBox(el) {
    closeBox();
    unhover();   // the outline is this tool's own class: it must be gone before the element is named
    const sel = selectorFor(el), label = labelOf(el), inside = whereIn(el);
    const had = notes.find((n) => n.page === PAGE && n.selector === sel);
    const box = document.createElement('div');
    box.id = 'dn-pop';
    box.innerHTML = `<code>${esc(sel)}</code>
      <p class="said">${esc(el.tagName.toLowerCase())}${inside ? ' in ' + esc(inside) : ''}${label ? ' — “' + esc(label) + '”' : ''}</p>
      <div class="quick">${QUICK.map((q) => `<button type="button" data-q="${esc(q)}">${esc(q)}</button>`).join('')}</div>
      <textarea id="dn-text" rows="3" placeholder="What should change here? For example: make the count bigger and red when it is not zero">${esc(had?.note || '')}</textarea>
      <div class="row">${had ? '<button id="dn-drop">Remove</button>' : ''}<button id="dn-cancel">Cancel</button><button class="go" id="dn-save">Save</button></div>`;
    // A dialog opened with showModal() sits above everything, whatever the z-index, so to leave a note
    // on something inside one (a POE submission, the lesson QR) the box has to go inside it.
    (el.closest('dialog[open]') || document.querySelector('dialog[open]') || document.body).appendChild(box);
    // Near what was tapped, but always on the screen.
    const r = el.getBoundingClientRect(), h = box.offsetHeight, w = box.offsetWidth;
    box.style.top = Math.max(bar.offsetHeight + 6, Math.min(window.innerHeight - h - 10, r.bottom + 8)) + 'px';
    box.style.left = Math.max(10, Math.min(window.innerWidth - w - 10, r.left)) + 'px';
    $('#dn-text').focus();
    box.querySelector('.quick').onclick = (e) => {
      const q = e.target.closest('[data-q]');
      if (!q) return;
      const area = $('#dn-text');
      area.value = (area.value.trim() ? area.value.trim().replace(/\.$/, '') + '. ' : '') + q.dataset.q;
      area.focus();
    };
    $('#dn-cancel').onclick = closeBox;
    $('#dn-drop') && ($('#dn-drop').onclick = () => { notes = notes.filter((n) => n !== had); save(notes); closeBox(); refresh(); toast('Note removed'); });
    $('#dn-save').onclick = () => {
      const note = $('#dn-text').value.trim();
      if (!note) { $('#dn-text').focus(); return; }
      const row = { page: PAGE, selector: sel, tag: el.tagName.toLowerCase(), label, inside, note, needles: needles(el), at: new Date().toISOString() };
      if (had) Object.assign(had, row); else notes.push(row);
      save(notes);
      closeBox();
      refresh();
      toast('Noted — keep going, then Copy');
    };
    $('#dn-text').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) $('#dn-save').click();
      if (e.key === 'Escape') { e.stopPropagation(); closeBox(); }
    });
  }

  /* ---------- the list ---------- */
  function toggleList() {
    const open = $('#dn-list');
    if (open) { open.remove(); return; }
    const panel = document.createElement('div');
    panel.id = 'dn-list';
    panel.innerHTML = `<b>Notes so far</b><ol>${notes.map((n, i) => `<li>
      <button class="del" data-i="${i}" aria-label="Remove note ${i + 1}">✕</button>
      <code>${esc(n.selector)}</code>${n.page !== PAGE ? ` <small>(${esc(n.page)})</small>` : ''}
      <div class="note">${esc(n.note)}</div></li>`).join('')}</ol>`;
    document.body.appendChild(panel);
    panel.onclick = (e) => {
      const b = e.target.closest('.del');
      if (!b) return;
      notes.splice(Number(b.dataset.i), 1);
      save(notes);
      panel.remove();
      refresh();
      toggleList();
    };
  }

  /* ---------- copying it out ---------- */
  let sources = null;
  async function readSources() {
    if (sources) return sources;
    sources = {};
    await Promise.all(FILES.map(async (f) => {
      try { const r = await fetch(f); if (r.ok) sources[f] = (await r.text()).split('\n'); } catch { /* not there */ }
    }));
    return sources;
  }
  function placesFor(note) {
    // Notes saved by an older version kept one flat list; both shapes are read.
    const tiers = Array.isArray(note.needles) ? [note.needles]
      : [note.needles?.strong || [], note.needles?.weak || []];
    const other = note.page === 'student.html' ? 'index.html' : 'student.html';
    const files = Object.keys(sources).filter((f) => f !== other)    // the other app's page is not it
      .sort((a, b) => (a === note.page ? -1 : b === note.page ? 1 : 0));   // this page's markup first
    for (const list of tiers) {
      if (!list.length) continue;
      const hits = [];
      for (const f of files) {
        const lines = sources[f];
        for (let i = 0; i < lines.length; i++) {
          if (list.some((n) => lines[i].includes(n))) { hits.push(`${f}:${i + 1}`); break; }
        }
      }
      if (hits.length) return hits.slice(0, 5);
    }
    return [];
  }
  async function copyOut() {
    $('#dn-copy').textContent = 'Looking…';
    await readSources();
    const byPage = {};
    for (const n of notes) (byPage[n.page] = byPage[n.page] || []).push(n);
    let out = `Design notes — ${notes.length} change${notes.length === 1 ? '' : 's'} asked for\n`;
    for (const [page, list] of Object.entries(byPage)) {
      out += `\n## ${page}${page === PAGE ? ` (${PAGE_NAME})` : ''}\n`;
      list.forEach((n, i) => {
        const places = placesFor(n);
        out += `\n${i + 1}. \`${n.selector}\`${n.label ? ` — “${n.label}”` : ''}\n`;
        if (n.inside) out += `   in ${n.inside}\n`;
        if (places.length) out += `   ${places.join(', ')}\n`;
        out += `   → ${n.note.replace(/\n/g, '\n     ')}\n`;
      });
    }
    try {
      await navigator.clipboard.writeText(out);
      toast('Copied — paste it where you are asking for the change');
    } catch {
      // Clipboard blocked (it often is without https): show it to be copied by hand.
      const box = document.createElement('div');
      box.id = 'dn-pop';
      box.style.top = bar.offsetHeight + 14 + 'px';
      box.innerHTML = '<p class="said">Copying was blocked, so here it is to copy by hand:</p>'
        + `<textarea rows="12" readonly>${esc(out)}</textarea><div class="row"><button class="go" id="dn-cancel">Done</button></div>`;
      document.body.appendChild(box);
      box.querySelector('textarea').select();
      $('#dn-cancel').onclick = closeBox;
    }
    $('#dn-copy').textContent = 'Copy';
  }

  /* ---------- the strip's buttons ---------- */
  bar.addEventListener('click', (e) => {
    const id = e.target.id;
    if (id === 'dn-pick') { picking = !picking; unhover(); refresh(); }
    if (id === 'dn-show') toggleList();
    if (id === 'dn-copy') copyOut();
    if (id === 'dn-clear' && confirm(`Forget all ${notes.length} note(s)?`)) { notes = []; save(notes); $('#dn-list')?.remove(); refresh(); }
    if (id === 'dn-off') {
      // Leave the page exactly as a trainer or student sees it.
      picking = false;
      unhover();
      closeBox();
      $('#dn-list')?.remove();
      bar.remove();
      style.remove();
      document.body.classList.remove('dn-on');
      document.querySelectorAll('.dn-noted').forEach((el) => el.classList.remove('dn-noted'));
      toast('Design notes closed — your notes are kept; add ?notes=1 again to carry on');
    }
  });

  refresh();
  toast(notes.length ? `${notes.length} note(s) from before — tap anything to add more` : 'Tap anything to say what should change');
})();

/* Term register: one class, one unit, 12 teaching weeks × up to 3 lessons a week — the same layout
 * as RVNP's General Class Register. Used for the Reports screen, the Excel export and the print view.
 *
 * Hours: a lesson's length comes from the loading (hours per week ÷ lessons per week, usually 1.5 h).
 * Possible hours count only lessons the student was on the register for, so students who join
 * mid-term are not penalised for lessons before they joined.
 * Actual hours: Present = full lesson, Late and Excused = the trainer's chosen share of the lesson.
 * A double lesson fills two cells of its week. CAT and other assessment registers are not part of it: a CAT week has no
 * lessons, so its three cells are merged into one column reading "CAT 1" (with the CAT's date), as on the paper register.
 * catTable() gives the CATs and extra CAT attendance as their own table (the Excel file's CATs sheet). */
'use strict';

const TermReport = (() => {
  const WEEKS = 12, CELLS = WEEKS * 3;
  const mondayOf = (iso) => {
    const d = new Date(iso + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    return d.toISOString().slice(0, 10);
  };
  const round2 = (n) => Math.round(n * 100) / 100;
  const PERIOD_ORDER = (p) => { const m = /(\d+)/.exec(p || ''); return m ? Number(m[1]) : /ev/i.test(p || '') ? 9 : 0; };
  const dshort = (iso) => (iso ? new Date(iso + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }) : '');

  /**
   * input = { weeks: [Monday ISO × 12], lessons: [{ id, date, period, slots (1, or 2 for a double), marks: {adm: 'P'|'A'|'L'|'E'}, names }],
   *           roster: [{ admNo, name, pending }], aliases: { fromAdm: toAdm }, rejected: Set(adm),
   *           lessonHours, latePct, excusedPct, threshold,
   *           catWeeks: [week numbers, 1-12], assessments: [{ date, kind: 'cat'|'extra' }] }
   * cats in the result: [{ w (0-11), label: 'CAT 1', dates, merge }]; merge is false if lessons were marked in that week anyway.
   */
  function build(input) {
    const h = Number(input.lessonHours) || 1.5;
    const late = (Number(input.latePct ?? 50)) / 100, exc = (Number(input.excusedPct ?? 100)) / 100;
    const threshold = Number(input.threshold || 75);
    const lessons = [...input.lessons].sort((a, b) => (a.date + PERIOD_ORDER(a.period)).localeCompare(b.date + PERIOD_ORDER(b.period))
      || String(a.date + a.period).localeCompare(b.date + b.period));
    let weeks = (input.weeks || []).slice(0, WEEKS);
    if (!weeks.length) weeks = [...new Set(lessons.map((l) => mondayOf(l.date)))].sort().slice(0, WEEKS);
    const slots = new Map(); // lesson id -> cell indexes (0..35); a double has two
    const used = weeks.map(() => 0);
    const overflow = [];
    for (const l of lessons) {
      const w = weeks.indexOf(mondayOf(l.date));
      if (w === -1 || used[w] >= 3) { overflow.push(l); continue; }
      const n = Math.min(Number(l.slots) === 2 ? 2 : 1, 3 - used[w]);
      slots.set(l.id, Array.from({ length: n }, (_, k) => w * 3 + used[w] + k));
      used[w] += n;
    }
    const catDates = (w) => [...new Set((input.assessments || []).filter((a) => a.kind === 'cat' && mondayOf(a.date) === weeks[w]).map((a) => a.date))].sort();
    const cats = (input.catWeeks || []).map(Number).filter((n) => n >= 1 && n <= weeks.length)
      .map((n, i) => ({ w: n - 1, label: `CAT ${i + 1}`, dates: catDates(n - 1), merge: !used[n - 1] }));
    const alias = input.aliases || {};
    const rejected = input.rejected || new Set();
    const rows = new Map();
    const ensure = (adm, name, extra = {}) => {
      if (!rows.has(adm)) rows.set(adm, { admNo: adm, name: name || adm, cells: Array(CELLS).fill(''), P: 0, A: 0, L: 0, E: 0, held: 0, ...extra });
      return rows.get(adm);
    };
    for (const t of input.roster || []) if (!rejected.has(t.admNo)) ensure(t.admNo, t.name, { pending: !!t.pending });
    const placed = lessons.filter((l) => slots.has(l.id));
    for (const l of placed) {
      const cells = slots.get(l.id);
      const marks = {};
      for (const [adm, st] of Object.entries(l.marks || {})) {
        const to = alias[adm] || adm;
        if (marks[to] && to !== adm) continue; // the real student's own mark wins over a typo's
        marks[to] = st;
      }
      for (const [adm, st] of Object.entries(marks)) {
        if (!'PALE'.includes(st) || rejected.has(adm)) continue;
        const r = ensure(adm, l.names?.[adm], { unlisted: !(input.roster || []).some((t) => t.admNo === adm) });
        for (const cell of cells) { r.cells[cell] = st; r[st]++; r.held++; }
      }
    }
    const list = [...rows.values()].map((r) => {
      const possible = round2(r.held * h);
      const actual = round2((r.P + r.L * late + r.E * exc) * h);
      const pct = possible ? Math.round((actual / possible) * 1000) / 10 : null;
      return { ...r, possible, actual, pct, below: pct !== null && pct < threshold };
    });
    const withPct = list.filter((r) => r.pct !== null);
    return {
      weeks, list, overflow, cats, lessonsHeld: placed.reduce((a, l) => a + slots.get(l.id).length, 0), lessonHours: h, threshold,
      avg: withPct.length ? Math.round(withPct.reduce((a, r) => a + r.pct, 0) / withPct.length) : 0,
      below: list.filter((r) => r.below).length,
      latePct: Math.round(late * 100), excusedPct: Math.round(exc * 100),
    };
  }

  /** The CAT weeks shown as one merged column: week index → { label, dates }. */
  const catMap = (r) => new Map((r.cats || []).filter((c) => c.merge).map((c) => [c.w, c]));

  /** The register's 36 cells as a strip of 12 week groups (phones). A CAT week is one bar. */
  function strip(cells, cats) {
    let s = '<span class="strip" aria-hidden="true">';
    for (let w = 0; w < WEEKS; w++) {
      if (cats?.has(w)) { s += '<span class="wk"><i class="cat"></i></span>'; continue; }
      s += '<span class="wk">';
      for (let k = 0; k < 3; k++) { const v = cells[w * 3 + k]; s += `<i class="${v || 'n'}"></i>`; }
      s += '</span>';
    }
    return s + '</span>';
  }

  /** Grid like the Excel register (tablets, computers, and phones turned sideways). */
  function sheetTable(r, esc, th) {
    // th(col, label, cls, extra): a heading that sorts the table when tapped (plain headings when not given).
    const h = th || ((col, label, cls, extra) => `<th${extra} class="${cls}">${label}</th>`);
    const cats = catMap(r);
    const head1 = '<tr>' + h('adm', '#', 'sticky n', ' rowspan="2"') + h('adm', 'Admission no', 'sticky adm', ' rowspan="2"') + h('name', 'Name', 'sticky nm', ' rowspan="2"')
      + Array.from({ length: WEEKS }, (_, w) => `<th colspan="3" class="wkh${cats.has(w) ? ' cat' : ''}">WK${w + 1}</th>`).join('')
      + h('possible', 'Possible hrs', 'num', ' rowspan="2"') + h('actual', 'Actual hrs', 'num', ' rowspan="2"') + h('pct', '%', 'num', ' rowspan="2"') + '</tr>';
    const head2 = '<tr>' + Array.from({ length: WEEKS }, (_, w) => (cats.has(w)
      ? `<th colspan="3" class="sub end cat">${esc(cats.get(w).dates.map(dshort).join(', '))}</th>`
      : [0, 1, 2].map((k) => `<th class="sub${k === 2 ? ' end' : ''}">${k + 1}</th>`).join(''))).join('') + '</tr>';
    const n = r.list.length;
    const cellsOf = (x, i) => Array.from({ length: WEEKS }, (_, w) => {
      if (cats.has(w)) return i ? '' : `<td class="catcol end" colspan="3" rowspan="${n}"><span>${esc(cats.get(w).label)}</span></td>`;
      return [0, 1, 2].map((k) => { const v = x.cells[w * 3 + k]; return `<td class="c ${v}${k === 2 ? ' end' : ''}">${v}</td>`; }).join('');
    }).join('');
    const body = r.list.map((x, i) => `<tr class="${x.below ? 'below' : ''}">
      <td class="sticky n">${x.sn || i + 1}</td><td class="sticky adm">${esc(x.admNo)}</td>
      <td class="sticky nm">${esc(x.name)}${x.stream ? ` <span class="stag" title="Stream">${esc(x.stream)}</span>` : ''}${x.pending ? ' <span class="ptag">Pending</span>' : ''}</td>
      ${cellsOf(x, i)}
      <td class="num">${x.possible || ''}</td><td class="num">${x.actual || ''}</td><td class="num pct">${x.pct === null ? '–' : x.pct + '%'}</td></tr>`).join('');
    return `<table class="sheet-table"><thead>${head1}${head2}</thead><tbody>${body || `<tr><td colspan="${CELLS + 6}" class="empty">No trainees.</td></tr>`}</tbody></table>`;
  }

  /**
   * CATs and extra CAT attendance as a table: a column each, by date. A student absent from a CAT who sat the extra
   * attendance that makes it up reads "Ab (Supplementary CAT - Sat 19 Mar)". An extra attendance makes up the CAT its
   * title names ("CAT 1 make-up"), else the latest CAT before it.
   * students: [{ admNo, name }], items: [{ date, period, kind, title, marks }]
   */
  function catTable(students, items) {
    const sorted = [...items].sort((a, b) => (a.date + PERIOD_ORDER(a.period)).localeCompare(b.date + PERIOD_ORDER(b.period)));
    const cats = sorted.filter((a) => a.kind === 'cat');
    const makesUp = new Map();
    for (const x of sorted.filter((a) => a.kind === 'extra')) {
      const m = /CAT\s*(\d+)/i.exec(x.title || '');
      const t = (m && cats.find((c) => new RegExp(`CAT\\s*${m[1]}\\b`, 'i').test(c.title || ''))) || [...cats].reverse().find((c) => c.date <= x.date);
      if (t) makesUp.set(x, t);
    }
    const sat = (v) => v === 'P' || v === 'L';
    const rows = students.map((s) => ({ admNo: s.admNo, name: s.name, vals: sorted.map((a) => {
      const v = a.marks?.[s.admNo] || '';
      if (a.kind === 'cat' && v === 'A') {
        const sup = sorted.find((x) => makesUp.get(x) === a && sat(x.marks?.[s.admNo]));
        if (sup) return `Ab (Supplementary CAT - Sat ${dshort(sup.date)})`;
      }
      return v === 'A' ? 'Ab' : v;
    }) }));
    const count = (k, test) => rows.filter((r) => test(r.vals[k])).length;
    return {
      cols: sorted.map((a) => ({ label: a.title || (a.kind === 'cat' ? 'CAT' : 'Extra CAT attendance'), date: dshort(a.date), kind: a.kind })),
      rows,
      totals: [
        { label: 'Sat', vals: sorted.map((a, k) => count(k, sat)) },
        { label: 'Absent', vals: sorted.map((a, k) => count(k, (v) => String(v).startsWith('Ab'))) },
        { label: 'Absent, sat the supplementary', vals: sorted.map((a, k) => (a.kind === 'cat' ? count(k, (v) => String(v).startsWith('Ab (')) : '')) },
      ],
    };
  }

  /** Data for Xlsx.registerFile and the print view. info.assessments: the CATs and extra attendance, for the CATs sheet. */
  function exportData(r, info) {
    const students = [...r.list].sort((a, b) => a.admNo.localeCompare(b.admNo, undefined, { numeric: true }));
    return {
      lecturer: info.lecturer, duration: info.duration, classLabel: info.classLabel, level: info.level,
      subject: info.subject, filter: `FILTERED BY: {Class: ${info.misClass || info.classCode}}`,
      weekLabels: Array.from({ length: WEEKS }, (_, i) => `WK${i + 1}`),
      sheetName: info.sheetName, lecturerComment: info.lecturerComment, hodComment: info.hodComment,
      // Same order as the MIS class register: by admission number.
      students: students.map((x) => ({ admNo: x.admNo, name: x.name, pending: x.pending, cells: x.cells, possible: x.possible, actual: x.actual })),
      cats: [...catMap(r).values()].map((c) => ({ w: c.w, label: c.label, date: c.dates.map(dshort).join(', ') })),
      catSheet: info.assessments?.length ? catTable(students, info.assessments) : null,
    };
  }

  /** Printable copy of the register (Save as PDF from the print dialog), same layout as the Excel file. */
  function printHtml(d, esc) {
    const cats = new Map((d.cats || []).map((c) => [c.w, c])), n = d.students.length;
    const cellsOf = (s, i) => Array.from({ length: WEEKS }, (_, w) => (cats.has(w)
      ? (i ? '' : `<td class="cat e" colspan="3" rowspan="${n}"><span>${esc(cats.get(w).label)}</span></td>`)
      : [0, 1, 2].map((k) => `<td class="c${k === 2 ? ' e' : ''}">${s.cells[w * 3 + k] || ''}</td>`).join(''))).join('');
    const cs = d.catSheet;
    const catPage = cs ? `<div class="rp-cats"><h2>CAT ATTENDANCE · ${esc(d.subject)}</h2><p>${esc(d.classLabel)}</p>
      <table class="rp-grid rp-cat"><thead><tr><th>#</th><th>ADMISSION NO</th><th>NAMES</th>${cs.cols.map((c) => `<th>${esc(c.label)}<br><small>${esc(c.date)}</small></th>`).join('')}</tr></thead>
      <tbody>${cs.rows.map((r, i) => `<tr><td>${i + 1}</td><td class="l">${esc(r.admNo)}</td><td class="l">${esc(r.name)}</td>${r.vals.map((v) => `<td>${esc(v)}</td>`).join('')}</tr>`).join('')}
      ${cs.totals.map((t) => `<tr class="tot"><td colspan="3" class="l">${esc(t.label)}</td>${t.vals.map((v) => `<td>${v}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` : '';
    const rows = d.students.map((s, i) => `<tr><td>${i + 1}</td><td class="l">${esc(s.admNo)}</td><td class="l">${esc(s.name)}${s.pending ? ' (pending)' : ''}</td>
      ${cellsOf(s, i)}
      <td>${s.possible || ''}</td><td>${s.actual || ''}</td><td>${Number(s.possible) ? (Math.round((s.actual / s.possible) * 1000) / 10) + '%' : '-'}</td></tr>`).join('');
    return `<div class="reg-print">
      <div class="rp-head"><img src="icons/rvnp-logo.png" alt=""><div class="rp-title">
        <h1>RIFT VALLEY NATIONAL POLYTECHNIC</h1>
        <table class="rp-fields"><tr><th>NAME OF LECTURER</th><td>${esc(d.lecturer)}</td><th>DURATION</th><td>${esc(d.duration)}</td></tr>
        <tr><th>CLASS</th><td>${esc(d.classLabel)}</td><th>LEVEL</th><td>${esc(d.level)}</td></tr>
        <tr><th>SUBJECT</th><td colspan="3">${esc(d.subject)}</td></tr></table>
        <h2>GENERAL CLASS REGISTER</h2><p>${esc(d.filter)}</p></div></div>
      <table class="rp-grid"><thead><tr><th rowspan="2">#</th><th rowspan="2">ADMISSION NO</th><th rowspan="2">NAMES</th>
        ${d.weekLabels.map((w) => `<th colspan="3" class="e">${esc(w)}</th>`).join('')}<th rowspan="2">Possible Hrs</th><th rowspan="2">Actual Hrs</th><th rowspan="2">Actual Attendance %</th></tr>
        <tr>${Array.from({ length: WEEKS }, (_, w) => (cats.has(w) ? `<th colspan="3" class="e catd">${esc(cats.get(w).date)}</th>`
          : [0, 1, 2].map((k) => `<th class="c${k === 2 ? ' e' : ''}"></th>`).join(''))).join('')}</tr></thead>
        <tbody>${rows}</tbody></table>
      <table class="rp-comments"><tr><th>Lecturer's Comment</th><td>${esc(d.lecturerComment)}</td></tr><tr><th>HOD's Comment</th><td>${esc(d.hodComment)}</td></tr></table>
    </div>${catPage}`;
  }

  return { build, strip, catMap, catTable, sheetTable, exportData, printHtml, mondayOf, WEEKS };
})();

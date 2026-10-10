/* Term register: one class, one unit, 12 teaching weeks × up to 3 lessons a week — the same layout
 * as RVNP's General Class Register. Used for the Reports screen, the Excel export and the print view.
 *
 * Hours: a lesson's length comes from the loading (hours per week ÷ lessons per week, usually 1.5 h).
 * Possible hours count only lessons the student was on the register for, so students who join
 * mid-term are not penalised for lessons before they joined.
 * Actual hours: Present = full lesson, Late and Excused = the trainer's chosen share of the lesson.
 * A double lesson fills two cells of its week. CAT and other assessment registers are not part of it. */
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

  /**
   * input = { weeks: [Monday ISO × 12], lessons: [{ id, date, period, slots (1, or 2 for a double), marks: {adm: 'P'|'A'|'L'|'E'}, names }],
   *           roster: [{ admNo, name, pending }], aliases: { fromAdm: toAdm }, rejected: Set(adm),
   *           lessonHours, latePct, excusedPct, threshold }
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
      weeks, list, overflow, lessonsHeld: placed.reduce((a, l) => a + slots.get(l.id).length, 0), lessonHours: h, threshold,
      avg: withPct.length ? Math.round(withPct.reduce((a, r) => a + r.pct, 0) / withPct.length) : 0,
      below: list.filter((r) => r.below).length,
      latePct: Math.round(late * 100), excusedPct: Math.round(exc * 100),
    };
  }

  /** The register's 36 cells as a strip of 12 week groups (phones). */
  function strip(cells) {
    let s = '<span class="strip" aria-hidden="true">';
    for (let w = 0; w < WEEKS; w++) {
      s += '<span class="wk">';
      for (let k = 0; k < 3; k++) { const v = cells[w * 3 + k]; s += `<i class="${v || 'n'}"></i>`; }
      s += '</span>';
    }
    return s + '</span>';
  }

  /** Grid like the Excel register (tablets, computers, and phones turned sideways). */
  function sheetTable(r, esc) {
    const head1 = '<tr><th rowspan="2" class="sticky n">#</th><th rowspan="2" class="sticky adm">Admission no</th><th rowspan="2" class="sticky nm">Name</th>'
      + Array.from({ length: WEEKS }, (_, w) => `<th colspan="3" class="wkh">WK${w + 1}</th>`).join('')
      + '<th rowspan="2" class="num">Possible hrs</th><th rowspan="2" class="num">Actual hrs</th><th rowspan="2" class="num">%</th></tr>';
    const head2 = '<tr>' + Array.from({ length: CELLS }, (_, k) => `<th class="sub${k % 3 === 2 ? ' end' : ''}">${(k % 3) + 1}</th>`).join('') + '</tr>';
    const body = r.list.map((x, i) => `<tr class="${x.below ? 'below' : ''}">
      <td class="sticky n">${i + 1}</td><td class="sticky adm">${esc(x.admNo)}</td>
      <td class="sticky nm">${esc(x.name)}${x.pending ? ' <span class="ptag">Pending</span>' : ''}</td>
      ${x.cells.map((v, k) => `<td class="c ${v}${k % 3 === 2 ? ' end' : ''}">${v}</td>`).join('')}
      <td class="num">${x.possible || ''}</td><td class="num">${x.actual || ''}</td><td class="num pct">${x.pct === null ? '–' : x.pct + '%'}</td></tr>`).join('');
    return `<table class="sheet-table"><thead>${head1}${head2}</thead><tbody>${body || `<tr><td colspan="${CELLS + 6}" class="empty">No trainees.</td></tr>`}</tbody></table>`;
  }

  /** Data for Xlsx.registerFile and the print view. */
  function exportData(r, info) {
    return {
      lecturer: info.lecturer, duration: info.duration, classLabel: info.classLabel, level: info.level,
      subject: info.subject, filter: `FILTERED BY: {Class: ${info.misClass || info.classCode}}`,
      weekLabels: Array.from({ length: WEEKS }, (_, i) => `WK${i + 1}`),
      sheetName: info.sheetName, lecturerComment: info.lecturerComment, hodComment: info.hodComment,
      // Same order as the MIS class register: by admission number.
      students: [...r.list].sort((a, b) => a.admNo.localeCompare(b.admNo, undefined, { numeric: true }))
        .map((x) => ({ admNo: x.admNo, name: x.name, pending: x.pending, cells: x.cells, possible: x.possible, actual: x.actual })),
    };
  }

  /** Printable copy of the register (Save as PDF from the print dialog), same layout as the Excel file. */
  function printHtml(d, esc) {
    const rows = d.students.map((s, i) => `<tr><td>${i + 1}</td><td class="l">${esc(s.admNo)}</td><td class="l">${esc(s.name)}${s.pending ? ' (pending)' : ''}</td>
      ${Array.from({ length: CELLS }, (_, k) => `<td class="c${k % 3 === 2 ? ' e' : ''}">${s.cells[k] || ''}</td>`).join('')}
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
        <tr>${Array.from({ length: CELLS }, (_, k) => `<th class="c${k % 3 === 2 ? ' e' : ''}"></th>`).join('')}</tr></thead>
        <tbody>${rows}</tbody></table>
      <table class="rp-comments"><tr><th>Lecturer's Comment</th><td>${esc(d.lecturerComment)}</td></tr><tr><th>HOD's Comment</th><td>${esc(d.hodComment)}</td></tr></table>
    </div>`;
  }

  return { build, strip, sheetTable, exportData, printHtml, mondayOf, WEEKS };
})();

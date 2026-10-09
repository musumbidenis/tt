/* Reading the MIS Officer's files in the browser:
 *   Imports.classList(file)  class register PDF from the MIS system (or the same register as Excel, or a CSV)
 *   Imports.loading(file)    the department loading workbook: Subject Loading, List of Trainers, List of Subject
 * Nothing leaves the phone or computer until the MIS Officer confirms the preview. */
'use strict';

const Imports = (() => {
  // Admission numbers look like CSL6/25S/304250 or L6CS/25M/302739: three or more parts.
  const ADM = /^[A-Z0-9]{2,12}(\/[A-Z0-9]{1,12}){2,3}$/i;
  const isAdm = (s) => ADM.test(String(s || '').trim()) && /\d/.test(s);
  const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
  const norm = (s) => clean(s).toUpperCase();

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src; s.onload = resolve;
      s.onerror = () => reject(new Error('The PDF reader could not load. Connect to the internet once and try again.'));
      document.head.appendChild(s);
    });
  }
  async function pdfLib() {
    if (!window.pdfjsLib) await loadScript('vendor/pdfjs/pdf.min.js');
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdfjs/pdf.worker.min.js';
    return window.pdfjsLib;
  }

  /** Groups the text pieces of a page into lines (same height on the page), left to right. */
  function toLines(items) {
    const lines = [];
    for (const it of items) {
      if (!it.str || !it.str.trim()) continue;
      const y = it.y;
      let line = lines.find((l) => Math.abs(l.y - y) <= 3);
      if (!line) { line = { y, items: [] }; lines.push(line); }
      line.items.push(it);
    }
    lines.sort((a, b) => b.y - a.y);
    for (const l of lines) l.items.sort((a, b) => a.x - b.x);
    return lines;
  }
  const valueAfter = (lines, label) => {
    for (const l of lines) {
      const i = l.items.findIndex((it) => norm(it.str) === label);
      if (i === -1) continue;
      const v = l.items.slice(i + 1).map((it) => clean(it.str)).filter(Boolean)
        .filter((s) => !['NAME OF LECTURER', 'DURATION', 'CLASS', 'LEVEL', 'SUBJECT'].includes(norm(s)));
      if (v.length) return v[0];
    }
    return '';
  };

  /** Turns the lines of an MIS "General class register" into its class code, duration and students. */
  function parseRegisterLines(pages) {
    const all = pages.flat();
    let misClass = valueAfter(all, 'CLASS');
    const filtered = all.map((l) => l.items.map((i) => i.str).join(' ')).join('\n').match(/\{\s*Class:\s*([^}]+)\}/i);
    if (filtered) misClass = clean(filtered[1]) || misClass;
    const duration = valueAfter(all, 'DURATION');
    const level = valueAfter(all, 'LEVEL');
    const students = [], seen = new Set();
    for (const l of all) {
      const i = l.items.findIndex((it) => isAdm(it.str));
      if (i === -1) continue;
      const admNo = clean(l.items[i].str);
      const name = clean(l.items.slice(i + 1).map((it) => it.str).join(' '));
      if (!name || seen.has(admNo.toLowerCase())) continue;
      seen.add(admNo.toLowerCase());
      students.push({ admNo, name });
    }
    return { misClass, duration, level, students };
  }

  async function fromPdf(file) {
    const lib = await pdfLib();
    const doc = await lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false }).promise;
    const pages = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const tc = await (await doc.getPage(p)).getTextContent();
      pages.push(toLines(tc.items.map((it) => ({ str: it.str, x: it.transform[4], y: it.transform[5] }))));
    }
    return parseRegisterLines(pages);
  }

  /** The same register saved as Excel (as in the template), or any sheet with admission number and name columns. */
  async function fromExcel(file) {
    const book = await Xlsx.open(await file.arrayBuffer());
    const rows = await book.rows(book.names[0]);
    const lines = rows.map((r) => ({ items: (r || []).map((v, x) => ({ str: v === undefined ? '' : String(v), x })).filter((i) => clean(i.str)) }));
    const head = rows.findIndex((r) => (r || []).some((v) => /admission/i.test(v)) && (r || []).some((v) => /name/i.test(v)));
    if (head === -1) throw new Error('Could not find the ADMISSION NO and NAMES columns in that sheet');
    const admCol = rows[head].findIndex((v) => /admission/i.test(v));
    const nameCol = rows[head].findIndex((v, i) => /name/i.test(v) && i !== admCol);
    const students = [], seen = new Set();
    for (const r of rows.slice(head + 1)) {
      const adm = clean(r?.[admCol]), name = clean(r?.[nameCol]);
      if (!isAdm(adm) || !name || seen.has(adm.toLowerCase())) continue;
      seen.add(adm.toLowerCase());
      students.push({ admNo: adm, name });
    }
    const top = lines.slice(0, head);
    let misClass = valueAfter(top, 'CLASS');
    const f = top.map((l) => l.items.map((i) => i.str).join(' ')).join('\n').match(/\{\s*Class:\s*([^}]+)\}/i);
    if (f) misClass = clean(f[1]) || misClass;
    return { misClass, duration: valueAfter(top, 'DURATION'), level: valueAfter(top, 'LEVEL'), students };
  }

  function fromCsv(text) {
    const rows = text.replace(/^﻿/, '').split(/\r?\n/).map((l) => l.split(',').map((c) => clean(c.replace(/^"|"$/g, ''))));
    const head = rows.findIndex((r) => r.some((v) => /adm/i.test(v)) && r.some((v) => /name/i.test(v)));
    if (head === -1) throw new Error('The CSV needs AdmNo and Name columns');
    const a = rows[head].findIndex((v) => /adm/i.test(v)), n = rows[head].findIndex((v, i) => /name/i.test(v) && i !== a);
    const students = rows.slice(head + 1).filter((r) => isAdm(r[a]) && r[n]).map((r) => ({ admNo: r[a], name: r[n] }));
    return { misClass: '', duration: '', level: '', students };
  }

  async function classList(file) {
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    let out;
    if (ext === 'pdf' || file.type === 'application/pdf') out = await fromPdf(file);
    else if (ext === 'xlsx' || ext === 'xlsm') out = await fromExcel(file);
    else out = fromCsv(await file.text());
    if (!out.students.length) throw new Error(`No students found in ${file.name}`);
    return { ...out, fileName: file.name };
  }

  /* ---------- loading workbook ---------- */
  const headerIndex = (rows, needed) => rows.findIndex((r) => r && needed.every((h) => (r || []).some((v) => norm(v) === h)));
  const colOf = (row, ...names) => { for (const n of names) { const i = row.findIndex((v) => norm(v) === n); if (i !== -1) return i; } return -1; };
  const metaAfter = (rows, label) => {
    for (const r of rows) {
      if (!r) continue;
      const i = r.findIndex((v) => norm(v) === label);
      if (i !== -1) { const v = r.slice(i + 1).find((x) => clean(x) !== ''); if (v !== undefined) return clean(v); }
    }
    return '';
  };

  async function loading(file) {
    const book = await Xlsx.open(await file.arrayBuffer());
    const loadName = book.find('Subject Loading');
    if (!loadName) throw new Error('This workbook has no "Subject Loading" tab');
    const L = await book.rows(loadName);
    const h = headerIndex(L, ['CLASS', 'SUBJECT CODE', 'TRAINER CODE']);
    if (h === -1) throw new Error('Could not find the CLASS, SUBJECT CODE and TRAINER CODE columns in Subject Loading');
    const H = L[h];
    const c = {
      cls: colOf(H, 'CLASS'), code: colOf(H, 'SUBJECT CODE'), name: colOf(H, 'SUBJECT NAME'),
      tcode: colOf(H, 'TRAINER CODE'), tname: colOf(H, 'TRAINER NAME'), lessons: colOf(H, 'LESSONS/WK', 'LESSONS PER WEEK'),
      hours: colOf(H, 'HRS/WK', 'HOURS/WK', 'HOURS PER WEEK'), pop: colOf(H, 'POPULATION'),
    };
    const subjects = {};
    const subName = book.find('List of Subject', 'List of Subjects');
    if (subName) {
      const S = await book.rows(subName);
      const sh = headerIndex(S, ['CODE', 'SUBJECT NAME']);
      if (sh !== -1) {
        const sc = colOf(S[sh], 'CODE'), sn = colOf(S[sh], 'SUBJECT NAME');
        for (const r of S.slice(sh + 1)) if (r && clean(r[sc])) subjects[norm(r[sc])] = clean(r[sn]);
      }
    }
    const rows = [];
    for (const r of L.slice(h + 1)) {
      if (!r) continue;
      const classCode = clean(r[c.cls]), unitCode = clean(r[c.code]), trainerCode = clean(r[c.tcode]);
      if (!classCode || !unitCode || !trainerCode) continue;
      rows.push({
        classCode, unitCode, unitName: clean(r[c.name]) || subjects[norm(unitCode)] || unitCode,
        trainerCode, trainerName: clean(r[c.tname]),
        lessonsPerWeek: Number(r[c.lessons]) || 2, hoursPerWeek: Number(r[c.hours]) || 3, population: Number(r[c.pop]) || '',
      });
    }
    const trainers = [];
    let meta = {};
    const trName = book.find('List of Trainers');
    if (trName) {
      const T = await book.rows(trName);
      const th = headerIndex(T, ['CODE', 'RESPONSIBILITY']);
      if (th !== -1) {
        const tc = colOf(T[th], 'CODE'), tn = colOf(T[th], 'TRAINERS NAME', "TRAINER'S NAME", 'TRAINER NAME', 'NAME'), tr = colOf(T[th], 'RESPONSIBILITY');
        for (const r of T.slice(th + 1)) if (r && clean(r[tc])) trainers.push({ code: clean(r[tc]), name: clean(r[tn]), responsibility: clean(r[tr]) });
      }
      meta = { department: metaAfter(T, 'DEPARTMENT'), term: metaAfter(T, 'TERM'), year: metaAfter(T, 'YEAR') };
    }
    if (!rows.length) throw new Error('No loading rows found in Subject Loading');
    return { rows, trainers, subjects: Object.keys(subjects).length, meta, fileName: file.name };
  }

  /**
   * Suggests which loading classes (streams) an MIS class list belongs to:
   * CSCL6-25-S-RS → CS, level 6, intake 25S → ICT L6CS-25SA / 25SB / 25SC.
   */
  function suggestStreams(misClass, classCodes) {
    const m = norm(misClass).match(/^([A-Z]+?)L(\d)-?(\d{2})-?([A-Z])/);
    if (!m) return classCodes.filter((c) => norm(c) === norm(misClass));
    let prog = m[1], level = m[2], year = m[3], intake = m[4];
    if (prog.endsWith('CS') || prog === 'CSC') prog = 'CS';
    const re = new RegExp(`L${level}${prog}-${year}${intake}(-?[A-Z])?$`);
    return classCodes.filter((c) => re.test(norm(c).replace(/\s+/g, ' ').split(' ').pop()));
  }

  return { classList, loading, suggestStreams, parseRegisterLines, toLines, isAdm };
})();

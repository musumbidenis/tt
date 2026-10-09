/* Small Excel helpers built on JSZip:
 *   Xlsx.open(data)          read the sheets of an .xlsx / .xlsm file (values only)
 *   Xlsx.registerFile(t, d)  fill the class register template (templates/class-register.xlsx)
 * The template keeps RVNP's layout exactly: crest, title block, 10 week blocks of 3 lessons,
 * Possible / Actual hours, the % formula, landscape A4 print setup and the comment rows. */
'use strict';

const Xlsx = (() => {
  const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const colNum = (letters) => [...letters].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
  const colName = (n) => { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };
  const parse = (xml) => new DOMParser().parseFromString(xml, 'application/xml');
  const serialize = (doc) => new XMLSerializer().serializeToString(doc);
  const norm = (s) => String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
  const kids = (el, tag) => [...el.childNodes].filter((n) => n.nodeType === 1 && n.localName === tag);

  /* ---------- reading ---------- */
  async function open(data) {
    const zip = await JSZip.loadAsync(data);
    const file = (p) => zip.file(p) || zip.file(p.replace(/^\//, ''));
    const wbFile = file('xl/workbook.xml');
    if (!wbFile) throw new Error('This is not an Excel workbook');
    const wb = parse(await wbFile.async('string'));
    const rels = parse(await file('xl/_rels/workbook.xml.rels').async('string'));
    const target = {};
    for (const r of rels.getElementsByTagName('Relationship')) target[r.getAttribute('Id')] = r.getAttribute('Target');
    const sheets = [...wb.getElementsByTagName('sheet')].map((s) => {
      const t = target[s.getAttribute('r:id')] || '';
      return { name: s.getAttribute('name'), path: t.startsWith('/') ? t.slice(1) : 'xl/' + t.replace(/^\.\//, '') };
    });
    let strings = [];
    const ssf = file('xl/sharedStrings.xml');
    if (ssf) {
      strings = [...parse(await ssf.async('string')).getElementsByTagName('si')]
        .map((si) => [...si.getElementsByTagName('t')].map((t) => t.textContent).join(''));
    }
    return {
      names: sheets.map((s) => s.name),
      /** Find a sheet by name, ignoring case, spaces and a trailing "s". */
      find(...wanted) {
        const key = (n) => norm(n).replace(/s$/, '');
        for (const w of wanted) { const s = sheets.find((x) => key(x.name) === key(w)); if (s) return s.name; }
        return null;
      },
      /** Rows of a sheet as arrays (index 0 = column A); strings and numbers as stored. */
      async rows(name) {
        const sh = sheets.find((s) => s.name === name);
        if (!sh) throw new Error(`No sheet called "${name}"`);
        const doc = parse(await file(sh.path).async('string'));
        const out = [];
        for (const row of doc.getElementsByTagName('row')) {
          const r = Number(row.getAttribute('r')) - 1;
          const vals = [];
          for (const c of kids(row, 'c')) {
            const ref = c.getAttribute('r') || '';
            const col = colNum(ref.replace(/\d+/g, '')) - 1;
            const t = c.getAttribute('t');
            const v = kids(c, 'v')[0]?.textContent ?? '';
            let val;
            if (t === 's') val = strings[Number(v)] ?? '';
            else if (t === 'inlineStr') val = [...c.getElementsByTagName('t')].map((x) => x.textContent).join('');
            else if (t === 'b') val = v === '1';
            else if (t === 'str' || t === 'e') val = v;
            else val = v === '' ? '' : Number(v);
            vals[col] = val;
          }
          out[r] = vals;
        }
        return out;
      },
    };
  }

  /* ---------- writing the class register ---------- */
  function setCell(doc, row, ref, value) {
    let c = kids(row, 'c').find((x) => x.getAttribute('r') === ref);
    if (!c) {
      c = doc.createElementNS(NS, 'c');
      c.setAttribute('r', ref);
      const n = colNum(ref.replace(/\d+/g, ''));
      const after = kids(row, 'c').find((x) => colNum(x.getAttribute('r').replace(/\d+/g, '')) > n);
      row.insertBefore(c, after || null);
    }
    while (c.firstChild) c.removeChild(c.firstChild);
    c.removeAttribute('t');
    if (value === null || value === undefined || value === '') return c;
    if (typeof value === 'object' && value.f) {
      const f = doc.createElementNS(NS, 'f'); f.textContent = value.f; c.appendChild(f);
      const v = doc.createElementNS(NS, 'v'); v.textContent = String(value.v); c.appendChild(v);
      if (typeof value.v !== 'number') c.setAttribute('t', 'str');
    } else if (typeof value === 'number') {
      const v = doc.createElementNS(NS, 'v'); v.textContent = String(value); c.appendChild(v);
    } else {
      c.setAttribute('t', 'inlineStr');
      const is = doc.createElementNS(NS, 'is');
      const t = doc.createElementNS(NS, 't');
      t.setAttributeNS('http://www.w3.org/XML/1998/namespace', 'xml:space', 'preserve');
      t.textContent = String(value);
      is.appendChild(t); c.appendChild(is);
    }
    return c;
  }
  function renumber(row, n) {
    row.setAttribute('r', String(n));
    for (const c of kids(row, 'c')) c.setAttribute('r', c.getAttribute('r').replace(/\d+$/, String(n)));
    return row;
  }
  const safeSheetName = (s) => String(s || 'Register').replace(/[[\]:*?/\\]/g, '-').slice(0, 31);
  const xmlEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  /**
   * d = { lecturer, duration, classLabel, level, subject, filter, weekLabels[10], sheetName,
   *       students: [{ admNo, name, cells: [30 × 'P'|'A'|'L'|'E'|''], possible, actual }],
   *       lecturerComment, hodComment }
   */
  async function registerFile(templateData, d) {
    const zip = await JSZip.loadAsync(templateData);
    const path = 'xl/worksheets/sheet1.xml';
    const doc = parse(await zip.file(path).async('string'));
    const sheetData = doc.getElementsByTagName('sheetData')[0];
    const byNum = {};
    for (const r of kids(sheetData, 'row')) byNum[r.getAttribute('r')] = r;
    const proto = { mid: byNum['9'], last: byNum['10'], lect: byNum['11'], hod: byNum['12'] };
    for (const k of ['9', '10', '11', '12']) sheetData.removeChild(byNum[k]);

    setCell(doc, byNum['2'], 'D2', d.lecturer || '');
    setCell(doc, byNum['2'], 'AB2', d.duration || '');
    setCell(doc, byNum['3'], 'D3', d.classLabel || '');
    setCell(doc, byNum['3'], 'AB3', d.level || '');
    setCell(doc, byNum['4'], 'D4', d.subject || '');
    setCell(doc, byNum['6'], 'A6', d.filter || '');
    for (let w = 0; w < 10; w++) setCell(doc, byNum['7'], colName(4 + w * 3) + '7', (d.weekLabels || [])[w] || `WK${w + 1}`);

    const list = d.students.length ? d.students : [{ admNo: '', name: '', cells: [], possible: '', actual: '' }];
    list.forEach((s, i) => {
      const r = 9 + i;
      const row = renumber((i === list.length - 1 ? proto.last : proto.mid).cloneNode(true), r);
      if (s.admNo) {
        setCell(doc, row, 'A' + r, i + 1);
        setCell(doc, row, 'B' + r, s.admNo);
        setCell(doc, row, 'C' + r, s.name + (s.pending ? ' (pending)' : ''));
        for (let k = 0; k < 30; k++) setCell(doc, row, colName(4 + k) + r, s.cells[k] || '');
        setCell(doc, row, 'AH' + r, s.possible);
        setCell(doc, row, 'AI' + r, s.actual);
      }
      const ratio = Number(s.possible) ? Number(s.actual) / Number(s.possible) : '-';
      setCell(doc, row, 'AJ' + r, { f: `IF(N(AH${r})=0,"-",AI${r}/AH${r})`, v: ratio });
      sheetData.appendChild(row);
    });
    const lr = 9 + list.length, hr = lr + 1;
    const lect = renumber(proto.lect.cloneNode(true), lr);
    setCell(doc, lect, 'D' + lr, d.lecturerComment || '');
    const hod = renumber(proto.hod.cloneNode(true), hr);
    setCell(doc, hod, 'D' + hr, d.hodComment || '');
    sheetData.appendChild(lect);
    sheetData.appendChild(hod);

    const merges = doc.getElementsByTagName('mergeCells')[0];
    for (const m of kids(merges, 'mergeCell')) {
      if (Number((m.getAttribute('ref').match(/\d+/) || ['0'])[0]) >= 9) merges.removeChild(m);
    }
    for (const ref of [`A${lr}:C${lr}`, `D${lr}:AJ${lr}`, `A${hr}:C${hr}`, `D${hr}:AJ${hr}`]) {
      const m = doc.createElementNS(NS, 'mergeCell'); m.setAttribute('ref', ref); merges.appendChild(m);
    }
    merges.setAttribute('count', String(kids(merges, 'mergeCell').length));
    doc.getElementsByTagName('dimension')[0]?.setAttribute('ref', `A1:AJ${hr}`);
    zip.file(path, serialize(doc));

    const name = safeSheetName(d.sheetName);
    const quoted = `'${name.replace(/'/g, "''")}'`;
    let wb = await zip.file('xl/workbook.xml').async('string');
    wb = wb.replace('name="Register"', `name="${xmlEsc(name)}"`).replace(/'Register'/g, xmlEsc(quoted)).replace('$A$1:$AJ$12', `$A$1:$AJ$${hr}`);
    zip.file('xl/workbook.xml', wb);
    const app = zip.file('docProps/app.xml');
    if (app) zip.file('docProps/app.xml', (await app.async('string')).replace('<vt:lpstr>Register</vt:lpstr>', `<vt:lpstr>${xmlEsc(name)}</vt:lpstr>`));
    return zip.generateAsync({ type: 'blob', mimeType: MIME, compression: 'DEFLATE' });
  }

  return { open, registerFile, colName, colNum };
})();

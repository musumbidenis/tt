/* Small Excel helpers built on JSZip:
 *   Xlsx.open(data)          read the sheets of an .xlsx / .xlsm file (values only)
 *   Xlsx.registerFile(t, d)  fill the class register template (templates/class-register.xlsx), with CAT weeks as one
 *                            merged column reading "CAT 1" upwards, and a CATs sheet when there are CATs
 *   Xlsx.marksheetFile(t, d) fill the continuous assessment marksheet (templates/marksheet.xlsx)
 * The template keeps RVNP's layout exactly: crest, title block, 12 week blocks of 3 lessons,
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
   *       students: [{ admNo, name, cells: [36 × 'P'|'A'|'L'|'E'|''], possible, actual }],
   *       lecturerComment, hodComment,
   *       cats: [{ w (0-11), label: 'CAT 1', date }], catSheet: TermReport.catTable() result or null }
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
    const cats = new Map((d.cats || []).map((c) => [c.w, c]));
    for (let w = 0; w < 12; w++) {
      const label = (d.weekLabels || [])[w] || `WK${w + 1}`;
      setCell(doc, byNum['7'], colName(4 + w * 3) + '7', cats.get(w)?.date ? `${label}\n${cats.get(w).date}` : label);
    }

    const list = d.students.length ? d.students : [{ admNo: '', name: '', cells: [], possible: '', actual: '' }];
    list.forEach((s, i) => {
      const r = 9 + i;
      const row = renumber((i === list.length - 1 ? proto.last : proto.mid).cloneNode(true), r);
      if (s.admNo) {
        setCell(doc, row, 'A' + r, i + 1);
        setCell(doc, row, 'B' + r, s.admNo);
        setCell(doc, row, 'C' + r, s.name + (s.pending ? ' (pending)' : ''));
        for (let k = 0; k < 36; k++) setCell(doc, row, colName(4 + k) + r, s.cells[k] || '');
        setCell(doc, row, 'AN' + r, s.possible);
        setCell(doc, row, 'AO' + r, s.actual);
      }
      const ratio = Number(s.possible) ? Number(s.actual) / Number(s.possible) : '-';
      setCell(doc, row, 'AP' + r, { f: `IF(N(AN${r})=0,"-",AO${r}/AN${r})`, v: ratio });
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
    const addMerge = (ref) => { const m = doc.createElementNS(NS, 'mergeCell'); m.setAttribute('ref', ref); merges.appendChild(m); };
    for (const ref of [`A${lr}:C${lr}`, `D${lr}:AP${lr}`, `A${hr}:C${hr}`, `D${hr}:AP${hr}`]) addMerge(ref);
    // A CAT week: its three columns, all the student rows, as one cell reading "CAT 1" upwards.
    if (d.students.length && cats.size) {
      const xf = await addStyle(zip, '<xf numFmtId="0" fontId="3" fillId="0" borderId="4" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" textRotation="90"/></xf>');
      const first = kids(sheetData, 'row').find((r) => r.getAttribute('r') === '9');
      for (const c of cats.values()) {
        const a = colName(4 + c.w * 3), b = colName(6 + c.w * 3);
        setCell(doc, first, a + '9', c.label).setAttribute('s', String(xf));
        addMerge(`${a}9:${b}${8 + d.students.length}`);
      }
    }
    merges.setAttribute('count', String(kids(merges, 'mergeCell').length));
    doc.getElementsByTagName('dimension')[0]?.setAttribute('ref', `A1:AP${hr}`);
    zip.file(path, serialize(doc));

    const name = safeSheetName(d.sheetName);
    const quoted = `'${name.replace(/'/g, "''")}'`;
    let wb = await zip.file('xl/workbook.xml').async('string');
    wb = wb.replace('name="Register"', `name="${xmlEsc(name)}"`).replace(/'Register'/g, xmlEsc(quoted)).replace('$A$1:$AP$12', `$A$1:$AP$${hr}`);
    zip.file('xl/workbook.xml', wb);
    const app = zip.file('docProps/app.xml');
    if (app) zip.file('docProps/app.xml', (await app.async('string')).replace('<vt:lpstr>Register</vt:lpstr>', `<vt:lpstr>${xmlEsc(name)}</vt:lpstr>`));
    if (d.catSheet?.cols.length) await addCatSheet(zip, d);
    return zip.generateAsync({ type: 'blob', mimeType: MIME, compression: 'DEFLATE' });
  }

  /** Adds a cell format to the workbook's styles and gives its index. */
  async function addStyle(zip, xfXml) {
    let st = await zip.file('xl/styles.xml').async('string');
    const m = /<cellXfs count="(\d+)">/.exec(st);
    const n = Number(m[1]);
    st = st.replace(m[0], `<cellXfs count="${n + 1}">`).replace('</cellXfs>', xfXml + '</cellXfs>');
    zip.file('xl/styles.xml', st);
    return n;
  }

  /** The CATs sheet: a column for each CAT and extra CAT attendance, its date, P / Ab / L / E per student, and totals. */
  async function addCatSheet(zip, d) {
    const cs = d.catSheet, X = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    // Template formats: 22 bold title, 17 bold boxed heading (wrapped), 10 boxed centred, 11 boxed left, 3 boxed left (bold row label).
    const cell = (ref, v, s) => (typeof v === 'number' ? `<c r="${ref}" s="${s}"><v>${v}</v></c>`
      : `<c r="${ref}" s="${s}" t="inlineStr"><is><t xml:space="preserve">${X(v)}</t></is></c>`);
    const last = colName(3 + cs.cols.length), rows = [];
    rows.push(`<row r="1" ht="21" customHeight="1">${cell('A1', `CAT ATTENDANCE · ${d.subject || ''}`, 22)}</row>`);
    rows.push(`<row r="2">${cell('A2', d.classLabel || '', 22)}</row>`);
    rows.push(`<row r="4" ht="45" customHeight="1">${cell('A4', '#', 17)}${cell('B4', 'ADMISSION NO', 17)}${cell('C4', 'NAMES', 17)}${cs.cols.map((c, k) => cell(colName(4 + k) + '4', `${c.label}\n${c.date}`, 17)).join('')}</row>`);
    cs.rows.forEach((r, i) => {
      const n = 5 + i;
      rows.push(`<row r="${n}">${cell('A' + n, i + 1, 10)}${cell('B' + n, r.admNo, 11)}${cell('C' + n, r.name, 11)}${r.vals.map((v, k) => cell(colName(4 + k) + n, v, 10)).join('')}</row>`);
    });
    const t0 = 5 + cs.rows.length;
    cs.totals.forEach((t, i) => {
      const n = t0 + i;
      rows.push(`<row r="${n}">${cell('A' + n, t.label, 3)}${cell('B' + n, '', 3)}${cell('C' + n, '', 3)}${t.vals.map((v, k) => cell(colName(4 + k) + n, v, 10)).join('')}</row>`);
    });
    const end = t0 + cs.totals.length - 1;
    const wide = cs.rows.some((r) => r.vals.some((v) => String(v).length > 4));
    const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="${NS}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">`
      + `<dimension ref="A1:${last}${end}"/><sheetViews><sheetView showGridLines="0" workbookViewId="0"><pane ySplit="4" topLeftCell="A5" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`
      + `<sheetFormatPr defaultRowHeight="18"/><cols><col min="1" max="1" width="5" customWidth="1"/><col min="2" max="2" width="22" customWidth="1"/><col min="3" max="3" width="34" customWidth="1"/>`
      + `<col min="4" max="${3 + cs.cols.length}" width="${wide ? 22 : 14}" customWidth="1"/></cols>`
      + `<sheetData>${rows.join('')}</sheetData>`
      + `<mergeCells count="${2 + cs.totals.length}"><mergeCell ref="A1:${last}1"/><mergeCell ref="A2:${last}2"/>${cs.totals.map((t, i) => `<mergeCell ref="A${t0 + i}:C${t0 + i}"/>`).join('')}</mergeCells>`
      + `<pageMargins left="0.4" right="0.4" top="0.5" bottom="0.5" header="0.3" footer="0.3"/><pageSetup paperSize="9" orientation="${cs.cols.length > 4 ? 'landscape' : 'portrait'}" fitToHeight="0"/></worksheet>`;
    zip.file('xl/worksheets/sheet2.xml', sheet);
    const ct = await zip.file('[Content_Types].xml').async('string');
    zip.file('[Content_Types].xml', ct.replace('</Types>', '<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'));
    const rels = await zip.file('xl/_rels/workbook.xml.rels').async('string');
    zip.file('xl/_rels/workbook.xml.rels', rels.replace('</Relationships>', '<Relationship Id="rIdCats" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/></Relationships>'));
    const wb = await zip.file('xl/workbook.xml').async('string');
    zip.file('xl/workbook.xml', wb.replace('</sheets>', '<sheet name="CATs" sheetId="2" r:id="rIdCats"/></sheets>'));
    const app = zip.file('docProps/app.xml');
    if (app) {
      zip.file('docProps/app.xml', (await app.async('string'))
        .replace('<vt:lpstr>Worksheets</vt:lpstr></vt:variant><vt:variant><vt:i4>1</vt:i4>', '<vt:lpstr>Worksheets</vt:lpstr></vt:variant><vt:variant><vt:i4>2</vt:i4>')
        .replace(/<TitlesOfParts><vt:vector size="(\d+)" baseType="lpstr">((?:<vt:lpstr>[^<]*<\/vt:lpstr>))/, (m, n, firstName) => `<TitlesOfParts><vt:vector size="${Number(n) + 1}" baseType="lpstr">${firstName}<vt:lpstr>CATs</vt:lpstr>`));
    }
  }

  /**
   * The RVNP continuous assessment marks sheet per unit of competency.
   * d = { courseCode, courseName, unitCode, unitTitle, series, sheetName,
   *       students: [{ regCode, admNo, name, cat: [3 × number|''], prac: [3 × number|''] }] }
   * AVG = sum ÷ 3 (a CAT not done counts as 0), as the department works it out.
   */
  async function marksheetFile(templateData, d) {
    const zip = await JSZip.loadAsync(templateData);
    const path = 'xl/worksheets/sheet1.xml';
    const doc = parse(await zip.file(path).async('string'));
    const sheetData = doc.getElementsByTagName('sheetData')[0];
    const byNum = {};
    for (const r of kids(sheetData, 'row')) byNum[r.getAttribute('r')] = r;
    const proto = byNum['16'];
    for (const r of kids(sheetData, 'row')) if (Number(r.getAttribute('r')) >= 16) sheetData.removeChild(r);
    setCell(doc, byNum['10'], 'C10', d.courseCode || '');
    setCell(doc, byNum['10'], 'G10', d.courseName || '');
    setCell(doc, byNum['11'], 'C11', d.unitCode || '');
    setCell(doc, byNum['11'], 'G11', d.unitTitle || '');
    setCell(doc, byNum['12'], 'C12', d.series || '');
    const avg = (xs) => (xs.some((x) => x !== '' && x != null) ? xs.reduce((n, x) => n + (Number(x) || 0), 0) / 3 : '');
    const list = d.students.length ? d.students : [{ admNo: '', name: '', cat: [], prac: [] }];
    list.forEach((s, i) => {
      const r = 16 + i, row = renumber(proto.cloneNode(true), r);
      if (s.admNo) {
        setCell(doc, row, 'A' + r, i + 1);
        setCell(doc, row, 'B' + r, s.regCode || '');
        setCell(doc, row, 'C' + r, s.admNo);
        setCell(doc, row, 'D' + r, s.name);
        ['E', 'F', 'G'].forEach((c, k) => setCell(doc, row, c + r, s.cat?.[k] ?? ''));
        ['I', 'J', 'K'].forEach((c, k) => setCell(doc, row, c + r, s.prac?.[k] ?? ''));
      }
      setCell(doc, row, 'H' + r, { f: `IF(COUNT(E${r}:G${r})=0,"",SUM(E${r}:G${r})/3)`, v: avg(s.cat || []) });
      setCell(doc, row, 'L' + r, { f: `IF(COUNT(I${r}:K${r})=0,"",SUM(I${r}:K${r})/3)`, v: avg(s.prac || []) });
      sheetData.appendChild(row);
    });
    const last = 15 + list.length, footRow = last + 2, end = footRow + 6;
    doc.getElementsByTagName('dimension')[0]?.setAttribute('ref', `A1:L${last}`);
    zip.file(path, serialize(doc));
    // The Prepared / Received / Approved block sits two rows under the last student.
    const dPath = 'xl/drawings/drawing1.xml', drawing = parse(await zip.file(dPath).async('string'));
    const anchors = [...drawing.documentElement.childNodes].filter((n) => n.nodeType === 1);
    const from = anchors[1] && [...anchors[1].childNodes].find((n) => n.localName === 'from');
    const rowEl = from && [...from.childNodes].find((n) => n.localName === 'row');
    if (rowEl) rowEl.textContent = String(footRow - 1);
    zip.file(dPath, serialize(drawing));
    const name = safeSheetName(d.sheetName || 'Marksheet');
    let wb = await zip.file('xl/workbook.xml').async('string');
    wb = wb.replace('name="Marksheet"', `name="${xmlEsc(name)}"`).replace(/'Marksheet'/g, xmlEsc(`'${name.replace(/'/g, "''")}'`)).replace('$A$1:$L$24', `$A$1:$L$${end}`);
    zip.file('xl/workbook.xml', wb);
    const app = zip.file('docProps/app.xml');
    if (app) zip.file('docProps/app.xml', (await app.async('string')).replace('<vt:lpstr>Marksheet</vt:lpstr>', `<vt:lpstr>${xmlEsc(name)}</vt:lpstr>`));
    return zip.generateAsync({ type: 'blob', mimeType: MIME, compression: 'DEFLATE' });
  }

  /* ---------- writing a plain table ---------- */
  /** A one-sheet workbook from a header row and rows of text or numbers. */
  async function simple(title, head, rows) {
    const xml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const cell = (v, r, c, style) => {
      const ref = colName(c + 1) + r;
      if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}"${style}><v>${v}</v></c>`;
      return `<c r="${ref}" t="inlineStr"${style}><is><t xml:space="preserve">${xml(v)}</t></is></c>`;
    };
    const all = [head, ...rows];
    const widths = head.map((_, c) => Math.min(60, Math.max(8, ...all.map((r) => String(r[c] ?? '').length)) + 2));
    const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="${NS}">`
      + `<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`
      + `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>`
      + `<sheetData>${all.map((r, i) => `<row r="${i + 1}">${r.map((v, c) => cell(v, i + 1, c, i === 0 ? ' s="1"' : '')).join('')}</row>`).join('')}</sheetData></worksheet>`;
    const name = String(title || 'Sheet').replace(/[^A-Za-z0-9 _.-]/g, ' ').trim().slice(0, 31) || 'Sheet';
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
      + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
      + '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
      + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>');
    zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>');
    zip.file('xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="${NS}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xml(name)}" sheetId="1" r:id="rId1"/></sheets></workbook>`);
    zip.file('xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
      + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>');
    zip.file('xl/styles.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="${NS}"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>`
      + '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
      + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>'
      + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>');
    zip.file('xl/worksheets/sheet1.xml', sheet);
    return zip.generateAsync({ type: 'blob', mimeType: MIME, compression: 'DEFLATE' });
  }

  return { open, registerFile, marksheetFile, simple, colName, colNum };
})();

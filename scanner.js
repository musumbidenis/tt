/* Document scanner for POE evidence, all on the phone (no internet needed):
 *   Scanner.load(file)            photo → canvas (no more than 3000 px on the long side, upright)
 *   Scanner.findCorners(canvas)   where the sheet of paper is: 4 points (top-left, top-right, bottom-right, bottom-left)
 *   Scanner.flatten(canvas, quad) straightens the sheet (perspective correction) → new canvas
 *   Scanner.filter(canvas, mode)  'document' (clean white page, crisp ink), 'grey' or 'colour'
 *   Scanner.pdf(pages)            JPEG pages → one PDF (Blob), one page per photo
 */
'use strict';

const Scanner = (() => {
  const MAX_SRC = 3000, MAX_OUT = 2000;

  async function load(file) {
    let bmp;
    try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
    catch {
      bmp = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('That photo could not be opened')); i.src = URL.createObjectURL(file); });
    }
    const w = bmp.width, h = bmp.height, k = Math.min(1, MAX_SRC / Math.max(w, h));
    const c = document.createElement('canvas');
    c.width = Math.round(w * k); c.height = Math.round(h * k);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    return c;
  }
  function rotate(canvas) {
    const c = document.createElement('canvas');
    c.width = canvas.height; c.height = canvas.width;
    const g = c.getContext('2d');
    g.translate(c.width, 0); g.rotate(Math.PI / 2); g.drawImage(canvas, 0, 0);
    return c;
  }

  /* ---------- finding the page: the biggest bright area, and its four extreme corners ---------- */
  function findCorners(canvas) {
    const k = Math.min(1, 360 / Math.max(canvas.width, canvas.height));
    const w = Math.max(8, Math.round(canvas.width * k)), h = Math.max(8, Math.round(canvas.height * k));
    const s = document.createElement('canvas'); s.width = w; s.height = h;
    const g = s.getContext('2d', { willReadFrequently: true });
    g.filter = 'blur(2px)'; g.drawImage(canvas, 0, 0, w, h);
    const px = g.getImageData(0, 0, w, h).data, gray = new Uint8Array(w * h), hist = new Uint32Array(256);
    for (let i = 0; i < w * h; i++) { const v = (px[i * 4] * 299 + px[i * 4 + 1] * 587 + px[i * 4 + 2] * 114) / 1000 | 0; gray[i] = v; hist[v]++; }
    // Otsu: the brightness that best separates paper from background
    let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
    let sumB = 0, wB = 0, best = 0, t = 128;
    for (let i = 0; i < 256; i++) {
      wB += hist[i]; if (!wB) continue;
      const wF = w * h - wB; if (!wF) break;
      sumB += i * hist[i];
      const mB = sumB / wB, mF = (sum - sumB) / wF, between = wB * wF * (mB - mF) ** 2;
      if (between > best) { best = between; t = i; }
    }
    // largest connected bright area
    const seen = new Uint8Array(w * h);
    let bestComp = null;
    const stack = new Int32Array(w * h);
    for (let start = 0; start < w * h; start++) {
      if (seen[start] || gray[start] <= t) continue;
      let top = 0, n = 0, tl = [0, 0, Infinity], tr = [0, 0, -Infinity], br = [0, 0, -Infinity], bl = [0, 0, Infinity];
      stack[top++] = start; seen[start] = 1;
      while (top) {
        const i = stack[--top], x = i % w, y = (i / w) | 0; n++;
        if (x + y < tl[2]) tl = [x, y, x + y];
        if (x + y > br[2]) br = [x, y, x + y];
        if (x - y > tr[2]) tr = [x, y, x - y];
        if (x - y < bl[2]) bl = [x, y, x - y];
        const nb = [i - 1, i + 1, i - w, i + w];
        if (x === 0) nb[0] = -1; if (x === w - 1) nb[1] = -1;
        for (const j of nb) if (j >= 0 && j < w * h && !seen[j] && gray[j] > t) { seen[j] = 1; stack[top++] = j; }
      }
      if (!bestComp || n > bestComp.n) bestComp = { n, pts: [tl, tr, br, bl] };
    }
    const area = bestComp ? bestComp.n / (w * h) : 0;
    if (!bestComp || area < 0.12 || area > 0.985) return defaultQuad(canvas);
    return bestComp.pts.map(([x, y]) => [x / k, y / k]);
  }
  const defaultQuad = (c) => { const mx = c.width * 0.04, my = c.height * 0.04; return [[mx, my], [c.width - mx, my], [c.width - mx, c.height - my], [mx, c.height - my]]; };

  /* ---------- straightening: maps the output rectangle onto the four corners ---------- */
  function homography(src, dst) {
    // solves for H with dst = H·src (8 unknowns, h33 = 1)
    const A = [], b = [];
    for (let i = 0; i < 4; i++) {
      const [x, y] = src[i], [u, v] = dst[i];
      A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
      A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
    }
    for (let c = 0; c < 8; c++) {
      let p = c; for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
      [A[c], A[p]] = [A[p], A[c]]; [b[c], b[p]] = [b[p], b[c]];
      for (let r = 0; r < 8; r++) {
        if (r === c) continue;
        const f = A[r][c] / A[c][c];
        for (let k = c; k < 8; k++) A[r][k] -= f * A[c][k];
        b[r] -= f * b[c];
      }
    }
    return b.map((v, i) => v / A[i][i]).concat(1);
  }
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  function flatten(canvas, quad) {
    const [tl, tr, br, bl] = quad;
    let W = Math.max(dist(tl, tr), dist(bl, br)), H = Math.max(dist(tl, bl), dist(tr, br));
    const k = Math.min(1, MAX_OUT / Math.max(W, H)); W = Math.max(16, Math.round(W * k)); H = Math.max(16, Math.round(H * k));
    const m = homography([[0, 0], [W, 0], [W, H], [0, H]], quad);
    const src = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height);
    const sw = src.width, sh = src.height, sp = src.data;
    const out = document.createElement('canvas'); out.width = W; out.height = H;
    const g = out.getContext('2d'), od = g.createImageData(W, H), op = od.data;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const d = m[6] * x + m[7] * y + 1;
        let sx = (m[0] * x + m[1] * y + m[2]) / d, sy = (m[3] * x + m[4] * y + m[5]) / d;
        if (sx < 0) sx = 0; else if (sx > sw - 1.001) sx = sw - 1.001;
        if (sy < 0) sy = 0; else if (sy > sh - 1.001) sy = sh - 1.001;
        const x0 = sx | 0, y0 = sy | 0, fx = sx - x0, fy = sy - y0, i = (y0 * sw + x0) * 4, o = (y * W + x) * 4;
        for (let c = 0; c < 3; c++) {
          const a = sp[i + c] + (sp[i + 4 + c] - sp[i + c]) * fx, b2 = sp[i + sw * 4 + c] + (sp[i + sw * 4 + 4 + c] - sp[i + sw * 4 + c]) * fx;
          op[o + c] = a + (b2 - a) * fy;
        }
        op[o + 3] = 255;
      }
    }
    g.putImageData(od, 0, 0);
    return out;
  }

  /* ---------- filters ---------- */
  function filter(canvas, mode) {
    if (mode === 'colour') return canvas;
    const W = canvas.width, H = canvas.height;
    const out = document.createElement('canvas'); out.width = W; out.height = H;
    const g = out.getContext('2d', { willReadFrequently: true });
    g.drawImage(canvas, 0, 0);
    const im = g.getImageData(0, 0, W, H), p = im.data;
    if (mode === 'grey') {
      for (let i = 0; i < p.length; i += 4) { const v = (p[i] * 299 + p[i + 1] * 587 + p[i + 2] * 114) / 1000; p[i] = p[i + 1] = p[i + 2] = v; }
      g.putImageData(im, 0, 0); return out;
    }
    // 'document': divide by the page's own lighting (a heavily blurred copy), so shadows go and the paper turns white
    const s = document.createElement('canvas'); s.width = Math.max(4, W >> 4); s.height = Math.max(4, H >> 4);
    const sg = s.getContext('2d'); sg.filter = 'blur(3px)'; sg.drawImage(canvas, 0, 0, s.width, s.height);
    const bgC = document.createElement('canvas'); bgC.width = W; bgC.height = H;
    const bg = bgC.getContext('2d', { willReadFrequently: true }); bg.imageSmoothingQuality = 'high'; bg.drawImage(s, 0, 0, W, H);
    const bp = bg.getImageData(0, 0, W, H).data;
    for (let i = 0; i < p.length; i += 4) {
      const v = (p[i] * 299 + p[i + 1] * 587 + p[i + 2] * 114) / 1000;
      const b = Math.max(40, (bp[i] * 299 + bp[i + 1] * 587 + bp[i + 2] * 114) / 1000);
      let r = (v / b) * 255;
      r = r > 235 ? 255 : r < 40 ? 0 : Math.pow(r / 255, 1.6) * 255; // white paper, dark ink
      p[i] = p[i + 1] = p[i + 2] = r;
    }
    g.putImageData(im, 0, 0);
    return out;
  }
  const toJpeg = (canvas, q = 0.72) => new Promise((res) => canvas.toBlob(res, 'image/jpeg', q));

  /* ---------- a small PDF writer: one JPEG per page, A4 width ---------- */
  async function pdf(pages) {
    const enc = new TextEncoder(), parts = [], offsets = [];
    let len = 0;
    const put = (x) => { const b = typeof x === 'string' ? enc.encode(x) : x; parts.push(b); len += b.length; };
    const obj = (n, body) => { offsets[n] = len; put(`${n} 0 obj\n`); body(); put('\nendobj\n'); };
    put('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
    const n = pages.length, kids = [];
    for (let i = 0; i < n; i++) kids.push(`${3 + i * 3} 0 R`);
    obj(1, () => put('<< /Type /Catalog /Pages 2 0 R >>'));
    obj(2, () => put(`<< /Type /Pages /Count ${n} /Kids [${kids.join(' ')}] >>`));
    for (let i = 0; i < n; i++) {
      const { jpeg, width, height } = pages[i];
      const bytes = new Uint8Array(await jpeg.arrayBuffer());
      const pw = 595.28, ph = Math.round((pw * height / width) * 100) / 100;
      const page = 3 + i * 3, img = page + 1, content = page + 2;
      obj(page, () => put(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] /Resources << /XObject << /Im${i} ${img} 0 R >> >> /Contents ${content} 0 R >>`));
      obj(img, () => { put(`<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${bytes.length} >>\nstream\n`); put(bytes); put('\nendstream'); });
      const cs = `q ${pw} 0 0 ${ph} 0 0 cm /Im${i} Do Q`;
      obj(content, () => put(`<< /Length ${cs.length} >>\nstream\n${cs}\nendstream`));
    }
    const xref = len, total = 3 + n * 3;
    put(`xref\n0 ${total}\n0000000000 65535 f \n`);
    for (let i = 1; i < total; i++) put(String(offsets[i]).padStart(10, '0') + ' 00000 n \n');
    put(`trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
    return new Blob(parts, { type: 'application/pdf' });
  }

  return { load, rotate, findCorners, defaultQuad, flatten, filter, toJpeg, pdf };
})();

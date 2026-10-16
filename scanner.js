/* Document scanner for POE evidence, all on the phone (no internet needed):
 *   Scanner.load(file)            photo → canvas (no more than 4000 px on the long side, upright)
 *   Scanner.findCorners(canvas)   where the sheet of paper is: 4 points (top-left, top-right, bottom-right, bottom-left)
 *   Scanner.flatten(canvas, quad) straightens the sheet (perspective correction) → new canvas
 *   Scanner.filter(canvas, mode)  'document' (clean white page, crisp ink), 'grey' or 'colour'
 *   Scanner.page(canvas)          a filtered page ready for the PDF: high-quality JPEG
 *   Scanner.pdf(pages)            pages → one PDF (Blob), one page per photo
 */
'use strict';

const Scanner = (() => {
  // Phones run out of memory with camera-sized images (a 12 MP photo is about 48 MB once decoded) and then the
  // browser closes the page. So photos are decoded already shrunk, and pages are kept at about A4 at 200 dpi.
  // The page is kept at up to 3000 px (A4 at about 255 dpi): sharp enough for small handwriting and pencil.
  const MAX_SRC = 4000, MAX_OUT = 3000;

  /** A JPEG's width and height from its header (and whether its EXIF turns it on its side), without decoding it. */
  async function jpegSize(file) {
    try {
      const b = new Uint8Array(await file.slice(0, 256 * 1024).arrayBuffer());
      if (b[0] !== 0xFF || b[1] !== 0xD8) return null;
      let i = 2, turned = false;
      while (i + 9 < b.length) {
        if (b[i] !== 0xFF) { i++; continue; }
        const m = b[i + 1], len = (b[i + 2] << 8) | b[i + 3];
        if (m === 0xD8 || m === 0x01 || (m >= 0xD0 && m <= 0xD7) || m === 0xFF) { i += m === 0xFF ? 1 : 2; continue; }
        if (m === 0xE1 && b[i + 4] === 0x45 && b[i + 5] === 0x78 && b[i + 6] === 0x69 && b[i + 7] === 0x66) {   // "Exif"
          const t = i + 10, le = b[t] === 0x49;
          const u16 = (o) => (le ? b[o] | (b[o + 1] << 8) : (b[o] << 8) | b[o + 1]);
          const u32 = (o) => (le ? (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) : ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3])) >>> 0;
          const ifd = t + u32(t + 4), n = ifd + 2 <= b.length ? u16(ifd) : 0;
          for (let e = 0; e < n; e++) {
            const p = ifd + 2 + e * 12;
            if (p + 10 > b.length) break;
            if (u16(p) === 0x0112) { turned = u16(p + 8) >= 5; break; }   // orientations 5–8 are on their side
          }
        }
        if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) {
          const h = (b[i + 5] << 8) | b[i + 6], w = (b[i + 7] << 8) | b[i + 8];
          return w && h ? (turned ? { w: h, h: w } : { w, h }) : null;
        }
        i += 2 + len;
      }
    } catch { /* not readable: decoded the ordinary way */ }
    return null;
  }

  async function load(file) {
    let bmp = null, img = null, url = '';
    const size = await jpegSize(file);
    try {
      // Only the width is given, so the shape is kept whichever way the browser applies the EXIF turn.
      bmp = size && Math.max(size.w, size.h) > MAX_SRC
        ? await createImageBitmap(file, { imageOrientation: 'from-image', resizeWidth: Math.round(size.w * (MAX_SRC / Math.max(size.w, size.h))), resizeQuality: 'high' })
        : await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch { bmp = null; }
    if (!bmp) {
      url = URL.createObjectURL(file);
      img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('That photo could not be opened')); i.src = url; });
    }
    const pic = bmp || img, w = pic.width, h = pic.height, k = Math.min(1, MAX_SRC / Math.max(w, h));
    const c = document.createElement('canvas');
    c.width = Math.round(w * k); c.height = Math.round(h * k);
    c.getContext('2d').drawImage(pic, 0, 0, c.width, c.height);
    bmp?.close?.();                         // let the decoded photo go at once
    if (url) URL.revokeObjectURL(url);
    return c;
  }
  /** Gives a canvas's memory back straight away instead of waiting for the browser to tidy up. */
  const release = (c) => { if (c) { c.width = 0; c.height = 0; } };
  /** A small copy of a page for the list of pages. */
  function thumb(canvas, size = 320) {
    const k = Math.min(1, size / Math.max(canvas.width, canvas.height));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(canvas.width * k)); c.height = Math.max(1, Math.round(canvas.height * k));
    c.getContext('2d').drawImage(canvas, 0, 0, c.width, c.height);
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
  /** The size the straightened page will have. */
  function outSize(quad) {
    const [tl, tr, br, bl] = quad;
    let W = Math.max(dist(tl, tr), dist(bl, br)), H = Math.max(dist(tl, bl), dist(tr, br));
    const k = Math.min(1, MAX_OUT / Math.max(W, H));
    return { w: Math.max(16, Math.round(W * k)), h: Math.max(16, Math.round(H * k)) };
  }
  function flatten(canvas, quad) {
    const { w: W, h: H } = outSize(quad);
    const m = homography([[0, 0], [W, 0], [W, H], [0, H]], quad);
    const xs = quad.map((p) => p[0]), ys = quad.map((p) => p[1]);
    const bx = Math.max(0, Math.floor(Math.min(...xs)) - 1), by = Math.max(0, Math.floor(Math.min(...ys)) - 1);
    const bw = Math.max(2, Math.min(canvas.width, Math.ceil(Math.max(...xs)) + 2) - bx), bh = Math.max(2, Math.min(canvas.height, Math.ceil(Math.max(...ys)) + 2) - by);
    const src = canvas.getContext('2d', { willReadFrequently: true }).getImageData(bx, by, bw, bh);
    const sw = src.width, sh = src.height, sp = src.data;
    const out = document.createElement('canvas'); out.width = W; out.height = H;
    const g = out.getContext('2d'), od = g.createImageData(W, H), op = od.data;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const d = m[6] * x + m[7] * y + 1;
        let sx = (m[0] * x + m[1] * y + m[2]) / d - bx, sy = (m[3] * x + m[4] * y + m[5]) / d - by;
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
    // 'document': each colour divided by the page's own lighting (a heavily blurred copy), so shadows and the paper's tint
    // go and the paper turns white while ink keeps its colour (the trainer's red marking stays red); faint strokes are
    // darkened, then lightly sharpened (unsharp mask) so writing from a phone camera comes out crisp
    const s = document.createElement('canvas'); s.width = Math.max(4, W >> 4); s.height = Math.max(4, H >> 4);
    const sg = s.getContext('2d'); sg.filter = 'blur(3px)'; sg.drawImage(canvas, 0, 0, s.width, s.height);
    const bgC = document.createElement('canvas'); bgC.width = W; bgC.height = H;
    const bg = bgC.getContext('2d', { willReadFrequently: true }); bg.imageSmoothingQuality = 'high'; bg.drawImage(s, 0, 0, W, H);
    const bp = bg.getImageData(0, 0, W, H).data;
    const curve = (x) => 255 * Math.pow(Math.min(1, x / 255), 1.6);
    for (let i = 0; i < p.length; i += 4) {
      const r = (p[i] / Math.max(40, bp[i])) * 255, gr = (p[i + 1] / Math.max(40, bp[i + 1])) * 255, bl = (p[i + 2] / Math.max(40, bp[i + 2])) * 255;
      if ((r * 299 + gr * 587 + bl * 114) / 1000 > 236) { p[i] = p[i + 1] = p[i + 2] = 255; continue; }   // paper
      p[i] = curve(r); p[i + 1] = curve(gr); p[i + 2] = curve(bl);
    }
    g.putImageData(im, 0, 0);
    bgC.width = 0; bgC.height = 0; s.width = 0; s.height = 0;   // give the working copies back at once
    const blC = document.createElement('canvas'); blC.width = W; blC.height = H;
    const bl = blC.getContext('2d', { willReadFrequently: true }); bl.filter = `blur(${Math.max(1.2, 1.2 * Math.max(W, H) / 2400).toFixed(2)}px)`; bl.drawImage(out, 0, 0);   // blur radius scales with the resolution
    const bd = bl.getImageData(0, 0, W, H).data;
    blC.width = 0; blC.height = 0;
    for (let i = 0; i < p.length; i += 4) {
      if (p[i] === 255 && p[i + 1] === 255 && p[i + 2] === 255 && bd[i] > 250) continue;
      for (let k = 0; k < 3; k++) { const v = p[i + k] + 0.8 * (p[i + k] - bd[i + k]); p[i + k] = v > 255 ? 255 : v < 0 ? 0 : v; }
      if (p[i] > 246 && p[i + 1] > 246 && p[i + 2] > 246) p[i] = p[i + 1] = p[i + 2] = 255;
    }
    g.putImageData(im, 0, 0);
    return out;
  }
  const toJpeg = (canvas, q = 0.72) => new Promise((res) => canvas.toBlob(res, 'image/jpeg', q));

  /* ---------- a page for the PDF: high quality ---------- */
  // A page is kept like a scanner's colour document setting: white paper, ink in its own colour, smooth strokes, pencil
  // and shading kept. JPEG quality 0.92, lowered only for a very busy page, never below 0.82.
  // The original photo kept: JPEG 0.95, stepped down to no lower than 0.8 to fit 2 MB; only if still too big is it made
  // a little smaller (never below 2000 px on the long side).
  const PAGE_BUDGET = 2 * 1024 * 1024;
  async function page(canvas) {
    let c = canvas, q = 0.95, jpeg = await toJpeg(c, q);
    while (jpeg.size > PAGE_BUDGET && q > 0.8) { q = Math.round((q - 0.03) * 100) / 100; jpeg = await toJpeg(c, q); }
    while (jpeg.size > PAGE_BUDGET && Math.max(c.width, c.height) > 2000) {
      const k = 0.85, n = document.createElement('canvas');
      n.width = Math.round(c.width * k); n.height = Math.round(c.height * k);
      const g = n.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(c, 0, 0, n.width, n.height);
      if (c !== canvas) release(c);
      c = n; jpeg = await toJpeg(c, q);
    }
    const out = { width: c.width, height: c.height, jpeg };
    if (c !== canvas) release(c);
    return out;
  }

  /* ---------- a small PDF writer: one image per page (JPEG, or 1-bit deflated), A4 width ---------- */
  async function pdf(pages, { landscape = false } = {}) {
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
      const { jpeg, bits, width, height } = pages[i];
      const bytes = bits || new Uint8Array(await jpeg.arrayBuffer());
      const kind = bits ? '/ColorSpace /DeviceGray /BitsPerComponent 1 /Filter /FlateDecode' : '/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode';
      // A4 width (portrait), or A4 landscape's width for a page made landscape (HtmlPdf).
      const pw = landscape ? 841.89 : 595.28, ph = Math.round((pw * height / width) * 100) / 100;
      const page = 3 + i * 3, img = page + 1, content = page + 2;
      obj(page, () => put(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] /Resources << /XObject << /Im${i} ${img} 0 R >> >> /Contents ${content} 0 R >>`));
      obj(img, () => { put(`<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} ${kind} /Length ${bytes.length} >>\nstream\n`); put(bytes); put('\nendstream'); });
      const cs = `q ${pw} 0 0 ${ph} 0 0 cm /Im${i} Do Q`;
      obj(content, () => put(`<< /Length ${cs.length} >>\nstream\n${cs}\nendstream`));
    }
    const xref = len, total = 3 + n * 3;
    put(`xref\n0 ${total}\n0000000000 65535 f \n`);
    for (let i = 1; i < total; i++) put(String(offsets[i]).padStart(10, '0') + ' 00000 n \n');
    put(`trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
    return new Blob(parts, { type: 'application/pdf' });
  }

  return { load, rotate, findCorners, defaultQuad, outSize, flatten, filter, toJpeg, page, pdf, release, thumb };
})();

/* A PDF from a printable page, made on this device (offline too, nothing sent anywhere): the page is laid out with the
 * app's print styles at A4 size, each printed page is drawn as a picture, and the pictures go into a PDF.
 *   HtmlPdf.make(html, { landscape }) → Blob (application/pdf)
 * A new page starts wherever the print styles start one (break-before: page), as Print / Save as PDF does.
 * Uses Scanner.page / Scanner.pdf (scanner.js) for the PDF itself. */
'use strict';

const HtmlPdf = (() => {
  const MM = 96 / 25.4, SCALE = 2;              // CSS px per mm; pictures drawn at twice screen size (about 190 dpi)
  let cssText = null;
  const images = new Map();

  /** The rules inside the stylesheet's @media print blocks (not @page), each scoped to the PDF's box. */
  async function printCss() {
    if (cssText !== null) return cssText;
    const all = await (await fetch('styles.css')).text();
    let out = '', i = 0;
    while ((i = all.indexOf('@media print', i)) !== -1) {
      const open = all.indexOf('{', i);
      let depth = 1, j = open + 1;
      for (; j < all.length && depth; j++) { if (all[j] === '{') depth++; else if (all[j] === '}') depth--; }
      out += all.slice(open + 1, j - 1) + '\n';
      i = j;
    }
    out = out.replace(/@page\s*\{[^}]*\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    // Scope every selector to .pdf-host so nothing on the screen changes while the PDF is made.
    cssText = out.replace(/([^{}]+)\{([^{}]*)\}/g, (m, sel, body) => {
      const s = sel.trim(); if (!s || s.startsWith('@')) return m;
      // Rules for the page around the printout (body.printing …, html, *) are left out: they would hide or reshape it.
      const keep = s.split(',').map((x) => x.trim()).filter((x) => x && !/^(body|html|\*|:root)\b/.test(x));
      return keep.length ? keep.map((x) => `.pdf-host ${x}`).join(', ') + `{${body}}` : '';
    });
    return cssText;
  }
  /** Pictures inside a page must be part of it (data: addresses) to be drawn. */
  async function dataUrl(src) {
    if (images.has(src)) return images.get(src);
    const b = await (await fetch(src)).blob();
    const url = await new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(b); });
    images.set(src, url);
    return url;
  }

  /** The blocks of the page in order: the children of the print containers, each with the container it sits in. */
  function blocks(host) {
    const out = [];
    const walk = (el, chain) => {
      for (const c of el.children) {
        if (c.matches('.reg-print, .rp-cats, .ms-print, .ms-page, .tbl-print')) walk(c, [...chain, c]);
        else out.push({ el: c, chain, brk: getComputedStyle(c).breakBefore === 'page' || chain.some((a) => a.firstElementChild === c && getComputedStyle(a).breakBefore === 'page') });
      }
    };
    walk(host, []);
    return out;
  }

  async function make(html, { landscape = true } = {}) {
    const css = await printCss();
    const W = Math.round((landscape ? 297 : 210) * MM), H = Math.round((landscape ? 210 : 297) * MM), pad = Math.round(10 * MM);
    const host = document.createElement('div');
    host.className = 'pdf-host';
    host.style.cssText = `position:fixed;left:-20000px;top:0;width:${W - 2 * pad}px;background:#fff;color:#000`;
    host.innerHTML = `<style>${css}</style>${html}`;
    document.body.appendChild(host);
    try {
      for (const img of host.querySelectorAll('img')) img.setAttribute('src', await dataUrl(img.getAttribute('src')));
      // Pages: a block that starts a page, or one that would run past the bottom, begins the next.
      const list = blocks(host), pages = [];
      let cur = null, used = 0;
      for (const b of list) {
        const h = b.el.getBoundingClientRect().height + 8;
        if (!cur || b.brk || used + h > H - 2 * pad) { cur = []; pages.push(cur); used = 0; }
        cur.push(b); used += h;
      }
      const out = [];
      for (const page of pages) {
        // Rebuild the page with its blocks inside copies of their containers (so their styles still apply).
        const box = document.createElement('div');
        for (const b of page) {
          let parent = box;
          for (const a of b.chain) {
            let copy = [...parent.children].find((x) => x.__from === a);
            if (!copy) { copy = a.cloneNode(false); copy.__from = a; copy.style.breakBefore = 'auto'; parent.appendChild(copy); }
            parent = copy;
          }
          const c = b.el.cloneNode(true); c.style.breakBefore = 'auto'; parent.appendChild(c);
        }
        out.push(await draw(box, css, W, H, pad));
      }
      return Scanner.pdf(out, { landscape });
    } finally { host.remove(); }
  }
  async function draw(box, css, W, H, pad) {
    const xml = new XMLSerializer().serializeToString(box);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><foreignObject x="0" y="0" width="${W}" height="${H}">`
      + `<div xmlns="http://www.w3.org/1999/xhtml" class="pdf-host" style="box-sizing:border-box;width:${W}px;height:${H}px;padding:${pad}px;background:#fff;color:#000;overflow:hidden">`
      + `<style>${css.replace(/</g, '\\3c ')}</style>${xml}</div></foreignObject></svg>`;
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('The page could not be drawn')); img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg); });
    const c = document.createElement('canvas');
    c.width = W * SCALE; c.height = H * SCALE;
    const g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
    g.drawImage(img, 0, 0, c.width, c.height);
    return Scanner.page(c);
  }
  return { make };
})();
window.HtmlPdf = HtmlPdf;

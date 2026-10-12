'use strict';
/* shareimg.js — Imágenes legibles del catálogo para enviar por WhatsApp.
   En lugar de UNA imagen gigantesca (que se reduce y se pixela), se genera una colección:
   una o varias imágenes por categoría, todas del mismo ancho (1080 px) y con letra grande.
   Cada imagen mide como máximo ~2000 px de alto; si una categoría no cabe, se divide en
   imágenes numeradas («1/3», «2/3»…). Solo contiene texto: nunca fotos de productos. */
(function () {
  const W = 1080, PAD = 48, MAX_H = 2000;
  const FONT = '"Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
  const NAME_FS = 40, DETAIL_FS = 30, LINE = 50, DLINE = 38;

  function wrap(ctx, text, maxW) {
    const words = String(text).split(/\s+/).filter(Boolean);
    const lines = [];
    let cur = '';
    for (const w of words) {
      const t = cur ? `${cur} ${w}` : w;
      if (ctx.measureText(t).width <= maxW || !cur) cur = t; else { lines.push(cur); cur = w; }
    }
    if (cur) lines.push(cur);
    return lines.length ? lines : [''];
  }

  /* structure: [{ catId, catName, subName, rows:[{ name, detail, qty, price }] }] (ya ordenado)
     opts: { showQty, showPrice, subtitle } */
  async function render(structure, opts) {
    const o = opts || {};
    const measure = document.createElement('canvas').getContext('2d');
    const qW = o.showQty ? 250 : 0;
    const pW = o.showPrice ? 220 : 0;
    const nameW = W - PAD * 2 - qW - pW - (qW || pW ? 20 : 0);

    // 1) Agrupar por categoría y medir cada fila
    const cats = [];
    for (const g of structure) {
      let cat = cats[cats.length - 1];
      if (!cat || cat.id !== g.catId) { cat = { id: g.catId, name: g.catName, items: [] }; cats.push(cat); }
      if (g.subName) cat.items.push({ band: g.subName });
      for (const r of g.rows) {
        measure.font = `600 ${NAME_FS}px ${FONT}`;
        const nl = wrap(measure, r.name, nameW);
        measure.font = `${DETAIL_FS}px ${FONT}`;
        const dl = r.detail ? wrap(measure, r.detail, nameW).slice(0, 2) : [];
        cat.items.push({ row: r, nl, dl, h: nl.length * LINE + dl.length * DLINE + 26 });
      }
    }

    // 2) Repartir en páginas por altura
    const HEAD_H = 190, FOOT_H = 70, BAND_H = 70;
    const pages = [];
    for (const cat of cats) {
      let cur = null;
      let lastBand = null;
      const open = () => { cur = { cat, items: [], h: HEAD_H + FOOT_H }; pages.push(cur); };
      open();
      for (const it of cat.items) {
        if (it.band) { lastBand = it.band; continue; }
        const needBand = lastBand && !cur.items.some((x) => x.band === lastBand);
        const need = it.h + (needBand ? BAND_H : 0);
        if (cur.h + need > MAX_H && cur.items.length) { open(); }
        if (lastBand && !cur.items.some((x) => x.band === lastBand)) { cur.items.push({ band: lastBand }); cur.h += BAND_H; }
        cur.items.push(it); cur.h += it.h;
      }
    }
    const perCat = new Map();
    pages.forEach((p) => perCat.set(p.cat.id, (perCat.get(p.cat.id) || 0) + 1));
    const seen = new Map();

    // 3) Dibujar
    const out = [];
    for (const pg of pages) {
      const n = (seen.get(pg.cat.id) || 0) + 1;
      seen.set(pg.cat.id, n);
      const total = perCat.get(pg.cat.id);
      const cv = document.createElement('canvas');
      cv.width = W; cv.height = pg.h + 20;
      const ctx = cv.getContext('2d');
      ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, W, cv.height);
      ctx.fillStyle = '#0f766e'; ctx.fillRect(0, 0, W, 14);
      let y = 40;
      ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
      ctx.fillStyle = '#0f172a'; ctx.font = `800 56px ${FONT}`;
      const title = total > 1 ? `${pg.cat.name} (${n}/${total})` : pg.cat.name;
      wrap(ctx, title, W - PAD * 2).slice(0, 2).forEach((ln, i) => { ctx.fillText(ln, PAD, y + 56 + i * 62); });
      y = 40 + 62 + 10;
      ctx.fillStyle = '#475569'; ctx.font = `${DETAIL_FS}px ${FONT}`;
      ctx.fillText(o.subtitle || '', PAD, y + 36);
      y = HEAD_H - 24;
      if (o.showQty || o.showPrice) {
        ctx.fillStyle = '#64748b'; ctx.font = `700 26px ${FONT}`; ctx.textAlign = 'right';
        if (o.showPrice) ctx.fillText('PRECIO', W - PAD, y);
        if (o.showQty) ctx.fillText('EXISTENCIA', W - PAD - pW, y);
        ctx.textAlign = 'left';
      }
      ctx.strokeStyle = '#0f766e'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(PAD, HEAD_H - 10); ctx.lineTo(W - PAD, HEAD_H - 10); ctx.stroke();
      y = HEAD_H;
      let stripe = false;
      for (const it of pg.items) {
        if (it.band) {
          ctx.fillStyle = '#d6f2ed'; ctx.fillRect(PAD - 14, y + 8, W - PAD * 2 + 28, BAND_H - 14);
          ctx.fillStyle = '#0f4f49'; ctx.font = `800 34px ${FONT}`; ctx.textAlign = 'left';
          ctx.fillText(it.band.toLocaleUpperCase('es'), PAD, y + 50);
          y += BAND_H; stripe = false; continue;
        }
        if (stripe) { ctx.fillStyle = '#f1f5f9'; ctx.fillRect(PAD - 14, y, W - PAD * 2 + 28, it.h); }
        stripe = !stripe;
        ctx.textAlign = 'left';
        let ty = y + 13;
        ctx.fillStyle = '#0f172a'; ctx.font = `600 ${NAME_FS}px ${FONT}`;
        it.nl.forEach((ln) => { ty += LINE; ctx.fillText(ln, PAD, ty - 12); });
        ctx.fillStyle = '#64748b'; ctx.font = `${DETAIL_FS}px ${FONT}`;
        it.dl.forEach((ln) => { ty += DLINE; ctx.fillText(ln, PAD, ty - 10); });
        ctx.textAlign = 'right'; ctx.fillStyle = '#0f172a'; ctx.font = `600 ${NAME_FS - 4}px ${FONT}`;
        const by = y + 13 + LINE - 12;
        if (o.showPrice) { ctx.fillStyle = it.row.price ? '#0f172a' : '#94a3b8'; ctx.fillText(it.row.price || '—', W - PAD, by); }
        if (o.showQty) { ctx.fillStyle = '#0f172a'; ctx.fillText(it.row.qty || '—', W - PAD - pW, by); }
        y += it.h;
      }
      ctx.textAlign = 'left'; ctx.fillStyle = '#94a3b8'; ctx.font = `${24}px ${FONT}`;
      ctx.fillText(`Imagen ${out.length + 1} de ${pages.length}`, PAD, cv.height - 22);
      const blob = await new Promise((res, rej) => cv.toBlob((b) => (b ? res(b) : rej(new Error('No se pudo crear la imagen.'))), 'image/png'));
      out.push({ name: `${pg.cat.name}${total > 1 ? ` ${n}-${total}` : ''}`, blob, w: cv.width, h: cv.height });
    }
    return out;
  }

  const slug = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30);

  /* Comparte todas las imágenes juntas con el menú de Android; si no se puede, las descarga una por una. */
  async function share(images, title) {
    const files = images.map((im, i) => new File([im.blob], `${String(i + 1).padStart(2, '0')}-${slug(im.name)}.png`, { type: 'image/png' }));
    if (navigator.canShare && navigator.share) {
      let ok = false;
      try { ok = navigator.canShare({ files }); } catch (_) { ok = false; }
      if (ok) {
        try { await navigator.share({ files, title }); return 'shared'; } catch (e) { if (e && e.name === 'AbortError') return 'cancelled'; }
      }
    }
    files.forEach((f, i) => setTimeout(() => UI.download(f, f.name), i * 400));
    return 'downloaded';
  }

  globalThis.ShareImg = { render, share };
})();

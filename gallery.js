'use strict';
/* gallery.js — Fotografías de productos y galería.
   La foto completa vive UNA sola vez (almacén "photos", clave = id del producto).
   La galería no guarda copias: es una vista de los productos que tienen foto,
   organizada por las categorías reales. Cambiar de categoría, renombrarla o quitar
   la foto actualiza la galería sin tocar ninguna imagen. */
(function () {
  const { AppError, DB, Inventory } = globalThis;
  const norm = (s) => Inventory.norm(s);
  const esc = (s) => UI.esc(s);

  const MAX_SIDE = 1600;          // lado máximo de la foto guardada
  const KEEP_ORIGINAL_BYTES = 900 * 1024;
  const THUMB_SIDE = 256;
  const MAX_INPUT_BYTES = 40 * 1024 * 1024;
  const gs = { q: '', categoryId: '', subId: '', brand: '' };

  /* ---------------- Procesado de imágenes ---------------- */

  async function loadSource(file) {
    if (typeof createImageBitmap === 'function') {
      try {
        return await createImageBitmap(file, { imageOrientation: 'from-image' });
      } catch (_) { /* se intenta con <img> */ }
    }
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new AppError('BAD_IMAGE', 'No se pudo leer la imagen. Prueba con una foto en formato JPG o PNG.'));
      };
      img.src = url;
    });
  }

  const dims = (src) => ({ w: src.naturalWidth || src.width, h: src.naturalHeight || src.height });

  function canvasBlob(canvas, type, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new AppError('BAD_IMAGE', 'No se pudo preparar la imagen.'))), type, quality);
    });
  }

  /* Devuelve { blob, thumb (dataURL), width, height }.
     Solo se reduce si es muy grande; los colores no se modifican (JPEG de alta calidad). */
  async function processImage(file) {
    if (!file || !/^image\//.test(file.type || '')) throw new AppError('BAD_IMAGE', 'El archivo elegido no es una imagen.');
    if (file.size > MAX_INPUT_BYTES) throw new AppError('BIG_IMAGE', 'La imagen es demasiado grande (más de 40 MB). Elige una más pequeña.');
    const src = await loadSource(file);
    try {
      const { w, h } = dims(src);
      if (!w || !h) throw new AppError('BAD_IMAGE', 'La imagen está vacía o dañada.');
      const scale = Math.min(1, MAX_SIDE / Math.max(w, h));
      let blob;
      if (scale === 1 && file.size <= KEEP_ORIGINAL_BYTES && /^image\/(jpeg|png|webp)$/.test(file.type)) {
        blob = file.slice(0, file.size, file.type);
      } else {
        const cw = Math.max(1, Math.round(w * scale));
        const ch = Math.max(1, Math.round(h * scale));
        const canvas = document.createElement('canvas');
        canvas.width = cw; canvas.height = ch;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, cw, ch);
        ctx.drawImage(src, 0, 0, cw, ch);
        blob = await canvasBlob(canvas, 'image/jpeg', 0.9);
      }
      const ts = Math.min(1, THUMB_SIDE / Math.max(w, h));
      const tw = Math.max(1, Math.round(w * ts));
      const th = Math.max(1, Math.round(h * ts));
      const tc = document.createElement('canvas');
      tc.width = tw; tc.height = th;
      const tctx = tc.getContext('2d');
      tctx.fillStyle = '#ffffff';
      tctx.fillRect(0, 0, tw, th);
      tctx.drawImage(src, 0, 0, tw, th);
      return { blob, thumb: tc.toDataURL('image/jpeg', 0.82), width: Math.round(w * scale), height: Math.round(h * scale) };
    } finally {
      if (src.close) src.close();
    }
  }

  /* Genera la miniatura a partir de la foto guardada (reparación / restauración). */
  async function thumbFromBlob(blob) {
    const p = await processImage(new File([blob], 'foto', { type: blob.type || 'image/jpeg' }));
    return p.thumb;
  }

  /* Abre el selector de archivos (cámara o galería del teléfono). Devuelve File o null. */
  function pickFile(capture) {
    return new Promise((resolve) => {
      const inp = document.createElement('input');
      inp.type = 'file';
      inp.accept = 'image/*';
      if (capture) inp.setAttribute('capture', 'environment');
      inp.style.display = 'none';
      document.body.appendChild(inp);
      let done = false;
      const finish = (f) => {
        if (done) return;
        done = true;
        inp.remove();
        resolve(f || null);
      };
      inp.addEventListener('change', () => finish(inp.files && inp.files[0]));
      inp.addEventListener('cancel', () => finish(null));
      inp.click();
    });
  }

  /* ---------------- Acceso a la foto completa ---------------- */

  async function getBlob(productId) {
    const rec = await DB.get('photos', productId);
    return rec ? rec.blob : null;
  }

  function extFor(type) {
    return ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' })[type] || 'jpg';
  }
  function safeName(s) {
    return String(s || 'foto').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 60) || 'foto';
  }

  async function downloadPhoto(productId) {
    const p = App.state.products.find((x) => x.id === productId);
    const blob = await getBlob(productId);
    if (!blob) { UI.toast('Esta foto ya no está disponible.', 'error'); return false; }
    UI.download(blob, `${safeName(p && p.name)}.${extFor(blob.type)}`);
    return true;
  }

  /* Comparte UNA foto con la hoja nativa del teléfono (WhatsApp, etc.). Abrir el menú de compartir
     no significa que se haya enviado: solo se confirma si el sistema lo rechaza. */
  async function sharePhoto(productId) {
    const p = App.state.products.find((x) => x.id === productId);
    let blob;
    try { blob = await getBlob(productId); } catch (e) { UI.toast(DB.friendlyError(e), 'error'); return; }
    if (!blob) { UI.toast('Esta foto ya no está disponible.', 'error'); return; }
    const file = new File([blob], `${safeName(p && p.name)}.${extFor(blob.type)}`, { type: blob.type || 'image/jpeg' });
    if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: p ? p.name : 'Foto' });
        return; // sin mensaje de éxito: el sistema no confirma el envío
      } catch (e) {
        if (e && e.name === 'AbortError') return; // el usuario cerró el menú
        UI.toast('No se pudo abrir el menú de compartir. Puedes descargar la foto y enviarla desde tu galería.', 'error');
        return;
      }
    }
    await downloadPhoto(productId);
    UI.toast('Este navegador no puede compartir imágenes directamente. Se descargó la foto: envíala desde tu galería o tus archivos.');
  }

  /* ---------------- Datos de la galería ---------------- */

  function visiblePhotos() {
    const st = App.state;
    const showArch = !!st.settings.showArchivedPhotos;
    return st.products.filter((p) => p.hasPhoto && p.thumb && (showArch || !p.archived));
  }

  function sortPhotos(list) {
    const st = App.state;
    const ord = (id) => { const c = id ? st.catById.get(id) : null; return c ? c.order : Infinity; };
    return list.slice().sort((a, b) => (ord(a.categoryId) - ord(b.categoryId)) || (ord(a.subcategoryId) - ord(b.subcategoryId)) || Inventory.collator.compare(a.name, b.name));
  }

  /* Álbumes = categorías reales con al menos una foto (+ "Sin categoría"). */
  function buildAlbums() {
    const st = App.state;
    const photos = visiblePhotos();
    const albums = [];
    for (const c of Categories.rootsOf(st.categories)) {
      const items = sortPhotos(photos.filter((p) => p.categoryId === c.id));
      if (items.length) albums.push({ id: c.id, name: c.name, count: items.length, cover: items[0].thumb });
    }
    const none = sortPhotos(photos.filter((p) => !p.categoryId || !st.catById.has(p.categoryId)));
    if (none.length) albums.push({ id: '__none', name: 'Sin categoría', count: none.length, cover: none[0].thumb });
    return { albums, total: photos.length };
  }

  function filteredPhotos() {
    const st = App.state;
    const tokens = norm(gs.q).split(/\s+/).filter(Boolean);
    const brand = norm(gs.brand);
    const list = visiblePhotos().filter((p) => {
      if (gs.categoryId === '__none') { if (p.categoryId && st.catById.has(p.categoryId)) return false; }
      else if (gs.categoryId && p.categoryId !== gs.categoryId) return false;
      if (gs.subId && p.subcategoryId !== gs.subId) return false;
      if (brand && norm(p.brand) !== brand) return false;
      if (tokens.length) {
        const names = Categories.pathNames(p, st.catById);
        const hay = norm(`${p.name} ${p.brand} ${p.code} ${names.category} ${names.subcategory}`);
        if (!tokens.every((t) => hay.includes(t))) return false;
      }
      return true;
    });
    return sortPhotos(list);
  }

  /* ---------------- Sección dentro de Almacén ---------------- */

  function renderSection() {
    const el = document.getElementById('gallery-section');
    if (!el) return;
    const { albums, total } = buildAlbums();
    let html = `<h2 id="gallery-title">Galería de fotos</h2>
      <p class="muted small-text">Las fotos de tus productos, organizadas por categoría. Se añaden desde la ficha de cada producto.</p>`;
    if (!total) {
      html += `<div class="empty card" style="margin-top:12px"><h3>Todavía no hay fotos</h3><p>Cuando añadas una foto a un producto aparecerá aquí automáticamente, dentro del álbum de su categoría.</p></div>`;
    } else {
      html += `<div class="albums">${albums.map((a) => `
        <button type="button" class="album" data-album="${esc(a.id)}">
          <span class="cover"><img src="${a.cover}" alt="" loading="lazy" decoding="async"></span>
          <span class="meta"><b>${esc(a.name)}</b><small>${a.count} foto${a.count === 1 ? '' : 's'}</small></span>
        </button>`).join('')}</div>
        <div class="center"><button type="button" class="btn secondary" data-album="">Buscar en todas las fotos (${total})</button></div>`;
    }
    el.innerHTML = html;
  }

  /* ---------------- Panel de galería (álbum o búsqueda) ---------------- */

  function openPanel(opts) {
    const o = opts || {};
    gs.q = o.q || '';
    gs.categoryId = o.categoryId || '';
    gs.subId = '';
    gs.brand = '';
    const d = UI.dialog({
      title: 'Galería de fotos', cls: 'full',
      html: `<div class="stack">
        <input type="search" id="g-q" placeholder="Buscar por nombre, marca, código o categoría" autocomplete="off" aria-label="Buscar fotos">
        <div class="row3">
          <label class="field"><span>Categoría</span><select id="g-cat"></select></label>
          <label class="field"><span>Subcategoría</span><select id="g-sub"></select></label>
          <label class="field"><span>Marca</span><select id="g-brand"></select></label>
        </div>
        <div id="g-info" class="muted small-text"></div>
        <div id="g-grid" class="photos"></div>
      </div>`,
    });
    const q = d.body.querySelector('#g-q');
    const selCat = d.body.querySelector('#g-cat');
    const selSub = d.body.querySelector('#g-sub');
    const selBrand = d.body.querySelector('#g-brand');
    const grid = d.body.querySelector('#g-grid');
    const info = d.body.querySelector('#g-info');
    q.value = gs.q;
    let shown = [];

    const fillControls = () => {
      const st = App.state;
      const photos = visiblePhotos();
      const catIds = new Set(photos.map((p) => (p.categoryId && st.catById.has(p.categoryId) ? p.categoryId : '__none')));
      const cats = Categories.rootsOf(st.categories).filter((c) => catIds.has(c.id));
      selCat.innerHTML = `<option value="">Todas</option>` + cats.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')
        + (catIds.has('__none') ? `<option value="__none">Sin categoría</option>` : '');
      selCat.value = gs.categoryId;
      if (selCat.value !== gs.categoryId) { gs.categoryId = ''; selCat.value = ''; }
      const subs = gs.categoryId && gs.categoryId !== '__none' ? Categories.childrenOf(st.categories, gs.categoryId) : [];
      selSub.innerHTML = `<option value="">Todas</option>` + subs.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
      selSub.disabled = subs.length === 0;
      selSub.value = gs.subId;
      if (selSub.value !== gs.subId) { gs.subId = ''; selSub.value = ''; }
      const brands = [...new Set(photos.map((p) => p.brand).filter(Boolean))].sort((a, b) => Inventory.collator.compare(a, b));
      selBrand.innerHTML = `<option value="">Todas</option>` + brands.map((b) => `<option value="${esc(b)}">${esc(b)}</option>`).join('');
      selBrand.value = gs.brand;
      if (selBrand.value !== gs.brand) { gs.brand = ''; selBrand.value = ''; }
    };

    const renderGrid = () => {
      const st = App.state;
      shown = filteredPhotos();
      info.textContent = shown.length ? `${shown.length} foto${shown.length === 1 ? '' : 's'}` : '';
      if (!shown.length) {
        grid.innerHTML = `<div class="empty" style="grid-column:1/-1"><h3>No hay fotos con esos filtros</h3><p>Prueba con otra búsqueda o quita los filtros.</p></div>`;
        return;
      }
      const groupBySub = gs.categoryId && gs.categoryId !== '__none' && !gs.subId && Categories.childrenOf(st.categories, gs.categoryId).length > 0;
      const groupByCat = !gs.categoryId;
      let last = null;
      let html = '';
      shown.forEach((p, i) => {
        if (groupBySub || groupByCat) {
          const names = Categories.pathNames(p, st.catById);
          const key = groupBySub ? (names.subcategory || 'Sin subcategoría') : (names.category || 'Sin categoría');
          if (key !== last) { html += `<div class="group-title">${esc(key)}</div>`; last = key; }
        }
        const sub = [p.brand, p.code].filter(Boolean).join(' · ');
        html += `<button type="button" class="ph" data-i="${i}" aria-label="Ver foto de ${esc(p.name)}">
          <img src="${p.thumb}" alt="" loading="lazy" decoding="async">
          <span class="ph-name">${esc(p.name)}</span><span class="ph-sub">${esc(sub || ' ')}</span></button>`;
      });
      grid.innerHTML = html;
    };

    const update = () => { fillControls(); renderGrid(); };
    update();

    let timer = null;
    q.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => { gs.q = q.value; renderGrid(); }, 120);
    });
    selCat.addEventListener('change', () => { gs.categoryId = selCat.value; gs.subId = ''; update(); });
    selSub.addEventListener('change', () => { gs.subId = selSub.value; renderGrid(); });
    selBrand.addEventListener('change', () => { gs.brand = selBrand.value; renderGrid(); });
    grid.addEventListener('click', (e) => {
      const b = e.target.closest('.ph');
      if (!b) return;
      openViewer(shown.map((p) => p.id), Number(b.dataset.i), { onChange: update });
    });
    return d;
  }

  /* ---------------- Vista ampliada ---------------- */

  /* ids: lista de productos con foto; index: posición inicial. */
  function openViewer(ids, index, opts) {
    const st = App.state;
    let i = Math.max(0, Math.min(index, ids.length - 1));
    let url = null;
    let token = 0;
    const d = UI.dialog({ title: 'Foto', cls: 'sheet', html: '<div id="v-body"></div>' });
    d.setFoot(`<button type="button" class="btn secondary" data-v="download">Descargar</button><button type="button" class="btn" data-v="share">Compartir foto</button>`);
    const body = d.body.querySelector('#v-body');

    const show = async (n) => {
      i = n;
      const my = ++token;
      const p = st.products.find((x) => x.id === ids[i]);
      if (!p) { d.close(); return; }
      const names = Categories.pathNames(p, st.catById);
      const catLine = [names.category, names.subcategory].filter(Boolean).join(' › ') || 'Sin categoría';
      d.el.querySelector('.dlg-head h2').textContent = p.name;
      body.innerHTML = `
        <img class="viewer-img" alt="Foto de ${esc(p.name)}" src="${p.thumb || ''}">
        <div class="stack" style="margin-top:12px">
          <div class="kv">
            <div><div class="k">Marca</div><div class="v">${esc(p.brand || '—')}</div></div>
            <div><div class="k">Código</div><div class="v">${esc(p.code || '—')}</div></div>
            <div class="full"><div class="k">Categoría</div><div class="v">${esc(catLine)}</div></div>
          </div>
          <div class="viewer-nav">
            <button type="button" class="btn secondary small" data-v="prev" ${ids.length < 2 ? 'hidden' : ''} ${i === 0 ? 'disabled' : ''}>‹ Anterior</button>
            <span class="muted small-text">${ids.length > 1 ? `${i + 1} de ${ids.length}` : ''}</span>
            <button type="button" class="btn secondary small" data-v="next" ${ids.length < 2 ? 'hidden' : ''} ${i === ids.length - 1 ? 'disabled' : ''}>Siguiente ›</button>
          </div>
          <button type="button" class="btn ghost" data-v="sheet">Ver ficha del producto</button>
        </div>`;
      try {
        const blob = await getBlob(p.id);
        if (my !== token) return;
        if (url) URL.revokeObjectURL(url);
        if (blob) {
          url = URL.createObjectURL(blob);
          const img = body.querySelector('.viewer-img');
          if (img) img.src = url;
        } else {
          UI.toast('No se encontró la foto completa; se muestra la miniatura.', 'error');
        }
      } catch (e) {
        UI.toast(DB.friendlyError(e), 'error');
      }
    };

    d.el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-v]');
      if (!b || b.disabled) return;
      const a = b.dataset.v;
      if (a === 'prev' && i > 0) show(i - 1);
      else if (a === 'next' && i < ids.length - 1) show(i + 1);
      else if (a === 'share') UI.once('share-photo', () => sharePhoto(ids[i]));
      else if (a === 'download') UI.once('dl-photo', () => downloadPhoto(ids[i]));
      else if (a === 'sheet') { const id = ids[i]; d.close(); App.openProduct(id); }
    });
    d.promise.then(() => { if (url) URL.revokeObjectURL(url); token++; if (opts && opts.onChange) opts.onChange(); });
    show(i);
    return d;
  }

  function openProductPhoto(productId) {
    return openViewer([productId], 0);
  }

  function init() {
    const el = document.getElementById('gallery-section');
    el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-album]');
      if (!b) return;
      openPanel({ categoryId: b.dataset.album });
    });
  }

  globalThis.Gallery = {
    init, renderSection, openPanel, openViewer, openProductPhoto,
    processImage, thumbFromBlob, pickFile, getBlob, sharePhoto, downloadPhoto,
    buildAlbums, filteredPhotos, safeName, extFor,
  };
})();

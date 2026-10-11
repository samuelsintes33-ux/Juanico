'use strict';
/* app.js — Núcleo de la aplicación: ayudas de interfaz, navegación, productos,
   existencias, historial de movimientos y arranque. Coordina el resto de módulos. */
(function () {
  const { AppError, DB, Inventory } = globalThis;
  const fmtNum = Inventory.fmtNum;

  /* =====================================================================
     Ayudas de interfaz (UI)
     ===================================================================== */
  const UI = {};
  UI.esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const esc = UI.esc;
  UI.money = (v) => `${fmtNum(v)} ${App.state.settings.currency}`;
  UI.fmtDateTime = (ts) => new Date(ts).toLocaleString('es', { dateStyle: 'medium', timeStyle: 'short' });

  /* Mensajes breves. Se muestran por encima de las ventanas (capa superior del navegador). */
  UI.toast = (msg, kind) => {
    const box = document.getElementById('toasts');
    if (!box) return;
    const t = document.createElement('div');
    t.className = `toast ${kind || ''}`;
    t.textContent = msg;
    box.appendChild(t);
    while (box.children.length > 3) box.firstChild.remove();
    try {
      if (box.showPopover) {
        if (box.matches(':popover-open')) box.hidePopover();
        box.showPopover();
      }
    } catch (_) { /* sin soporte de popover */ }
    setTimeout(() => {
      t.remove();
      try { if (!box.children.length && box.matches(':popover-open')) box.hidePopover(); } catch (_) { /* nada */ }
    }, kind === 'error' ? 8000 : 4500);
  };

  /* Evita que una acción se ejecute dos veces si el usuario pulsa varias veces. */
  const running = new Set();
  UI.once = async (key, fn) => {
    if (running.has(key)) return undefined;
    running.add(key);
    try { return await fn(); } finally { running.delete(key); }
  };

  UI.download = (blob, name) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 15000);
  };

  UI.copyText = async (text) => {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (_) { /* se prueba el método alternativo */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (_) { return false; }
  };

  /* ---- Ventanas con soporte del botón «Atrás» de Android ---- */
  const dlgStack = [];
  let dlgSeq = 0;

  function dialog(o) {
    const el = document.createElement('dialog');
    const id = `dlg${++dlgSeq}`;
    el.className = `dlg ${o.cls || 'sheet'}`;
    el.id = id;
    el.setAttribute('aria-labelledby', `${id}-t`);
    el.innerHTML = `<div class="dlg-head"><h2 id="${id}-t"></h2><button type="button" class="icon-btn" data-dlg-close aria-label="Cerrar">✕</button></div><div class="dlg-body"></div><div class="dlg-foot" hidden></div>`;
    el.querySelector('h2').textContent = o.title || '';
    document.body.appendChild(el);
    const d = {
      el, id, body: el.querySelector('.dlg-body'), foot: el.querySelector('.dlg-foot'),
      guard: o.guard || null, closed: false, busy: false,
    };
    d.body.innerHTML = o.html || '';
    d.promise = new Promise((res) => { d._resolve = res; });
    d.setFoot = (html) => { d.foot.innerHTML = html; d.foot.hidden = false; };
    d.setTitle = (t) => { el.querySelector('h2').textContent = t; };
    d.close = (v) => closeDialog(d, v);
    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-dlg-close]') || e.target === el) requestClose(d);
    });
    el.addEventListener('cancel', (e) => { e.preventDefault(); requestClose(d); });
    el.showModal();
    dlgStack.push(d);
    try { history.pushState({ dlg: dlgStack.length }, ''); } catch (_) { /* sin historial */ }
    if (o.onOpen) o.onOpen(d);
    return d;
  }

  function closeDialog(d, value) {
    if (d.closed) return;
    d.closed = true;
    const i = dlgStack.indexOf(d);
    if (i > -1) dlgStack.splice(i, 1);
    try { d.el.close(); } catch (_) { /* ya cerrada */ }
    d.el.remove();
    // Se espera a que el historial termine de retroceder antes de resolver: así una ventana
    // que se abra justo después (por ejemplo, el resumen de una actualización) no se cierra sola.
    const st = history.state;
    if (st && st.dlg > dlgStack.length) {
      let fired = false;
      const done = () => { if (fired) return; fired = true; window.removeEventListener('popstate', done); d._resolve(value); };
      window.addEventListener('popstate', done);
      setTimeout(done, 400);
      history.back();
    } else d._resolve(value);
  }

  async function requestClose(d) {
    if (d.closed || d._asking) return;
    if (d.guard && d.guard()) {
      d._asking = true;
      const ok = await confirmDiscard();
      d._asking = false;
      if (!ok) return;
    }
    closeDialog(d);
  }

  const confirmDiscard = () => UI.confirm({ title: '¿Descartar los cambios?', message: 'Lo que escribiste todavía no se ha guardado.', okLabel: 'Descartar', cancelLabel: 'Seguir editando', danger: true });

  window.addEventListener('popstate', async (e) => {
    const depth = (e.state && e.state.dlg) || 0;
    while (dlgStack.length > depth) {
      const d = dlgStack[dlgStack.length - 1];
      if (d.guard && d.guard() && !d._discardOk) {
        try { history.pushState({ dlg: dlgStack.length }, ''); } catch (_) { /* nada */ }
        const ok = await confirmDiscard();
        if (ok) { d._discardOk = true; closeDialog(d); }
        return;
      }
      closeDialog(d);
    }
    const st = history.state;
    const dd = (st && st.dlg) || 0;
    if (dd > dlgStack.length) history.go(-(dd - dlgStack.length));
  });

  const kindClass = (k) => ({ secondary: 'secondary', ghost: 'ghost', danger: 'danger', 'danger-ghost': 'danger-ghost' }[k] || '');

  /* Ventana con botones. onAction(id, body, d) puede devolver false para mantenerla abierta.
     Resuelve con el id del botón pulsado, o 'cancel'. */
  UI.modal = (o) => {
    const d = dialog({ title: o.title, html: o.html, cls: o.cls, guard: o.guard });
    const acts = o.actions || [];
    if (acts.length) {
      d.setFoot(acts.map((a) => `<button type="button" class="btn ${kindClass(a.kind)}" data-act="${a.id}">${esc(a.label)}</button>`).join(''));
    }
    d.foot.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-act]');
      if (!b || d.busy) return;
      const id = b.dataset.act;
      if (id === 'cancel') { requestClose(d); return; }
      if (o.onAction) {
        d.busy = true;
        d.foot.querySelectorAll('.btn').forEach((x) => x.classList.add('is-busy'));
        let r;
        try { r = await o.onAction(id, d.body, d); }
        catch (err) { UI.toast(DB.friendlyError(err), 'error'); r = false; }
        d.busy = false;
        d.foot.querySelectorAll('.btn').forEach((x) => x.classList.remove('is-busy'));
        if (r === false) return;
      }
      closeDialog(d, id);
    });
    if (o.onOpen) o.onOpen(d);
    const p = d.promise.then((v) => (v === undefined ? 'cancel' : v));
    p.dialog = d;
    return p;
  };

  UI.confirm = async (o) => {
    const html = o.html || `<p>${esc(o.message || '')}</p>`;
    const r = await UI.modal({
      title: o.title || 'Confirmar', html, cls: 'center-dlg',
      actions: [{ id: 'cancel', label: o.cancelLabel || 'Cancelar', kind: 'ghost' }, { id: 'ok', label: o.okLabel || 'Aceptar', kind: o.danger ? 'danger' : 'primary' }],
    });
    return r === 'ok';
  };

  UI.alert = (o) => UI.modal({
    title: o.title || 'Aviso', html: o.html || `<p>${esc(o.message || '')}</p>`, cls: 'center-dlg',
    actions: [{ id: 'ok', label: 'Entendido', kind: 'primary' }],
  });

  /* Pide un texto. o.submit(valor) puede lanzar un error de validación que se muestra dentro de la ventana.
     Devuelve el texto, o null si se cancela. */
  UI.prompt = async (o) => {
    let result = null;
    const html = `<div class="stack">
      ${o.message ? `<p class="muted">${esc(o.message)}</p>` : ''}
      <label class="field"><span>${esc(o.label || '')}</span>
        <input id="pr-input" autocomplete="off" maxlength="${o.maxlength || 80}" placeholder="${esc(o.placeholder || '')}" value="${esc(o.value || '')}" inputmode="${o.inputmode || 'text'}"></label>
      <div class="field-error" id="pr-err" role="alert"></div></div>`;
    const r = await UI.modal({
      title: o.title, html, cls: 'center-dlg',
      actions: [{ id: 'cancel', label: 'Cancelar', kind: 'ghost' }, { id: 'ok', label: o.okLabel || 'Aceptar', kind: 'primary' }],
      onOpen(d) {
        const inp = d.body.querySelector('#pr-input');
        inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); d.foot.querySelector('[data-act=ok]').click(); } });
        setTimeout(() => { inp.focus(); inp.select(); }, 60);
      },
      async onAction(id, body) {
        const v = body.querySelector('#pr-input').value;
        const err = body.querySelector('#pr-err');
        err.textContent = '';
        if (!o.allowEmpty && !v.trim()) { err.textContent = 'Escribe un valor.'; return false; }
        if (o.submit) {
          try { await o.submit(v); } catch (e) { err.textContent = DB.friendlyError(e); return false; }
        }
        result = v;
      },
    });
    return r === 'ok' ? result : null;
  };

  /* Lista de opciones. Devuelve el id elegido o null. */
  UI.actionSheet = async (title, items) => {
    const r = await UI.modal({
      title, cls: 'sheet',
      html: `<div class="sheet-menu">${items.map((it) => `<button type="button" class="btn ${it.danger ? 'danger-item' : ''}" data-pick="${it.id}">${esc(it.label)}</button>`).join('')}</div>`,
      actions: [{ id: 'cancel', label: 'Cancelar', kind: 'ghost' }],
      onOpen(d) { d.body.addEventListener('click', (e) => { const b = e.target.closest('[data-pick]'); if (b) closeDialog(d, b.dataset.pick); }); },
    });
    return r === 'cancel' ? null : r;
  };

  globalThis.UI = UI;

  /* =====================================================================
     Estado y carga de datos
     ===================================================================== */
  const state = {
    products: [], categories: [], catById: new Map(),
    settings: Object.assign({}, Settings.DEFAULTS),
    tab: 'almacen',
    filters: { query: '', categoryId: '', subcategoryId: '', sort: 'name', status: 'active' },
    listLimit: 60,
    mv: { q: '', type: '', from: '', to: '', productId: null, items: [], hasMore: false, offset: 0, token: 0, loading: false },
    reminderDismissed: false,
  };
  const PAGE = 60;
  const $ = (id) => document.getElementById(id);

  async function reload() {
    const snap = await DB.tx(['products', 'categories'], 'readonly', async (S) => ({
      products: await DB.req(S.products.getAll()),
      categories: await DB.req(S.categories.getAll()),
    }));
    state.products = snap.products;
    state.categories = Categories.sortCategories(snap.categories);
    state.catById = new Map(snap.categories.map((c) => [c.id, c]));
    // Si un filtro apunta a una categoría que ya no existe, se limpia.
    const f = state.filters;
    if (f.categoryId && f.categoryId !== '__none' && !state.catById.has(f.categoryId)) { f.categoryId = ''; f.subcategoryId = ''; }
    if (f.subcategoryId && !state.catById.has(f.subcategoryId)) f.subcategoryId = '';
  }

  async function refresh() {
    await reload();
    renderFilters();
    renderProducts();
    Gallery.renderSection();
    if (state.tab === 'config') Settings.render();
    if (state.tab === 'movimientos') await loadMovements(true);
  }

  async function afterRestore() {
    await Settings.load();
    Settings.applyAppearance();
    state.filters = { query: '', categoryId: '', subcategoryId: '', sort: 'name', status: state.settings.defaultStatus === 'all' ? 'all' : 'active' };
    $('search').value = '';
    state.mv.productId = null;
    await refresh();
  }

  /* =====================================================================
     Almacén: lista, filtros, búsqueda
     ===================================================================== */
  const PLACEHOLDER_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 4 7.5v9L12 21l8-4.5v-9z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M4 7.5 12 12l8-4.5M12 12v9" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>';
  const unitLabel = (unit, q) => Inventory.unitText(unit, q).replace(/^\S+\s/, '');
  const qtyText = (p) => Inventory.qtyText(p.quantity, p.unit);
  const isEst = (p) => p.quantityStatus === 'estimated' && p.quantity !== null && p.quantity !== undefined;

  function qtyChip(p) {
    if (p.quantity === null || p.quantity === undefined) return `<span class="chip unknown" title="Todavía no se ha registrado la existencia">${esc(state.settings.unknownQtyLabel)}</span>`;
    if (p.quantity === 0) return `<span class="chip zero">0 · Agotado</span>`;
    if (p.quantity < 0) return `<span class="chip neg">${esc(qtyText(p))}</span>`;
    if (isEst(p)) return `<span class="chip est" title="Cantidad aproximada (estimación)">≈ ${esc(qtyText(p))}</span>`;
    return `<span class="chip ok">${esc(qtyText(p))}</span>`;
  }

  function priceHtml(p) {
    const pr = Categories.resolvePrice(p, state.catById);
    if (pr.value === null) return `<span class="price none">Sin precio</span>`;
    const tag = pr.source === 'product' ? '' : `<span class="tag" title="Precio general de ${esc(pr.source === 'subcategory' ? 'la subcategoría' : 'la categoría')} ${esc(pr.name)}">gral.</span>`;
    return `<span class="price">${esc(UI.money(pr.value))}${tag}</span>`;
  }

  function productCard(p) {
    const thumb = p.hasPhoto && p.thumb
      ? `<button type="button" class="thumb" data-zoom="${p.id}" aria-label="Ampliar foto de ${esc(p.name)}"><img src="${p.thumb}" alt="" loading="lazy" decoding="async"></button>`
      : `<span class="thumb" aria-hidden="true">${PLACEHOLDER_ICON}</span>`;
    const sub = [p.brand, p.code].filter(Boolean).join(' · ');
    const detail = [p.color, p.presentation, p.capacity].filter(Boolean).join(' · ');
    const cat = state.filters.subcategoryId ? '' : Categories.pathText(p, state.catById);
    return `<article class="card product ${p.archived ? 'archived' : ''}" data-id="${p.id}" tabindex="0" role="button" aria-label="Abrir ${esc(p.name)}">
      ${thumb}
      <div class="pmain"><div class="pname">${esc(p.name)}${p.archived ? ' <span class="badge arch">Archivado</span>' : ''}</div>
        ${sub ? `<div class="psub">${esc(sub)}</div>` : ''}${detail ? `<div class="psub">${esc(detail)}</div>` : ''}${cat ? `<div class="pcat">${esc(cat)}</div>` : ''}</div>
      <div class="pside">${qtyChip(p)}${priceHtml(p)}</div></article>`;
  }

  function activeFilterCount() {
    const f = state.filters;
    const defStatus = state.settings.defaultStatus === 'all' ? 'all' : 'active';
    return (f.categoryId ? 1 : 0) + (f.subcategoryId ? 1 : 0) + (f.sort !== 'name' ? 1 : 0) + (f.status !== defStatus ? 1 : 0);
  }

  function renderFilters() {
    const f = state.filters;
    const roots = Categories.rootsOf(state.categories);
    $('f-category').innerHTML = `<option value="">Todas</option><option value="__none">Sin categoría</option>` + roots.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
    $('f-category').value = f.categoryId;
    const subs = f.categoryId && f.categoryId !== '__none' ? Categories.childrenOf(state.categories, f.categoryId) : [];
    $('f-sub').innerHTML = `<option value="">Todas</option>` + subs.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
    $('f-sub').disabled = subs.length === 0;
    $('f-sub').value = f.subcategoryId;
    $('f-sort').value = f.sort;
    $('f-status').value = f.status;
    const n = activeFilterCount();
    $('btn-filters').textContent = n ? `Filtros (${n})` : 'Filtros';
  }

  function renderProducts() {
    const list = Inventory.filterProducts(state.products, state.filters, state.catById);
    const shown = list.slice(0, state.listLimit);
    const total = state.products.filter((p) => !p.archived).length;
    $('count-label').textContent = list.length === state.products.length
      ? `${list.length} producto${list.length === 1 ? '' : 's'}`
      : `${list.length} de ${state.products.length}`;
    const box = $('product-list');
    if (!state.products.length) {
      box.innerHTML = `<div class="empty card"><h3>Tu almacén está vacío</h3>
        <p>Empieza añadiendo tu primer producto. Solo el nombre es obligatorio; la cantidad, el precio y la foto puedes completarlos después.</p>
        <button type="button" class="btn" data-empty="add">+ Añadir producto</button></div>`;
    } else if (!list.length) {
      box.innerHTML = `<div class="empty card"><h3>No hay productos que mostrar</h3>
        <p>${total ? 'Prueba con otra búsqueda o cambia los filtros.' : 'Todos tus productos están archivados.'}</p>
        <button type="button" class="btn secondary" data-empty="clear">Quitar filtros</button></div>`;
    } else {
      box.innerHTML = shown.map(productCard).join('');
    }
    $('more-wrap').hidden = list.length <= shown.length;
    renderReminder();
  }

  function renderReminder() {
    const el = $('backup-reminder');
    const last = state.settings.lastBackupAt;
    const old = !last || Date.now() - last > 14 * 86400000;
    if (state.reminderDismissed || !state.products.length || !old) { el.innerHTML = ''; return; }
    el.innerHTML = `<div class="notice info" role="note"><span>${last ? 'Hace más de 2 semanas que no haces una copia de seguridad.' : 'Aún no has hecho una copia de seguridad de tu inventario.'}</span>
      <span class="inline"><button type="button" class="btn small" data-rem="go">Crear copia</button><button type="button" class="btn small ghost" data-rem="later">Luego</button></span></div>`;
  }

  /* Muestra los productos de una categoría o subcategoría (desde el administrador de categorías). */
  function showCategory(cat) {
    state.filters.query = '';
    $('search').value = '';
    state.filters.categoryId = cat.parentId || cat.id;
    state.filters.subcategoryId = cat.parentId ? cat.id : '';
    state.listLimit = PAGE;
    go('almacen');
    renderFilters();
    renderProducts();
    $('filters-panel').hidden = false;
    $('btn-filters').setAttribute('aria-expanded', 'true');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  /* =====================================================================
     Ficha de producto
     ===================================================================== */
  function openProduct(id) {
    if (!state.products.find((p) => p.id === id)) return null;
    const d = dialog({ title: 'Producto', cls: 'sheet', html: '' });

    const render = () => {
      const p = state.products.find((x) => x.id === id);
      if (!p) { d.close(); return; }
      d.setTitle(p.name);
      const pr = Categories.resolvePrice(p, state.catById);
      const origin = pr.source === 'product' ? 'Precio de este producto'
        : pr.source === 'subcategory' ? `Precio general de la subcategoría «${pr.name}»`
          : pr.source === 'category' ? `Precio general de la categoría «${pr.name}»` : 'Sin precio asignado';
      const unknown = p.quantity === null || p.quantity === undefined;
      const qtyBig = unknown
        ? `<span class="chip unknown">${esc(state.settings.unknownQtyLabel)}</span><div class="muted small-text" style="font-weight:400;margin-top:4px">Aún no sabes cuántas hay. No es lo mismo que 0.</div>`
        : p.quantity === 0 ? `0 <span class="chip zero">Agotado</span>`
          : `${isEst(p) ? '≈ ' : ''}${esc(fmtNum(p.quantity))} <span class="muted" style="font-size:.9rem;font-weight:600">${esc(unitLabel(p.unit, p.quantity))}</span>${isEst(p) ? ' <span class="chip est">Aproximada</span>' : ''}${p.quantity < 0 ? ' <span class="chip neg">Negativa</span>' : ''}`;
      const undef = '<span class="muted">Sin definir</span>';
      const extra = (p.fields || []).map((f) => `<div><div class="k">${esc(f.name)}</div><div class="v" style="font-weight:500">${f.value ? esc(f.value) : undef}</div></div>`).join('');
      const cat = Categories.pathText(p, state.catById);
      d.body.innerHTML = `<div class="stack">
        <div class="pimg">${p.hasPhoto && p.thumb ? `<img src="${p.thumb}" alt="Foto de ${esc(p.name)}" data-a="zoom">` : '<span>Sin foto</span>'}</div>
        <div class="inline" style="align-items:center;gap:8px;flex-wrap:wrap">
          <button type="button" class="btn secondary small" data-a="photo">${p.hasPhoto ? 'Cambiar foto' : 'Añadir foto'}</button>
          ${p.hasPhoto ? '<button type="button" class="btn danger-ghost small" data-a="rmphoto">Quitar foto</button>' : ''}
        </div>
        ${p.archived ? '<div class="notice">Este producto está archivado: no aparece en la lista normal, pero conserva su historial.</div>' : ''}
        <div class="kv">
          <div><div class="k">Existencia</div><div class="v big">${qtyBig}</div></div>
          <div><div class="k">Precio</div><div class="v">${pr.value === null ? '<span class="muted">Sin precio</span>' : esc(UI.money(pr.value))}</div><div class="muted small-text">${esc(origin)}</div></div>
          <div><div class="k">Marca</div><div class="v">${esc(p.brand || '—')}</div></div>
          <div><div class="k">Código</div><div class="v">${esc(p.code || '—')}</div></div>
          <div><div class="k">Color</div><div class="v">${esc(p.color || '—')}</div></div>
          <div><div class="k">Presentación</div><div class="v">${esc(p.presentation || '—')}</div></div>
          <div><div class="k">Capacidad</div><div class="v">${esc(p.capacity || '—')}</div></div>
          <div><div class="k">Unidad</div><div class="v">${esc(p.unit || 'unidades')}</div></div>
          ${extra}
          <div class="full"><div class="k">Categoría</div><div class="v">${esc(cat || 'Sin categoría')}</div></div>
          ${p.notes ? `<div class="full"><div class="k">Notas</div><div class="v" style="font-weight:500;white-space:pre-wrap">${esc(p.notes)}</div></div>` : ''}
        </div>
        ${p.archived ? '' : `<div class="section-title">Existencias</div>
        <div class="actions-grid">
          <button type="button" class="btn" data-a="entrada">＋ Entrada</button>
          <button type="button" class="btn" data-a="salida">− Salida</button>
          <button type="button" class="btn secondary span2" data-a="ajuste">Ajustar existencia</button>
        </div>`}
        <div class="section-title">Producto</div>
        <div class="actions-grid">
          <button type="button" class="btn secondary" data-a="history">Historial</button>
          <button type="button" class="btn secondary" data-a="edit">Editar</button>
          <button type="button" class="btn secondary" data-a="dup">Duplicar</button>
          <button type="button" class="btn secondary" data-a="${p.archived ? 'unarchive' : 'archive'}">${p.archived ? 'Restaurar' : 'Archivar'}</button>
          <button type="button" class="btn danger-ghost span2" data-a="delete">Eliminar…</button>
        </div></div>`;
    };
    render();

    const after = async () => { await refresh(); render(); };

    d.el.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-a]');
      if (!b) return;
      const a = b.dataset.a;
      const p = state.products.find((x) => x.id === id);
      if (!p) return;
      try {
        if (a === 'zoom') Gallery.openProductPhoto(id);
        else if (a === 'photo') await UI.once('photo', async () => { if (await changePhoto(id)) await after(); });
        else if (a === 'rmphoto') {
          if (await UI.confirm({ title: 'Quitar foto', message: 'La foto de este producto se eliminará de la aplicación y de la galería.', okLabel: 'Quitar', danger: true })) {
            await Inventory.setPhoto(id, null);
            UI.toast('Foto eliminada.', 'ok');
            await after();
          }
        } else if (a === 'entrada' || a === 'salida' || a === 'ajuste') {
          await openMovement(id, a, after);
        } else if (a === 'history') { d.close(); showHistory(id); }
        else if (a === 'edit') { openForm(p, after); }
        else if (a === 'dup') {
          const copy = await Inventory.duplicateProduct(id);
          await refresh();
          UI.toast('Producto duplicado (conserva marca, color, presentación y campos). Sin cantidad ni foto: ajusta lo que necesites.', 'ok');
          d.close();
          openForm(state.products.find((x) => x.id === copy.id), refresh);
        } else if (a === 'archive') {
          if (await UI.confirm({ title: `Archivar «${p.name}»`, message: 'Dejará de verse en la lista normal, pero conserva su historial y su foto. Puedes restaurarlo cuando quieras.', okLabel: 'Archivar' })) {
            await Inventory.setArchived(id, true);
            UI.toast('Producto archivado.', 'ok');
            d.close();
            await refresh();
          }
        } else if (a === 'unarchive') {
          await Inventory.setArchived(id, false);
          UI.toast('Producto restaurado.', 'ok');
          await after();
        } else if (a === 'delete') {
          if (await deleteFlow(p)) { d.close(); await refresh(); }
        }
      } catch (err) {
        UI.toast(DB.friendlyError(err), 'error');
      }
    });
    return d;
  }

  async function deleteFlow(p) {
    const n = await Inventory.countMovements(p.id);
    if (n === 0) {
      const ok = await UI.confirm({ title: `Eliminar «${p.name}»`, message: 'Se eliminará el producto y su foto. Esta acción no se puede deshacer.', okLabel: 'Eliminar', danger: true });
      if (!ok) return false;
      await Inventory.deleteProduct(p.id);
      UI.toast('Producto eliminado.', 'ok');
      return true;
    }
    const choice = await UI.modal({
      title: `Eliminar «${p.name}»`, cls: 'center-dlg',
      html: `<div class="stack"><p>Este producto tiene <b>${n} movimiento${n === 1 ? '' : 's'}</b> en el historial.</p>
        <p><b>Lo más seguro es archivarlo:</b> deja de verse en la lista, pero su historial se conserva.</p></div>`,
      actions: [{ id: 'cancel', label: 'Cancelar', kind: 'ghost' }, { id: 'archive', label: 'Archivar', kind: 'primary' }, { id: 'del', label: 'Eliminar con su historial', kind: 'danger-ghost' }],
    });
    if (choice === 'archive') {
      await Inventory.setArchived(p.id, true);
      UI.toast('Producto archivado. Su historial se conserva.', 'ok');
      return true;
    }
    if (choice === 'del') {
      const ok = await UI.confirm({ title: '¿Eliminar definitivamente?', message: `Se borrarán «${p.name}», su foto y sus ${n} movimientos. No se puede deshacer.`, okLabel: 'Eliminar todo', danger: true });
      if (!ok) return false;
      await Inventory.deleteProduct(p.id, { withHistory: true });
      UI.toast('Producto e historial eliminados.', 'ok');
      return true;
    }
    return false;
  }

  /* Tomar o elegir una foto y guardarla en el producto. Devuelve true si cambió. */
  async function changePhoto(id) {
    const choice = await UI.actionSheet('Foto del producto', [
      { id: 'camera', label: 'Tomar una foto' }, { id: 'gallery', label: 'Elegir de la galería del teléfono' },
    ]);
    if (!choice) return false;
    const file = await Gallery.pickFile(choice === 'camera');
    if (!file) return false;
    UI.toast('Procesando foto…');
    const photo = await Gallery.processImage(file);
    await Inventory.setPhoto(id, photo);
    UI.toast('Foto guardada. Ya aparece en la galería.', 'ok');
    return true;
  }

  /* =====================================================================
     Formulario de producto (crear / editar)
     ===================================================================== */
  const UNIT_SUGGESTIONS = ['unidades', 'cajas', 'paquetes', 'frascos', 'botellas', 'tubos', 'sobres', 'kits', 'potecitos', 'pares', 'litros', 'kg', 'g', 'L', 'ml'];

  function openForm(p, onSaved) {
    const creating = !p;
    const id = creating ? DB.uuid() : p.id; // el id se fija al abrir: guardar dos veces no duplica
    let dirty = false;
    let photoChange; // undefined = conservar, null = quitar, objeto = nueva
    let preview = p && p.hasPhoto ? p.thumb : null;
    const uniq = (key) => [...new Set(state.products.map((x) => x[key]).filter(Boolean))].sort((a, b) => Inventory.collator.compare(a, b));
    const brands = uniq('brand');
    const presentations = uniq('presentation');
    const capacities = uniq('capacity');
    const fieldNames = [...new Set(state.products.flatMap((x) => (x.fields || []).map((f) => f.name)))].sort((a, b) => Inventory.collator.compare(a, b));
    const fieldRow = (f) => `<div class="cf-row"><input class="cf-name" maxlength="40" list="dl-fnames" placeholder="Nombre (ej. Contenido)" value="${esc(f.name)}" aria-label="Nombre del campo"><input class="cf-value" maxlength="300" placeholder="Valor (vacío = pendiente)" value="${esc(f.value)}" aria-label="Valor del campo"><button type="button" class="btn danger-ghost small" data-f="rmfield" aria-label="Quitar campo">✕</button></div>`;

    const html = `<form id="pf" novalidate autocomplete="off"><div class="stack">
      <label class="field"><span>Nombre del producto *</span><input name="name" maxlength="120" required value="${esc(p ? p.name : '')}" placeholder="Ej. Stereo 7.1"><span class="field-error" data-err="name"></span></label>
      <div class="row2">
        <label class="field"><span>Marca</span><input name="brand" maxlength="60" list="dl-brands" value="${esc(p ? p.brand : '')}"><span class="field-error" data-err="brand"></span></label>
        <label class="field"><span>Código o referencia</span><input name="code" maxlength="60" value="${esc(p ? p.code : '')}"><span class="field-error" data-err="code"></span></label>
      </div>
      <datalist id="dl-brands">${brands.map((b) => `<option value="${esc(b)}">`).join('')}</datalist>
      <div class="row2">
        <label class="field"><span>Color</span><input name="color" maxlength="60" value="${esc(p ? p.color : '')}" placeholder="Ej. Rubio ceniza"><span class="field-error" data-err="color"></span></label>
        <label class="field"><span>Presentación</span><input name="presentation" maxlength="80" list="dl-pres" value="${esc(p ? p.presentation : '')}" placeholder="Ej. Tubo, sobre, botella"><span class="field-error" data-err="presentation"></span></label>
      </div>
      <label class="field"><span>Capacidad</span><input name="capacity" maxlength="60" list="dl-cap" value="${esc(p ? p.capacity : '')}" placeholder="Ej. 50 ml (vacío = sin confirmar)"><span class="field-error" data-err="capacity"></span></label>
      <datalist id="dl-pres">${presentations.map((b) => `<option value="${esc(b)}">`).join('')}</datalist>
      <datalist id="dl-cap">${capacities.map((b) => `<option value="${esc(b)}">`).join('')}</datalist>
      <div class="inline"><label class="field"><span>Categoría</span><select name="categoryId"></select></label><button type="button" class="btn secondary small" data-f="newcat" aria-label="Crear categoría">+ Nueva</button></div>
      <div class="inline"><label class="field"><span>Subcategoría</span><select name="subcategoryId"></select></label><button type="button" class="btn secondary small" data-f="newsub" aria-label="Crear subcategoría">+ Nueva</button></div>
      <span class="field-error" data-err="categoryId"></span><span class="field-error" data-err="subcategoryId"></span>
      <div class="row2">
        ${creating
    ? `<label class="field"><span>Cantidad inicial</span><input name="quantity" inputmode="decimal" placeholder="Sin registrar"><span class="hint">Déjala vacía si aún no la sabes: vacío no es 0.</span><span class="field-error" data-err="quantity"></span></label>`
    : `<div class="field"><span>Existencia</span><div class="preview-box">${p.quantity === null || p.quantity === undefined ? esc(state.settings.unknownQtyLabel) : `${isEst(p) ? '≈ ' : ''}${esc(qtyText(p))}`}</div><span class="hint">Se cambia con Entrada, Salida o Ajuste para que quede en el historial.</span></div>`}
        <label class="field"><span>Unidad de medida</span><input name="unit" maxlength="20" list="dl-units" value="${esc(p ? p.unit : '')}" placeholder="unidades"><span class="field-error" data-err="unit"></span></label>
      </div>
      <datalist id="dl-units">${UNIT_SUGGESTIONS.map((u) => `<option value="${esc(u)}">`).join('')}</datalist>
      <label class="field"><span>Precio (${esc(state.settings.currency)})</span><input name="price" inputmode="decimal" value="${p && p.price !== null && p.price !== undefined ? esc(fmtNum(p.price)) : ''}" placeholder="Usar el precio general o sin precio"><span class="hint">Si lo dejas vacío se usará el precio general de su subcategoría o categoría, si existe.</span><span class="field-error" data-err="price"></span></label>
      ${creating ? `<label class="switch"><span class="sw-text">La cantidad inicial es aproximada<small>Se marcará como estimación (≈) y quedará separada de lo confirmado.</small></span><input type="checkbox" name="estimated"></label>` : ''}
      <label class="field"><span>Descripción o notas</span><textarea name="notes" maxlength="1000">${esc(p ? p.notes : '')}</textarea></label>
      <div class="field"><span>Otros datos del producto</span>
        <span class="hint">Añade las características que necesites (contenido, tipo, presentación de compra…). Si aún no lo sabes, deja el valor vacío y complétalo después.</span>
        <div id="cf-list">${(p && p.fields ? p.fields : []).map(fieldRow).join('')}</div>
        <button type="button" class="btn secondary small" data-f="addfield">+ Añadir dato</button>
        <datalist id="dl-fnames">${fieldNames.map((b) => `<option value="${esc(b)}">`).join('')}</datalist>
        <span class="field-error" data-err="fields"></span></div>
      <div class="field"><span>Fotografía</span>
        <div class="photo-edit"><span class="thumb" id="pf-thumb" aria-hidden="true">${preview ? `<img src="${preview}" alt="">` : PLACEHOLDER_ICON}</span>
          <div class="btns"><button type="button" class="btn secondary small" data-f="camera">Tomar foto</button><button type="button" class="btn secondary small" data-f="pick">Elegir de la galería</button>
          <button type="button" class="btn danger-ghost small" data-f="rmphoto" ${preview ? '' : 'hidden'}>Quitar</button></div></div>
        <span class="field-error" data-err="photo"></span></div>
      <div class="field-error" id="pf-error" role="alert"></div>
    </div></form>`;

    const d = dialog({
      title: creating ? 'Nuevo producto' : 'Editar producto', cls: 'sheet', html, guard: () => dirty,
    });
    d.setFoot(`<button type="button" class="btn ghost" data-f="cancel">Cancelar</button><button type="button" class="btn" data-f="save">Guardar</button>`);
    const form = d.body.querySelector('#pf');
    const catSel = form.elements.categoryId;
    const subSel = form.elements.subcategoryId;

    const fillCats = (selCat, selSub) => {
      const roots = Categories.rootsOf(state.categories);
      catSel.innerHTML = `<option value="">Sin categoría</option>` + roots.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
      catSel.value = selCat || '';
      if (catSel.value !== (selCat || '')) catSel.value = '';
      const subs = catSel.value ? Categories.childrenOf(state.categories, catSel.value) : [];
      subSel.innerHTML = `<option value="">Sin subcategoría</option>` + subs.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
      subSel.disabled = !catSel.value;
      subSel.value = selSub || '';
      if (subSel.value !== (selSub || '')) subSel.value = '';
      form.querySelector('[data-f=newsub]').disabled = !catSel.value;
    };
    fillCats(p ? p.categoryId : '', p ? p.subcategoryId : '');

    const setPreview = (src) => {
      preview = src;
      d.body.querySelector('#pf-thumb').innerHTML = src ? `<img src="${src}" alt="">` : PLACEHOLDER_ICON;
      d.body.querySelector('[data-f=rmphoto]').hidden = !src;
    };
    const clearErrors = () => {
      d.body.querySelectorAll('[data-err]').forEach((x) => { x.textContent = ''; });
      d.body.querySelector('#pf-error').textContent = '';
      form.querySelectorAll('.invalid').forEach((x) => x.classList.remove('invalid'));
    };
    const showError = (e) => {
      const field = e && e.extra && e.extra.field;
      const msg = DB.friendlyError(e);
      const slot = field && d.body.querySelector(`[data-err="${field}"]`);
      if (slot) {
        slot.textContent = msg;
        const inp = form.elements[field];
        if (inp) { inp.classList.add('invalid'); inp.scrollIntoView({ block: 'center', behavior: 'smooth' }); inp.focus({ preventScroll: true }); }
      } else {
        d.body.querySelector('#pf-error').textContent = msg;
        UI.toast(msg, 'error');
      }
    };

    form.addEventListener('input', () => { dirty = true; });
    form.addEventListener('submit', (e) => e.preventDefault());
    catSel.addEventListener('change', () => { dirty = true; fillCats(catSel.value, ''); });

    const createCat = async (parent) => {
      let made = null;
      const name = await UI.prompt({
        title: parent ? 'Nueva subcategoría' : 'Nueva categoría', label: 'Nombre', okLabel: 'Crear', maxlength: Categories.NAME_MAX,
        placeholder: parent ? 'Ej. Stereo' : 'Ej. Tintes', submit: async (v) => { made = await Categories.create(v, parent); },
      });
      if (name === null || !made) return;
      await reload();
      renderFilters();
      Gallery.renderSection();
      dirty = true;
      if (parent) fillCats(parent, made.id); else fillCats(made.id, '');
      UI.toast(parent ? 'Subcategoría creada.' : 'Categoría creada.', 'ok');
    };

    d.el.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-f]');
      if (!b) return;
      const a = b.dataset.f;
      try {
        if (a === 'cancel') d.requestClose ? d.requestClose() : requestClose(d);
        else if (a === 'newcat') await createCat(null);
        else if (a === 'newsub') { if (catSel.value) await createCat(catSel.value); }
        else if (a === 'camera' || a === 'pick') {
          await UI.once('pf-photo', async () => {
            const file = await Gallery.pickFile(a === 'camera');
            if (!file) return;
            d.body.querySelector('[data-err=photo]').textContent = 'Procesando foto…';
            try {
              const photo = await Gallery.processImage(file);
              photoChange = photo;
              dirty = true;
              setPreview(photo.thumb);
              d.body.querySelector('[data-err=photo]').textContent = '';
            } catch (err) {
              d.body.querySelector('[data-err=photo]').textContent = DB.friendlyError(err);
            }
          });
        } else if (a === 'addfield') {
          const list = d.body.querySelector('#cf-list');
          list.insertAdjacentHTML('beforeend', fieldRow({ name: '', value: '' }));
          list.lastElementChild.querySelector('.cf-name').focus();
          dirty = true;
        } else if (a === 'rmfield') {
          b.closest('.cf-row').remove();
          dirty = true;
        } else if (a === 'rmphoto') {
          photoChange = creating ? undefined : null;
          dirty = true;
          setPreview(null);
        } else if (a === 'save') {
          await UI.once('pf-save', async () => {
            clearErrors();
            const fd = {
              id, name: form.elements.name.value, brand: form.elements.brand.value, code: form.elements.code.value,
              categoryId: catSel.value, subcategoryId: subSel.value, unit: form.elements.unit.value,
              price: form.elements.price.value, notes: form.elements.notes.value,
              color: form.elements.color.value, presentation: form.elements.presentation.value, capacity: form.elements.capacity.value,
              fields: [...d.body.querySelectorAll('.cf-row')].map((r) => ({ name: r.querySelector('.cf-name').value, value: r.querySelector('.cf-value').value })),
              quantityStatus: creating && form.elements.estimated && form.elements.estimated.checked ? 'estimated' : 'confirmed',
              quantity: creating ? form.elements.quantity.value : undefined,
            };
            try {
              Inventory.validateProductInput(fd, creating);
              const similar = Inventory.findSimilar(state.products, fd, creating ? null : p.id);
              if (similar) {
                const go2 = await UI.confirm({ title: 'Posible duplicado', message: `Ya existe un producto con el mismo nombre, marca y código («${similar.name}»). ¿Guardar de todos modos?`, okLabel: 'Guardar igualmente' });
                if (!go2) return;
              }
              if (creating) await Inventory.createProduct(fd, photoChange || null);
              else await Inventory.updateProduct(p.id, fd, photoChange);
              dirty = false;
              UI.toast(creating ? 'Producto guardado.' : 'Cambios guardados.', 'ok');
              d.close();
              await refresh();
              if (onSaved) await onSaved();
            } catch (err) {
              showError(err);
            }
          });
        }
      } catch (err) {
        UI.toast(DB.friendlyError(err), 'error');
      }
    });
    if (creating) setTimeout(() => form.elements.name.focus(), 80);
    return d;
  }

  /* =====================================================================
     Entradas, salidas y ajustes
     ===================================================================== */
  async function openMovement(productId, type, onDone) {
    const p = state.products.find((x) => x.id === productId);
    if (!p) return;
    if (p.archived) { UI.toast('Restaura el producto para registrar movimientos.', 'error'); return; }
    const unknown = p.quantity === null || p.quantity === undefined;
    if (type !== 'ajuste' && unknown) {
      const ok = await UI.confirm({
        title: 'Existencia sin registrar',
        message: `Todavía no se sabe cuántas unidades hay de «${p.name}», así que no se puede calcular una ${type}. Primero establece la existencia con un ajuste.`,
        okLabel: 'Establecer existencia',
      });
      if (ok) await openMovement(productId, 'ajuste', onDone);
      return;
    }
    const opId = DB.uuid(); // identifica esta operación: no se puede registrar dos veces
    const L = {
      entrada: { title: 'Registrar entrada', label: 'Cantidad que entra *', btn: 'Registrar entrada' },
      salida: { title: 'Registrar salida', label: 'Cantidad que sale *', btn: 'Registrar salida' },
      ajuste: { title: 'Ajustar existencia', label: unknown ? 'Existencia actual (la que hay ahora) *' : 'Cantidad correcta *', btn: 'Guardar ajuste' },
    }[type];
    const curText = unknown ? esc(state.settings.unknownQtyLabel) : `${isEst(p) ? '≈ ' : ''}${esc(qtyText(p))}${isEst(p) ? ' <span class="chip est">Aproximada</span>' : ''}`;
    const html = `<div class="stack">
      <div><b>${esc(p.name)}</b><div class="muted small-text">${esc([p.brand, p.code].filter(Boolean).join(' · '))}</div></div>
      <div class="kv"><div class="full"><div class="k">Existencia actual</div><div class="v big">${curText}</div></div></div>
      ${type === 'ajuste' ? `<p class="muted small-text">Un ajuste corrige la existencia (por ejemplo, tras contar). Se guarda como corrección, no como entrada ni salida.</p>` : ''}
      <label class="field"><span>${esc(L.label)}</span><input id="mv-amount" inputmode="decimal" autocomplete="off" placeholder="0"></label>
      ${type === 'ajuste' ? `<div class="field"><span>Esta cantidad es…</span><div class="seg" role="group" aria-label="Tipo de cantidad" id="mv-status"><button type="button" data-v="confirmed" aria-pressed="${!isEst(p)}">Confirmada</button><button type="button" data-v="estimated" aria-pressed="${isEst(p)}">Aproximada</button></div><span class="hint">Las cantidades aproximadas se muestran con ≈ y no se suman a las confirmadas.</span></div>` : ''}
      <div class="preview-box" id="mv-preview" aria-live="polite"></div>
      <label class="field"><span>Nota (opcional)</span><input id="mv-note" maxlength="300" autocomplete="off" placeholder="Ej. compra a proveedor"></label>
      <div class="field-error" id="mv-err" role="alert"></div></div>`;

    const compute = (raw) => {
      const r = Inventory.parseDecimal(raw);
      if (r.empty) return { text: 'Escribe la cantidad para ver el resultado.', cls: '' };
      if (r.invalid) return { text: 'Escribe un número válido (puedes usar decimales).', cls: 'bad' };
      const v = r.value;
      if (type === 'ajuste') {
        if (v < 0) return { text: 'La cantidad no puede ser negativa.', cls: 'bad' };
        if (unknown) return { text: `Sin registrar → ${fmtNum(v)} (existencia inicial)`, cls: 'ok' };
        const diff = Inventory.round6(v - p.quantity);
        const wantEst = (document.querySelector('#mv-status [aria-pressed=true]') || {}).dataset ? document.querySelector('#mv-status [aria-pressed=true]').dataset.v === 'estimated' : isEst(p);
        if (diff === 0 && wantEst === isEst(p)) return { text: `Ya es ${fmtNum(p.quantity)}: no hay nada que ajustar.`, cls: 'bad' };
        if (diff === 0) return { text: wantEst ? 'Se marcará como cantidad aproximada.' : 'Se marcará como cantidad confirmada.', cls: 'ok' };
        return { text: `${fmtNum(p.quantity)} → ${fmtNum(v)}  (corrección ${Inventory.fmtSigned(diff)})`, cls: 'ok' };
      }
      if (v <= 0) return { text: 'La cantidad debe ser mayor que cero.', cls: 'bad' };
      if (type === 'entrada') return { text: `${fmtNum(p.quantity)} → ${fmtNum(Inventory.round6(p.quantity + v))}`, cls: 'ok' };
      const after = Inventory.round6(p.quantity - v);
      if (after < 0 && !state.settings.allowOversell) return { text: `Solo hay ${fmtNum(p.quantity)}: no puedes sacar ${fmtNum(v)}.`, cls: 'bad' };
      return { text: `${fmtNum(p.quantity)} → ${fmtNum(after)}${after < 0 ? '  (quedará en negativo)' : ''}`, cls: after < 0 ? 'bad' : 'ok' };
    };

    const res = await UI.modal({
      title: L.title, html,
      actions: [{ id: 'cancel', label: 'Cancelar', kind: 'ghost' }, { id: 'ok', label: L.btn, kind: 'primary' }],
      onOpen(d) {
        const inp = d.body.querySelector('#mv-amount');
        const prev = d.body.querySelector('#mv-preview');
        const upd = () => { const c = compute(inp.value); prev.textContent = c.text; prev.className = `preview-box ${c.cls}`; };
        upd();
        inp.addEventListener('input', upd);
        const st = d.body.querySelector('#mv-status');
        if (st) st.addEventListener('click', (e) => { const bt = e.target.closest('button'); if (!bt) return; st.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === bt))); upd(); });
        inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); d.foot.querySelector('[data-act=ok]').click(); } });
        setTimeout(() => inp.focus(), 80);
      },
      async onAction(id, body) {
        const err = body.querySelector('#mv-err');
        err.textContent = '';
        try {
          const amount = body.querySelector('#mv-amount').value;
          const out = await Inventory.registerMovement({
            opId, productId, type, amount, newQuantity: amount, note: body.querySelector('#mv-note').value,
            quantityStatus: type === 'ajuste' ? (body.querySelector('#mv-status [aria-pressed=true]') || {}).dataset.v : undefined,
          });
          const m = out.movement;
          const name = { entrada: 'Entrada', salida: 'Salida', ajuste: 'Ajuste' }[type];
          UI.toast(`${name} registrada: ${m.before === null ? 'sin registrar' : fmtNum(m.before)} → ${fmtNum(m.after)}`, 'ok');
        } catch (e) {
          err.textContent = DB.friendlyError(e);
          return false;
        }
      },
    });
    if (res === 'ok') {
      await refresh();
      if (onDone) await onDone();
    }
  }

  /* =====================================================================
     Movimientos (historial)
     ===================================================================== */
  const TYPE_LABEL = { entrada: 'Entrada', salida: 'Salida', ajuste: 'Ajuste' };
  const TYPE_CLASS = { entrada: 'in', salida: 'out', ajuste: 'adj' };

  function mvQtyText(m) {
    if (m.type === 'entrada') return `+${fmtNum(m.quantity)}`;
    if (m.type === 'salida') return `−${fmtNum(m.quantity)}`;
    if (m.quantity === null) return `= ${fmtNum(m.after)}`;
    return Inventory.fmtSigned(m.quantity);
  }

  function dayStart(v) { if (!v) return null; const [y, m, d] = v.split('-').map(Number); return new Date(y, m - 1, d, 0, 0, 0, 0).getTime(); }
  function dayEnd(v) { if (!v) return null; const [y, m, d] = v.split('-').map(Number); return new Date(y, m - 1, d, 23, 59, 59, 999).getTime(); }

  async function loadMovements(reset) {
    const mv = state.mv;
    if (reset) { mv.offset = 0; mv.items = []; }
    const token = ++mv.token;
    try {
      const r = await Inventory.listMovements({
        productId: mv.productId, type: mv.type, q: mv.q, from: dayStart(mv.from), to: dayEnd(mv.to),
      }, 50, mv.offset);
      if (token !== mv.token) return;
      mv.items = mv.items.concat(r.items);
      mv.offset += r.items.length;
      mv.hasMore = r.hasMore;
      renderMovements();
    } catch (e) {
      UI.toast(DB.friendlyError(e), 'error');
    }
  }

  function renderMovements() {
    const mv = state.mv;
    const chip = $('mv-product-chip');
    if (mv.productId) {
      const p = state.products.find((x) => x.id === mv.productId);
      const name = p ? p.name : (mv.items[0] ? mv.items[0].productName : 'producto');
      chip.innerHTML = `<div class="notice info"><span>Historial de <b>${esc(name)}</b></span><button type="button" class="btn small ghost" data-mv="clear-product">Ver todos</button></div>`;
    } else chip.innerHTML = '';
    const box = $('mv-list');
    if (!mv.items.length) {
      const filtered = mv.q || mv.type || mv.from || mv.to || mv.productId;
      box.innerHTML = `<div class="empty card"><h3>${filtered ? 'No hay movimientos con esos filtros' : 'Todavía no hay movimientos'}</h3>
        <p>${filtered ? 'Prueba con otra búsqueda o quita los filtros.' : 'Cuando registres entradas, salidas o ajustes desde la ficha de un producto aparecerán aquí.'}</p></div>`;
    } else {
      box.innerHTML = mv.items.map((m) => {
        const cat = [m.categoryName, m.subcategoryName].filter(Boolean).join(' › ');
        const meta = [m.brand, cat].filter(Boolean).join(' · ');
        const range = `${m.before === null ? 'Sin registrar' : fmtNum(m.before)} → ${fmtNum(m.after)}${m.estimated ? ' (aprox.)' : ''}`;
        return `<button type="button" class="card mv" data-mid="${m.id}">
          <div class="mv-top"><div><span class="badge ${TYPE_CLASS[m.type]}">${TYPE_LABEL[m.type]}${m.initial ? ' inicial' : ''}</span>
            <div class="mv-name">${esc(m.productName)}</div></div><div class="mv-qty ${TYPE_CLASS[m.type]}">${esc(mvQtyText(m))}</div></div>
          ${meta ? `<div class="mv-meta">${esc(meta)}</div>` : ''}
          <div class="mv-meta"><span>${esc(range)}</span><span>${esc(UI.fmtDateTime(m.createdAt))}</span></div>
          ${m.note ? `<div class="mv-note">${esc(m.note)}</div>` : ''}</button>`;
      }).join('');
    }
    $('mv-more-wrap').hidden = !mv.hasMore;
  }

  function showHistory(productId) {
    const mv = state.mv;
    mv.productId = productId; mv.q = ''; mv.type = ''; mv.from = ''; mv.to = '';
    $('mv-search').value = ''; $('mv-from').value = ''; $('mv-to').value = '';
    syncTypeButtons();
    go('movimientos');
  }

  function syncTypeButtons() {
    document.querySelectorAll('#mv-types button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.type === state.mv.type)));
  }

  function openMovementDetail(m) {
    const p = state.products.find((x) => x.id === m.productId);
    const cat = [m.categoryName, m.subcategoryName].filter(Boolean).join(' › ');
    const html = `<div class="stack">
      <div><span class="badge ${TYPE_CLASS[m.type]}">${TYPE_LABEL[m.type]}${m.initial ? ' (existencia inicial)' : ''}</span></div>
      <div class="kv">
        <div class="full"><div class="k">Producto</div><div class="v">${esc(m.productName)}${p && p.archived ? ' <span class="badge arch">Archivado</span>' : ''}${!p ? ' <span class="badge arch">Eliminado</span>' : ''}</div></div>
        <div><div class="k">Marca</div><div class="v">${esc(m.brand || '—')}</div></div>
        <div><div class="k">Código</div><div class="v">${esc(m.code || '—')}</div></div>
        <div class="full"><div class="k">Categoría (cuando se registró)</div><div class="v">${esc(cat || 'Sin categoría')}</div></div>
        <div><div class="k">${m.type === 'ajuste' ? 'Corrección' : 'Cantidad'}</div><div class="v">${esc(mvQtyText(m))}${m.unit ? ' ' + esc(m.unit) : ''}</div></div>
        <div><div class="k">Fecha</div><div class="v" style="font-size:.95rem">${esc(UI.fmtDateTime(m.createdAt))}</div></div>
        <div><div class="k">Cantidad anterior</div><div class="v">${m.before === null ? 'Sin registrar' : esc(fmtNum(m.before))}</div></div>
        <div><div class="k">Cantidad posterior</div><div class="v">${esc(fmtNum(m.after))}</div></div>
      </div>
      <label class="field"><span>Nota</span><input id="md-note" maxlength="300" value="${esc(m.note)}" placeholder="Sin nota"></label>
      <p class="muted small-text">Los movimientos no se editan ni se eliminan para que las existencias siempre cuadren con el historial. Solo puedes cambiar la nota. Si te equivocaste, registra un <b>Ajuste</b> con la cantidad correcta.</p>
    </div>`;
    const actions = [{ id: 'cancel', label: 'Cerrar', kind: 'ghost' }];
    if (p) actions.push({ id: 'product', label: 'Ver producto', kind: 'secondary' });
    actions.push({ id: 'save', label: 'Guardar nota', kind: 'primary' });
    UI.modal({
      title: 'Detalle del movimiento', html, actions,
      async onAction(id, body, d) {
        if (id === 'save') {
          await Inventory.updateMovementNote(m.id, body.querySelector('#md-note').value);
          UI.toast('Nota guardada.', 'ok');
          await loadMovements(true);
        } else if (id === 'product') {
          setTimeout(() => openProduct(p.id), 0);
        }
      },
    });
  }

  /* =====================================================================
     Navegación
     ===================================================================== */
  const TITLES = { almacen: 'Almacén', movimientos: 'Movimientos', config: 'Configuración' };

  function go(tab) {
    state.tab = tab;
    document.querySelectorAll('.view').forEach((v) => { v.hidden = v.id !== `view-${tab}`; });
    document.querySelectorAll('.bottom-nav button').forEach((b) => {
      if (b.dataset.tab === tab) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
    $('screen-title').textContent = TITLES[tab];
    document.title = `${TITLES[tab]} · Almacén`;
    $('fab-add').hidden = tab !== 'almacen';
    window.scrollTo(0, 0);
    if (tab === 'movimientos') loadMovements(true);
    else if (tab === 'config') Settings.render();
  }

  /* =====================================================================
     Actualizaciones (service worker)
     ===================================================================== */
  let swReg = null;
  let updateRequested = false;

  function showUpdateButton() {
    $('update-slot').innerHTML = `<button type="button" class="btn small" data-a="apply-update">Actualizar app</button>`;
  }

  function registerSW() {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('service-worker.js').then((reg) => {
      swReg = reg;
      if (reg.waiting && navigator.serviceWorker.controller) showUpdateButton();
      reg.addEventListener('updatefound', () => {
        const nw = reg.installing;
        if (!nw) return;
        nw.addEventListener('statechange', () => {
          if (nw.state === 'installed' && navigator.serviceWorker.controller) showUpdateButton();
        });
      });
    }).catch((e) => console.warn('No se pudo registrar el service worker:', e));
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (updateRequested) location.reload();
    });
  }

  async function checkUpdate(manual) {
    if (!swReg) { if (manual) UI.toast('La actualización automática no está disponible en este navegador.'); return; }
    try {
      await swReg.update();
      if (swReg.waiting) { showUpdateButton(); if (manual) UI.toast('Hay una versión nueva. Pulsa «Actualizar app» arriba.', 'ok'); }
      else if (manual) UI.toast('Ya tienes la última versión.', 'ok');
    } catch (_) {
      if (manual) UI.toast('No se pudo comprobar (¿sin conexión?). La app sigue funcionando.');
    }
  }

  function applyUpdate() {
    if (swReg && swReg.waiting) {
      updateRequested = true;
      swReg.waiting.postMessage({ type: 'SKIP_WAITING' });
    } else location.reload();
  }

  /* =====================================================================
     Arranque
     ===================================================================== */
  function bindEvents() {
    // Navegación
    document.querySelector('.bottom-nav').addEventListener('click', (e) => {
      const b = e.target.closest('[data-tab]');
      if (b) go(b.dataset.tab);
    });
    $('update-slot').addEventListener('click', (e) => { if (e.target.closest('[data-a=apply-update]')) applyUpdate(); });
    $('fab-add').addEventListener('click', () => openForm(null));

    // Búsqueda y filtros
    let timer = null;
    $('search').addEventListener('input', (e) => {
      clearTimeout(timer);
      timer = setTimeout(() => { state.filters.query = e.target.value; state.listLimit = PAGE; renderProducts(); }, 120);
    });
    $('btn-filters').addEventListener('click', () => {
      const panel = $('filters-panel');
      panel.hidden = !panel.hidden;
      $('btn-filters').setAttribute('aria-expanded', String(!panel.hidden));
    });
    const onFilter = () => {
      const f = state.filters;
      const newCat = $('f-category').value;
      if (newCat !== f.categoryId) { f.categoryId = newCat; f.subcategoryId = ''; } else f.subcategoryId = $('f-sub').value;
      f.sort = $('f-sort').value;
      f.status = $('f-status').value;
      state.listLimit = PAGE;
      renderFilters();
      renderProducts();
    };
    ['f-category', 'f-sub', 'f-sort', 'f-status'].forEach((id) => $(id).addEventListener('change', onFilter));
    const clearFilters = () => {
      state.filters = { query: '', categoryId: '', subcategoryId: '', sort: 'name', status: state.settings.defaultStatus === 'all' ? 'all' : 'active' };
      $('search').value = '';
      state.listLimit = PAGE;
      renderFilters();
      renderProducts();
    };
    $('btn-clear-filters').addEventListener('click', clearFilters);
    $('btn-categories').addEventListener('click', () => Categories.openManager());
    $('btn-more').addEventListener('click', () => { state.listLimit += PAGE; renderProducts(); });

    // Lista de productos
    const list = $('product-list');
    list.addEventListener('click', (e) => {
      const z = e.target.closest('[data-zoom]');
      if (z) { e.stopPropagation(); Gallery.openProductPhoto(z.dataset.zoom); return; }
      const empty = e.target.closest('[data-empty]');
      if (empty) { if (empty.dataset.empty === 'add') openForm(null); else clearFilters(); return; }
      const card = e.target.closest('.product');
      if (card) openProduct(card.dataset.id);
    });
    list.addEventListener('keydown', (e) => {
      if ((e.key === 'Enter' || e.key === ' ') && e.target.classList.contains('product')) { e.preventDefault(); openProduct(e.target.dataset.id); }
    });
    $('backup-reminder').addEventListener('click', (e) => {
      const b = e.target.closest('[data-rem]');
      if (!b) return;
      if (b.dataset.rem === 'later') { state.reminderDismissed = true; renderReminder(); return; }
      UI.once('export', async () => { try { await Settings.doExport(false); renderReminder(); } catch (err) { UI.toast(DB.friendlyError(err), 'error'); } });
    });

    // Movimientos
    let mt = null;
    $('mv-search').addEventListener('input', (e) => { clearTimeout(mt); mt = setTimeout(() => { state.mv.q = e.target.value; loadMovements(true); }, 150); });
    $('mv-types').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      state.mv.type = b.dataset.type;
      syncTypeButtons();
      loadMovements(true);
    });
    $('mv-from').addEventListener('change', (e) => { state.mv.from = e.target.value; loadMovements(true); });
    $('mv-to').addEventListener('change', (e) => { state.mv.to = e.target.value; loadMovements(true); });
    $('mv-more').addEventListener('click', () => loadMovements(false));
    $('view-movimientos').addEventListener('click', (e) => {
      if (e.target.closest('[data-mv=clear-product]')) { state.mv.productId = null; loadMovements(true); return; }
      const card = e.target.closest('[data-mid]');
      if (card) { const m = state.mv.items.find((x) => x.id === card.dataset.mid); if (m) openMovementDetail(m); }
    });

    // Tema automático
    if (window.matchMedia) {
      const mq = matchMedia('(prefers-color-scheme: dark)');
      const onChange = () => { if (state.settings.theme === 'system') Settings.applyAppearance(); };
      if (mq.addEventListener) mq.addEventListener('change', onChange);
    }
  }

  function showFatal(e) {
    const box = $('fatal');
    box.hidden = false;
    $('app').hidden = true;
    box.innerHTML = `<h2 style="margin-bottom:8px">No se pudo iniciar la aplicación</h2>
      <p>${esc(DB.friendlyError(e))}</p>
      <p style="margin-top:8px">No se borró ningún dato. Cierra y vuelve a abrir la aplicación; si el problema continúa, avisa a quien te la instaló.</p>
      <p style="margin-top:12px"><button type="button" class="btn" onclick="location.reload()">Reintentar</button></p>
      <pre>${esc(e && e.stack ? e.stack : String(e))}</pre>`;
  }

  async function boot() {
    try {
      await DB.open();
      await Settings.load();
      Settings.applyAppearance();
      state.filters.status = state.settings.defaultStatus === 'all' ? 'all' : 'active';
      await reload();
      bindEvents();
      Gallery.init();
      Settings.init();
      renderFilters();
      renderProducts();
      Gallery.renderSection();
      go('almacen');
      registerSW();
      DB.requestPersist();
    } catch (e) {
      console.error(e);
      showFatal(e);
    }
  }

  // Los errores inesperados no se ocultan: se avisa sin perder lo que haya en pantalla.
  let lastErrAt = 0;
  const reportUnexpected = (msg) => {
    console.error(msg);
    if (Date.now() - lastErrAt < 3000) return;
    lastErrAt = Date.now();
    UI.toast('Ocurrió un error inesperado. Tus datos guardados no se han tocado.', 'error');
  };
  window.addEventListener('error', (ev) => reportUnexpected(ev.error || ev.message));
  window.addEventListener('unhandledrejection', (ev) => reportUnexpected(ev.reason));

  globalThis.App = {
    state, reload, refresh, afterRestore, go, boot,
    openProduct, openForm, openMovement, showHistory, showCategory,
    renderProducts, renderFilters, loadMovements, checkUpdate,
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();

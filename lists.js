'use strict';
/* lists.js — Generador de listados de texto para clientes.
   Solo LEE el inventario: nunca modifica existencias, precios ni productos,
   y nunca incluye fotografías (esas se comparten únicamente desde la galería). */
(function () {
  const { Inventory } = globalThis;
  const norm = (s) => Inventory.norm(s);
  const esc = (s) => UI.esc(s);

  const FORMATS = [
    { id: 1, name: 'Solo productos', example: '- 7.1' },
    { id: 2, name: 'Productos y cantidades', example: '- 7.1 — 12 unidades' },
    { id: 3, name: 'Productos y precios', example: '- 7.1 — 500 CUP' },
    { id: 4, name: 'Productos, precios y cantidades', example: '- 7.1 — 12 unidades — 500 CUP' },
  ];

  const DEFAULT_PREFS = {
    format: 1, order: 'alpha',
    includeUnknownQty: true, unknownQtyLabel: 'Sin cantidad registrada',
    includeNoPrice: true, noPriceLabel: 'Sin precio',
    excludeZero: false, stripPrefix: true,
    includeEstimated: true, includeColor: false,
  };

  /* Quita del nombre el texto de su subcategoría ("Stereo 7.1" → "7.1" bajo el título STEREO). */
  function displayName(p, sub, strip) {
    if (!strip || !sub) return p.name;
    const n = norm(p.name);
    const s = norm(sub.name);
    if (!s || !n.startsWith(s) || n.length === s.length) return p.name;
    // Se recorta por longitud solo si el nombre original comienza igual (mismos caracteres base).
    if (norm(p.name.slice(0, sub.name.length)) !== s) return p.name;
    const rest = p.name.slice(sub.name.length).replace(/^[\s\-–—:·.,]+/, '').trim();
    return rest || p.name;
  }

  /* Función pura: no accede a la base de datos. Devuelve { text, count, excluded }.
     o: { scope:{type,id,ids}, format, title, note, order, includeUnknownQty, unknownQtyLabel,
          includeNoPrice, noPriceLabel, excludeZero, stripPrefix, currency } */
  function generate(o, products, byId) {
    const fmt = Number(o.format) || 1;
    const wantsQty = fmt === 2 || fmt === 4;
    const wantsPrice = fmt === 3 || fmt === 4;
    const scope = o.scope || { type: 'all' };
    const ids = new Set(scope.ids || []);
    const currency = o.currency || 'CUP';
    const excluded = { unknownQty: 0, noPrice: 0, zero: 0 };

    let list = products.filter((p) => !p.archived);
    if (scope.type === 'category') list = list.filter((p) => p.categoryId === scope.id);
    else if (scope.type === 'sub') list = list.filter((p) => p.subcategoryId === scope.id);
    else if (scope.type === 'manual') list = list.filter((p) => ids.has(p.id));

    const rows = [];
    for (const p of list) {
      const isEst = p.quantityStatus === 'estimated' && p.quantity !== null && p.quantity !== undefined;
      const qtyKnown = p.quantity !== null && p.quantity !== undefined && !(isEst && o.includeEstimated === false);
      if (o.excludeZero && qtyKnown && !isEst && p.quantity === 0) { excluded.zero++; continue; }
      if (wantsQty && !qtyKnown && !o.includeUnknownQty) { excluded.unknownQty++; continue; }
      const price = Categories.resolvePrice(p, byId);
      const hasPrice = price.value !== null;
      if (wantsPrice && !hasPrice && !o.includeNoPrice) { excluded.noPrice++; continue; }
      const sub = p.subcategoryId ? byId.get(p.subcategoryId) : null;
      const cat = p.categoryId ? byId.get(p.categoryId) : null;
      let line = displayName(p, sub, o.stripPrefix);
      if (o.includeColor && p.color && !norm(line).includes(norm(p.color))) line += ` (${p.color})`;
      const extras = [];
      if (wantsQty) {
        extras.push(qtyKnown ? `${isEst ? 'aprox. ' : ''}${Inventory.qtyText(p.quantity, p.unit)}` : (o.unknownQtyLabel || 'Sin cantidad registrada'));
      }
      if (wantsPrice) {
        extras.push(hasPrice ? `${Inventory.fmtNum(price.value)} ${currency}` : (o.noPriceLabel || 'Sin precio'));
      }
      line = ['- ' + line, ...extras].join(' — ');
      rows.push({ p, cat, sub, line, name: p.name });
    }

    const catIds = new Set(rows.map((r) => (r.cat ? r.cat.id : '')));
    const multiCat = catIds.size > 1;
    const groups = new Map();
    for (const r of rows) {
      const key = `${r.cat ? r.cat.id : ''}|${r.sub ? r.sub.id : ''}`;
      if (!groups.has(key)) {
        let header;
        if (r.sub) header = multiCat && r.cat ? `${r.cat.name} · ${r.sub.name}` : r.sub.name;
        else if (r.cat) header = r.cat.name;
        else header = 'Sin categoría';
        groups.set(key, {
          key, header: header.toLocaleUpperCase('es'),
          cOrder: r.cat ? r.cat.order : Infinity, sOrder: r.sub ? r.sub.order : -1,
          rows: [],
        });
      }
      groups.get(key).rows.push(r);
    }
    const glist = [...groups.values()];
    if (o.order === 'inventory') {
      glist.sort((a, b) => (a.cOrder - b.cOrder) || (a.sOrder - b.sOrder));
      glist.forEach((g) => g.rows.sort((a, b) => a.p.createdAt - b.p.createdAt));
    } else {
      glist.sort((a, b) => Inventory.collator.compare(a.header, b.header));
      glist.forEach((g) => g.rows.sort((a, b) => Inventory.collator.compare(a.line, b.line)));
    }

    const lines = [];
    const title = (o.title || '').trim();
    const note = (o.note || '').trim();
    if (title) lines.push(title);
    if (note) lines.push(note);
    if (title || note) lines.push('');
    const onlyUncategorized = glist.length === 1 && glist[0].key === '|';
    glist.forEach((g, gi) => {
      if (!onlyUncategorized) { lines.push(g.header); lines.push(''); }
      g.rows.forEach((r) => lines.push(r.line));
      if (gi < glist.length - 1) lines.push('');
    });
    return { text: rows.length ? lines.join('\n') : '', count: rows.length, excluded };
  }

  /* ---------------- Interfaz ---------------- */

  function pickProducts(current) {
    const st = App.state;
    const active = st.products.filter((p) => !p.archived).sort((a, b) => Inventory.collator.compare(a.name, b.name));
    const chosen = new Set(current);
    return new Promise((resolve) => {
      let result = null;
      UI.modal({
        title: 'Elegir productos', cls: 'full',
        html: `<div class="stack"><input type="search" id="pk-q" placeholder="Buscar producto" autocomplete="off" aria-label="Buscar producto">
          <div class="inline"><button type="button" class="btn secondary small" data-pk="all">Marcar los visibles</button><button type="button" class="btn secondary small" data-pk="none">Quitar todos</button></div>
          <div id="pk-count" class="muted small-text"></div>
          <div class="pick-list" id="pk-list"></div></div>`,
        actions: [{ id: 'cancel', label: 'Cancelar', kind: 'ghost' }, { id: 'ok', label: 'Listo', kind: 'primary' }],
        onOpen(d) {
          const q = d.body.querySelector('#pk-q');
          const listEl = d.body.querySelector('#pk-list');
          const count = d.body.querySelector('#pk-count');
          let visible = active;
          const draw = () => {
            const tokens = norm(q.value).split(/\s+/).filter(Boolean);
            visible = active.filter((p) => {
              const hay = norm(`${p.name} ${p.brand} ${p.code}`);
              return tokens.every((t) => hay.includes(t));
            });
            listEl.innerHTML = visible.map((p) => `<label class="pick-item"><input type="checkbox" value="${p.id}" ${chosen.has(p.id) ? 'checked' : ''}>
              <span><b>${esc(p.name)}</b><br><span class="muted small-text">${esc([p.brand, p.code].filter(Boolean).join(' · '))}</span></span></label>`).join('')
              || '<div class="empty">No hay productos que coincidan.</div>';
            count.textContent = `${chosen.size} seleccionado${chosen.size === 1 ? '' : 's'}`;
          };
          draw();
          q.addEventListener('input', draw);
          listEl.addEventListener('change', (e) => {
            const cb = e.target.closest('input[type=checkbox]');
            if (!cb) return;
            if (cb.checked) chosen.add(cb.value); else chosen.delete(cb.value);
            count.textContent = `${chosen.size} seleccionado${chosen.size === 1 ? '' : 's'}`;
          });
          d.body.addEventListener('click', (e) => {
            const b = e.target.closest('[data-pk]');
            if (!b) return;
            if (b.dataset.pk === 'all') visible.forEach((p) => chosen.add(p.id)); else chosen.clear();
            draw();
          });
        },
        onAction(id) { if (id === 'ok') result = new Set(chosen); },
      }).then((id) => resolve(id === 'ok' ? result : null));
    });
  }

  function openGenerator() {
    const st = App.state;
    const prefs = Object.assign({}, DEFAULT_PREFS, st.settings.listPrefs || {});
    const s = { scopeType: 'all', scopeId: '', ids: new Set(), title: '', note: '' };

    const formatsHtml = FORMATS.map((f) => `
      <label class="format-opt" data-f="${f.id}"><input type="radio" name="l-format" value="${f.id}" ${prefs.format === f.id ? 'checked' : ''}>
        <span><b>${f.id}. ${esc(f.name)}</b><small>${esc(f.example.replace('CUP', st.settings.currency))}</small></span></label>`).join('');

    const d = UI.dialog({
      title: 'Generador de listados', cls: 'full',
      html: `<div class="stack">
        <p class="muted">Crea un texto para copiar o compartir (por ejemplo, por WhatsApp). No incluye fotos y no cambia tu inventario.</p>
        <div class="section-title">1. Productos</div>
        <label class="field"><span>¿Qué quieres incluir?</span>
          <select id="l-scope">
            <option value="all">Todo el inventario</option>
            <option value="category">Una categoría</option>
            <option value="sub">Una subcategoría</option>
            <option value="manual">Productos que elija</option>
          </select></label>
        <label class="field" id="l-id-wrap" hidden><span id="l-id-label">Categoría</span><select id="l-id"></select></label>
        <div id="l-manual" hidden class="inline"><button type="button" class="btn secondary" id="l-pick">Elegir productos…</button><span id="l-pick-count" class="muted small-text"></span></div>
        <div class="section-title">2. Formato</div>
        <div class="formats">${formatsHtml}</div>
        <div class="section-title">3. Presentación</div>
        <label class="field"><span>Título (opcional)</span><input id="l-title" maxlength="80" placeholder="Ej. Lista de precios" autocomplete="off"></label>
        <label class="field"><span>Nota (opcional)</span><textarea id="l-note" maxlength="300" placeholder="Ej. Precios sujetos a cambio"></textarea></label>
        <label class="field"><span>Orden</span>
          <select id="l-order"><option value="alpha">Alfabético</option><option value="inventory">Orden del inventario (por categorías)</option></select></label>
        <div id="l-qty-opts">
          <label class="switch"><span class="sw-text">Incluir productos sin cantidad registrada<small>Si lo desactivas, no aparecerán en la lista.</small></span><input type="checkbox" id="l-inc-qty"></label>
          <label class="field"><span>Texto cuando no hay cantidad</span><input id="l-qty-label" maxlength="40"></label>
        </div>
        <div id="l-price-opts">
          <label class="switch"><span class="sw-text">Incluir productos sin precio<small>Si lo desactivas, no aparecerán en la lista.</small></span><input type="checkbox" id="l-inc-price"></label>
          <label class="field"><span>Texto cuando no hay precio</span><input id="l-price-label" maxlength="40"></label>
        </div>
        <label class="switch"><span class="sw-text">No incluir productos agotados (cantidad 0)</span><input type="checkbox" id="l-zero"></label>
        <label class="switch"><span class="sw-text">Mostrar el color junto al nombre<small>Solo si el producto tiene color y no aparece ya en el nombre.</small></span><input type="checkbox" id="l-color"></label>
        <div id="l-est-opts"><label class="switch"><span class="sw-text">Mostrar cantidades aproximadas<small>Se escriben como «aprox.». Si lo desactivas, esos productos se tratan como sin cantidad registrada.</small></span><input type="checkbox" id="l-est"></label></div>
        <label class="switch"><span class="sw-text">Acortar nombres<small>Quita del nombre el texto de su subcategoría: «Stereo 7.1» queda «7.1» bajo STEREO.</small></span><input type="checkbox" id="l-strip"></label>
        <div class="section-title">Vista previa</div>
        <div id="l-count" class="muted small-text"></div>
        <pre class="list-preview" id="l-preview" aria-live="polite"></pre>
      </div>`,
    });
    d.setFoot(`<button type="button" class="btn secondary" data-l="copy">Copiar texto</button><button type="button" class="btn" data-l="share">Compartir</button>`);

    const $ = (id) => d.body.querySelector(id);
    $('#l-order').value = prefs.order;
    $('#l-inc-qty').checked = prefs.includeUnknownQty;
    $('#l-qty-label').value = prefs.unknownQtyLabel;
    $('#l-inc-price').checked = prefs.includeNoPrice;
    $('#l-price-label').value = prefs.noPriceLabel;
    $('#l-zero').checked = prefs.excludeZero;
    $('#l-strip').checked = prefs.stripPrefix;
    $('#l-color').checked = prefs.includeColor;
    $('#l-est').checked = prefs.includeEstimated;

    const currentFormat = () => Number((d.body.querySelector('input[name=l-format]:checked') || {}).value) || 1;

    const options = () => ({
      scope: { type: s.scopeType, id: s.scopeId, ids: [...s.ids] },
      format: currentFormat(), title: $('#l-title').value, note: $('#l-note').value,
      order: $('#l-order').value,
      includeUnknownQty: $('#l-inc-qty').checked, unknownQtyLabel: $('#l-qty-label').value.trim() || 'Sin cantidad registrada',
      includeNoPrice: $('#l-inc-price').checked, noPriceLabel: $('#l-price-label').value.trim() || 'Sin precio',
      excludeZero: $('#l-zero').checked, stripPrefix: $('#l-strip').checked,
      includeColor: $('#l-color').checked, includeEstimated: $('#l-est').checked,
      currency: st.settings.currency,
    });

    let lastText = '';
    const update = () => {
      const f = currentFormat();
      d.body.querySelectorAll('.format-opt').forEach((el) => el.classList.toggle('sel', Number(el.dataset.f) === f));
      $('#l-qty-opts').hidden = !(f === 2 || f === 4);
      $('#l-est-opts').hidden = !(f === 2 || f === 4);
      $('#l-price-opts').hidden = !(f === 3 || f === 4);
      const o = options();
      const r = generate(o, st.products, st.catById);
      lastText = r.text;
      const notes = [];
      if (r.excluded.unknownQty) notes.push(`${r.excluded.unknownQty} sin cantidad registrada`);
      if (r.excluded.noPrice) notes.push(`${r.excluded.noPrice} sin precio`);
      if (r.excluded.zero) notes.push(`${r.excluded.zero} agotado${r.excluded.zero === 1 ? '' : 's'}`);
      $('#l-count').textContent = `${r.count} producto${r.count === 1 ? '' : 's'} en la lista` + (notes.length ? ` · no incluidos: ${notes.join(', ')}` : '');
      $('#l-preview').textContent = r.text || 'No hay productos para este listado. Cambia la selección o las opciones.';
      d.foot.querySelectorAll('button').forEach((b) => { b.disabled = !r.text; });
      $('#l-pick-count').textContent = s.scopeType === 'manual' ? `${s.ids.size} elegido${s.ids.size === 1 ? '' : 's'}` : '';
    };

    const fillScopeIds = () => {
      const wrap = $('#l-id-wrap');
      const sel = $('#l-id');
      wrap.hidden = !(s.scopeType === 'category' || s.scopeType === 'sub');
      $('#l-manual').hidden = s.scopeType !== 'manual';
      if (wrap.hidden) return;
      if (s.scopeType === 'category') {
        $('#l-id-label').textContent = 'Categoría';
        sel.innerHTML = Categories.rootsOf(st.categories).map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
      } else {
        $('#l-id-label').textContent = 'Subcategoría';
        sel.innerHTML = Categories.rootsOf(st.categories).flatMap((c) => Categories.childrenOf(st.categories, c.id).map((x) => `<option value="${x.id}">${esc(c.name)} › ${esc(x.name)}</option>`)).join('');
      }
      if (!sel.options.length) {
        sel.innerHTML = `<option value="">(Aún no hay ${s.scopeType === 'sub' ? 'subcategorías' : 'categorías'})</option>`;
      }
      s.scopeId = sel.value;
    };

    let saveTimer = null;
    const savePrefs = () => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        const o = options();
        Settings.set('listPrefs', {
          format: o.format, order: o.order, includeUnknownQty: o.includeUnknownQty, unknownQtyLabel: o.unknownQtyLabel,
          includeNoPrice: o.includeNoPrice, noPriceLabel: o.noPriceLabel, excludeZero: o.excludeZero, stripPrefix: o.stripPrefix,
          includeColor: o.includeColor, includeEstimated: o.includeEstimated,
        }).catch(() => {});
      }, 400);
    };

    $('#l-scope').addEventListener('change', (e) => { s.scopeType = e.target.value; fillScopeIds(); update(); });
    $('#l-id').addEventListener('change', (e) => { s.scopeId = e.target.value; update(); });
    $('#l-pick').addEventListener('click', async () => {
      const res = await pickProducts(s.ids);
      if (res) { s.ids = res; update(); }
    });
    d.body.addEventListener('input', () => { update(); savePrefs(); });
    d.body.addEventListener('change', () => { update(); savePrefs(); });

    d.el.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-l]');
      if (!b || !lastText) return;
      if (b.dataset.l === 'copy') {
        const ok = await UI.copyText(lastText);
        UI.toast(ok ? 'Texto copiado. Ya puedes pegarlo en WhatsApp u otra aplicación.' : 'No se pudo copiar automáticamente. Mantén pulsado el texto de la vista previa para copiarlo.', ok ? 'ok' : 'error');
      } else if (b.dataset.l === 'share') {
        if (navigator.share) {
          try {
            await navigator.share({ text: lastText });
          } catch (err) {
            if (!err || err.name !== 'AbortError') UI.toast('No se pudo abrir el menú de compartir. Usa «Copiar texto».', 'error');
          }
        } else {
          const ok = await UI.copyText(lastText);
          UI.toast(ok ? 'Este navegador no puede compartir texto directamente. Lo copié: pégalo en WhatsApp.' : 'Este navegador no puede compartir texto. Usa «Copiar texto».', ok ? '' : 'error');
        }
      }
    });

    fillScopeIds();
    update();
    return d;
  }

  globalThis.Lists = { FORMATS, DEFAULT_PREFS, generate, displayName, openGenerator };
})();

'use strict';
/* cart.js — Carritos de salida y de entrada.
   Se arman tocando botones rápidos sobre los productos y se confirman de una vez, como un pedido
   (con el nombre del cliente o proveedor). Al confirmar, TODOS los movimientos se guardan en una
   sola transacción: o se registra el pedido completo o no cambia nada. */
(function () {
  const { Inventory, AppError, DB } = globalThis;
  const esc = (s) => UI.esc(s);
  const fmt = Inventory.fmtNum;
  const LABEL = {
    salida: { name: 'Salida', cart: 'Carrito de salida', party: 'Cliente (a quién se le lleva)', ph: 'Ej. María Pérez', ok: 'Confirmar salida' },
    entrada: { name: 'Entrada', cart: 'Carrito de entrada', party: 'Proveedor o procedencia (opcional)', ph: 'Ej. Proveedor Habana', ok: 'Confirmar entrada' },
    apartar: { name: 'Apartado', cart: 'Pedido apartado', party: 'Cliente (para quién se aparta)', ph: 'Ej. María Pérez', ok: 'Guardar pedido apartado' },
    baja: { name: 'Baja', cart: 'Carrito de baja (pérdida o retiro)', party: 'Quién retira o reporta (opcional)', ph: 'Ej. Papá', ok: 'Confirmar baja' },
  };

  const blankCart = () => ({ items: {}, prices: {}, party: '', note: '', reason: '', date: '', heldId: null, opId: DB.uuid() });
  const TYPES = ['salida', 'entrada', 'baja', 'apartar'];
  let carts = { salida: blankCart(), entrada: blankCart(), baja: blankCart(), apartar: blankCart() };
  let mode = 'ver'; // ver | salida | entrada
  let saveTimer = null;

  const S = () => App.state;
  const steps = () => (S().settings.quickSteps && S().settings.quickSteps.length ? S().settings.quickSteps : [1, 5, 10, 12, 50]);
  const productOf = (id) => S().products.find((p) => p.id === id);

  function load() {
    const raw = S().settings.carts;
    if (raw && typeof raw === 'object') {
      for (const t of TYPES) {
        const c = raw[t];
        if (c && typeof c === 'object') {
          carts[t] = { items: Object.assign({}, c.items || {}), prices: Object.assign({}, c.prices || {}), party: String(c.party || ''), note: String(c.note || ''), reason: String(c.reason || ''), date: String(c.date || ''), heldId: typeof c.heldId === 'string' ? c.heldId : null, opId: typeof c.opId === 'string' && c.opId ? c.opId : DB.uuid() };
        }
      }
    }
    prune();
  }

  /* Quita del carrito productos que ya no existen o fueron archivados. */
  function prune() {
    for (const t of TYPES) {
      for (const id of Object.keys(carts[t].items)) {
        const p = productOf(id);
        if (!p || p.archived) delete carts[t].items[id];
      }
    }
  }

  function persist() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { Settings.set('carts', carts).catch(() => {}); }, 300);
  }

  const cartOf = (t) => carts[t];
  const qty = (t, id) => carts[t].items[id] || 0;
  const count = (t) => Object.keys(carts[t].items).length;
  const total = (t) => Object.values(carts[t].items).reduce((a, b) => a + b, 0);

  const listPrice = (p) => { const r = Categories.resolvePrice(p, S().catById); return r.value; };
  /* Precio que se usará en el pedido: el que escribas en el carrito, o el del producto/subcategoría/categoría. */
  function effPrice(t, p) {
    if (t !== 'salida' && t !== 'apartar') return null;
    const o = carts[t].prices[p.id];
    if (o !== undefined && o !== null) return o;
    const lp = listPrice(p);
    return lp === undefined ? null : lp;
  }
  function money(v) { return `${fmt(Inventory.round2(v))} ${S().settings.currency}`; }
  function orderTotal(t) {
    let sum = 0; let missing = 0;
    for (const [id, n] of Object.entries(carts[t].items)) {
      const p = productOf(id); if (!p) continue;
      const pr = effPrice(t, p);
      if (pr === null) missing++; else sum += n * pr;
    }
    return { sum: Inventory.round2(sum), missing };
  }

  function maxFor(t, p) {
    return Infinity; // si supera la existencia se avisa y se puede registrar como discrepancia
  }

  /* Cambia la cantidad de un producto en el carrito. Devuelve la cantidad final. */
  function setQty(t, id, n) {
    const p = productOf(id);
    if (!p) return 0;
    if ((p.quantity === null || p.quantity === undefined) && t === 'entrada') {
      UI.toast(`«${p.name}» no tiene existencia registrada. Establécela primero con «Ajustar existencia».`, 'error');
      return qty(t, id);
    }
    n = Inventory.round6(Number(n));
    if (!Number.isFinite(n) || n < 0) n = 0;
    const max = maxFor(t, p);
    if (n <= 0) delete carts[t].items[id]; else carts[t].items[id] = n;
    persist();
    return n;
  }

  /* ---- Botones sobre cada producto ---- */
  function controlsHtml(p) {
    if (mode === 'ver' || p.archived) return '';
    const t = mode;
    const unknown = p.quantity === null || p.quantity === undefined;
    if (unknown && t === 'entrada') return `<div class="cart-row" data-pid="${p.id}"><span class="muted small-text">Sin existencia registrada: ajústala primero para poder registrar una entrada.</span></div>`;
    const q = qty(t, p.id);
    const over = t !== 'entrada' && q > 0 && (unknown || (!S().settings.allowOversell && q > p.quantity));
    return `<div class="cart-row ${t}" data-pid="${p.id}">
      ${over ? `<div class="field-error" style="flex:1 0 100%">${unknown ? 'Existencia sin confirmar: se registrará como discrepancia' : `Solo hay ${esc(fmt(p.quantity))}: se registrará como discrepancia`}</div>` : ''}
      <div class="cart-step"><button type="button" class="btn secondary small" data-c="add" data-n="-1" aria-label="Quitar uno">−</button>
        <input class="cq" inputmode="decimal" value="${q ? esc(fmt(q)) : ''}" placeholder="0" aria-label="Cantidad de ${esc(p.name)}">
        <button type="button" class="btn secondary small" data-c="add" data-n="1" aria-label="Añadir uno">+</button></div>
      <div class="cart-quick">${steps().filter((n) => n !== 1).map((n) => `<button type="button" class="btn small" data-c="add" data-n="${n}">+${esc(fmt(n))}</button>`).join('')}${q ? '<button type="button" class="btn ghost small" data-c="clear">Quitar</button>' : ''}</div></div>`;
  }

  let busy = false;
  function refreshCard(id) {
    if (busy) return;
    busy = true;
    try { refreshCard2(id); } finally { busy = false; }
  }

  function refreshCard2(id) {
    const card = document.querySelector(`#product-list .product[data-id="${id}"]`);
    const p = productOf(id);
    if (card && p) {
      const old = card.querySelector('.cart-row');
      if (old && !old.isConnected) return;
      if (old && document.activeElement && old.contains(document.activeElement)) document.activeElement.blur();
      const html = controlsHtml(p);
      if (old) old.outerHTML = html; else card.insertAdjacentHTML('beforeend', html);
      card.classList.toggle('in-cart', qty(mode, id) > 0);
    }
    renderBar();
    renderModeSeg();
  }

  /* Devuelve true si el clic era de un botón del carrito. */
  function handleClick(e) {
    const b = e.target.closest('[data-c]');
    if (!b) return !!e.target.closest('.cart-row');
    const row = b.closest('.cart-row');
    const id = row.dataset.pid;
    if (b.dataset.c === 'add') {
      const p = productOf(id);
      const cur = qty(mode, id);
      const delta = Number(b.dataset.n);
      // Si el valor tecleado todavía no se confirmó, se toma el del campo.
      const typed = row.querySelector('.cq').value.trim();
      const base = typed !== '' && Number.isFinite(Number(typed.replace(',', '.'))) ? Number(typed.replace(',', '.')) : cur;
      setQty(mode, id, base + delta);
      if (p) refreshCard(id);
    } else if (b.dataset.c === 'clear') {
      setQty(mode, id, 0);
      refreshCard(id);
    }
    return true;
  }

  function handleChange(e) {
    const inp = e.target.closest('.cq');
    if (!inp) return false;
    if (!inp.isConnected || busy) return true;
    const id = inp.closest('.cart-row').dataset.pid;
    const raw = inp.value.trim().replace(',', '.');
    setQty(mode, id, raw === '' ? 0 : Number(raw));
    refreshCard(id);
    return true;
  }

  /* ---- Selector de modo y barra del carrito ---- */
  function renderModeSeg() {
    const el = document.getElementById('mode-seg');
    if (!el) return;
    el.innerHTML = [['ver', 'Consultar', 0], ['salida', 'Salida', count('salida')], ['entrada', 'Entrada', count('entrada')], ['baja', 'Baja', count('baja')], ['apartar', 'Apartar', count('apartar')], ['pedidos', 'Pedidos', heldActive().length]]
      .map(([v, l, n]) => `<button type="button" data-mode="${v}" aria-pressed="${mode === v && v !== 'pedidos'}">${l}${n ? ` <span class="badge-n">${n}</span>` : ''}</button>`).join('');
  }

  function renderBar() {
    const el = document.getElementById('cart-bar');
    if (!el) return;
    if (mode === 'ver') { el.hidden = true; el.innerHTML = ''; document.body.classList.remove('cart-on'); return; }
    const n = count(mode);
    el.hidden = false;
    document.body.classList.add('cart-on');
    el.className = `cart-bar ${mode}`;
    el.innerHTML = n
      ? `<div class="cb-text"><b>${LABEL[mode].cart}</b><span>${n} producto${n === 1 ? '' : 's'} · ${esc(fmt(total(mode)))} unidades</span></div><button type="button" class="btn" data-cb="open">Ver y confirmar</button>`
      : `<div class="cb-text"><b>${LABEL[mode].cart} vacío</b><span>Toca + en los productos para añadirlos</span></div>`;
  }

  function setMode(m) {
    mode = m;
    document.getElementById('fab-add').hidden = m !== 'ver' || S().tab !== 'almacen';
    renderModeSeg();
    renderBar();
    App.renderProducts();
  }

  function refreshUI() {
    prune();
    renderModeSeg();
    renderBar();
    if (S().tab === 'almacen') App.renderProducts();
  }

  /* ---- Ventana del carrito ---- */
  async function knownParties() {
    try {
      const mv = await DB.getAll('movements');
      const seen = new Map();
      for (const m of mv) if (m.party) seen.set(m.party, Math.max(seen.get(m.party) || 0, m.createdAt));
      return [...seen.entries()].sort((a, b) => b[1] - a[1]).map((x) => x[0]).slice(0, 60);
    } catch (_) { return []; }
  }

  async function open(t) {
    t = t || mode;
    if (!LABEL[t] || t === 'ver') return;
    const L = LABEL[t];
    const parties = await knownParties();
    const c = () => carts[t];
    const body = () => {
      const items = Object.entries(c().items).map(([id, n]) => ({ p: productOf(id), n })).filter((x) => x.p);
      items.sort((a, b) => Inventory.collator.compare(a.p.name, b.p.name));
      return items.length ? items.map(({ p, n }) => {
        const unk = p.quantity === null || p.quantity === undefined;
        const over = t !== 'entrada' && (unk || (!S().settings.allowOversell && n > p.quantity));
        return `<div class="ci" data-pid="${p.id}">
          <div class="ci-main"><b>${esc(p.name)}</b><div class="muted small-text">${esc([p.color, p.presentation].filter(Boolean).join(' · '))}${p.quantity !== null ? ` · Hay ${esc(Inventory.qtyText(p.quantity, p.unit))}` : ''}</div>${over ? `<div class="field-error">${unk ? 'Existencia sin confirmar' : 'Supera la existencia'}: se registrará como discrepancia</div>` : ''}</div>
          <div class="cart-step"><button type="button" class="btn secondary small" data-ci="dec" aria-label="Quitar uno">−</button>
            <input class="cq" inputmode="decimal" value="${esc(fmt(n))}" aria-label="Cantidad">
            <button type="button" class="btn secondary small" data-ci="inc" aria-label="Añadir uno">+</button>
            <button type="button" class="btn danger-ghost small" data-ci="rm" aria-label="Quitar del carrito">✕</button></div>
          ${(t === 'salida' || t === 'apartar') ? `<div class="ci-price"><label>Precio c/u <input class="cp" inputmode="decimal" placeholder="${listPrice(p) === null || listPrice(p) === undefined ? 'Sin precio' : esc(fmt(listPrice(p)))}" value="${c().prices[p.id] !== undefined ? esc(fmt(c().prices[p.id])) : ''}" aria-label="Precio de ${esc(p.name)}"></label>
            <span class="ci-sub">${effPrice(t, p) === null ? '—' : esc(money(n * effPrice(t, p)))}</span></div>` : ''}</div>`;
      }).join('') : '<div class="empty">El carrito está vacío.</div>';
    };
    const html = `<div class="stack">
      <div id="ci-list">${body()}</div>
      <div id="ci-total" class="muted small-text"></div>
      ${t === 'baja' ? `<label class="field"><span>Motivo *</span><select id="ci-reason"><option value="">Elige el motivo…</option>${reasonList().map((x) => `<option value="${esc(x)}" ${c().reason === x ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select></label>
      <label class="field"><span>Fecha del movimiento</span><input id="ci-date" type="date" max="${todayStr()}" value="${esc(c().date || todayStr())}"></label>
      <p class="muted small-text">Una baja descuenta existencias pero <b>no es una venta</b> ni genera ingresos. Para corregir tras contar usa «Ajustar existencia».</p>` : ''}
      <label class="field"><span>${esc(L.party)}</span><input id="ci-party" maxlength="80" list="dl-parties" autocomplete="off" placeholder="${esc(L.ph)}" value="${esc(c().party)}"></label>
      <datalist id="dl-parties">${parties.map((x) => `<option value="${esc(x)}">`).join('')}</datalist>
      <label class="field"><span>Nota (opcional)</span><input id="ci-note" maxlength="300" autocomplete="off" value="${esc(c().note)}"></label>
      <div class="field-error" id="ci-err" role="alert"></div></div>`;

    let confirmed = null; let savedHeld = null;
    await UI.modal({
      title: t === 'apartar' && c().heldId ? `Editando pedido apartado${heldOf(c().heldId) ? ' n.º ' + heldOf(c().heldId).num : ''}` : L.cart, html, cls: 'sheet',
      actions: [{ id: 'cancel', label: 'Seguir añadiendo', kind: 'ghost' }, { id: 'clear', label: 'Vaciar', kind: 'danger-ghost' }, { id: 'ok', label: L.ok, kind: 'primary' }],
      onOpen(d) {
        const q = (s) => d.body.querySelector(s);
        const redraw = () => {
          q('#ci-list').innerHTML = body();
          const ot = (t === 'salida' || t === 'apartar') ? orderTotal(t) : null;
          q('#ci-total').innerHTML = `${count(t)} producto${count(t) === 1 ? '' : 's'} · ${fmt(total(t))} unidades` + (ot ? `<div class="ci-grand">Total: <b>${esc(money(ot.sum))}</b>${ot.missing ? ` <span class="muted small-text">(${ot.missing} sin precio, no incluido${ot.missing === 1 ? '' : 's'})</span>` : ''}</div>` : '');
          d.foot.querySelector('[data-act=ok]').disabled = !count(t);
          d.foot.querySelector('[data-act=clear]').disabled = !count(t);
        };
        redraw();
        d.body.addEventListener('click', (e) => {
          const b = e.target.closest('[data-ci]');
          if (!b) return;
          const id = b.closest('.ci').dataset.pid;
          const cur = qty(t, id);
          if (b.dataset.ci === 'inc') setQty(t, id, cur + 1);
          else if (b.dataset.ci === 'dec') setQty(t, id, cur - 1);
          else setQty(t, id, 0);
          redraw();
        });
        d.body.addEventListener('change', (e) => {
          if (e.target.id === 'ci-reason') { c().reason = e.target.value; persist(); return; }
          if (e.target.id === 'ci-date') { c().date = e.target.value; persist(); return; }
          const pin = e.target.closest('.cp');
          if (pin) {
            const id = pin.closest('.ci').dataset.pid;
            const v = pin.value.trim().replace(',', '.');
            if (v === '') delete c().prices[id]; else if (Number.isFinite(Number(v)) && Number(v) >= 0) c().prices[id] = Number(v); else UI.toast('Escribe un precio válido.', 'error');
            persist(); redraw(); return;
          }
          const inp = e.target.closest('.cq');
          if (inp) { const id = inp.closest('.ci').dataset.pid; setQty(t, id, Number(inp.value.replace(',', '.')) || 0); redraw(); }
        });
        d.body.addEventListener('input', (e) => {
          if (e.target.id === 'ci-party') { c().party = e.target.value; persist(); }
          if (e.target.id === 'ci-note') { c().note = e.target.value; persist(); }
          if (e.target.id === 'ci-date') { c().date = e.target.value; persist(); }
        });
      },
      async onAction(id, bodyEl) {
        const err = bodyEl.querySelector('#ci-err');
        err.textContent = '';
        if (id === 'clear') {
          if (!(await UI.confirm({ title: 'Vaciar el carrito', message: 'Se quitarán todos los productos del carrito. No se cambia ninguna existencia.', okLabel: 'Vaciar', danger: true }))) return false;
          carts[t] = blankCart(); persist();
          return;
        }
        if (id !== 'ok') return;
        if (t === 'salida' && !c().party.trim()) {
          if (!(await UI.confirm({ title: 'Sin nombre de cliente', message: 'No escribiste a quién se le lleva. ¿Registrar la salida sin cliente?', okLabel: 'Registrar igual' }))) {
            bodyEl.querySelector('#ci-party').focus();
            return false;
          }
        }
        if (t === 'apartar') {
          try {
            const prices = {};
            for (const pid of Object.keys(c().items)) { const pr = effPrice(t, productOf(pid)); if (pr !== null) prices[pid] = pr; }
            const r = await Inventory.saveHeldOrder({ id: c().heldId || undefined, items: c().items, prices, party: c().party, note: c().note, opId: c().opId });
            savedHeld = r.order;
            carts[t] = blankCart(); persist();
            return;
          } catch (e) { err.textContent = DB.friendlyError(e); return false; }
        }
        if (t === 'baja' && !c().reason) { err.textContent = 'Elige el motivo de la baja.'; bodyEl.querySelector('#ci-reason').focus(); return false; }
        try {
          const items = Object.entries(c().items).map(([productId, amount]) => ({ productId, amount, price: effPrice(t, productOf(productId)) }));
          const snapshot = items.map((it) => ({ p: productOf(it.productId), n: it.amount, price: it.price }));
          const call = (allow) => Inventory.registerBatch({ type: t, items, party: c().party, note: c().note, opId: c().opId, reason: c().reason, occurredAt: t === 'baja' ? dayMs(c().date) : null, allowDiscrepancy: allow });
          let out;
          try { out = await call(false); } catch (e) {
            if (!(e && e.code === 'DISCREPANCY' || (e && e.extra && e.extra.discrepancy))) throw e;
            const ok = await UI.confirm({
              title: 'Discrepancia de inventario',
              html: `<p>No se puede descontar con seguridad:</p><ul>${(e.extra.problems || []).map((x) => `<li>${esc(x)}</li>`).join('')}</ul><p>Puedes registrar el movimiento como <b>discrepancia para revisión</b>: queda en el historial, pero <b>no cambia la existencia</b> de esos productos (no se inventa ninguna cantidad). Los demás productos sí se descuentan.</p>`,
              okLabel: 'Registrar discrepancia', cancelLabel: 'Volver',
            });
            if (!ok) return false;
            out = await call(true);
          }
          confirmed = { t, party: c().party.trim(), note: c().note.trim(), snapshot, out, currency: S().settings.currency, discrepancies: out.discrepancies || 0, reason: c().reason };
          carts[t] = blankCart(); persist();
        } catch (e) {
          err.textContent = DB.friendlyError(e);
          return false;
        }
      },
    });
    if (savedHeld) await Settings.load();
    await App.refresh();
    refreshUI();
    if (savedHeld) { UI.toast(`Pedido apartado guardado: ${Object.keys(savedHeld.items).length} producto${Object.keys(savedHeld.items).length === 1 ? '' : 's'} descontados del almacén. Se factura desde «Pedidos».`, 'ok'); setMode('ver'); }
    if (confirmed) await showDone(confirmed);
  }

  /* ---- Pedidos apartados ---- */
  const heldAll = () => (Array.isArray(S().settings.heldOrders) ? S().settings.heldOrders : []);
  const heldActive = () => heldAll().filter((o) => o.status === 'apartado');
  const heldOf = (id) => heldAll().find((o) => o.id === id);
  function heldPrice(o, p) {
    const v = o.prices && o.prices[p.id];
    if (v !== undefined && v !== null) return v;
    const lp = listPrice(p);
    return lp === undefined ? null : lp;
  }
  function heldSnapshot(o) {
    return Object.entries(o.items || {}).map(([pid, n]) => ({ p: productOf(pid), n, price: null })).filter((x) => x.p).map((x) => Object.assign(x, { price: heldPrice(o, x.p) }));
  }
  const heldTotal = (o) => Inventory.round2(heldSnapshot(o).reduce((a, x) => a + (x.price === null ? 0 : x.n * x.price), 0));

  async function openHeld() {
    let showClosed = false;
    const html = () => {
      const list = heldAll().filter((o) => (showClosed ? o.status !== 'apartado' : o.status === 'apartado')).sort((a, b) => b.updatedAt - a.updatedAt);
      return `<p class="muted small-text">Los productos de un pedido apartado <b>ya salieron del almacén</b>, pero el pedido todavía no se factura. Puedes seguir editándolo (sumar o restar); al facturar se genera el recibo.</p>
        <div class="seg" style="margin-bottom:8px"><button type="button" data-hv="open" aria-pressed="${!showClosed}">Apartados (${heldActive().length})</button><button type="button" data-hv="closed" aria-pressed="${showClosed}">Facturados / cancelados</button></div>
        ${list.length ? list.map((o) => {
    const snap = heldSnapshot(o);
    const units = Object.values(o.items || {}).reduce((a, b) => a + b, 0);
    const tot = heldTotal(o);
    return `<div class="card" data-oid="${o.id}" style="margin-bottom:8px"><b>Pedido n.º ${o.num}${o.party ? ` — ${esc(o.party)}` : ''}</b>
      <div class="muted small-text">${snap.length} producto${snap.length === 1 ? '' : 's'} · ${esc(fmt(units))} unidades${tot ? ` · ${esc(money(tot))}` : ''} · ${o.status === 'apartado' ? 'Apartado' : o.status === 'facturado' ? 'Facturado' : 'Cancelado'}</div>
      <div class="muted small-text">${snap.slice(0, 4).map((x) => esc(`${fmt(x.n)} × ${nameOf(x.p)}`)).join('<br>')}${snap.length > 4 ? `<br>… y ${snap.length - 4} más` : ''}</div>
      ${o.status === 'apartado' ? `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px"><button type="button" class="btn small" data-hv="edit">Editar</button><button type="button" class="btn small" data-hv="invoice">Facturar</button><button type="button" class="btn small danger-ghost" data-hv="cancel">Cancelar pedido</button></div>` : ''}</div>`;
  }).join('') : `<div class="empty"><p>${showClosed ? 'Aún no hay pedidos cerrados.' : 'No hay pedidos apartados. Usa el modo «Apartar» para crear uno.'}</p></div>`}`;
    };
    const d = UI.dialog({ title: 'Pedidos apartados', cls: 'sheet', html: html() });
    d.setFoot('<button type="button" class="btn secondary" data-hv="close">Cerrar</button>');
    const redraw = () => { d.body.innerHTML = html(); };
    const handler = async (e) => {
      const b = e.target.closest('[data-hv]');
      if (!b) return;
      const act = b.dataset.hv;
      if (act === 'close') { d.close(); return; }
      if (act === 'open' || act === 'closed') { showClosed = act === 'closed'; redraw(); return; }
      const oid = b.closest('[data-oid]').dataset.oid;
      const o = heldOf(oid);
      if (!o) return;
      try {
        if (act === 'edit') {
          if (count('apartar') && !(await UI.confirm({ title: 'Reemplazar el pedido en curso', message: 'Hay un pedido apartado sin guardar. Si editas este, se descartará lo que tenías sin guardar.', okLabel: 'Editar este' }))) return;
          carts.apartar = Object.assign(blankCart(), { items: Object.assign({}, o.items), prices: Object.assign({}, o.prices || {}), party: o.party || '', note: o.note || '', heldId: o.id });
          persist(); await d.close(); setMode('apartar'); await open('apartar');
        } else if (act === 'invoice') {
          const snap = heldSnapshot(o); const tot = heldTotal(o);
          if (!(await UI.confirm({ title: 'Facturar el pedido', message: `Pedido n.º ${o.num}${o.party ? ' de ' + o.party : ''}: ${snap.length} producto${snap.length === 1 ? '' : 's'}${tot ? `, total ${money(tot)}` : ''}. Ya está descontado del almacén; al facturar se genera el recibo y ya no se podrá editar.`, okLabel: 'Facturar' }))) return;
          const fp = {}; for (const x of snap) if (x.price !== null) fp[x.p.id] = x.price;
          await Inventory.invoiceHeldOrder(o.id, fp);
          await Settings.load(); await App.refresh(); refreshUI();
          redraw();
          await showDone({ t: 'salida', party: o.party || '', note: o.note || '', snapshot: snap, out: {}, currency: S().settings.currency, discrepancies: 0, reason: '' });
          redraw();
        } else if (act === 'cancel') {
          if (!(await UI.confirm({ title: 'Cancelar el pedido apartado', message: 'Los productos del pedido vuelven al almacén (queda en el historial). Esto no se puede deshacer.', okLabel: 'Cancelar pedido', cancelLabel: 'Volver', danger: true }))) return;
          await Inventory.cancelHeldOrder(o.id);
          await Settings.load(); await App.refresh(); refreshUI();
          redraw();
          UI.toast('Pedido cancelado: los productos volvieron al almacén.', 'ok');
        }
      } catch (er) { UI.toast(DB.friendlyError(er), 'error'); }
    };
    d.body.addEventListener('click', handler);
    d.foot.addEventListener('click', handler);
  }

  function reasonList() { return [...Inventory.BAJA_REASONS, ...((S().settings.customReasons) || [])]; }
  const todayStr = () => { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
  const dayMs = (v) => { if (!v) return null; const [y, m, d] = v.split('-').map(Number); const ts = new Date(y, m - 1, d, 12, 0, 0).getTime(); return Number.isFinite(ts) ? ts : null; };

  const hasPrices = (r) => r.t === 'salida' && r.snapshot.some((x) => x.price !== null && x.price !== undefined);
  const lineTotal = (x) => (x.price === null || x.price === undefined ? null : Inventory.round2(x.n * x.price));
  const grand = (r) => Inventory.round2(r.snapshot.reduce((a, x) => a + (lineTotal(x) || 0), 0));
  const nameOf = (p) => `${p.name}${p.color && !Inventory.norm(p.name).includes(Inventory.norm(p.color)) ? ` (${p.color})` : ''}`;
  const dateText = () => new Date().toLocaleDateString('es', { dateStyle: 'long' });

  /* Cuántas unidades salen de cada categoría y, dentro de ella, de cada subcategoría
     (p. ej. «Tintes capilares: 40 tubos» y debajo «Stereo: 17 tubos»). */
  function groupTotals(r) {
    const byId = S().catById;
    const unitsText = (m) => [...m.entries()].map(([u, n]) => `${fmt(n)} ${Inventory.unitText(u, n)}`).join(' + ');
    const add = (m, u, n) => m.set(u, Inventory.round6((m.get(u) || 0) + n));
    const tops = new Map();
    for (const x of r.snapshot) {
      const top = x.p.categoryId && byId.get(x.p.categoryId);
      const sub = x.p.subcategoryId && byId.get(x.p.subcategoryId);
      const tn = top ? top.name : (sub ? sub.name : 'Sin categoría');
      const u = (x.p.unit || 'unidades').trim() || 'unidades';
      const t = tops.get(tn) || { name: tn, units: new Map(), subs: new Map(), order: top ? (top.order || 0) : 9999 };
      add(t.units, u, x.n);
      if (sub && top) { const sg = t.subs.get(sub.name) || { name: sub.name, units: new Map(), order: sub.order || 0 }; add(sg.units, u, x.n); t.subs.set(sub.name, sg); }
      tops.set(tn, t);
    }
    return [...tops.values()].sort((a, b) => a.order - b.order).map((t) => ({
      name: t.name, text: unitsText(t.units),
      subs: [...t.subs.values()].sort((a, b) => a.order - b.order).map((sg) => ({ name: sg.name, text: unitsText(sg.units) })),
    }));
  }

  /* Texto corto: cada producto en 2 líneas cortas, para que no se corte en el chat. */
  function summaryText(r, withPrices) {
    const wp = withPrices !== false && hasPrices(r);
    const lines = [`${r.t === 'salida' ? 'PEDIDO' : 'ENTRADA'}${r.party ? ` — ${r.party}` : ''}`, dateText(), ''];
    for (const x of r.snapshot) {
      lines.push(nameOf(x.p));
      const lt = lineTotal(x);
      lines.push(wp && lt !== null ? `   ${fmt(x.n)} × ${fmt(x.price)} = ${fmt(lt)} ${r.currency}` : `   ${fmt(x.n)} ${Inventory.unitText(x.p.unit, x.n).replace(/^\S+\s/, '')}`);
    }
    const gt = groupTotals(r);
    lines.push('', 'TOTAL POR CATEGORÍA');
    for (const g of gt) { lines.push(`${g.name}: ${g.text}`); for (const sg of g.subs) lines.push(`   ${sg.name}: ${sg.text}`); }
    lines.push('', `Total: ${fmt(r.snapshot.reduce((a, x) => a + x.n, 0))} unidades`);
    if (wp) lines.push(`TOTAL A PAGAR: ${fmt(grand(r))} ${r.currency}`);
    if (r.note) lines.push('', r.note);
    return lines.join('\n');
  }

  /* Dibuja en una imagen (PNG) con letra grande y ancho fijo: en WhatsApp se ve completa, sin cortes. */
  function canvasFor(draw, measureOnly) {
    const W = 760; const PAD = 36;
    const cv = document.createElement('canvas');
    const ctx = cv.getContext('2d');
    const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
    const wrap = (text, font, maxW) => {
      ctx.font = font;
      const words = String(text).split(/\s+/); const out = []; let cur = '';
      for (const w of words) {
        const t = cur ? `${cur} ${w}` : w;
        if (ctx.measureText(t).width > maxW && cur) { out.push(cur); cur = w; } else cur = t;
      }
      if (cur) out.push(cur);
      return out;
    };
    const H = draw(ctx, { W, PAD, FONT, wrap, dry: true });
    cv.width = W; cv.height = Math.ceil(H);
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, W, cv.height);
    draw(ctx, { W, PAD, FONT, wrap, dry: false });
    return cv;
  }
  const toBlob = (cv) => new Promise((res, rej) => cv.toBlob((b) => (b ? res(b) : rej(new Error('No se pudo crear la imagen.'))), 'image/png'));

  function receiptImage(r, withPrices) {
    const wp = withPrices !== false && hasPrices(r);
    const cv = canvasFor((ctx, { W, PAD, FONT, wrap, dry }) => {
      let y = PAD;
      const txt = (s, font, color, x, align) => { if (dry) return; ctx.font = font; ctx.fillStyle = color; ctx.textAlign = align || 'left'; ctx.textBaseline = 'alphabetic'; ctx.fillText(s, x, y); };
      const rule = () => { if (!dry) { ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(PAD, y); ctx.lineTo(W - PAD, y); ctx.stroke(); } };
      y += 34; txt(r.t === 'salida' ? 'PEDIDO' : 'ENTRADA', `800 38px ${FONT}`, '#0f766e', PAD); y += 14;
      if (r.party) for (const l of wrap(r.party, `700 32px ${FONT}`, W - 2 * PAD)) { y += 40; txt(l, `700 32px ${FONT}`, '#0f172a', PAD); }
      y += 36; txt(dateText(), `500 26px ${FONT}`, '#475569', PAD); y += 22; rule(); y += 10;
      const qx = W - PAD - (wp ? 220 : 0);
      for (const x of r.snapshot) {
        const lines = wrap(nameOf(x.p), `650 30px ${FONT}`, (wp ? qx - PAD - 160 : W - 2 * PAD - 150));
        const lt = lineTotal(x);
        const top = y;
        lines.forEach((l, i) => { y += 40; txt(l, `650 30px ${FONT}`, '#0f172a', PAD); });
        const q = wp && lt !== null ? `${fmt(x.n)} × ${fmt(x.price)}` : `${fmt(x.n)}`;
        const saved = y; y = top + 40;
        txt(q, `700 30px ${FONT}`, '#0f172a', wp ? qx + 10 : W - PAD, wp ? 'right' : 'right');
        if (wp) txt(lt !== null ? fmt(lt) : '—', `700 30px ${FONT}`, '#0f172a', W - PAD, 'right');
        y = saved + 16; rule(); y += 10;
      }
      y += 44; txt('TOTAL POR CATEGORÍA', `800 26px ${FONT}`, '#0f766e', PAD);
      const row = (name, text, ind, bold) => {
        const f1 = `${bold ? 700 : 500} 28px ${FONT}`; const f2 = `700 28px ${FONT}`;
        const gl = wrap(text, f2, 330);
        const top = y;
        wrap(name, f1, W - 2 * PAD - 360 - ind).forEach((l) => { y += 38; txt(l, f1, bold ? '#0f172a' : '#334155', PAD + ind); });
        const end = y; y = top;
        gl.forEach((l) => { y += 38; txt(l, f2, bold ? '#0f172a' : '#334155', W - PAD, 'right'); });
        y = Math.max(y, end);
      };
      for (const g of groupTotals(r)) { row(g.name, g.text, 0, true); for (const sg of g.subs) row(sg.name, sg.text, 28, false); }
      y += 12; rule(); y += 36; txt(`Total: ${fmt(r.snapshot.reduce((a, x) => a + x.n, 0))} unidades`, `600 28px ${FONT}`, '#334155', PAD);
      if (wp) { y += 56; txt('TOTAL A PAGAR', `800 32px ${FONT}`, '#0f172a', PAD); txt(`${fmt(grand(r))} ${r.currency}`, `800 38px ${FONT}`, '#0f766e', W - PAD, 'right'); }
      if (r.note) for (const l of wrap(r.note, `500 26px ${FONT}`, W - 2 * PAD)) { y += 40; txt(l, `500 26px ${FONT}`, '#475569', PAD); }
      return y + PAD;
    });
    return toBlob(cv);
  }

  /* Convierte cualquier texto (por ejemplo un listado) en una imagen legible. */
  function textImage(lines) {
    const cv = canvasFor((ctx, { W, PAD, FONT, wrap, dry }) => {
      let y = PAD;
      for (const raw of lines) {
        const head = raw && raw === raw.toLocaleUpperCase('es') && !raw.startsWith('-') && raw.length > 2;
        const font = head ? `800 30px ${FONT}` : `500 28px ${FONT}`;
        if (!raw) { y += 22; continue; }
        for (const l of wrap(raw, font, W - 2 * PAD)) { y += head ? 44 : 38; if (!dry) { ctx.font = font; ctx.fillStyle = head ? '#0f766e' : '#0f172a'; ctx.textAlign = 'left'; ctx.fillText(l, PAD, y); } }
      }
      return y + PAD;
    });
    return toBlob(cv);
  }

  async function shareBlob(blob, name, type, title) {
    const file = new File([blob], name, { type });
    if (navigator.canShare && navigator.share) {
      let ok = false;
      try { ok = navigator.canShare({ files: [file] }); } catch (_) { /* nada */ }
      if (ok) {
        try { await navigator.share({ files: [file], title }); return 'shared'; } catch (e) { if (e && e.name === 'AbortError') return 'cancelled'; }
      }
    }
    UI.download(blob, name);
    return 'downloaded';
  }

  async function showBajaDone(r) {
    const totalU = r.snapshot.reduce((a, x) => a + x.n, 0);
    return UI.alert({
      title: 'Baja registrada',
      html: `<div class="stack"><div class="issue ok"><b>Listo.</b> ${esc(r.reason)} · ${r.snapshot.length} producto${r.snapshot.length === 1 ? '' : 's'}, ${fmt(totalU)} unidades${r.party ? ` · ${esc(r.party)}` : ''}. No se contabiliza como venta.</div>
        ${r.discrepancies ? `<div class="notice">${r.discrepancies} producto${r.discrepancies === 1 ? '' : 's'} quedó como <b>discrepancia pendiente de revisión</b> (no cambió su existencia). Revísalo en Movimientos › Discrepancias.</div>` : ''}</div>`,
    });
  }

  async function showDone(r) {
    if (r.t === 'baja') return showBajaDone(r);
    const totalU = r.snapshot.reduce((a, x) => a + x.n, 0);
    const wp = hasPrices(r);
    const html = `<div class="stack"><div class="issue ok"><b>Listo.</b> ${r.snapshot.length} producto${r.snapshot.length === 1 ? '' : 's'}, ${fmt(totalU)} unidades${r.party ? ` · ${esc(r.party)}` : ''}${wp ? `<br>Total: <b>${esc(money(grand(r)))}</b>` : ''}<br>${groupTotals(r).map((g) => `${esc(g.name)}: <b>${esc(g.text)}</b>${g.subs.map((sg) => `<br>&nbsp;&nbsp;${esc(sg.name)}: ${esc(sg.text)}`).join('')}`).join('<br>')}. Las existencias ya se actualizaron y el pedido quedó en Movimientos.</div>
      ${wp ? '<label class="switch"><span class="sw-text">Mostrar precios en el recibo</span><input type="checkbox" id="dn-prices" checked></label>' : ''}
      <button type="button" class="btn" data-dn="img">Compartir recibo (imagen)</button>
      <button type="button" class="btn secondary" data-dn="txt">Compartir como texto</button>
      <button type="button" class="btn secondary" data-dn="file">Compartir archivo de texto (.txt)</button>
      <p class="muted small-text">La imagen se ve completa en WhatsApp, sin tener que bajar el texto.</p></div>`;
    return UI.modal({
      title: `${LABEL[r.t].name} registrada`, cls: 'center-dlg', html,
      actions: [{ id: 'cancel', label: 'Cerrar', kind: 'ghost' }],
      onOpen(d) {
        d.body.addEventListener('click', async (e) => {
          const b = e.target.closest('[data-dn]');
          if (!b) return;
          const wpOn = !d.body.querySelector('#dn-prices') || d.body.querySelector('#dn-prices').checked;
          const base = `${r.t === 'salida' ? 'pedido' : 'entrada'}${r.party ? '-' + r.party.toLowerCase().replace(/[^a-z0-9áéíóúñ]+/gi, '-').replace(/^-|-$/g, '') : ''}`;
          try {
            if (b.dataset.dn === 'img') {
              const res = await shareBlob(await receiptImage(r, wpOn), `${base}.png`, 'image/png', 'Recibo');
              if (res === 'downloaded') UI.toast('Se guardó la imagen en tu teléfono. Envíala desde WhatsApp › adjuntar › galería.');
            } else if (b.dataset.dn === 'file') {
              const res = await shareBlob(new Blob([summaryText(r, wpOn)], { type: 'text/plain' }), `${base}.txt`, 'text/plain', 'Recibo');
              if (res === 'downloaded') UI.toast('Se guardó el archivo en tu teléfono.');
            } else {
              const text = summaryText(r, wpOn);
              if (navigator.share) { try { await navigator.share({ text }); } catch (er) { if (!er || er.name !== 'AbortError') UI.toast('No se pudo abrir el menú de compartir.', 'error'); } }
              else { const ok = await UI.copyText(text); UI.toast(ok ? 'Resumen copiado. Pégalo en WhatsApp.' : 'No se pudo copiar el resumen.', ok ? 'ok' : 'error'); }
            }
          } catch (er) { UI.toast(DB.friendlyError(er), 'error'); }
        });
      },
    });
  }

  function reload() {
    carts = { salida: blankCart(), entrada: blankCart(), baja: blankCart(), apartar: blankCart() };
    load();
    refreshUI();
  }

  function init() {
    load();
    document.getElementById('mode-seg').addEventListener('click', (e) => {
      const b = e.target.closest('[data-mode]');
      if (!b) return;
      if (b.dataset.mode === 'pedidos') openHeld(); else setMode(b.dataset.mode);
    });
    document.getElementById('cart-bar').addEventListener('click', (e) => { if (e.target.closest('[data-cb=open]')) open(mode); });
    renderModeSeg();
    renderBar();
  }

  globalThis.Cart = { openHeld, init, reload, addToCart(t, id, n) { setQty(t, id, n); }, textImage, shareBlob, controlsHtml, handleClick, handleChange, setMode, refreshUI, open, get mode() { return mode; }, qty, count, total };
})();

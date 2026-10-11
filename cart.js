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
  };

  const blankCart = () => ({ items: {}, party: '', note: '', opId: DB.uuid() });
  let carts = { salida: blankCart(), entrada: blankCart() };
  let mode = 'ver'; // ver | salida | entrada
  let saveTimer = null;

  const S = () => App.state;
  const steps = () => (S().settings.quickSteps && S().settings.quickSteps.length ? S().settings.quickSteps : [1, 5, 10, 12, 50]);
  const productOf = (id) => S().products.find((p) => p.id === id);

  function load() {
    const raw = S().settings.carts;
    if (raw && typeof raw === 'object') {
      for (const t of ['salida', 'entrada']) {
        const c = raw[t];
        if (c && typeof c === 'object') {
          carts[t] = { items: Object.assign({}, c.items || {}), party: String(c.party || ''), note: String(c.note || ''), opId: typeof c.opId === 'string' && c.opId ? c.opId : DB.uuid() };
        }
      }
    }
    prune();
  }

  /* Quita del carrito productos que ya no existen o fueron archivados. */
  function prune() {
    for (const t of ['salida', 'entrada']) {
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

  function maxFor(t, p) {
    if (t !== 'salida' || S().settings.allowOversell) return Infinity;
    return p.quantity > 0 ? p.quantity : 0;
  }

  /* Cambia la cantidad de un producto en el carrito. Devuelve la cantidad final. */
  function setQty(t, id, n) {
    const p = productOf(id);
    if (!p) return 0;
    if (p.quantity === null || p.quantity === undefined) {
      UI.toast(`«${p.name}» no tiene existencia registrada. Establécela primero con «Ajustar existencia».`, 'error');
      return qty(t, id);
    }
    n = Inventory.round6(Number(n));
    if (!Number.isFinite(n) || n < 0) n = 0;
    const max = maxFor(t, p);
    if (n > max) {
      n = max;
      UI.toast(max > 0 ? `Solo hay ${fmt(max)} de «${p.name}».` : `«${p.name}» está agotado.`, 'error');
    }
    if (n <= 0) delete carts[t].items[id]; else carts[t].items[id] = n;
    persist();
    return n;
  }

  /* ---- Botones sobre cada producto ---- */
  function controlsHtml(p) {
    if (mode === 'ver' || p.archived) return '';
    const t = mode;
    const unknown = p.quantity === null || p.quantity === undefined;
    if (unknown) return `<div class="cart-row" data-pid="${p.id}"><span class="muted small-text">Sin existencia registrada: ajústala primero para poder usarlo en un pedido.</span></div>`;
    const q = qty(t, p.id);
    return `<div class="cart-row ${t}" data-pid="${p.id}">
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
    el.innerHTML = [['ver', 'Consultar', 0], ['salida', 'Salida', count('salida')], ['entrada', 'Entrada', count('entrada')]]
      .map(([v, l, n]) => `<button type="button" data-mode="${v}" aria-pressed="${mode === v}">${l}${n ? ` <span class="badge-n">${n}</span>` : ''}</button>`).join('');
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
    if (t !== 'salida' && t !== 'entrada') return;
    const L = LABEL[t];
    const parties = await knownParties();
    const c = () => carts[t];
    const body = () => {
      const items = Object.entries(c().items).map(([id, n]) => ({ p: productOf(id), n })).filter((x) => x.p);
      items.sort((a, b) => Inventory.collator.compare(a.p.name, b.p.name));
      return items.length ? items.map(({ p, n }) => {
        const over = t === 'salida' && !S().settings.allowOversell && n > p.quantity;
        return `<div class="ci" data-pid="${p.id}">
          <div class="ci-main"><b>${esc(p.name)}</b><div class="muted small-text">${esc([p.color, p.presentation].filter(Boolean).join(' · '))}${p.quantity !== null ? ` · Hay ${esc(Inventory.qtyText(p.quantity, p.unit))}` : ''}</div>${over ? '<div class="field-error">Supera la existencia</div>' : ''}</div>
          <div class="cart-step"><button type="button" class="btn secondary small" data-ci="dec" aria-label="Quitar uno">−</button>
            <input class="cq" inputmode="decimal" value="${esc(fmt(n))}" aria-label="Cantidad">
            <button type="button" class="btn secondary small" data-ci="inc" aria-label="Añadir uno">+</button>
            <button type="button" class="btn danger-ghost small" data-ci="rm" aria-label="Quitar del carrito">✕</button></div></div>`;
      }).join('') : '<div class="empty">El carrito está vacío.</div>';
    };
    const html = `<div class="stack">
      <div id="ci-list">${body()}</div>
      <div id="ci-total" class="muted small-text"></div>
      <label class="field"><span>${esc(L.party)}</span><input id="ci-party" maxlength="80" list="dl-parties" autocomplete="off" placeholder="${esc(L.ph)}" value="${esc(c().party)}"></label>
      <datalist id="dl-parties">${parties.map((x) => `<option value="${esc(x)}">`).join('')}</datalist>
      <label class="field"><span>Nota (opcional)</span><input id="ci-note" maxlength="300" autocomplete="off" value="${esc(c().note)}"></label>
      <div class="field-error" id="ci-err" role="alert"></div></div>`;

    let confirmed = null;
    await UI.modal({
      title: L.cart, html, cls: 'sheet',
      actions: [{ id: 'cancel', label: 'Seguir añadiendo', kind: 'ghost' }, { id: 'clear', label: 'Vaciar', kind: 'danger-ghost' }, { id: 'ok', label: L.ok, kind: 'primary' }],
      onOpen(d) {
        const q = (s) => d.body.querySelector(s);
        const redraw = () => {
          q('#ci-list').innerHTML = body();
          q('#ci-total').textContent = `${count(t)} producto${count(t) === 1 ? '' : 's'} · ${fmt(total(t))} unidades`;
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
          const inp = e.target.closest('.cq');
          if (inp) { const id = inp.closest('.ci').dataset.pid; setQty(t, id, Number(inp.value.replace(',', '.')) || 0); redraw(); }
        });
        d.body.addEventListener('input', (e) => {
          if (e.target.id === 'ci-party') { c().party = e.target.value; persist(); }
          if (e.target.id === 'ci-note') { c().note = e.target.value; persist(); }
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
        try {
          const items = Object.entries(c().items).map(([productId, amount]) => ({ productId, amount }));
          const snapshot = items.map((it) => ({ p: productOf(it.productId), n: it.amount }));
          const out = await Inventory.registerBatch({ type: t, items, party: c().party, note: c().note, opId: c().opId });
          confirmed = { t, party: c().party.trim(), note: c().note.trim(), snapshot, out };
          carts[t] = blankCart(); persist();
        } catch (e) {
          err.textContent = DB.friendlyError(e);
          return false;
        }
      },
    });
    await App.refresh();
    refreshUI();
    if (confirmed) await showDone(confirmed);
  }

  function summaryText(r) {
    const lines = [`${r.t === 'salida' ? 'Pedido' : 'Entrada'}${r.party ? ` — ${r.party}` : ''}`, new Date().toLocaleDateString('es', { dateStyle: 'long' }), ''];
    for (const { p, n } of r.snapshot) lines.push(`- ${p.name}${p.color && !Inventory.norm(p.name).includes(Inventory.norm(p.color)) ? ` (${p.color})` : ''} × ${fmt(n)}`);
    lines.push('', `Total: ${fmt(r.snapshot.reduce((a, x) => a + x.n, 0))} unidades`);
    if (r.note) lines.push(r.note);
    return lines.join('\n');
  }

  async function showDone(r) {
    const totalU = r.snapshot.reduce((a, x) => a + x.n, 0);
    const choice = await UI.modal({
      title: `${LABEL[r.t].name} registrada`, cls: 'center-dlg',
      html: `<div class="stack"><div class="issue ok"><b>Listo.</b> ${r.snapshot.length} producto${r.snapshot.length === 1 ? '' : 's'}, ${fmt(totalU)} unidades${r.party ? ` · ${esc(r.party)}` : ''}. Las existencias ya se actualizaron y el pedido quedó en Movimientos.</div></div>`,
      actions: [{ id: 'cancel', label: 'Cerrar', kind: 'ghost' }, { id: 'share', label: 'Compartir resumen', kind: 'primary' }],
      async onAction(id) {
        if (id !== 'share') return;
        const text = summaryText(r);
        if (navigator.share) {
          try { await navigator.share({ text }); } catch (e) { if (!e || e.name !== 'AbortError') UI.toast('No se pudo abrir el menú de compartir.', 'error'); }
        } else {
          const ok = await UI.copyText(text);
          UI.toast(ok ? 'Resumen copiado. Pégalo en WhatsApp.' : 'No se pudo copiar el resumen.', ok ? 'ok' : 'error');
        }
        return false;
      },
    });
    return choice;
  }

  function reload() {
    carts = { salida: blankCart(), entrada: blankCart() };
    load();
    refreshUI();
  }

  function init() {
    load();
    document.getElementById('mode-seg').addEventListener('click', (e) => {
      const b = e.target.closest('[data-mode]');
      if (b) setMode(b.dataset.mode);
    });
    document.getElementById('cart-bar').addEventListener('click', (e) => { if (e.target.closest('[data-cb=open]')) open(mode); });
    renderModeSeg();
    renderBar();
  }

  globalThis.Cart = { init, reload, controlsHtml, handleClick, handleChange, setMode, refreshUI, open, get mode() { return mode; }, qty, count, total };
})();

'use strict';
/* categories.js — Categorías, subcategorías y precios generales.
   Modelo: una sola colección con dos niveles (categoría → subcategoría).
   Los productos guardan solo los identificadores; los nombres se leen siempre de aquí,
   así renombrar o mover una categoría actualiza al instante inventario y galería. */
(function () {
  const { AppError, DB, Inventory } = globalThis;
  const R = (r) => DB.req(r);
  const norm = (s) => Inventory.norm(s);
  const NAME_MAX = 60;

  const fail = (msg, field) => { throw new AppError('VALIDATION', msg, { field }); };

  function cleanName(name) {
    const s = String(name == null ? '' : name).replace(/\s+/g, ' ').trim();
    if (!s) fail('Escribe un nombre.', 'name');
    if (s.length > NAME_MAX) fail(`El nombre no puede tener más de ${NAME_MAX} caracteres.`, 'name');
    return s;
  }

  function sortCategories(list) {
    return list.slice().sort((a, b) => (a.order - b.order) || Inventory.collator.compare(a.name, b.name));
  }
  const rootsOf = (list) => sortCategories(list.filter((c) => !c.parentId));
  const childrenOf = (list, id) => sortCategories(list.filter((c) => c.parentId === id));

  /* ---------------- Operaciones de datos ---------------- */

  function create(name, parentId) {
    const clean = cleanName(name);
    return DB.tx(['categories'], 'readwrite', async (S) => {
      const all = await R(S.categories.getAll());
      if (parentId) {
        const parent = all.find((c) => c.id === parentId);
        if (!parent || parent.parentId) fail('La categoría principal ya no existe.');
      }
      const sibs = all.filter((c) => (c.parentId || null) === (parentId || null));
      if (sibs.some((s) => norm(s.name) === norm(clean))) {
        fail(parentId ? 'Ya existe una subcategoría con ese nombre en esta categoría.' : 'Ya existe una categoría con ese nombre.', 'name');
      }
      const now = Date.now();
      const rec = {
        id: DB.uuid(), name: clean, parentId: parentId || null,
        order: sibs.reduce((m, s) => Math.max(m, s.order), -1) + 1,
        generalPrice: null, createdAt: now, updatedAt: now,
      };
      await R(S.categories.put(rec));
      return rec;
    });
  }

  function rename(id, name) {
    const clean = cleanName(name);
    return DB.tx(['categories'], 'readwrite', async (S) => {
      const all = await R(S.categories.getAll());
      const cat = all.find((c) => c.id === id);
      if (!cat) throw new AppError('NOT_FOUND', 'La categoría ya no existe.');
      const sibs = all.filter((c) => c.id !== id && (c.parentId || null) === (cat.parentId || null));
      if (sibs.some((s) => norm(s.name) === norm(clean))) fail('Ya existe otra con ese nombre.', 'name');
      cat.name = clean;
      cat.updatedAt = Date.now();
      await R(S.categories.put(cat));
      return cat;
    });
  }

  /* dir: -1 sube, +1 baja dentro de su grupo. */
  function move(id, dir) {
    return DB.tx(['categories'], 'readwrite', async (S) => {
      const all = await R(S.categories.getAll());
      const cat = all.find((c) => c.id === id);
      if (!cat) throw new AppError('NOT_FOUND', 'La categoría ya no existe.');
      const sibs = sortCategories(all.filter((c) => (c.parentId || null) === (cat.parentId || null)));
      const i = sibs.findIndex((c) => c.id === id);
      const j = i + dir;
      if (j < 0 || j >= sibs.length) return false;
      [sibs[i], sibs[j]] = [sibs[j], sibs[i]];
      for (let k = 0; k < sibs.length; k++) {
        if (sibs[k].order !== k) {
          sibs[k].order = k;
          await R(S.categories.put(sibs[k]));
        }
      }
      return true;
    });
  }

  /* price vacío/null quita el precio general. No toca los precios individuales. */
  function setGeneralPrice(id, rawPrice) {
    const p = Inventory.parseDecimal(rawPrice);
    if (p.invalid) fail('Escribe un precio válido (por ejemplo 500 o 12,50).', 'price');
    if (!p.empty && p.value < 0) fail('El precio no puede ser negativo.', 'price');
    if (!p.empty && p.value > 1e9) fail('El precio es demasiado grande.', 'price');
    const value = p.empty ? null : Inventory.round2(p.value);
    return DB.tx(['categories'], 'readwrite', async (S) => {
      const cat = await R(S.categories.get(id));
      if (!cat) throw new AppError('NOT_FOUND', 'La categoría ya no existe.');
      cat.generalPrice = value;
      cat.updatedAt = Date.now();
      await R(S.categories.put(cat));
      return cat;
    });
  }

  /* Elimina una categoría o subcategoría SIN borrar nunca productos.
     Si tiene productos hay que indicar un destino: opts.target = { categoryId|null, subcategoryId|null }. */
  function remove(id, opts) {
    const target = opts && opts.target;
    return DB.tx(['categories', 'products'], 'readwrite', async (S) => {
      const all = await R(S.categories.getAll());
      const cat = all.find((c) => c.id === id);
      if (!cat) throw new AppError('NOT_FOUND', 'La categoría ya no existe.');
      const subs = cat.parentId ? [] : all.filter((c) => c.parentId === id);
      const doomed = new Set([id, ...subs.map((s) => s.id)]);
      const products = (await R(S.products.getAll())).filter((p) => (cat.parentId ? p.subcategoryId === id : p.categoryId === id));

      if (products.length) {
        if (!target) throw new AppError('NEEDS_TARGET', 'Esta categoría tiene productos: elige a dónde moverlos.');
        if (target.categoryId) {
          const tc = all.find((c) => c.id === target.categoryId);
          if (!tc || tc.parentId || doomed.has(tc.id)) fail('El destino elegido no es válido.');
          if (target.subcategoryId) {
            const ts = all.find((c) => c.id === target.subcategoryId);
            if (!ts || ts.parentId !== tc.id || doomed.has(ts.id)) fail('La subcategoría de destino no es válida.');
          }
        }
        for (const p of products) {
          p.categoryId = target.categoryId || null;
          p.subcategoryId = target.categoryId ? target.subcategoryId || null : null;
          p.updatedAt = Date.now();
          await R(S.products.put(p));
        }
      }
      for (const did of doomed) await R(S.categories.delete(did));
      return { movedProducts: products.length, removedSubcategories: subs.length };
    });
  }

  /* Mueve todos los productos de una categoría/subcategoría a otro destino (sin borrar nada). */
  function moveAllProducts(id, target) {
    return DB.tx(['categories', 'products'], 'readwrite', async (S) => {
      const all = await R(S.categories.getAll());
      const cat = all.find((c) => c.id === id);
      if (!cat) throw new AppError('NOT_FOUND', 'La categoría ya no existe.');
      if (target.categoryId) {
        const tc = all.find((c) => c.id === target.categoryId);
        if (!tc || tc.parentId) fail('El destino elegido no es válido.');
        if (target.subcategoryId) {
          const ts = all.find((c) => c.id === target.subcategoryId);
          if (!ts || ts.parentId !== tc.id) fail('La subcategoría de destino no es válida.');
        }
      }
      const products = (await R(S.products.getAll())).filter((p) => (cat.parentId ? p.subcategoryId === id : p.categoryId === id));
      for (const p of products) {
        p.categoryId = target.categoryId || null;
        p.subcategoryId = target.categoryId ? target.subcategoryId || null : null;
        p.updatedAt = Date.now();
        await R(S.products.put(p));
      }
      return products.length;
    });
  }

  /* ---------------- Consultas (sobre datos ya cargados) ---------------- */

  function productCount(products, cat) {
    let n = 0;
    for (const p of products) if (cat.parentId ? p.subcategoryId === cat.id : p.categoryId === cat.id) n++;
    return n;
  }

  /* Prioridad: precio del producto → subcategoría → categoría → sin precio. */
  function resolvePrice(product, byId) {
    if (product.price !== null && product.price !== undefined) return { value: product.price, source: 'product', name: '' };
    const sub = product.subcategoryId ? byId.get(product.subcategoryId) : null;
    if (sub && sub.generalPrice !== null && sub.generalPrice !== undefined) return { value: sub.generalPrice, source: 'subcategory', name: sub.name };
    const cat = product.categoryId ? byId.get(product.categoryId) : null;
    if (cat && cat.generalPrice !== null && cat.generalPrice !== undefined) return { value: cat.generalPrice, source: 'category', name: cat.name };
    return { value: null, source: null, name: '' };
  }

  function pathNames(product, byId) {
    const cat = product.categoryId ? byId.get(product.categoryId) : null;
    const sub = product.subcategoryId ? byId.get(product.subcategoryId) : null;
    return { category: cat ? cat.name : '', subcategory: sub ? sub.name : '' };
  }

  function pathText(product, byId) {
    const p = pathNames(product, byId);
    if (p.category && p.subcategory) return `${p.category} › ${p.subcategory}`;
    return p.category || p.subcategory || '';
  }

  /* ---------------- Interfaz: administrador de categorías ---------------- */

  const esc = (s) => UI.esc(s);
  const money = (v) => UI.money(v);

  /* Selector de destino para mover productos. Devuelve { categoryId, subcategoryId } o null si se cancela. */
  function askTarget(o) {
    const st = App.state;
    const excluded = new Set(o.excludeIds || []);
    const roots = rootsOf(st.categories).filter((c) => !excluded.has(c.id));
    const catOptions = [`<option value="">— Sin categoría —</option>`]
      .concat(roots.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`)).join('');
    let result = null;
    const html = `
      <div class="stack">
        <p>${o.intro || ''}</p>
        <label class="field"><span>Categoría de destino</span><select id="tg-cat">${catOptions}</select></label>
        <label class="field"><span>Subcategoría de destino</span><select id="tg-sub"></select></label>
      </div>`;
    return UI.modal({
      title: o.title,
      cls: 'center-dlg',
      html,
      actions: [{ id: 'cancel', label: 'Cancelar', kind: 'ghost' }, { id: 'ok', label: o.okLabel || 'Aceptar', kind: o.danger ? 'danger' : 'primary' }],
      onOpen(d) {
        const catSel = d.body.querySelector('#tg-cat');
        const subSel = d.body.querySelector('#tg-sub');
        const fillSubs = () => {
          const subs = catSel.value ? childrenOf(st.categories, catSel.value).filter((s) => !excluded.has(s.id)) : [];
          subSel.innerHTML = `<option value="">— Sin subcategoría —</option>` + subs.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
          subSel.disabled = !catSel.value || subs.length === 0;
        };
        catSel.addEventListener('change', fillSubs);
        if (o.defaultCategoryId && roots.some((c) => c.id === o.defaultCategoryId)) catSel.value = o.defaultCategoryId;
        fillSubs();
        if (o.defaultSubId) subSel.value = o.defaultSubId;
      },
      onAction(id, body) {
        if (id === 'ok') {
          result = { categoryId: body.querySelector('#tg-cat').value || null, subcategoryId: body.querySelector('#tg-sub').value || null };
        }
      },
    }).then((id) => (id === 'ok' ? result : null));
  }

  async function removeFlow(cat) {
    const st = App.state;
    const subs = childrenOf(st.categories, cat.id);
    const count = productCount(st.products, cat);
    try {
      if (count === 0) {
        const extra = subs.length ? ` También se eliminarán sus ${subs.length} subcategorías (vacías).` : '';
        const ok = await UI.confirm({ title: `Eliminar «${cat.name}»`, message: `Esta ${cat.parentId ? 'subcategoría' : 'categoría'} no tiene productos.${extra}`, okLabel: 'Eliminar', danger: true });
        if (!ok) return false;
        await remove(cat.id);
      } else {
        const subTxt = subs.length ? ` y ${subs.length} subcategorías` : '';
        const target = await askTarget({
          title: `Eliminar «${cat.name}»`,
          intro: `Contiene <b>${count} producto${count === 1 ? '' : 's'}</b>${subTxt}. Los productos <b>no se borran</b>: elige a dónde moverlos.`,
          excludeIds: [cat.id, ...subs.map((s) => s.id)],
          defaultCategoryId: cat.parentId || '',
          okLabel: 'Mover y eliminar',
          danger: true,
        });
        if (!target) return false;
        await remove(cat.id, { target });
      }
      UI.toast(`«${cat.name}» eliminada. Ningún producto se perdió.`, 'ok');
      return true;
    } catch (e) {
      UI.toast(DB.friendlyError(e), 'error');
      return false;
    }
  }

  function priceDialog(cat) {
    const cur = App.state.settings.currency;
    const html = `
      <div class="stack">
        <p class="muted">Precio predeterminado para los productos de «${esc(cat.name)}» que no tengan precio propio. No cambia los precios individuales.</p>
        <label class="field"><span>Precio general (${esc(cur)})</span>
          <input id="gp-input" inputmode="decimal" autocomplete="off" value="${cat.generalPrice === null || cat.generalPrice === undefined ? '' : esc(Inventory.fmtNum(cat.generalPrice))}" placeholder="Sin precio general"></label>
        <div class="field-error" id="gp-err" role="alert"></div>
      </div>`;
    const actions = [{ id: 'cancel', label: 'Cancelar', kind: 'ghost' }];
    if (cat.generalPrice !== null && cat.generalPrice !== undefined) actions.push({ id: 'clear', label: 'Quitar precio', kind: 'secondary' });
    actions.push({ id: 'ok', label: 'Guardar', kind: 'primary' });
    return UI.modal({
      title: `Precio general — ${cat.name}`, cls: 'center-dlg', html, actions,
      async onAction(id, body) {
        const err = body.querySelector('#gp-err');
        try {
          if (id === 'clear') await setGeneralPrice(cat.id, null);
          else {
            const v = body.querySelector('#gp-input').value;
            await setGeneralPrice(cat.id, v);
          }
        } catch (e) {
          err.textContent = DB.friendlyError(e);
          return false;
        }
      },
    });
  }

  function openManager() {
    const st = App.state;
    const d = UI.dialog({ title: 'Categorías y precios', cls: 'sheet', html: '' });
    d.setFoot(`<button type="button" class="btn" data-a="new-cat">+ Nueva categoría</button>`);

    const rowHtml = (c, isSub) => {
      const n = productCount(st.products, c);
      const subs = isSub ? 0 : childrenOf(st.categories, c.id).length;
      const price = c.generalPrice !== null && c.generalPrice !== undefined ? ` · precio general ${esc(money(c.generalPrice))}` : '';
      const info = `${n} producto${n === 1 ? '' : 's'}${subs ? ` · ${subs} subcategoría${subs === 1 ? '' : 's'}` : ''}${price}`;
      return `<div class="cat-row${isSub ? ' sub' : ''}" data-id="${c.id}">
        <div class="cat-main"><b>${esc(c.name)}</b><span class="muted">${info}</span></div>
        <div class="cat-ctl">
          <button type="button" class="icon-btn" data-a="up" aria-label="Subir ${esc(c.name)}">▲</button>
          <button type="button" class="icon-btn" data-a="down" aria-label="Bajar ${esc(c.name)}">▼</button>
          <button type="button" class="btn small secondary" data-a="menu" aria-label="Opciones de ${esc(c.name)}">Opciones</button>
        </div></div>`;
    };

    const render = () => {
      const roots = rootsOf(st.categories);
      if (!roots.length) {
        d.body.innerHTML = `<div class="empty"><h3>Aún no hay categorías</h3><p>Crea categorías (y subcategorías) para organizar tus productos y tus fotos. Son opcionales.</p></div>`;
        return;
      }
      d.body.innerHTML = `<p class="muted small-text" style="margin-bottom:10px">Las fotos de la galería se organizan solas según estas categorías.</p>
        <div class="list">${roots.map((c) => rowHtml(c, false) + childrenOf(st.categories, c.id).map((s) => rowHtml(s, true)).join('')).join('')}</div>`;
    };
    render();

    const refresh = async () => { await App.refresh(); render(); };
    const guard = (fn) => async (...a) => {
      try { await fn(...a); } catch (e) { UI.toast(DB.friendlyError(e), 'error'); }
    };

    const addCategory = guard(async (parent) => {
      const name = await UI.prompt({
        title: parent ? `Nueva subcategoría en «${parent.name}»` : 'Nueva categoría',
        label: 'Nombre', placeholder: parent ? 'Ej. Stereo' : 'Ej. Tintes', okLabel: 'Crear', maxlength: NAME_MAX,
        submit: (v) => create(v, parent ? parent.id : null),
      });
      if (name !== null) await refresh();
    });

    const openMenu = guard(async (cat) => {
      const isSub = !!cat.parentId;
      const items = [{ id: 'view', label: 'Ver sus productos' }, { id: 'rename', label: 'Cambiar nombre' }, { id: 'price', label: 'Precio general' }];
      if (!isSub) items.push({ id: 'addsub', label: 'Añadir subcategoría' });
      items.push({ id: 'moveall', label: 'Mover todos sus productos a…' });
      items.push({ id: 'delete', label: isSub ? 'Eliminar subcategoría' : 'Eliminar categoría', danger: true });
      const choice = await UI.actionSheet(cat.name, items);
      if (!choice) return;
      if (choice === 'view') {
        d.close();
        App.showCategory(cat);
      } else if (choice === 'rename') {
        const v = await UI.prompt({ title: 'Cambiar nombre', label: 'Nombre', value: cat.name, okLabel: 'Guardar', maxlength: NAME_MAX, submit: (x) => rename(cat.id, x) });
        if (v !== null) { UI.toast('Nombre actualizado. Productos y galería ya lo reflejan.', 'ok'); await refresh(); }
      } else if (choice === 'price') {
        await priceDialog(cat);
        await refresh();
      } else if (choice === 'addsub') {
        await addCategory(cat);
      } else if (choice === 'moveall') {
        const n = productCount(st.products, cat);
        if (!n) { UI.toast('Esta categoría no tiene productos que mover.'); return; }
        const sub = cat.parentId ? '' : ' (incluidos los de sus subcategorías)';
        const target = await askTarget({
          title: `Mover productos de «${cat.name}»`,
          intro: `Se moverán <b>${n} producto${n === 1 ? '' : 's'}</b>${sub}. Sus fotos pasarán al álbum de destino.`,
          excludeIds: [cat.id], defaultCategoryId: cat.parentId || '', okLabel: 'Mover',
        });
        if (!target) return;
        const moved = await moveAllProducts(cat.id, target);
        UI.toast(`${moved} producto${moved === 1 ? '' : 's'} movido${moved === 1 ? '' : 's'}.`, 'ok');
        await refresh();
      } else if (choice === 'delete') {
        if (await removeFlow(cat)) await refresh();
      }
    });

    d.el.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-a]');
      if (!btn) return;
      const a = btn.dataset.a;
      if (a === 'new-cat') { addCategory(null); return; }
      const row = btn.closest('.cat-row');
      const cat = row && st.catById.get(row.dataset.id);
      if (!cat) return;
      if (a === 'up' || a === 'down') guard(async () => { await move(cat.id, a === 'up' ? -1 : 1); await refresh(); })();
      else if (a === 'menu') openMenu(cat);
    });
    return d;
  }

  globalThis.Categories = {
    NAME_MAX, sortCategories, rootsOf, childrenOf,
    create, rename, move, setGeneralPrice, remove, moveAllProducts,
    productCount, resolvePrice, pathNames, pathText,
    askTarget, openManager,
  };
})();

'use strict';
/* inventory.js — Productos, existencias y movimientos.
   Toda operación que cambia existencias se hace en UNA transacción:
   se valida, se actualiza la cantidad y se guarda el movimiento, o no se hace nada. */
(function () {
  const { AppError, DB } = globalThis;
  const MOVEMENT_TYPES = ['entrada', 'salida', 'ajuste'];
  const LIMITS = { name: 120, brand: 60, code: 60, unit: 20, notes: 1000, note: 300, color: 60, presentation: 80, capacity: 60, fieldName: 40, fieldValue: 300, maxFields: 30 };
  const R = (r) => DB.req(r);
  let lastTs = 0;

  /* Marca de tiempo estrictamente creciente: el orden del historial nunca es ambiguo. */
  function nextTs() {
    const n = Date.now();
    lastTs = n > lastTs ? n : lastTs + 1;
    return lastTs;
  }

  function norm(s) {
    return String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
  }
  const round6 = (n) => Math.round((n + Number.EPSILON) * 1e6) / 1e6;
  const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

  function fmtNum(n) {
    if (n === null || n === undefined || Number.isNaN(Number(n))) return '';
    return Number(n).toLocaleString('es', { useGrouping: false, maximumFractionDigits: 3 });
  }
  function fmtSigned(n) {
    if (n === null || n === undefined) return '';
    const s = fmtNum(Math.abs(n));
    return (n > 0 ? '+' : n < 0 ? '−' : '') + s;
  }

  /* Unidad en singular o plural según la cantidad: «1 tubo», «12 tubos», «1 unidad».
     Solo se singulariza una palabra suelta en plural; símbolos como ml, kg o L no cambian. */
  function singularUnit(u) {
    if (!/^[A-Za-zÁÉÍÓÚáéíóúÑñ]{4,}$/.test(u)) return u;
    if (/dades$/i.test(u)) return u.slice(0, -2);
    if (/s$/i.test(u)) return u.slice(0, -1);
    return u;
  }
  function unitText(unit, q) {
    const u = String(unit == null ? '' : unit).trim();
    if (!u) return Math.abs(q) === 1 ? 'unidad' : 'unidades';
    return Math.abs(q) === 1 ? singularUnit(u) : u;
  }
  const qtyText = (q, unit) => `${fmtNum(q)} ${unitText(unit, q)}`;

  /* Interpreta texto numérico: vacío ≠ 0. Acepta coma o punto decimal. */
  function parseDecimal(raw) {
    if (raw === null || raw === undefined) return { empty: true };
    if (typeof raw === 'number') return Number.isFinite(raw) ? { value: raw } : { invalid: true };
    const s = String(raw).trim().replace(/\s/g, '').replace(',', '.');
    if (s === '') return { empty: true };
    if (!/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(s)) return { invalid: true };
    const v = Number(s);
    return Number.isFinite(v) ? { value: v } : { invalid: true };
  }

  const fail = (field, msg) => { throw new AppError('VALIDATION', msg, { field }); };

  function cleanText(v, max, field, label, required) {
    const s = (v == null ? '' : String(v)).replace(/\s+/g, ' ').trim();
    if (required && !s) fail(field, `${label} es obligatorio.`);
    if (s.length > max) fail(field, `${label} no puede tener más de ${max} caracteres.`);
    return s;
  }

  /* Campos personalizados: lista de { name, value }. Se descartan las filas totalmente vacías.
     Un valor vacío es válido: significa «sin definir / pendiente de confirmar». */
  function cleanFields(list) {
    if (list === undefined || list === null) return [];
    if (!Array.isArray(list)) fail('fields', 'Los campos personalizados no son válidos.');
    const out = [];
    const seen = new Set();
    for (const f of list) {
      const name = cleanText(f && f.name, LIMITS.fieldName, 'fields', 'El nombre del campo', false);
      const value = cleanText(f && f.value, LIMITS.fieldValue, 'fields', `El valor del campo «${name}»`, false);
      if (!name && !value) continue;
      if (!name) fail('fields', 'Escribe el nombre del campo o quita la fila vacía.');
      const key = norm(name);
      if (seen.has(key)) fail('fields', `El campo «${name}» está repetido.`);
      seen.add(key);
      out.push({ name, value });
    }
    if (out.length > LIMITS.maxFields) fail('fields', `Puedes tener como máximo ${LIMITS.maxFields} campos personalizados.`);
    return out;
  }

  /* Valida y normaliza los datos de un producto. La cantidad solo se admite al crear. */
  function validateProductInput(input, creating) {
    const c = {};
    c.name = cleanText(input.name, LIMITS.name, 'name', 'El nombre del producto', true);
    c.brand = cleanText(input.brand, LIMITS.brand, 'brand', 'La marca', false);
    c.code = cleanText(input.code, LIMITS.code, 'code', 'El código', false);
    c.unit = cleanText(input.unit, LIMITS.unit, 'unit', 'La unidad', false);
    c.color = cleanText(input.color, LIMITS.color, 'color', 'El color', false);
    c.presentation = cleanText(input.presentation, LIMITS.presentation, 'presentation', 'La presentación', false);
    c.capacity = cleanText(input.capacity, LIMITS.capacity, 'capacity', 'La capacidad', false);
    c.fields = cleanFields(input.fields);
    c.quantityStatus = input.quantityStatus === 'estimated' ? 'estimated' : 'confirmed';
    const notes = (input.notes == null ? '' : String(input.notes)).trim();
    if (notes.length > LIMITS.notes) fail('notes', `Las notas no pueden tener más de ${LIMITS.notes} caracteres.`);
    c.notes = notes;

    const pr = parseDecimal(input.price);
    if (pr.invalid) fail('price', 'El precio debe ser un número válido (por ejemplo 500 o 12,50).');
    if (pr.empty) c.price = null;
    else {
      if (pr.value < 0) fail('price', 'El precio no puede ser negativo.');
      if (pr.value > 1e9) fail('price', 'El precio es demasiado grande.');
      c.price = round2(pr.value);
    }

    c.quantity = null;
    if (creating) {
      const q = parseDecimal(input.quantity);
      if (q.invalid) fail('quantity', 'La cantidad debe ser un número válido (puedes usar decimales).');
      if (!q.empty) {
        if (q.value < 0) fail('quantity', 'La cantidad no puede ser negativa.');
        if (q.value > 1e9) fail('quantity', 'La cantidad es demasiado grande.');
        c.quantity = round6(q.value);
      }
    }

    c.categoryId = input.categoryId ? String(input.categoryId) : null;
    c.subcategoryId = input.subcategoryId ? String(input.subcategoryId) : null;
    if (c.subcategoryId && !c.categoryId) fail('categoryId', 'Elige primero la categoría de la subcategoría.');
    return c;
  }

  /* La subcategoría debe existir y pertenecer a la categoría indicada. */
  async function checkCategoryRefs(S, categoryId, subcategoryId) {
    if (!categoryId) return;
    const cat = await R(S.categories.get(categoryId));
    if (!cat || cat.parentId) throw new AppError('VALIDATION', 'La categoría elegida ya no existe.', { field: 'categoryId' });
    if (subcategoryId) {
      const sub = await R(S.categories.get(subcategoryId));
      if (!sub || sub.parentId !== categoryId) {
        throw new AppError('VALIDATION', 'La subcategoría elegida no pertenece a esa categoría.', { field: 'subcategoryId' });
      }
    }
  }

  async function snapshotNames(S, product) {
    let categoryName = '';
    let subcategoryName = '';
    if (product.categoryId) {
      const c = await R(S.categories.get(product.categoryId));
      if (c) categoryName = c.name;
    }
    if (product.subcategoryId) {
      const s = await R(S.categories.get(product.subcategoryId));
      if (s) subcategoryName = s.name;
    }
    return { categoryName, subcategoryName };
  }

  /* El historial guarda una "foto" del producto para identificarlo aunque cambie o se archive. */
  async function buildMovement(S, product, f) {
    const names = await snapshotNames(S, product);
    return {
      id: f.id,
      productId: product.id,
      productName: product.name,
      brand: product.brand || '',
      code: product.code || '',
      categoryName: names.categoryName,
      subcategoryName: names.subcategoryName,
      type: f.type,
      quantity: f.quantity,
      before: f.before,
      after: f.after,
      unit: product.unit || '',
      note: f.note || '',
      initial: !!f.initial,
      estimated: !!f.estimated,
      orderId: f.orderId || null,
      price: typeof f.price === 'number' && Number.isFinite(f.price) ? f.price : null,
      party: f.party || '',
      createdAt: f.createdAt,
    };
  }

  /* ---------------- Productos ---------------- */

  /* photo: { blob, thumb } opcional (ya procesada). input.id permite crear sin duplicar si se repite la acción. */
  async function createProduct(input, photo) {
    const c = validateProductInput(input, true);
    const id = input.id || DB.uuid();
    const now = nextTs();
    return DB.tx(['products', 'categories', 'movements', 'photos'], 'readwrite', async (S) => {
      const existing = await R(S.products.get(id));
      if (existing) return { product: existing, duplicate: true };
      await checkCategoryRefs(S, c.categoryId, c.subcategoryId);
      const product = {
        id, name: c.name, brand: c.brand, code: c.code,
        categoryId: c.categoryId, subcategoryId: c.categoryId ? c.subcategoryId : null,
        color: c.color, presentation: c.presentation, capacity: c.capacity, fields: c.fields,
        quantity: c.quantity, quantityStatus: c.quantity !== null ? c.quantityStatus : 'confirmed',
        unit: c.unit, price: c.price, notes: c.notes,
        hasPhoto: !!photo, thumb: photo ? photo.thumb : null, photoUpdatedAt: photo ? now : null,
        archived: false, archivedAt: null, createdAt: now, updatedAt: now,
      };
      await R(S.products.put(product));
      if (photo) {
        await R(S.photos.put({ productId: id, blob: photo.blob, type: photo.blob.type || 'image/jpeg', width: photo.width || 0, height: photo.height || 0, updatedAt: now }));
      }
      if (c.quantity !== null) {
        /* La existencia inicial queda registrada como ajuste: el historial siempre explica la cantidad. */
        const mv = await buildMovement(S, product, {
          id: DB.uuid(), type: 'ajuste', quantity: null, before: null, after: c.quantity,
          note: 'Existencia inicial', initial: true, estimated: product.quantityStatus === 'estimated', createdAt: nextTs(),
        });
        await R(S.movements.put(mv));
      }
      return { product };
    });
  }

  /* photoChange: undefined = conservar, null = quitar, {blob, thumb} = reemplazar. La cantidad NO se edita aquí. */
  async function updateProduct(id, input, photoChange) {
    const c = validateProductInput(input, false);
    return DB.tx(['products', 'categories', 'photos'], 'readwrite', async (S) => {
      const p = await R(S.products.get(id));
      if (!p) throw new AppError('NOT_FOUND', 'El producto ya no existe.');
      await checkCategoryRefs(S, c.categoryId, c.subcategoryId);
      const now = Date.now();
      p.name = c.name; p.brand = c.brand; p.code = c.code; p.unit = c.unit; p.price = c.price; p.notes = c.notes;
      p.color = c.color; p.presentation = c.presentation; p.capacity = c.capacity; p.fields = c.fields;
      p.categoryId = c.categoryId;
      p.subcategoryId = c.categoryId ? c.subcategoryId : null;
      p.updatedAt = now;
      await applyPhotoChange(S, p, photoChange, now);
      await R(S.products.put(p));
      return p;
    });
  }

  async function applyPhotoChange(S, p, photoChange, now) {
    if (photoChange === undefined) return;
    if (photoChange === null) {
      await R(S.photos.delete(p.id));
      p.hasPhoto = false; p.thumb = null; p.photoUpdatedAt = null;
    } else {
      await R(S.photos.put({ productId: p.id, blob: photoChange.blob, type: photoChange.blob.type || 'image/jpeg', width: photoChange.width || 0, height: photoChange.height || 0, updatedAt: now }));
      p.hasPhoto = true; p.thumb = photoChange.thumb; p.photoUpdatedAt = now;
    }
  }

  function setPhoto(id, photoChange) {
    return DB.tx(['products', 'photos'], 'readwrite', async (S) => {
      const p = await R(S.products.get(id));
      if (!p) throw new AppError('NOT_FOUND', 'El producto ya no existe.');
      const now = Date.now();
      await applyPhotoChange(S, p, photoChange, now);
      p.updatedAt = now;
      await R(S.products.put(p));
      return p;
    });
  }

  function setArchived(id, archived) {
    return DB.tx(['products'], 'readwrite', async (S) => {
      const p = await R(S.products.get(id));
      if (!p) throw new AppError('NOT_FOUND', 'El producto ya no existe.');
      p.archived = !!archived;
      p.archivedAt = archived ? Date.now() : null;
      p.updatedAt = Date.now();
      await R(S.products.put(p));
      return p;
    });
  }

  function countMovements(productId) {
    return DB.tx(['movements'], 'readonly', (S) => R(S.movements.index('productId').count(IDBKeyRange.only(productId))));
  }

  /* Sin historial se borra directamente. Con historial hay que decidir expresamente (withHistory)
     y se elimina también el historial de ese producto, para no dejar registros huérfanos. */
  function deleteProduct(id, opts) {
    const withHistory = !!(opts && opts.withHistory);
    return DB.tx(['products', 'movements', 'photos'], 'readwrite', async (S) => {
      const p = await R(S.products.get(id));
      if (!p) return { deleted: false, movements: 0 };
      const keys = await R(S.movements.index('productId').getAllKeys(IDBKeyRange.only(id)));
      if (keys.length && !withHistory) {
        throw new AppError('HAS_HISTORY', 'Este producto tiene movimientos en el historial. Archívalo para conservarlos.');
      }
      for (const k of keys) await R(S.movements.delete(k));
      await R(S.photos.delete(id));
      await R(S.products.delete(id));
      return { deleted: true, movements: keys.length };
    });
  }

  /* Duplicar copia los datos de la ficha. NO copia cantidad (no hay entrada que la respalde) ni foto. */
  function duplicateProduct(id) {
    return DB.tx(['products'], 'readwrite', async (S) => {
      const p = await R(S.products.get(id));
      if (!p) throw new AppError('NOT_FOUND', 'El producto ya no existe.');
      const now = nextTs();
      const copy = {
        ...p, id: DB.uuid(), name: `${p.name} (copia)`.slice(0, LIMITS.name),
        fields: (p.fields || []).map((f) => ({ name: f.name, value: f.value })),
        quantity: null, quantityStatus: 'confirmed', hasPhoto: false, thumb: null, photoUpdatedAt: null,
        archived: false, archivedAt: null, createdAt: now, updatedAt: now,
      };
      await R(S.products.put(copy));
      return copy;
    });
  }

  function moveProducts(ids, categoryId, subcategoryId) {
    return DB.tx(['products', 'categories'], 'readwrite', async (S) => {
      await checkCategoryRefs(S, categoryId || null, categoryId ? subcategoryId || null : null);
      let n = 0;
      for (const id of ids) {
        const p = await R(S.products.get(id));
        if (!p) continue;
        p.categoryId = categoryId || null;
        p.subcategoryId = categoryId ? subcategoryId || null : null;
        p.updatedAt = Date.now();
        await R(S.products.put(p));
        n++;
      }
      return n;
    });
  }

  /* ---------------- Existencias ---------------- */

  /* input: { productId, type, amount | newQuantity, quantityStatus, note, opId }
     opId identifica la operación: si llega repetida (doble pulsación) no se duplica.
     quantityStatus ('confirmed' | 'estimated') solo se usa en los ajustes: una entrada o una salida
     no cambian si la cantidad es confirmada o aproximada. */
  async function registerMovement(input) {
    const type = input.type;
    if (!MOVEMENT_TYPES.includes(type)) throw new AppError('VALIDATION', 'Tipo de movimiento no válido.');
    const opId = input.opId || DB.uuid();
    let note = String(input.note || '').trim().slice(0, LIMITS.note);
    const wantedStatus = input.quantityStatus === 'estimated' ? 'estimated' : input.quantityStatus === 'confirmed' ? 'confirmed' : null;
    let amount = null;
    let newQty = null;
    if (type === 'ajuste') {
      const p = parseDecimal(input.newQuantity);
      if (p.empty) fail('amount', 'Escribe la cantidad correcta. Si todavía no la conoces, no hace falta ajustar.');
      if (p.invalid) fail('amount', 'La cantidad debe ser un número válido (puedes usar decimales).');
      if (p.value < 0) fail('amount', 'La cantidad corregida no puede ser negativa.');
      if (p.value > 1e9) fail('amount', 'La cantidad es demasiado grande.');
      newQty = round6(p.value);
    } else {
      const p = parseDecimal(input.amount);
      if (p.empty) fail('amount', 'Escribe la cantidad.');
      if (p.invalid) fail('amount', 'La cantidad debe ser un número válido (puedes usar decimales).');
      if (p.value <= 0) fail('amount', 'La cantidad debe ser mayor que cero.');
      if (p.value > 1e9) fail('amount', 'La cantidad es demasiado grande.');
      amount = round6(p.value);
    }

    return DB.tx(['products', 'categories', 'movements', 'settings'], 'readwrite', async (S) => {
      const dup = await R(S.movements.get(opId));
      if (dup) return { movement: dup, duplicate: true };
      const product = await R(S.products.get(input.productId));
      if (!product) throw new AppError('NOT_FOUND', 'El producto ya no existe.');
      if (product.archived) throw new AppError('ARCHIVED', 'Este producto está archivado. Restáuralo para registrar movimientos.');

      const before = product.quantity === undefined ? null : product.quantity;
      const beforeStatus = product.quantityStatus === 'estimated' ? 'estimated' : 'confirmed';
      let afterStatus = beforeStatus;
      let after;
      let qty;
      if (type === 'entrada' || type === 'salida') {
        if (before === null) {
          throw new AppError('UNKNOWN_QTY', 'La existencia de este producto todavía no está registrada. Primero establécela con «Ajustar existencia».');
        }
        if (type === 'entrada') {
          after = round6(before + amount);
        } else {
          after = round6(before - amount);
          if (after < 0) {
            const row = await R(S.settings.get('allowOversell'));
            if (!(row && row.value === true)) {
              throw new AppError('INSUFFICIENT', `No hay suficientes existencias: solo hay ${fmtNum(before)} y quieres sacar ${fmtNum(amount)}.`, { field: 'amount' });
            }
          }
        }
        qty = amount;
      } else {
        after = newQty;
        qty = before === null ? null : round6(after - before);
        afterStatus = wantedStatus || (before === null ? 'confirmed' : beforeStatus);
        if (before !== null && qty === 0 && afterStatus === beforeStatus) {
          throw new AppError('NO_CHANGE', `La existencia ya es ${fmtNum(before)}; no hay nada que ajustar. Si solo quieres cambiar entre «confirmada» y «aproximada», cambia esa opción.`, { field: 'amount' });
        }
        if (!note && before !== null && afterStatus !== beforeStatus) {
          note = afterStatus === 'estimated' ? 'Cantidad marcada como aproximada' : 'Cantidad confirmada';
        }
      }

      const mv = await buildMovement(S, product, { id: opId, type, quantity: qty, before, after, note, estimated: afterStatus === 'estimated', createdAt: nextTs() });
      await R(S.movements.put(mv));
      product.quantity = after;
      product.quantityStatus = afterStatus;
      product.updatedAt = Date.now();
      await R(S.products.put(product));
      return { movement: mv, product };
    });
  }

  /* Pedido: varias entradas o salidas a la vez, en UNA transacción (todo o nada).
     input: { type:'entrada'|'salida', items:[{productId, amount}], party, note, opId }
     opId identifica el pedido: si llega repetido (doble pulsación) no se duplica. */
  async function registerBatch(input) {
    const type = input.type;
    if (type !== 'entrada' && type !== 'salida') throw new AppError('VALIDATION', 'Tipo de pedido no válido.');
    const opId = input.opId || DB.uuid();
    const party = String(input.party || '').trim().slice(0, 80);
    const note = String(input.note || '').trim().slice(0, LIMITS.note);
    const merged = new Map();
    const prices = new Map();
    for (const it of input.items || []) {
      if (it.price !== null && it.price !== undefined && it.price !== '') {
        const pp = Number(it.price);
        if (!Number.isFinite(pp) || pp < 0 || pp > 1e9) throw new AppError('VALIDATION', 'Hay un precio no válido en el carrito.');
        prices.set(it.productId, round2(pp));
      }
      const p = parseDecimal(it.amount);
      if (p.empty || p.invalid || p.value <= 0 || p.value > 1e9) throw new AppError('VALIDATION', 'Hay un producto con una cantidad no válida. Revisa el carrito.');
      merged.set(it.productId, round6((merged.get(it.productId) || 0) + p.value));
    }
    if (!merged.size) throw new AppError('VALIDATION', 'El carrito está vacío.');
    return DB.tx(['products', 'categories', 'movements', 'settings'], 'readwrite', async (S) => {
      const first = await R(S.movements.get(`${opId}:0`));
      if (first) return { duplicate: true, movements: [first], orderId: opId };
      const row = await R(S.settings.get('allowOversell'));
      const oversell = !!(row && row.value === true);
      const work = [];
      for (const [productId, amount] of merged) {
        const product = await R(S.products.get(productId));
        if (!product) throw new AppError('NOT_FOUND', 'Un producto del carrito ya no existe. Quítalo y vuelve a intentarlo.');
        if (product.archived) throw new AppError('ARCHIVED', `«${product.name}» está archivado. Quítalo del carrito.`);
        const before = product.quantity === undefined ? null : product.quantity;
        if (before === null) throw new AppError('UNKNOWN_QTY', `«${product.name}» no tiene existencia registrada. Establécela primero con «Ajustar existencia».`);
        const after = type === 'entrada' ? round6(before + amount) : round6(before - amount);
        if (after < 0 && !oversell) throw new AppError('INSUFFICIENT', `«${product.name}»: solo hay ${fmtNum(before)} y pides ${fmtNum(amount)}. No se registró nada.`);
        work.push({ product, amount, before, after });
      }
      const out = [];
      let i = 0;
      for (const w of work) {
        const mv = await buildMovement(S, w.product, {
          id: `${opId}:${i++}`, type, quantity: w.amount, before: w.before, after: w.after, note,
          estimated: w.product.quantityStatus === 'estimated', orderId: opId, party, price: type === 'salida' && prices.has(w.product.id) ? prices.get(w.product.id) : null, createdAt: nextTs(),
        });
        await R(S.movements.put(mv));
        w.product.quantity = w.after;
        w.product.updatedAt = Date.now();
        await R(S.products.put(w.product));
        out.push(mv);
      }
      return { movements: out, orderId: opId };
    });
  }

  /* Los movimientos no se editan ni se borran (no se podría reconciliar de forma segura las existencias);
     solo se puede corregir la nota. Una equivocación se corrige con un Ajuste. */
  function updateMovementNote(id, note) {
    const clean = String(note || '').trim().slice(0, LIMITS.note);
    return DB.tx(['movements'], 'readwrite', async (S) => {
      const m = await R(S.movements.get(id));
      if (!m) throw new AppError('NOT_FOUND', 'El movimiento ya no existe.');
      m.note = clean;
      await R(S.movements.put(m));
      return m;
    });
  }

  /* filter: { productId, type, from, to (ms), q }. Más recientes primero. */
  function listMovements(filter, limit, offset) {
    const f = filter || {};
    const tokens = norm(f.q).split(/\s+/).filter(Boolean);
    const match = (m) => {
      if (f.productId && m.productId !== f.productId) return false;
      if (f.type && m.type !== f.type) return false;
      if (f.orderId && m.orderId !== f.orderId) return false;
      if (f.from && m.createdAt < f.from) return false;
      if (f.to && m.createdAt > f.to) return false;
      if (tokens.length) {
        const hay = norm(`${m.productName} ${m.brand} ${m.code} ${m.categoryName} ${m.subcategoryName} ${m.note} ${m.party || ''}`);
        if (!tokens.every((t) => hay.includes(t))) return false;
      }
      return true;
    };
    return DB.tx(['movements'], 'readonly', async (S) => {
      const items = [];
      let skipped = 0;
      await new Promise((resolve, reject) => {
        const r = S.movements.index('createdAt').openCursor(null, 'prev');
        r.onsuccess = () => {
          const cur = r.result;
          if (!cur || items.length > limit) { resolve(); return; }
          if (match(cur.value)) {
            if (skipped < offset) skipped++;
            else items.push(cur.value);
          }
          cur.continue();
        };
        r.onerror = () => reject(r.error);
      });
      const hasMore = items.length > limit;
      if (hasMore) items.pop();
      return { items, hasMore };
    });
  }

  /* ---------------- Búsqueda y orden (datos ya cargados en memoria) ---------------- */

  const searchCache = new WeakMap();
  function searchText(p) {
    let s = searchCache.get(p);
    if (s === undefined) {
      s = norm(`${p.name} ${p.brand} ${p.code} ${p.color || ''}`);
      searchCache.set(p, s);
    }
    return s;
  }
  const collator = new Intl.Collator('es', { sensitivity: 'base', numeric: true });

  /* f: { query, categoryId ('' todas, '__none' sin categoría, id), subcategoryId, status, sort } */
  function filterProducts(products, f, catById) {
    const tokens = norm(f.query).split(/\s+/).filter(Boolean);
    const out = products.filter((p) => {
      if (f.status === 'active' && p.archived) return false;
      if (f.status === 'archived' && !p.archived) return false;
      if (f.categoryId === '__none') { if (p.categoryId) return false; }
      else if (f.categoryId && p.categoryId !== f.categoryId) return false;
      if (f.subcategoryId && p.subcategoryId !== f.subcategoryId) return false;
      if (tokens.length) {
        const hay = searchText(p);
        for (const t of tokens) if (!hay.includes(t)) return false;
      }
      return true;
    });
    const order = (id) => {
      const c = id ? catById.get(id) : null;
      return c ? c.order : Infinity;
    };
    switch (f.sort) {
      case 'brand':
        out.sort((a, b) => (!a.brand - !b.brand) || collator.compare(a.brand, b.brand) || collator.compare(a.name, b.name));
        break;
      case 'category':
        out.sort((a, b) => (order(a.categoryId) - order(b.categoryId)) || (order(a.subcategoryId) - order(b.subcategoryId)) || collator.compare(a.name, b.name));
        break;
      case 'created':
        out.sort((a, b) => b.createdAt - a.createdAt);
        break;
      default:
        out.sort((a, b) => collator.compare(a.name, b.name));
    }
    return out;
  }

  /* Producto activo con el mismo nombre, marca y código (aviso de posible duplicado). */
  function findSimilar(products, data, excludeId) {
    const n = norm(data.name);
    const b = norm(data.brand);
    const c = norm(data.code);
    return products.find((p) => p.id !== excludeId && !p.archived && norm(p.name) === n && norm(p.brand) === b && norm(p.code) === c) || null;
  }

  globalThis.Inventory = {
    MOVEMENT_TYPES, LIMITS,
    norm, fmtNum, fmtSigned, unitText, qtyText, parseDecimal, round2, round6, nextTs, collator,
    validateProductInput, createProduct, updateProduct, setPhoto, setArchived,
    deleteProduct, duplicateProduct, moveProducts, countMovements,
    registerMovement, registerBatch, updateMovementNote, listMovements,
    filterProducts, findSimilar,
  };
})();

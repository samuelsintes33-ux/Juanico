'use strict';
/* settings.js — Configuración, copias de seguridad, mantenimiento y restablecimiento. */
(function () {
  const { AppError, DB, Inventory } = globalThis;
  const R = (r) => DB.req(r);
  const esc = (s) => UI.esc(s);

  const APP_ID = 'almacen-inventario';
  const APP_VERSION = '1.4.2';
  const BACKUP_SCHEMA = 2; // versión del formato de copia (coincide con la versión de la base de datos)
  const LOCAL_ONLY_KEYS = ['lastBackupAt', 'syncState', 'carts']; // propios de cada teléfono: nunca viajan en copias

  const DEFAULTS = {
    theme: 'system',            // system | light | dark
    fontScale: 100,             // 90 | 100 | 115 | 130
    currency: 'CUP',
    allowOversell: false,       // permitir salidas mayores a la existencia
    showArchivedPhotos: false,  // fotos de productos archivados en la galería
    defaultStatus: 'active',    // active | all
    unknownQtyLabel: 'Pendiente de conteo',
    listPrefs: null,
    lastBackupAt: null,
    quickSteps: [1, 5, 10, 12, 50], // botones rápidos del carrito (se editan en Configuración)
    customReasons: [],          // otros motivos de baja (se añaden en Configuración)
    carts: null,                // carritos de entrada/salida sin confirmar (de este teléfono)
    syncState: null,            // datos de sincronización de ESTE teléfono (no se copia ni se comparte)
  };
  const FONT_SIZES = [[90, 'Pequeño'], [100, 'Normal'], [115, 'Grande'], [130, 'Muy grande']];

  /* ---------------- Preferencias ---------------- */

  async function load() {
    const rows = await DB.getAll('settings');
    const s = Object.assign({}, DEFAULTS);
    for (const r of rows) if (r.key in DEFAULTS) s[r.key] = r.value;
    App.state.settings = s;
    return s;
  }

  async function set(key, value) {
    if (!(key in DEFAULTS)) throw new AppError('VALIDATION', 'Ajuste desconocido.');
    await DB.put('settings', { key, value });
    App.state.settings[key] = value;
    if (key === 'theme' || key === 'fontScale') applyAppearance();
  }

  function applyAppearance() {
    const s = App.state.settings;
    const dark = s.theme === 'dark' || (s.theme === 'system' && window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    document.documentElement.style.setProperty('--fs', String(s.fontScale / 100));
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', dark ? '#0b1220' : '#0f766e');
    try {
      localStorage.setItem('almacen-pref-theme', s.theme);
      localStorage.setItem('almacen-pref-fontscale', String(s.fontScale));
    } catch (_) { /* solo evita parpadeos al abrir */ }
  }

  /* ---------------- Copias de seguridad ---------------- */

  async function blobToBase64(blob) {
    const buf = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    const CH = 0x8000;
    for (let i = 0; i < buf.length; i += CH) bin += String.fromCharCode.apply(null, buf.subarray(i, i + CH));
    return btoa(bin);
  }

  function base64ToBlob(b64, type) {
    const bin = atob(b64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return new Blob([u8], { type: type || 'image/jpeg' });
  }

  /* Lee todo en UNA transacción (estado consistente) y arma el archivo por partes para no
     crear una cadena gigante en memoria. */
  async function buildBackup() {
    const snap = await DB.exportSnapshot();
    const counts = {
      products: snap.products.length, categories: snap.categories.length,
      movements: snap.movements.length, photos: snap.photos.length,
    };
    const settingsOut = snap.settings.filter((r) => r.key in DEFAULTS && !LOCAL_ONLY_KEYS.includes(r.key));
    const exportedAt = Date.now();
    const parts = [
      `{"app":${JSON.stringify(APP_ID)},"kind":"backup","schemaVersion":${BACKUP_SCHEMA},"appVersion":${JSON.stringify(APP_VERSION)},` +
      `"exportedAt":${exportedAt},"counts":${JSON.stringify(counts)},"data":{` +
      `"products":${JSON.stringify(snap.products)},"categories":${JSON.stringify(snap.categories)},` +
      `"movements":${JSON.stringify(snap.movements)},"settings":${JSON.stringify(settingsOut)},"photos":[`,
    ];
    let first = true;
    for (const ph of snap.photos) {
      const b64 = await blobToBase64(ph.blob);
      parts.push((first ? '' : ',') + JSON.stringify({ productId: ph.productId, mime: ph.type || ph.blob.type || 'image/jpeg', width: ph.width || 0, height: ph.height || 0, updatedAt: ph.updatedAt || 0, data: b64 }));
      first = false;
    }
    parts.push(']}}');
    return { blob: new Blob(parts, { type: 'application/json' }), counts, exportedAt };
  }

  function backupFileName(ts) {
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return `almacen-copia-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}.json`;
  }

  const isStr = (v) => typeof v === 'string' && v.length > 0;
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
  const isNumOrNull = (v) => v === null || v === undefined || isNum(v);
  const isStrOrNull = (v) => v === null || v === undefined || typeof v === 'string';

  function cleanFieldList(list) {
    if (!Array.isArray(list)) return [];
    const L = Inventory.LIMITS;
    const out = [];
    const seen = new Set();
    for (const f of list) {
      if (!f || typeof f !== 'object') continue;
      const name = String(f.name || '').trim().slice(0, L.fieldName);
      if (!name || seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());
      out.push({ name, value: String(f.value || '').slice(0, L.fieldValue) });
      if (out.length >= L.maxFields) break;
    }
    return out;
  }

  /* Valida la estructura SIN tocar la base de datos. Devuelve datos limpios (solo campos conocidos). */
  function validateBackup(obj, opts) {
    opts = opts || {};
    const errors = [];
    const warnings = [];
    const clean = { products: [], categories: [], movements: [], photos: [], settings: [] };
    const fail = (m) => { if (errors.length < 30) errors.push(m); };
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, errors: ['El archivo no tiene el formato de una copia de Almacén.'], warnings, clean, summary: null };
    if (obj.app !== APP_ID) fail('El archivo no es una copia de esta aplicación.');
    if (obj.kind === 'update' && !opts.allowUpdate) fail('Este archivo es una ACTUALIZACIÓN, no una copia de seguridad. Impórtalo desde «Actualización entre teléfonos».');
    if (!isNum(obj.schemaVersion)) fail('La copia no indica su versión.');
    else if (obj.schemaVersion > BACKUP_SCHEMA) fail(`La copia es de una versión más nueva (${obj.schemaVersion}). Actualiza la aplicación antes de restaurarla.`);
    else if (obj.schemaVersion < 1) fail('La versión de la copia no es válida.');
    const data = obj.data;
    if (!data || typeof data !== 'object') {
      fail('La copia no contiene datos.');
      return { ok: false, errors, warnings, clean, summary: null };
    }
    for (const k of ['products', 'categories', 'movements', 'photos']) {
      if (!Array.isArray(data[k])) fail(`Falta la lista «${k}» en la copia.`);
    }
    if (errors.length) return { ok: false, errors, warnings, clean, summary: null };

    // Categorías
    const catIds = new Set();
    for (const c of data.categories) {
      if (!c || !isStr(c.id) || !isStr(c.name)) { fail('Hay una categoría sin identificador o sin nombre.'); continue; }
      if (catIds.has(c.id)) { fail(`Categoría repetida: «${c.name}».`); continue; }
      if (!(c.parentId === null || c.parentId === undefined || isStr(c.parentId))) { fail(`La categoría «${c.name}» tiene un dato de jerarquía inválido.`); continue; }
      if (!isNumOrNull(c.generalPrice) || (isNum(c.generalPrice) && c.generalPrice < 0)) { fail(`Precio general inválido en «${c.name}».`); continue; }
      catIds.add(c.id);
      clean.categories.push({
        id: c.id, name: String(c.name).slice(0, 60), parentId: c.parentId || null,
        order: isNum(c.order) ? c.order : 0, generalPrice: isNum(c.generalPrice) ? c.generalPrice : null,
        createdAt: isNum(c.createdAt) ? c.createdAt : Date.now(), updatedAt: isNum(c.updatedAt) ? c.updatedAt : Date.now(),
      });
    }
    const catById = new Map(clean.categories.map((c) => [c.id, c]));
    for (const c of clean.categories) {
      if (c.parentId) {
        const parent = catById.get(c.parentId);
        if (!parent) fail(`La subcategoría «${c.name}» apunta a una categoría que no existe.`);
        else if (parent.parentId) fail(`La subcategoría «${c.name}» está dentro de otra subcategoría (no permitido).`);
      }
    }

    // Productos
    const prodIds = new Set();
    for (const p of data.products) {
      if (!p || !isStr(p.id) || !isStr(p.name)) { fail('Hay un producto sin identificador o sin nombre.'); continue; }
      if (prodIds.has(p.id)) { fail(`Producto repetido: «${p.name}».`); continue; }
      if (!isNumOrNull(p.quantity)) { fail(`Cantidad inválida en «${p.name}».`); continue; }
      if (!isNumOrNull(p.price) || (isNum(p.price) && p.price < 0)) { fail(`Precio inválido en «${p.name}».`); continue; }
      if (!isStrOrNull(p.categoryId) || !isStrOrNull(p.subcategoryId)) { fail(`Categoría inválida en «${p.name}».`); continue; }
      prodIds.add(p.id);
      const q = isNum(p.quantity) ? p.quantity : null;
      if (q !== null && q < 0) warnings.push(`«${p.name}» tiene una existencia negativa (${q}).`);
      clean.products.push({
        id: p.id, name: String(p.name).slice(0, 120), brand: String(p.brand || '').slice(0, 60), code: String(p.code || '').slice(0, 60),
        categoryId: p.categoryId || null, subcategoryId: p.subcategoryId || null,
        quantity: q, unit: String(p.unit || '').slice(0, 20), price: isNum(p.price) ? p.price : null, notes: String(p.notes || '').slice(0, 1000),
        color: String(p.color || '').slice(0, Inventory.LIMITS.color), presentation: String(p.presentation || '').slice(0, Inventory.LIMITS.presentation),
        capacity: String(p.capacity || '').slice(0, Inventory.LIMITS.capacity), fields: cleanFieldList(p.fields),
        quantityStatus: p.quantityStatus === 'estimated' && q !== null ? 'estimated' : 'confirmed',
        hasPhoto: !!p.hasPhoto, thumb: typeof p.thumb === 'string' && p.thumb.startsWith('data:image/') ? p.thumb : null,
        photoUpdatedAt: isNum(p.photoUpdatedAt) ? p.photoUpdatedAt : null,
        archived: !!p.archived, archivedAt: isNum(p.archivedAt) ? p.archivedAt : null,
        createdAt: isNum(p.createdAt) ? p.createdAt : Date.now(), updatedAt: isNum(p.updatedAt) ? p.updatedAt : Date.now(),
      });
    }
    for (const p of clean.products) {
      if (p.categoryId && !catById.has(p.categoryId)) fail(`«${p.name}» apunta a una categoría que no está en la copia.`);
      else if (p.categoryId && catById.get(p.categoryId).parentId) fail(`«${p.name}» usa una subcategoría como categoría.`);
      if (p.subcategoryId) {
        const s = catById.get(p.subcategoryId);
        if (!s) fail(`«${p.name}» apunta a una subcategoría que no está en la copia.`);
        else if (s.parentId !== p.categoryId) fail(`La subcategoría de «${p.name}» no pertenece a su categoría.`);
      }
    }

    // Movimientos
    const mvIds = new Set();
    for (const m of data.movements) {
      if (!m || !isStr(m.id) || !isStr(m.productId)) { fail('Hay un movimiento sin identificador o sin producto.'); continue; }
      if (mvIds.has(m.id)) { fail('Hay movimientos repetidos en la copia.'); continue; }
      if (!Inventory.MOVEMENT_TYPES.includes(m.type)) { fail('Hay un movimiento con tipo desconocido.'); continue; }
      if (!isNum(m.createdAt)) { fail('Hay un movimiento sin fecha.'); continue; }
      if (!isNumOrNull(m.quantity) || !isNumOrNull(m.before) || !isNumOrNull(m.after)) { fail('Hay un movimiento con cantidades inválidas.'); continue; }
      if (!prodIds.has(m.productId)) { fail(`Hay un movimiento de «${m.productName || '?'}» cuyo producto no está en la copia.`); continue; }
      mvIds.add(m.id);
      clean.movements.push({
        id: m.id, productId: m.productId, productName: String(m.productName || '').slice(0, 120), brand: String(m.brand || ''), code: String(m.code || ''),
        categoryName: String(m.categoryName || ''), subcategoryName: String(m.subcategoryName || ''), type: m.type,
        quantity: isNum(m.quantity) ? m.quantity : null, before: isNum(m.before) ? m.before : null, after: isNum(m.after) ? m.after : null,
        unit: String(m.unit || ''), note: String(m.note || '').slice(0, 300), initial: !!m.initial, estimated: !!m.estimated, orderId: isStr(m.orderId) ? m.orderId : null, reason: String(m.reason || '').slice(0, 60), discrepancy: !!m.discrepancy, resolved: !!m.resolved, occurredAt: isNum(m.occurredAt) ? m.occurredAt : null, price: isNum(m.price) && m.price >= 0 ? m.price : null, party: String(m.party || '').slice(0, 80), createdAt: m.createdAt,
      });
    }

    // Fotos
    const photoIds = new Set();
    for (const ph of data.photos) {
      if (!ph || !isStr(ph.productId) || typeof ph.data !== 'string' || !ph.data) { fail('Hay una foto sin producto o sin datos.'); continue; }
      if (!prodIds.has(ph.productId)) { fail('Hay una foto que no pertenece a ningún producto de la copia.'); continue; }
      if (photoIds.has(ph.productId)) { fail('Hay dos fotos para el mismo producto.'); continue; }
      if (typeof ph.mime !== 'string' || !/^image\//.test(ph.mime)) { fail('Hay una foto con formato no válido.'); continue; }
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(ph.data)) { fail('Hay una foto dañada (datos no válidos).'); continue; }
      photoIds.add(ph.productId);
      clean.photos.push({ productId: ph.productId, mime: ph.mime, width: isNum(ph.width) ? ph.width : 0, height: isNum(ph.height) ? ph.height : 0, updatedAt: isNum(ph.updatedAt) ? ph.updatedAt : Date.now(), data: ph.data });
    }
    for (const p of clean.products) {
      if (p.hasPhoto && !photoIds.has(p.id) && !opts.keepPhotoFlags) { p.hasPhoto = false; p.thumb = null; p.photoUpdatedAt = null; warnings.push(`«${p.name}» indicaba una foto que no está en la copia; se dejó sin foto.`); }
      if (!p.hasPhoto && photoIds.has(p.id) && !opts.keepPhotoFlags) p.hasPhoto = true;
    }

    // Ajustes (solo claves conocidas y con tipo correcto)
    if (Array.isArray(data.settings)) {
      for (const r of data.settings) {
        if (!r || !(r.key in DEFAULTS) || LOCAL_ONLY_KEYS.includes(r.key)) continue;
        const def = DEFAULTS[r.key];
        if (def !== null && typeof r.value !== typeof def) continue;
        if (Array.isArray(def) && !Array.isArray(r.value)) continue;
        if (r.key === 'theme' && !['system', 'light', 'dark'].includes(r.value)) continue;
        if (r.key === 'fontScale' && ![90, 100, 115, 130].includes(r.value)) continue;
        if (r.key === 'defaultStatus' && !['active', 'all'].includes(r.value)) continue;
        if (r.key === 'quickSteps' && !(Array.isArray(r.value) && r.value.length <= 8 && r.value.every((x) => isNum(x) && x > 0 && x <= 100000))) continue;
        if (r.key === 'customReasons' && !(Array.isArray(r.value) && r.value.length <= 20 && r.value.every((x) => typeof x === 'string' && x.length <= 60))) continue;
        if (r.key === 'listPrefs' && r.value !== null && typeof r.value !== 'object') continue;
        clean.settings.push({ key: r.key, value: r.value });
      }
    }

    const summary = {
      products: clean.products.length, categories: clean.categories.filter((c) => !c.parentId).length,
      subcategories: clean.categories.filter((c) => c.parentId).length, movements: clean.movements.length,
      photos: clean.photos.length, exportedAt: isNum(obj.exportedAt) ? obj.exportedAt : null,
    };
    return { ok: errors.length === 0, errors, warnings, clean, summary };
  }

  /* Convierte las fotos de la copia en registros listos para guardar. Se hace ANTES de tocar
     la base de datos, para que un error aquí no afecte a los datos actuales. */
  function prepareRecords(clean) {
    const now = Date.now();
    return {
      products: clean.products,
      categories: clean.categories,
      movements: clean.movements,
      settings: clean.settings,
      photos: clean.photos.map((ph) => {
        const blob = base64ToBlob(ph.data, ph.mime);
        return { productId: ph.productId, blob, type: blob.type, width: ph.width, height: ph.height, updatedAt: ph.updatedAt || now };
      }),
    };
  }

  /* mode 'replace': sustituye todo (una sola transacción: si falla, queda lo anterior).
     mode 'merge': solo añade lo que no existe; los productos que ya existen se respetan
     (con sus movimientos), así las existencias nunca quedan desfasadas del historial. */
  async function restoreBackup(clean, mode) {
    const rec = prepareRecords(clean);
    if (mode === 'replace') {
      await DB.replaceAll(rec, LOCAL_ONLY_KEYS);
      return { mode, products: rec.products.length, movements: rec.movements.length, photos: rec.photos.length };
    }
    const snap = await DB.exportSnapshot();
    const haveProd = new Set(snap.products.map((p) => p.id));
    const haveCat = new Set(snap.categories.map((c) => c.id));
    const newProducts = rec.products.filter((p) => !haveProd.has(p.id));
    const newIds = new Set(newProducts.map((p) => p.id));
    const plan = {
      categories: rec.categories.filter((c) => !haveCat.has(c.id)),
      products: newProducts,
      movements: rec.movements.filter((m) => newIds.has(m.productId)),
      photos: rec.photos.filter((ph) => newIds.has(ph.productId)),
      settings: [],
    };
    const added = await DB.addMissing(plan);
    return { mode, products: added.products, movements: added.movements, photos: added.photos, categories: added.categories, skipped: rec.products.length - newProducts.length };
  }

  /* ---------------- Mantenimiento: integridad ---------------- */

  async function runIntegrity() {
    const snap = await DB.exportSnapshot();
    const issues = [];
    const catById = new Map(snap.categories.map((c) => [c.id, c]));
    const prodById = new Map(snap.products.map((p) => [p.id, p]));
    const photoById = new Map(snap.photos.map((ph) => [ph.productId, ph]));
    const lastMv = new Map();
    for (const m of snap.movements) {
      const cur = lastMv.get(m.productId);
      if (!cur || m.createdAt > cur.createdAt) lastMv.set(m.productId, m);
    }
    const add = (level, kind, text, fix) => issues.push({ level, kind, text, fix: fix || null });

    for (const c of snap.categories) {
      if (c.parentId && !catById.has(c.parentId)) add('err', 'cat-orphan', `La subcategoría «${c.name}» no tiene categoría principal.`);
    }
    for (const p of snap.products) {
      if (p.categoryId && !catById.has(p.categoryId)) add('err', 'bad-cat', `«${p.name}» apunta a una categoría que ya no existe.`, { type: 'clear-category', id: p.id });
      else if (p.subcategoryId) {
        const s = catById.get(p.subcategoryId);
        if (!s || s.parentId !== p.categoryId) add('err', 'bad-sub', `La subcategoría de «${p.name}» no es válida.`, { type: 'clear-sub', id: p.id });
      }
      if (typeof p.quantity === 'number' && p.quantity < 0) add('warn', 'neg-qty', `«${p.name}» tiene existencia negativa (${Inventory.fmtNum(p.quantity)}). Corrígela con un ajuste.`);
      if (p.hasPhoto && !photoById.has(p.id)) add('err', 'photo-missing', `«${p.name}» indica una foto que no existe.`, { type: 'drop-photo-flag', id: p.id });
      if (!p.hasPhoto && photoById.has(p.id)) add('warn', 'photo-flag', `«${p.name}» tiene una foto guardada pero no marcada.`, { type: 'fix-photo-flag', id: p.id });
      if (p.hasPhoto && photoById.has(p.id) && !p.thumb) add('warn', 'thumb-missing', `«${p.name}» no tiene miniatura.`, { type: 'make-thumb', id: p.id });
      const last = lastMv.get(p.id);
      if (last && last.after !== null && p.quantity !== last.after) {
        add('warn', 'qty-mismatch', `La existencia de «${p.name}» (${p.quantity === null ? 'sin registrar' : Inventory.fmtNum(p.quantity)}) no coincide con su último movimiento (${Inventory.fmtNum(last.after)}). Registra un ajuste si no sabes por qué.`);
      }
    }
    for (const ph of snap.photos) {
      if (!prodById.has(ph.productId)) add('err', 'photo-orphan', 'Hay una foto guardada que no pertenece a ningún producto.', { type: 'drop-photo', id: ph.productId });
    }
    const orphanMv = snap.movements.filter((m) => !prodById.has(m.productId));
    if (orphanMv.length) add('warn', 'mv-orphan', `Hay ${orphanMv.length} movimiento${orphanMv.length === 1 ? '' : 's'} de productos que ya no existen. Se conservan por seguridad.`);
    return {
      issues,
      stats: { products: snap.products.length, categories: snap.categories.length, movements: snap.movements.length, photos: snap.photos.length },
    };
  }

  /* Repara solo lo que se puede arreglar sin perder información. */
  async function repairIntegrity(issues) {
    let fixed = 0;
    for (const is of issues) {
      const f = is.fix;
      if (!f) continue;
      try {
        if (f.type === 'drop-photo') {
          await DB.del('photos', f.id);
        } else {
          const p = await DB.get('products', f.id);
          if (!p) continue;
          if (f.type === 'clear-category') { p.categoryId = null; p.subcategoryId = null; }
          else if (f.type === 'clear-sub') p.subcategoryId = null;
          else if (f.type === 'drop-photo-flag') { p.hasPhoto = false; p.thumb = null; p.photoUpdatedAt = null; }
          else if (f.type === 'fix-photo-flag' || f.type === 'make-thumb') {
            const blob = await Gallery.getBlob(p.id);
            if (!blob) continue;
            p.thumb = await Gallery.thumbFromBlob(blob);
            p.hasPhoto = true;
          }
          p.updatedAt = Date.now();
          await DB.put('products', p);
        }
        fixed++;
      } catch (e) {
        console.error('No se pudo reparar', is, e);
      }
    }
    return fixed;
  }

  async function resetAll() {
    await DB.wipeAll();
    try { localStorage.removeItem('almacen-pref-theme'); localStorage.removeItem('almacen-pref-fontscale'); } catch (_) { /* nada */ }
    await load();
    applyAppearance();
  }

  /* ---------------- Interfaz ---------------- */

  const fmtBytes = (n) => (n >= 1073741824 ? `${(n / 1073741824).toFixed(1)} GB` : n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
  const fmtDateTime = (ts) => new Date(ts).toLocaleString('es', { dateStyle: 'medium', timeStyle: 'short' });

  async function doExport(share) {
    const { blob, counts, exportedAt } = await buildBackup();
    const name = backupFileName(exportedAt);
    if (share) {
      const r = await shareOrDownload(blob, name, 'Copia de seguridad de Almacén');
      if (r === 'cancelled') return false;
      if (r === 'downloaded') UI.toast('Este navegador no puede compartir archivos. La copia se descargó en tu teléfono.');
    } else {
      UI.download(blob, name);
    }
    await set('lastBackupAt', exportedAt);
    UI.toast(`Copia creada: ${counts.products} productos, ${counts.movements} movimientos, ${counts.photos} fotos. Guárdala en un lugar seguro (por ejemplo, tu Drive o WhatsApp).`, 'ok');
    return true;
  }

  async function chooseFile(accept) {
    return new Promise((resolve) => {
      const inp = document.createElement('input');
      inp.type = 'file';
      // .txt incluido: WhatsApp y algunos navegadores renombran los .json como .txt
      inp.accept = accept || '.json,.txt,application/json,text/plain';
      inp.style.display = 'none';
      document.body.appendChild(inp);
      let done = false;
      const finish = (f) => { if (done) return; done = true; inp.remove(); resolve(f || null); };
      inp.addEventListener('change', () => finish(inp.files && inp.files[0]));
      inp.addEventListener('cancel', () => finish(null));
      inp.click();
    });
  }

  /* Comparte un archivo con el menú del teléfono. Android/Chrome a veces no acepta .json para
     compartir: se prueba .json, luego .txt (mismo contenido) y por último se descarga.
     Devuelve 'shared' | 'downloaded' | 'cancelled'. Nunca afirma que se "envió": solo que se abrió el menú. */
  async function shareOrDownload(blob, name, title) {
    const attempts = [
      new File([blob], name, { type: 'application/json' }),
      new File([blob], name.replace(/\.json$/i, '.txt'), { type: 'text/plain' }),
    ];
    if (navigator.canShare && navigator.share) {
      for (const file of attempts) {
        let ok = false;
        try { ok = navigator.canShare({ files: [file] }); } catch (_) { ok = false; }
        if (!ok) continue;
        try {
          await navigator.share({ files: [file], title });
          return 'shared';
        } catch (e) {
          if (e && e.name === 'AbortError') return 'cancelled';
          // otro error: se prueba el siguiente formato
        }
      }
    }
    UI.download(blob, name);
    return 'downloaded';
  }

  async function importFlow() {
    const file = await chooseFile();
    if (!file) return;
    let result;
    try {
      const text = await file.text();
      let obj;
      try { obj = JSON.parse(text); } catch (_) { throw new AppError('BAD_BACKUP', 'El archivo no se pudo leer: no es una copia válida (JSON dañado).'); }
      result = validateBackup(obj);
    } catch (e) {
      await UI.alert({ title: 'No se puede restaurar', message: DB.friendlyError(e) + ' Tus datos actuales no se tocaron.' });
      return;
    }
    if (!result.ok) {
      await UI.alert({
        title: 'La copia no es válida',
        html: `<p>Se encontraron problemas y <b>no se modificó nada</b> de tu inventario actual:</p><ul>${result.errors.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`,
      });
      return;
    }
    const s = result.summary;
    const cur = App.state;
    const hasData = cur.products.length > 0 || cur.categories.length > 0;
    const when = s.exportedAt ? fmtDateTime(s.exportedAt) : 'fecha desconocida';
    const html = `
      <div class="stack">
        <div class="kv">
          <div><div class="k">Productos</div><div class="v">${s.products}</div></div>
          <div><div class="k">Categorías</div><div class="v">${s.categories} (+${s.subcategories} sub.)</div></div>
          <div><div class="k">Movimientos</div><div class="v">${s.movements}</div></div>
          <div><div class="k">Fotos</div><div class="v">${s.photos}</div></div>
          <div class="full"><div class="k">Copia creada</div><div class="v">${esc(when)}</div></div>
        </div>
        ${result.warnings.length ? `<div class="notice">${esc(result.warnings.slice(0, 3).join(' '))}${result.warnings.length > 3 ? ` (y ${result.warnings.length - 3} avisos más)` : ''}</div>` : ''}
        <div class="field"><span>¿Cómo restaurar?</span></div>
        <label class="format-opt sel" id="rs-replace"><input type="radio" name="rs-mode" value="replace" checked>
          <span><b>Reemplazar todo (recomendado)</b><small style="font-family:inherit">Tu inventario queda exactamente como en la copia. Repetir esta acción no duplica nada.</small></span></label>
        <label class="format-opt" id="rs-merge"><input type="radio" name="rs-mode" value="merge">
          <span><b>Combinar</b><small style="font-family:inherit">Solo añade productos que no existen aquí (con su historial y foto). No modifica los que ya tienes.</small></span></label>
        <div class="notice danger" id="rs-warn">${hasData ? `Se <b>reemplazarán</b> tus ${cur.products.length} productos actuales y su historial por los de la copia. Esto no se puede deshacer.` : 'Tu inventario actual está vacío.'}</div>
      </div>`;
    let mode = 'replace';
    const choice = await UI.modal({
      title: 'Restaurar copia', html,
      actions: [{ id: 'cancel', label: 'Cancelar', kind: 'ghost' }, { id: 'ok', label: 'Restaurar', kind: 'primary' }],
      onOpen(d) {
        d.body.addEventListener('change', () => {
          mode = d.body.querySelector('input[name=rs-mode]:checked').value;
          d.body.querySelector('#rs-replace').classList.toggle('sel', mode === 'replace');
          d.body.querySelector('#rs-merge').classList.toggle('sel', mode === 'merge');
          const w = d.body.querySelector('#rs-warn');
          w.className = mode === 'replace' ? 'notice danger' : 'notice info';
          w.textContent = mode === 'replace'
            ? (hasData ? `Se reemplazarán tus ${cur.products.length} productos actuales y su historial por los de la copia. Esto no se puede deshacer.` : 'Tu inventario actual está vacío.')
            : 'Se conservará todo lo que tienes y solo se añadirá lo que falte.';
        });
      },
      async onAction(id) {
        if (id !== 'ok') return;
        if (mode === 'replace' && hasData) {
          const sure = await UI.confirm({ title: '¿Reemplazar tus datos actuales?', message: 'Si no tienes una copia reciente de lo que hay ahora, se perderá. ¿Continuar?', okLabel: 'Sí, reemplazar', danger: true });
          if (!sure) return false;
        }
        try {
          const r = await restoreBackup(result.clean, mode);
          await Settings.load();
          Settings.applyAppearance();
          await App.afterRestore();
          UI.toast(mode === 'replace'
            ? `Copia restaurada: ${r.products} productos, ${r.movements} movimientos, ${r.photos} fotos.`
            : `Se añadieron ${r.products} productos nuevos (${r.skipped} ya existían y se respetaron).`, 'ok');
        } catch (e) {
          UI.toast(`No se pudo restaurar: ${DB.friendlyError(e)} Tus datos anteriores se conservaron.`, 'error');
          return false;
        }
      },
    });
    return choice;
  }

  function integrityDialog(res) {
    const errs = res.issues.filter((i) => i.level === 'err');
    const warns = res.issues.filter((i) => i.level === 'warn');
    const fixable = res.issues.filter((i) => i.fix);
    const st = res.stats;
    const html = `
      <div class="stack">
        <p class="muted">Revisados: ${st.products} productos, ${st.categories} categorías, ${st.movements} movimientos y ${st.photos} fotos.</p>
        ${res.issues.length === 0 ? '<div class="issue ok"><b>Todo en orden.</b> No se encontraron problemas.</div>' : ''}
        ${errs.map((i) => `<div class="issue err">${esc(i.text)}</div>`).join('')}
        ${warns.map((i) => `<div class="issue warn">${esc(i.text)}</div>`).join('')}
        ${fixable.length ? `<p class="muted small-text">Se pueden reparar ${fixable.length} problema${fixable.length === 1 ? '' : 's'} sin perder información. Las existencias nunca se cambian automáticamente.</p>` : ''}
      </div>`;
    const actions = [{ id: 'cancel', label: 'Cerrar', kind: 'secondary' }];
    if (fixable.length) actions.push({ id: 'fix', label: `Reparar (${fixable.length})`, kind: 'primary' });
    return UI.modal({
      title: 'Comprobación de datos', html, actions,
      async onAction(id) {
        if (id !== 'fix') return;
        const n = await repairIntegrity(res.issues);
        await App.refresh();
        UI.toast(`${n} problema${n === 1 ? '' : 's'} reparado${n === 1 ? '' : 's'}.`, 'ok');
      },
    });
  }

  async function resetFlow() {
    const html = `
      <div class="stack">
        <div class="notice danger">Esto borra <b>todos</b> tus productos, categorías, precios, fotos y movimientos de este teléfono. No se puede deshacer.</div>
        <p>Antes de continuar, guarda una copia de seguridad.</p>
        <button type="button" class="btn secondary" id="rs-backup">Crear copia ahora</button>
        <label class="field"><span>Para confirmar, escribe BORRAR</span><input id="rs-word" autocomplete="off" autocapitalize="characters" placeholder="BORRAR"></label>
        <div class="field-error" id="rs-err" role="alert"></div>
      </div>`;
    return UI.modal({
      title: 'Restablecer la aplicación', html, cls: 'center-dlg',
      actions: [{ id: 'cancel', label: 'Cancelar', kind: 'ghost' }, { id: 'ok', label: 'Borrar todo', kind: 'danger' }],
      onOpen(d) {
        d.body.querySelector('#rs-backup').addEventListener('click', () => UI.once('reset-backup', async () => {
          try { await doExport(false); } catch (e) { UI.toast(DB.friendlyError(e), 'error'); }
        }));
      },
      async onAction(id, body) {
        if (id !== 'ok') return;
        if (body.querySelector('#rs-word').value.trim().toUpperCase() !== 'BORRAR') {
          body.querySelector('#rs-err').textContent = 'Escribe la palabra BORRAR para confirmar.';
          return false;
        }
        try {
          await resetAll();
          await App.afterRestore();
          UI.toast('Aplicación restablecida. Está vacía y lista para empezar.', 'ok');
        } catch (e) {
          UI.toast(`No se pudo restablecer: ${DB.friendlyError(e)}`, 'error');
          return false;
        }
      },
    });
  }

  function render() {
    const el = document.getElementById('view-config');
    if (!el) return;
    const s = App.state.settings;
    const seg = (name, items, cur) => `<div class="seg" role="group" aria-label="${name}" data-seg="${name}">${items.map(([v, l]) => `<button type="button" data-v="${v}" aria-pressed="${String(v) === String(cur)}">${l}</button>`).join('')}</div>`;
    el.innerHTML = `
      <div class="card cfg">
        <h2>Apariencia</h2>
        <div class="field"><span>Tema</span></div>
        ${seg('theme', [['system', 'Automático'], ['light', 'Claro'], ['dark', 'Oscuro']], s.theme)}
        <div class="field"><span>Tamaño del texto</span></div>
        ${seg('fontScale', FONT_SIZES, s.fontScale)}
        <div class="sample">Así se verá el texto: <b>Producto de ejemplo</b> — 12 unidades</div>
      </div>

      <div class="card cfg">
        <h2>Inventario</h2>
        <div class="stack">
          <label class="field"><span>Moneda</span><input id="cfg-currency" maxlength="8" value="${esc(s.currency)}" autocapitalize="characters" autocomplete="off">
            <span class="hint">Se muestra en precios y listados. No hay conversiones automáticas.</span></label>
          <label class="field"><span>Texto para cantidad no registrada</span><input id="cfg-unknown" maxlength="30" value="${esc(s.unknownQtyLabel)}" autocomplete="off">
            <span class="hint">«Pendiente de conteo» no es lo mismo que 0: significa que todavía no sabes cuántas hay.</span></label>
          <label class="switch"><span class="sw-text">Permitir salidas mayores a la existencia<small>Por defecto no se puede sacar más de lo que hay. Si lo activas, la existencia puede quedar en negativo.</small></span><input type="checkbox" id="cfg-oversell" ${s.allowOversell ? 'checked' : ''}></label>
          <label class="switch"><span class="sw-text">Mostrar productos archivados por defecto<small>Si no, solo se ven al elegir «Mostrar» en los filtros.</small></span><input type="checkbox" id="cfg-archived" ${s.defaultStatus === 'all' ? 'checked' : ''}></label>
          <label class="switch"><span class="sw-text">Fotos de archivados en la galería<small>Los productos archivados conservan su foto; aquí decides si se ve en la galería.</small></span><input type="checkbox" id="cfg-archphotos" ${s.showArchivedPhotos ? 'checked' : ''}></label>
          <label class="field"><span>Botones rápidos del carrito</span><input id="cfg-quick" inputmode="decimal" maxlength="40" value="${esc((s.quickSteps || []).join(', '))}" autocomplete="off">
            <span class="hint">Cantidades que se suman con un toque, separadas por comas. Ej.: 1, 5, 10, 12, 50 (máximo 8).</span></label>
          <label class="field"><span>Otros motivos de baja</span><input id="cfg-reasons" maxlength="200" value="${esc((s.customReasons || []).join(', '))}" autocomplete="off">
            <span class="hint">Se añaden a Pérdida, Producto dañado y Retiro de mercancía. Sepáralos con comas. Ej.: Muestra, Regalo, Vencido.</span></label>
          <button type="button" class="btn" data-s="price-groups">Cambiar precios (por grupo o eligiendo productos)</button>
          <button type="button" class="btn secondary" data-s="categories">Categorías y precios generales</button>
        </div>
      </div>

      <div class="card cfg">
        <h2>Generador de listados</h2>
        <p>Crea textos con tus productos para copiar o compartir con clientes (WhatsApp u otras apps).</p>
        <button type="button" class="btn" data-s="lists">Generar un listado</button>
      </div>

      ${globalThis.Sync ? Sync.cardHtml() : ''}

      <div class="card cfg">
        <h2>Copias de seguridad</h2>
        <p>Tus datos viven solo en este teléfono. Una copia guarda productos, categorías, precios, movimientos, ajustes y fotos en un archivo.</p>
        <p id="backup-status" class="muted small-text">${s.lastBackupAt ? `Última copia: ${esc(fmtDateTime(s.lastBackupAt))}` : 'Todavía no has hecho ninguna copia.'}</p>
        <div class="stack">
          <button type="button" class="btn" data-s="export">Crear copia (descargar)</button>
          <button type="button" class="btn secondary" data-s="share-backup">Compartir copia…</button>
          <button type="button" class="btn secondary" data-s="import">Restaurar una copia…</button>
        </div>
      </div>

      <div class="card cfg">
        <h2>Mantenimiento</h2>
        <p id="storage-info" class="muted small-text">Calculando espacio…</p>
        <div class="stack">
          <button type="button" class="btn secondary" data-s="integrity">Comprobar integridad de los datos</button>
          <button type="button" class="btn secondary" data-s="update">Buscar actualización de la aplicación</button>
        </div>
      </div>

      <div class="card cfg">
        <details>
          <summary>Zona de riesgo</summary>
          <p class="muted" style="margin:8px 0">Restablecer elimina todos los datos de la aplicación en este teléfono.</p>
          <button type="button" class="btn danger-ghost" data-s="reset">Restablecer la aplicación…</button>
        </details>
      </div>

      <p class="muted small-text center">Almacén · versión ${APP_VERSION} · Funciona sin conexión</p>`;
    updateStorageInfo();
  }

  async function updateStorageInfo() {
    const el = document.getElementById('storage-info');
    if (!el) return;
    const e = await DB.storageEstimate();
    if (!el.isConnected) return;
    if (!e) { el.textContent = 'No se pudo calcular el espacio usado.'; return; }
    const pers = e.persisted === true ? ' · Almacenamiento protegido' : e.persisted === false ? ' · El navegador podría liberar datos si se queda sin espacio: haz copias a menudo' : '';
    el.textContent = `Espacio usado: ${fmtBytes(e.usage)} de ${fmtBytes(e.quota)} disponibles${pers}.`;
  }

  function init() {
    const el = document.getElementById('view-config');
    el.addEventListener('click', async (e) => {
      const segBtn = e.target.closest('[data-seg] button');
      if (segBtn) {
        const key = segBtn.parentElement.dataset.seg;
        const raw = segBtn.dataset.v;
        try {
          await set(key, key === 'fontScale' ? Number(raw) : raw);
          render();
        } catch (err) { UI.toast(DB.friendlyError(err), 'error'); }
        return;
      }
      const b = e.target.closest('[data-s]');
      if (!b) return;
      const a = b.dataset.s;
      try {
        if (a === 'categories') Categories.openManager();
        else if (a === 'price-groups') Categories.openPriceGroups();
        else if (a === 'lists') Lists.openGenerator();
        else if (a === 'export') await UI.once('export', () => doExport(false));
        else if (a === 'share-backup') await UI.once('export', () => doExport(true));
        else if (a === 'import') await importFlow();
        else if (a === 'sync-export') await Sync.openExport();
        else if (a === 'sync-import') await Sync.importFlow();
        else if (a === 'integrity') {
          const res = await runIntegrity();
          await integrityDialog(res);
        } else if (a === 'update') await App.checkUpdate(true);
        else if (a === 'reset') await resetFlow();
        if (a === 'export' || a === 'share-backup') render();
      } catch (err) {
        UI.toast(DB.friendlyError(err), 'error');
      }
    });
    el.addEventListener('change', async (e) => {
      const t = e.target;
      try {
        if (t.id === 'cfg-oversell') await set('allowOversell', t.checked);
        else if (t.id === 'cfg-archived') { await set('defaultStatus', t.checked ? 'all' : 'active'); App.state.filters.status = t.checked ? 'all' : 'active'; }
        else if (t.id === 'cfg-archphotos') { await set('showArchivedPhotos', t.checked); Gallery.renderSection(); }
        else if (t.id === 'cfg-reasons') {
          const vals = [...new Set(t.value.split(',').map((x) => x.trim().slice(0, 60)).filter(Boolean))].slice(0, 20);
          await set('customReasons', vals);
          t.value = vals.join(', ');
        } else if (t.id === 'cfg-quick') {
          const vals = [...new Set(t.value.split(/[\s,;]+/).map((x) => Number(x.replace(',', '.'))).filter((x) => Number.isFinite(x) && x > 0 && x <= 100000))].slice(0, 8);
          const use = vals.length ? vals : DEFAULTS.quickSteps;
          await set('quickSteps', use);
          t.value = use.join(', ');
          if (globalThis.Cart) Cart.refreshUI();
        } else if (t.id === 'cfg-currency') {
          const v = t.value.trim().toUpperCase().slice(0, 8);
          if (!v) { t.value = App.state.settings.currency; UI.toast('Escribe una moneda, por ejemplo CUP.', 'error'); return; }
          await set('currency', v);
          t.value = v;
          App.renderProducts();
        } else if (t.id === 'cfg-unknown') {
          const v = t.value.trim().slice(0, 30) || DEFAULTS.unknownQtyLabel;
          await set('unknownQtyLabel', v);
          t.value = v;
          App.renderProducts();
        }
      } catch (err) { UI.toast(DB.friendlyError(err), 'error'); }
    });
  }

  globalThis.Settings = {
    APP_ID, APP_VERSION, BACKUP_SCHEMA, DEFAULTS,
    load, set, applyAppearance, render, init,
    buildBackup, backupFileName, chooseFile, shareOrDownload, LOCAL_ONLY_KEYS, validateBackup, restoreBackup, importFlow, doExport,
    runIntegrity, repairIntegrity, resetAll,
    blobToBase64, base64ToBlob,
  };
})();

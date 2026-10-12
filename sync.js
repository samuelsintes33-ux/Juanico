'use strict';
/* sync.js — Actualización del almacén entre teléfonos mediante un archivo.

   Idea: el teléfono que gestiona el almacén crea un «archivo de actualización» con el catálogo
   (categorías, productos, precios, cantidades y, si se quiere, fotos) y lo comparte (WhatsApp, etc.).
   El otro teléfono lo importa y se actualiza SIN duplicar nada:
   - Cada producto y categoría se reconoce por su identificador estable (no por nombre, código o color).
   - Los productos nuevos se añaden; los existentes se modifican; los que el administrador eliminó
     se ARCHIVAN en el otro teléfono (no se borran).
   - Todo se aplica en una sola transacción: o se aplica completo o no cambia nada.
   - Nunca se tocan los datos propios de cada teléfono: ajustes, apariencia, listados, historial
     de movimientos ni productos que solo existan en ese teléfono. */
(function () {
  const { AppError, DB, Inventory } = globalThis;
  const R = (r) => DB.req(r);
  const esc = (s) => UI.esc(s);
  const fmtNum = Inventory.fmtNum;
  const norm = (s) => Inventory.norm(s);

  const KIND = 'update';
  const FORMAT = 1;
  const SHARED_TEXT_FIELDS = ['name', 'brand', 'code', 'color', 'presentation', 'capacity', 'unit', 'notes'];

  const blank = () => ({
    deviceId: null, sequence: 0, lastExportAt: null, photoStamps: {},
    knownProductIds: [], knownCategoryIds: [], lastImport: null,
  });
  const stateFrom = (row) => Object.assign(blank(), row && row.value ? row.value : {});
  const nv = (v) => (v === null || v === undefined ? '' : v);
  const sameFields = (a, b) => JSON.stringify((a || []).map((f) => [f.name, f.value])) === JSON.stringify((b || []).map((f) => [f.name, f.value]));
  const fmtDate = (ts) => new Date(ts).toLocaleString('es', { dateStyle: 'medium', timeStyle: 'short' });
  const fmtMB = (n) => (n < 1048576 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1048576).toFixed(1)} MB`);

  /* ======================= Crear el archivo de actualización ======================= */

  /* photosMode: 'none' | 'changed' (nuevas o cambiadas desde la última actualización creada) | 'all' */
  async function buildUpdate(photosMode, note) {
    const snap = await DB.exportSnapshot();
    const st = stateFrom(snap.settings.find((r) => r.key === 'syncState'));
    if (!st.deviceId) st.deviceId = DB.uuid();
    const sequence = (st.sequence || 0) + 1;
    const prodIds = new Set(snap.products.map((p) => p.id));
    const chosen = photosMode === 'none' ? [] : snap.photos.filter((ph) => prodIds.has(ph.productId)
      && (photosMode === 'all' || (st.photoStamps || {})[ph.productId] !== ph.updatedAt));
    const exportedAt = Date.now();
    const counts = { products: snap.products.length, categories: snap.categories.length, photos: chosen.length };
    const parts = [
      `{"app":${JSON.stringify(Settings.APP_ID)},"kind":${JSON.stringify(KIND)},"formatVersion":${FORMAT},"schemaVersion":${Settings.BACKUP_SCHEMA},` +
      `"appVersion":${JSON.stringify(Settings.APP_VERSION)},"exportedAt":${exportedAt},"masterId":${JSON.stringify(st.deviceId)},"sequence":${sequence},` +
      `"note":${JSON.stringify(String(note || '').trim().slice(0, 300))},"photosMode":${JSON.stringify(photosMode)},"counts":${JSON.stringify(counts)},"data":{` +
      `"categories":${JSON.stringify(snap.categories)},"products":${JSON.stringify(snap.products)},"photos":[`,
    ];
    let first = true;
    for (const ph of chosen) {
      parts.push((first ? '' : ',') + JSON.stringify({
        productId: ph.productId, mime: ph.type || ph.blob.type || 'image/jpeg', width: ph.width || 0, height: ph.height || 0,
        updatedAt: ph.updatedAt || 0, data: await Settings.blobToBase64(ph.blob),
      }));
      first = false;
    }
    parts.push(']}}');
    const stamps = {};
    for (const ph of snap.photos) if (prodIds.has(ph.productId)) stamps[ph.productId] = (st.photoStamps || {})[ph.productId];
    for (const ph of chosen) stamps[ph.productId] = ph.updatedAt;
    for (const k of Object.keys(stamps)) if (stamps[k] === undefined) delete stamps[k];
    const nextState = Object.assign({}, st, { deviceId: st.deviceId, sequence, lastExportAt: exportedAt, photoStamps: stamps });
    return { blob: new Blob(parts, { type: 'application/json' }), counts, exportedAt, sequence, nextState };
  }

  const updateFileName = (ts) => Settings.backupFileName(ts).replace('almacen-copia-', 'almacen-actualizacion-');

  async function openExport() {
    const snap = await DB.exportSnapshot();
    if (!snap.products.length) {
      await UI.alert({ title: 'No hay nada que enviar', message: 'Este teléfono todavía no tiene productos. Añade o importa tu inventario primero.' });
      return;
    }
    const st = stateFrom(snap.settings.find((r) => r.key === 'syncState'));
    const prodIds = new Set(snap.products.map((p) => p.id));
    const photos = snap.photos.filter((ph) => prodIds.has(ph.productId));
    const changed = photos.filter((ph) => (st.photoStamps || {})[ph.productId] !== ph.updatedAt);
    const size = (list) => Math.round(list.reduce((s, ph) => s + (ph.blob ? ph.blob.size : 0), 0) * 1.37);
    const sAll = size(photos);
    const sChanged = size(changed);
    const defMode = photos.length === 0 ? 'none' : (st.sequence ? 'changed' : 'all');
    const radio = (v, title, hint) => `<label class="format-opt ${v === defMode ? 'sel' : ''}" data-m="${v}"><input type="radio" name="sy-photos" value="${v}" ${v === defMode ? 'checked' : ''}><span><b>${title}</b><small style="font-family:inherit">${hint}</small></span></label>`;
    const html = `<div class="stack">
      <p>Crea un archivo con el catálogo de este teléfono para actualizar otro teléfono: <b>${snap.products.length}</b> producto${snap.products.length === 1 ? '' : 's'} y <b>${snap.categories.length}</b> categorías/subcategorías, con sus precios y cantidades.</p>
      <div class="section-title">Fotos</div>
      ${radio('none', 'Sin fotos', 'Archivo pequeño. Las fotos que ya tenga el otro teléfono se conservan; los productos nuevos llegarán sin foto.')}
      ${radio('changed', 'Solo fotos nuevas o cambiadas' + (st.sequence ? ' (recomendado)' : ''), `${changed.length} foto${changed.length === 1 ? '' : 's'} · aprox. ${fmtMB(sChanged)}`)}
      ${radio('all', 'Todas las fotos' + (st.sequence ? '' : ' (recomendado la primera vez)'), `${photos.length} foto${photos.length === 1 ? '' : 's'} · aprox. ${fmtMB(sAll)}`)}
      <p class="muted small-text">Si el otro teléfono todavía no tiene tus fotos, elige «Todas las fotos» al menos una vez.</p>
      <label class="field"><span>Mensaje (opcional)</span><textarea id="sy-note" maxlength="300" placeholder="Ej. Precios nuevos de octubre"></textarea></label>
      <p class="muted small-text">El archivo no incluye tus ajustes, tu historial de movimientos ni tus copias de seguridad. Quien lo reciba podrá previsualizar los cambios antes de aplicarlos.</p>
      <div class="field-error" id="sy-err" role="alert"></div></div>`;
    let done = null;
    await UI.modal({
      title: 'Crear archivo de actualización', html,
      actions: [{ id: 'cancel', label: 'Cancelar', kind: 'ghost' }, { id: 'download', label: 'Descargar', kind: 'secondary' }, { id: 'share', label: 'Compartir…', kind: 'primary' }],
      onOpen(d) {
        d.body.addEventListener('change', () => {
          const m = d.body.querySelector('input[name=sy-photos]:checked').value;
          d.body.querySelectorAll('.format-opt').forEach((el) => el.classList.toggle('sel', el.dataset.m === m));
        });
      },
      async onAction(id, body) {
        const err = body.querySelector('#sy-err');
        err.textContent = '';
        try {
          const mode = body.querySelector('input[name=sy-photos]:checked').value;
          const built = await buildUpdate(mode, body.querySelector('#sy-note').value);
          const name = updateFileName(built.exportedAt);
          if (id === 'share') {
            const r = await Settings.shareOrDownload(built.blob, name, 'Actualización del almacén');
            if (r === 'cancelled') return false; // cerró el menú: no se cuenta como enviada
            if (r === 'downloaded') UI.toast('Este navegador no puede compartir archivos: se descargó. Envíalo desde tu teléfono (WhatsApp › adjuntar › documento).');
          } else {
            UI.download(built.blob, name);
          }
          await Settings.set('syncState', built.nextState);
          done = built;
          if (built.blob.size > 90 * 1048576) UI.toast('El archivo es muy grande (más de 90 MB). WhatsApp admite hasta 100 MB: crea uno sin fotos o solo con las nuevas.', 'error');
        } catch (e) {
          err.textContent = DB.friendlyError(e);
          return false;
        }
      },
    });
    if (done) {
      UI.toast(`Archivo n.º ${done.sequence} creado: ${done.counts.products} productos, ${done.counts.photos} fotos. Compártelo con el otro teléfono.`, 'ok');
      if (App.state.tab === 'config') Settings.render();
    }
  }

  /* ======================= Validar y planificar la importación ======================= */

  function validateUpdate(obj) {
    const errors = [];
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, errors: ['El archivo no tiene el formato de una actualización de Almacén.'] };
    if (obj.app !== Settings.APP_ID) errors.push('El archivo no pertenece a esta aplicación.');
    if (obj.kind === 'backup' || (obj.kind === undefined && obj.data && Array.isArray(obj.data.movements))) {
      errors.push('Este archivo es una copia de seguridad, no una actualización. Restáurala desde «Copias de seguridad».');
    } else if (obj.kind !== KIND) errors.push('El archivo no es una actualización.');
    if (typeof obj.formatVersion !== 'number') errors.push('La actualización no indica su versión.');
    else if (obj.formatVersion > FORMAT) errors.push('La actualización se creó con una versión más nueva de la aplicación. Actualiza la aplicación e inténtalo otra vez.');
    if (typeof obj.masterId !== 'string' || !obj.masterId) errors.push('Falta el identificador del teléfono que la creó.');
    if (typeof obj.sequence !== 'number' || !(obj.sequence >= 1)) errors.push('Falta el número de la actualización.');
    const data = obj.data;
    if (!data || !Array.isArray(data.categories) || !Array.isArray(data.products)) errors.push('Faltan los productos o las categorías.');
    if (errors.length) return { ok: false, errors };
    const pseudo = { app: obj.app, kind: KIND, schemaVersion: Settings.BACKUP_SCHEMA, data: { products: data.products, categories: data.categories, movements: Array.isArray(data.movements) ? data.movements : [], photos: Array.isArray(data.photos) ? data.photos : [], settings: [] } };
    const v = Settings.validateBackup(pseudo, { keepPhotoFlags: true, allowUpdate: true });
    return {
      ok: v.ok, errors: v.errors, warnings: v.warnings, clean: v.clean,
      meta: { masterId: obj.masterId, sequence: obj.sequence, exportedAt: typeof obj.exportedAt === 'number' ? obj.exportedAt : null, note: typeof obj.note === 'string' ? obj.note : '' },
    };
  }

  /* Función pura: compara lo que trae el archivo con lo que hay en este teléfono. */
  function computePlan(local, inc, opts, st) {
    const lp = new Map(local.products.map((p) => [p.id, p]));
    const lc = new Map(local.categories.map((c) => [c.id, c]));
    const lph = new Map(local.photos.map((ph) => [ph.productId, ph]));
    const incPhotos = new Map(inc.photos.map((ph) => [ph.productId, ph]));
    const incProdIds = new Set(inc.products.map((p) => p.id));
    const incCatIds = new Set(inc.categories.map((c) => c.id));
    const explained = new Set((inc.movements || []).map((m) => m.productId)); // productos cuyo cambio de cantidad ya viene explicado por movimientos del archivo
    const known = opts.archiveMissing && !(st.knownProductIds || []).length ? new Set(local.products.map((p) => p.id)) : new Set(st.knownProductIds || []);
    const knownCats = new Set(st.knownCategoryIds || []);
    const lastAt = st.lastImport ? st.lastImport.at : null;
    const plan = {
      addCats: [], updCats: [], removeCats: [], addProds: [], updProds: [], qty: [], prices: 0,
      archive: [], photoSet: [], photoDrop: [], photosMissing: 0, newMovements: [], explained, conflicts: 0, unchanged: 0, localOnly: 0, possibleDuplicates: 0,
    };

    for (const c of inc.categories) {
      const l = lc.get(c.id);
      if (!l) { plan.addCats.push(c); continue; }
      const ch = {};
      if (c.name !== l.name) ch.name = c.name;
      if ((c.parentId || null) !== (l.parentId || null)) ch.parentId = c.parentId || null;
      if (c.order !== l.order) ch.order = c.order;
      if (opts.prices && nv(c.generalPrice) !== nv(l.generalPrice)) ch.generalPrice = c.generalPrice;
      if (Object.keys(ch).length) plan.updCats.push({ id: c.id, ch });
    }
    for (const id of knownCats) if (!incCatIds.has(id) && lc.has(id)) plan.removeCats.push(id);

    const localKeys = new Map();
    for (const p of local.products) localKeys.set(`${norm(p.name)}|${norm(p.brand)}|${norm(p.code)}`, p.id);

    for (const p of inc.products) {
      const l = lp.get(p.id);
      const ph = incPhotos.get(p.id);
      if (!l) {
        plan.addProds.push(p);
        const other = localKeys.get(`${norm(p.name)}|${norm(p.brand)}|${norm(p.code)}`);
        if (other && !incProdIds.has(other)) plan.possibleDuplicates++;
        if (opts.photos && p.hasPhoto && ph) plan.photoSet.push(p.id);
        else if (p.hasPhoto) plan.photosMissing++;
        continue;
      }
      const ch = {};
      for (const f of SHARED_TEXT_FIELDS) if (nv(l[f]) !== nv(p[f])) ch[f] = p[f];
      if (nv(l.categoryId) !== nv(p.categoryId)) ch.categoryId = p.categoryId;
      if (nv(l.subcategoryId) !== nv(p.subcategoryId)) ch.subcategoryId = p.subcategoryId;
      if (!sameFields(l.fields, p.fields)) ch.fields = p.fields;
      if (!!l.archived !== !!p.archived) ch.archived = !!p.archived;
      let qtyChange = null;
      if (opts.quantities) {
        if (p.quantity !== null && (l.quantityStatus || 'confirmed') !== p.quantityStatus) ch.quantityStatus = p.quantityStatus;
        // Una actualización nunca borra una cantidad conocida: si el archivo no la trae, se conserva la local.
        if (p.quantity !== null && p.quantity !== (l.quantity === undefined ? null : l.quantity)) {
          ch.quantity = p.quantity;
          qtyChange = { id: p.id, name: p.name, before: l.quantity === undefined ? null : l.quantity, after: p.quantity, unit: p.unit };
          plan.qty.push(qtyChange);
        }
      }
      // Una actualización nunca borra un precio conocido: si el archivo no trae precio, se conserva el local.
      if (opts.prices && p.price !== null && nv(l.price) !== nv(p.price)) { ch.price = p.price; plan.prices++; }
      let photoChanged = false;
      if (opts.photos) {
        if (p.hasPhoto && ph) {
          const lr = lph.get(p.id);
          if (!lr || lr.updatedAt !== ph.updatedAt) { plan.photoSet.push(p.id); photoChanged = true; }
        } else if (!p.hasPhoto && lph.has(p.id)) { plan.photoDrop.push(p.id); photoChanged = true; }
        else if (p.hasPhoto && !ph && !lph.has(p.id)) plan.photosMissing++;
      }
      if (Object.keys(ch).length || photoChanged) {
        plan.updProds.push({ id: p.id, name: p.name, ch });
        if (lastAt && l.updatedAt > lastAt) plan.conflicts++;
      } else plan.unchanged++;
    }
    const haveMv = new Set((local.movementIds || []));
    for (const m of inc.movements || []) if (!haveMv.has(m.id)) plan.newMovements.push(m);
    for (const id of known) {
      const l = lp.get(id);
      if (l && !incProdIds.has(id) && !l.archived) plan.archive.push({ id, name: l.name });
    }
    for (const p of local.products) if (!incProdIds.has(p.id) && !known.has(p.id)) plan.localOnly++;
    return plan;
  }

  /* ======================= Aplicar (una sola transacción) ======================= */

  async function applyUpdate(inc, opts, meta) {
    const blobs = new Map();
    if (opts.photos) for (const ph of inc.photos) blobs.set(ph.productId, { blob: Settings.base64ToBlob(ph.data, ph.mime), ph });
    const incProd = new Map(inc.products.map((p) => [p.id, p]));
    const note = `Actualización recibida n.º ${meta.sequence}`;

    return DB.tx(DB.STORE_NAMES, 'readwrite', async (S) => {
      const local = {
        products: await R(S.products.getAll()), categories: await R(S.categories.getAll()),
        photos: await R(S.photos.getAll()),
        movementIds: await R(S.movements.getAllKeys()),
      };
      const st = stateFrom(await R(S.settings.get('syncState')));
      const plan = computePlan(local, inc, opts, st);
      const now = Date.now();
      const lp = new Map(local.products.map((p) => [p.id, p]));
      const cats = new Map(local.categories.map((c) => [c.id, c]));
      const report = {
        added: plan.addProds.length, updated: plan.updProds.length, qty: plan.qty.length, prices: plan.prices,
        archived: plan.archive.length, catsAdded: plan.addCats.length, catsUpdated: plan.updCats.length,
        catsRemoved: 0, catsKept: 0, photosSet: 0, photosDropped: 0, unchanged: plan.unchanged,
      };

      // 1) Categorías
      for (const c of plan.addCats) {
        const rec = { id: c.id, name: c.name, parentId: c.parentId || null, order: c.order, generalPrice: opts.prices ? c.generalPrice : null, createdAt: c.createdAt, updatedAt: now };
        await R(S.categories.put(rec));
        cats.set(rec.id, rec);
      }
      for (const u of plan.updCats) {
        const rec = Object.assign({}, cats.get(u.id), u.ch, { updatedAt: now });
        await R(S.categories.put(rec));
        cats.set(rec.id, rec);
      }

      const names = (p) => ({
        categoryName: p.categoryId && cats.get(p.categoryId) ? cats.get(p.categoryId).name : '',
        subcategoryName: p.subcategoryId && cats.get(p.subcategoryId) ? cats.get(p.subcategoryId).name : '',
      });
      const movement = (p, before, after, initial) => Object.assign({
        id: DB.uuid(), productId: p.id, productName: p.name, brand: p.brand || '', code: p.code || '',
        type: 'ajuste', quantity: before === null ? null : Inventory.round6(after - before), before, after,
        unit: p.unit || '', note: initial ? `Existencia inicial · ${note}` : note, initial: !!initial, estimated: p.quantityStatus === 'estimated', createdAt: Inventory.nextTs(),
      }, names(p));

      // 2) Productos nuevos
      for (const p of plan.addProds) {
        const rec = Object.assign({}, p, {
          quantity: opts.quantities ? p.quantity : null,
          quantityStatus: opts.quantities && p.quantity !== null ? p.quantityStatus : 'confirmed',
          price: opts.prices ? p.price : null,
          hasPhoto: false, thumb: null, photoUpdatedAt: null,
          archivedAt: p.archived ? now : null, updatedAt: now,
        });
        lp.set(rec.id, rec);
        await R(S.products.put(rec));
        if (rec.quantity !== null && !plan.explained.has(rec.id)) await R(S.movements.put(movement(rec, null, rec.quantity, true)));
      }

      // 3) Productos existentes
      for (const u of plan.updProds) {
        const rec = Object.assign({}, lp.get(u.id), u.ch, { updatedAt: now });
        if (u.ch.archived !== undefined) rec.archivedAt = u.ch.archived ? now : null;
        if (u.ch.quantity !== undefined && !plan.explained.has(u.id)) {
          const before = lp.get(u.id).quantity === undefined ? null : lp.get(u.id).quantity;
          await R(S.movements.put(movement(rec, before, u.ch.quantity, false)));
        }
        lp.set(rec.id, rec);
        await R(S.products.put(rec));
      }

      // 3b) Movimientos que trae el archivo (retiros, ajustes con fecha…). Se identifican por su id: aplicar dos veces no duplica.
      for (const m of plan.newMovements) await R(S.movements.put(m));
      report.movements = plan.newMovements.length;

      // 4) Fotos (solo si el archivo las trae y el usuario las aceptó)
      for (const id of plan.photoSet) {
        const b = blobs.get(id);
        const rec = lp.get(id);
        if (!b || !rec) continue;
        await R(S.photos.put({ productId: id, blob: b.blob, type: b.blob.type, width: b.ph.width, height: b.ph.height, updatedAt: b.ph.updatedAt }));
        rec.hasPhoto = true;
        rec.thumb = incProd.get(id).thumb || rec.thumb || null;
        rec.photoUpdatedAt = b.ph.updatedAt;
        await R(S.products.put(rec));
        report.photosSet++;
      }
      for (const id of plan.photoDrop) {
        const rec = lp.get(id);
        if (!rec) continue;
        await R(S.photos.delete(id));
        rec.hasPhoto = false; rec.thumb = null; rec.photoUpdatedAt = null;
        await R(S.products.put(rec));
        report.photosDropped++;
      }

      // 5) Productos que el administrador ya no tiene: se archivan, no se borran
      for (const a of plan.archive) {
        const rec = lp.get(a.id);
        rec.archived = true; rec.archivedAt = now; rec.updatedAt = now;
        await R(S.products.put(rec));
      }

      // 6) Categorías retiradas: solo si ya no tienen productos en este teléfono
      for (const id of plan.removeCats) {
        const used = [...lp.values()].some((p) => p.categoryId === id || p.subcategoryId === id)
          || [...cats.values()].some((c) => c.parentId === id && !plan.removeCats.includes(c.id));
        if (used) report.catsKept++;
        else { await R(S.categories.delete(id)); cats.delete(id); report.catsRemoved++; }
      }

      // 7) Memoria de la actualización (propia de este teléfono)
      const next = Object.assign({}, st, {
        knownProductIds: inc.products.map((p) => p.id), knownCategoryIds: inc.categories.map((c) => c.id),
        lastImport: { masterId: meta.masterId, sequence: meta.sequence, at: now, exportedAt: meta.exportedAt },
      });
      await R(S.settings.put({ key: 'syncState', value: next }));
      return report;
    });
  }

  /* ======================= Importar: interfaz ======================= */

  const planSummary = (plan, opts) => {
    const rows = [];
    const line = (n, txt) => { if (n) rows.push(`<li><b>${n}</b> ${txt}</li>`); };
    line(plan.addProds.length, plan.addProds.length === 1 ? 'producto nuevo' : 'productos nuevos');
    line(plan.updProds.length, plan.updProds.length === 1 ? 'producto con cambios' : 'productos con cambios');
    line(plan.qty.length, plan.qty.length === 1 ? 'cantidad que cambia' : 'cantidades que cambian');
    line(plan.newMovements.length, plan.newMovements.length === 1 ? 'movimiento del historial (retiro, ajuste…)' : 'movimientos del historial (retiros, ajustes…)');
    line(plan.prices, plan.prices === 1 ? 'precio que cambia' : 'precios que cambian');
    line(plan.archive.length, plan.archive.length === 1 ? 'producto que ya no está en el almacén (se archivará, no se borra)' : 'productos que ya no están en el almacén (se archivarán, no se borran)');
    line(plan.addCats.length + plan.updCats.length, 'categorías o subcategorías nuevas o modificadas');
    line(plan.photoSet.length + plan.photoDrop.length, 'fotos nuevas, cambiadas o retiradas');
    return rows.length ? `<ul>${rows.join('')}</ul>` : '<div class="issue ok"><b>Este teléfono ya está al día.</b> No hay nada que cambiar con estas opciones.</div>';
  };

  async function importFlow() {
    const file = await Settings.chooseFile();
    if (!file) return;
    let v;
    try {
      let obj;
      try { obj = JSON.parse(await file.text()); } catch (_) { throw new AppError('BAD_UPDATE', 'No se pudo leer el archivo: no es una actualización válida (archivo dañado o incompleto).'); }
      v = validateUpdate(obj);
    } catch (e) {
      await UI.alert({ title: 'No se puede aplicar', message: `${DB.friendlyError(e)} No se cambió nada.` });
      return;
    }
    if (!v.ok) {
      await UI.alert({ title: 'La actualización no es válida', html: `<p>Se encontraron problemas y <b>no se cambió nada</b> en este teléfono:</p><ul>${v.errors.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` });
      return;
    }
    const snap = await DB.exportSnapshot();
    const st = stateFrom(snap.settings.find((r) => r.key === 'syncState'));
    const inc = v.clean;
    const hasPhotos = inc.photos.length > 0;
    const opts = { quantities: true, prices: true, photos: hasPhotos, backup: true };
    const meta = v.meta;
    const warn = [];
    if (meta.masterId === st.deviceId) warn.push('Este archivo se creó en este mismo teléfono.');
    if (st.lastImport && st.lastImport.masterId !== meta.masterId) warn.push('Esta actualización viene de un teléfono distinto al de la última que aplicaste. Comprueba que es la correcta.');
    if (st.lastImport && st.lastImport.masterId === meta.masterId && meta.sequence <= st.lastImport.sequence) warn.push(`Esta actualización (n.º ${meta.sequence}) es igual o más antigua que la última que aplicaste (n.º ${st.lastImport.sequence}). Aplicarla no duplica nada, pero podría devolver datos viejos.`);

    let result = null;
    const local = { products: snap.products, categories: snap.categories, photos: snap.photos, movementIds: snap.movements.map((m) => m.id) };
    const build = () => computePlan(local, inc, opts, st);
    const html = `<div class="stack">
      <div class="kv">
        <div><div class="k">Actualización n.º</div><div class="v">${meta.sequence}</div></div>
        <div><div class="k">Creada</div><div class="v" style="font-size:.95rem">${meta.exportedAt ? esc(fmtDate(meta.exportedAt)) : '—'}</div></div>
        ${meta.note ? `<div class="full"><div class="k">Mensaje</div><div class="v" style="font-weight:500;white-space:pre-wrap">${esc(meta.note)}</div></div>` : ''}
      </div>
      ${warn.map((w) => `<div class="notice">${esc(w)}</div>`).join('')}
      <div id="sy-warn2"></div>
      <div class="section-title">Qué cambiará en este teléfono</div>
      <div id="sy-summary"></div>
      <div class="section-title">Qué actualizar</div>
      <label class="switch"><span class="sw-text">Cantidades<small>Si lo desactivas, conservas las cantidades de este teléfono.</small></span><input type="checkbox" id="sy-o-qty" checked></label>
      <label class="switch"><span class="sw-text">Precios (individuales y generales)</span><input type="checkbox" id="sy-o-price" checked></label>
      ${hasPhotos ? '<label class="switch"><span class="sw-text">Fotos incluidas en el archivo</span><input type="checkbox" id="sy-o-photos" checked></label>' : ''}
      ${(st.knownProductIds || []).length ? '' : '<label class="switch" id="sy-am-wrap" hidden><span class="sw-text">Archivar lo que el administrador ya no tiene<small>Actívalo si este teléfono se preparó con una copia del administrador. Los productos que no estén en el archivo se archivarán (no se borran). Si añadiste productos propios aquí, déjalo desactivado.</small></span><input type="checkbox" id="sy-o-am"></label>'}
      <label class="switch"><span class="sw-text">Crear una copia de seguridad antes<small>Se descargará un archivo con tus datos actuales. Recomendado.</small></span><input type="checkbox" id="sy-o-backup" checked></label>
      <p class="muted small-text">Los ajustes, la apariencia, el historial de movimientos y los productos que solo existan en este teléfono no se modifican. Las categorías y los datos del producto (nombre, descripción, presentación, color, etc.) siempre se actualizan.</p>
      <div class="field-error" id="sy-err" role="alert"></div></div>`;

    const closed = await UI.modal({
      title: 'Aplicar actualización', html, cls: 'sheet',
      actions: [{ id: 'cancel', label: 'Cancelar', kind: 'ghost' }, { id: 'apply', label: 'Aplicar actualización', kind: 'primary' }],
      onOpen(d) {
        const q = (id) => d.body.querySelector(id);
        const update = () => {
          opts.quantities = q('#sy-o-qty').checked;
          opts.prices = q('#sy-o-price').checked;
          opts.photos = hasPhotos ? q('#sy-o-photos').checked : false;
          opts.backup = q('#sy-o-backup').checked;
          opts.archiveMissing = !!(q('#sy-o-am') && q('#sy-o-am').checked);
          const amw = q('#sy-am-wrap');
          if (amw && !opts.archiveMissing) { const t0 = computePlan(local, inc, Object.assign({}, opts, { archiveMissing: false }), st); amw.hidden = t0.localOnly === 0; }
          const plan = build();
          q('#sy-summary').innerHTML = planSummary(plan, opts) + (plan.qty.length
            ? `<details><summary>Ver cantidades que cambian</summary>${plan.qty.slice(0, 15).map((c) => `<div class="muted small-text">${esc(c.name)}: ${c.before === null ? 'sin registrar' : fmtNum(c.before)} → <b>${fmtNum(c.after)}</b></div>`).join('')}${plan.qty.length > 15 ? `<div class="muted small-text">… y ${plan.qty.length - 15} más</div>` : ''}</details>` : '');
          const extra = [];
          if (plan.conflicts) extra.push(`${plan.conflicts} producto${plan.conflicts === 1 ? '' : 's'} se modificaron en este teléfono después de la última actualización: se reemplazarán por los del administrador.`);
          if (plan.possibleDuplicates) extra.push(`${plan.possibleDuplicates} producto${plan.possibleDuplicates === 1 ? '' : 's'} nuevo${plan.possibleDuplicates === 1 ? '' : 's'} parece${plan.possibleDuplicates === 1 ? '' : 'n'} ya existir aquí con otro identificador (mismo nombre, marca y código): podrían quedar repetidos.`);
          if (plan.photosMissing) extra.push(`${plan.photosMissing} producto${plan.photosMissing === 1 ? '' : 's'} tiene${plan.photosMissing === 1 ? '' : 'n'} foto en el teléfono que creó el archivo, pero esta actualización no la incluye. Pide un archivo con «Todas las fotos» si las quieres.`);
          if (plan.localOnly) extra.push(`${plan.localOnly} producto${plan.localOnly === 1 ? '' : 's'} de este teléfono no vienen del administrador: se conservarán tal cual.`);
          q('#sy-warn2').innerHTML = extra.map((w) => `<div class="notice info">${esc(w)}</div>`).join('');
          const empty = !(plan.newMovements.length || plan.addProds.length || plan.updProds.length || plan.archive.length || plan.addCats.length || plan.updCats.length || plan.removeCats.length);
          d.foot.querySelector('[data-act=apply]').disabled = empty;
        };
        d.body.addEventListener('change', update);
        update();
      },
      async onAction(id, body) {
        if (id !== 'apply') return;
        const err = body.querySelector('#sy-err');
        err.textContent = '';
        if (opts.backup) {
          try { await Settings.doExport(false); } catch (e) {
            err.textContent = `No se pudo crear la copia de seguridad (${DB.friendlyError(e)}). No se aplicó la actualización. Desactiva la copia previa si quieres continuar sin ella.`;
            return false;
          }
        }
        try {
          result = await applyUpdate(inc, opts, meta);
          await Settings.load();
          await App.refresh();
        } catch (e) {
          err.textContent = `No se aplicó la actualización y tus datos no cambiaron: ${DB.friendlyError(e)}`;
          UI.toast('La actualización falló. No se cambió nada.', 'error');
          return false;
        }
      },
    });
    if (closed === 'apply' && result) {
      const r = result;
      const rows = [];
      const line = (n, t) => { if (n) rows.push(`<li><b>${n}</b> ${t}</li>`); };
      line(r.added, 'productos nuevos');
      line(r.updated, 'productos actualizados');
      line(r.qty, 'cantidades actualizadas (quedaron registradas en el historial)');
      line(r.movements, 'movimientos añadidos al historial');
      line(r.prices, 'precios actualizados');
      line(r.archived, 'productos archivados (ya no están en el almacén del administrador)');
      line(r.catsAdded + r.catsUpdated, 'categorías o subcategorías nuevas o modificadas');
      line(r.catsRemoved, 'categorías retiradas');
      line(r.catsKept, 'categorías que se conservaron porque aún tienen productos aquí');
      line(r.photosSet, 'fotos actualizadas');
      line(r.photosDropped, 'fotos retiradas');
      await UI.alert({
        title: 'Actualización aplicada correctamente',
        html: `<p>Este teléfono quedó al día con la actualización n.º ${meta.sequence}.</p>${rows.length ? `<ul>${rows.join('')}</ul>` : '<p>No hubo cambios.</p>'}<p class="muted small-text">${r.unchanged} producto${r.unchanged === 1 ? '' : 's'} ya estaba${r.unchanged === 1 ? '' : 'n'} igual.</p>`,
      });
    }
  }

  /* ======================= Tarjeta en Configuración ======================= */

  function cardHtml() {
    const st = Object.assign(blank(), App.state.settings.syncState || {});
    const sent = st.lastExportAt ? `Última creada: n.º ${st.sequence} · ${esc(fmtDate(st.lastExportAt))}` : 'Todavía no has creado ninguna.';
    const got = st.lastImport ? `Última aplicada: n.º ${st.lastImport.sequence} · ${esc(fmtDate(st.lastImport.at))}` : 'Todavía no has aplicado ninguna.';
    return `<div class="card cfg">
      <h2>Actualización entre teléfonos</h2>
      <p>Para que dos teléfonos tengan el mismo inventario: el que gestiona el almacén crea un archivo y lo envía (por ejemplo, por WhatsApp); el otro lo aplica sin duplicar nada.</p>
      <p class="muted small-text">${sent}<br>${got}</p>
      <div class="stack">
        <button type="button" class="btn" data-s="sync-export">Crear archivo de actualización…</button>
        <button type="button" class="btn secondary" data-s="sync-import">Aplicar un archivo de actualización…</button>
      </div>
    </div>`;
  }

  globalThis.Sync = { KIND, FORMAT, buildUpdate, validateUpdate, computePlan, applyUpdate, openExport, importFlow, cardHtml, stateFrom };
})();

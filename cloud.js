'use strict';
/* cloud.js — Sincronización automática por internet entre teléfonos (Supabase), con trabajo sin conexión.

   Cómo funciona (resumen):
   - Cada teléfono sigue guardando TODO en su propia base local (IndexedDB). La app funciona igual sin internet.
   - No hay cuentas ni contraseñas: cada teléfono se «vincula» una vez con un código largo y secreto.
     En el servidor solo se guarda un hash del código; todo el acceso pasa por funciones que lo comprueban.
   - Se detectan los cambios locales comparando huellas (hash) con lo último enviado. Lo pendiente se envía
     cuando hay conexión; lo nuevo de los demás teléfonos se descarga y se aplica en una sola transacción.
   - Categorías, productos y pedidos apartados: gana el cambio más reciente.
   - Existencias: NUNCA se copia la cantidad de un teléfono a otro. Se envían los MOVIMIENTOS y cada teléfono
     los aplica una sola vez como suma o resta. Así dos teléfonos que venden a la vez no se pisan.
   - Las fotos viajan aparte (se descargan después de los datos). */
(function () {
  const { AppError, DB } = globalThis;
  const R = (r) => DB.req(r);

  /* Datos públicos del proyecto (la seguridad está en el código de vinculación, no en esta clave). */
  const API_URL = 'https://wrebpmynlngqhdmklnhw.supabase.co';
  const API_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndyZWJwbXlubG5ncWhkbWtsbmh3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODcwNjE4NzcsImV4cCI6MjEwMjYzNzg3N30.FhDfNEQLU1nSENJiHK8DkEQyeRBEImlu-3m8ZmQGCqs';

  const STATE_KEY = 'cloud';
  const STORES = ['products', 'categories', 'movements', 'photos', 'settings'];
  const DATA_KINDS = ['category', 'product', 'movement', 'held'];
  const POLL_MS = 15000;
  const TOUCH_MS = 1200;
  const HTTP_MS = 30000;
  const BATCH_ROWS = 120;
  const BATCH_BYTES = 2500000;
  const PENDING_MAX_AGE = 14 * 86400000;
  const round6 = (n) => Math.round((n + Number.EPSILON) * 1e6) / 1e6;

  class CloudErr extends Error {
    constructor(kind, msg) { super(msg || kind); this.kind = kind; }
  }

  /* ---------------- Huellas ---------------- */
  function canon(v) {
    if (v === null || v === undefined) return 'null';
    if (typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
    return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`;
  }
  function h53(str) {
    let h1 = 0xdeadbeef; let h2 = 0x41c6ce57;
    for (let i = 0; i < str.length; i++) {
      const ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36) + str.length.toString(36);
  }
  const omit = (o, keys) => { const c = Object.assign({}, o); for (const k of keys) delete c[k]; return c; };
  const hashCat = (r) => h53(canon(omit(r, ['deleted'])));
  const hashProd = (r) => h53(canon(omit(r, ['quantity', 'updatedAt', 'thumb', 'seedQty', 'deleted'])));
  const hashMov = (r) => h53(canon(omit(r, ['before', 'after', 'remote', 'pre', 'deleted'])));
  const hashHeld = (r) => h53(canon(omit(r, ['deleted'])));
  const photoSig = (r) => `${r.updatedAt || 0}|${(r.blob && r.blob.size) || 0}|${r.type || ''}`;
  const key = (kind, id) => `${kind}|${id}`;
  const splitKey = (k) => { const i = k.indexOf('|'); return [k.slice(0, i), k.slice(i + 1)]; };

  /* ---------------- Estado (propio de cada teléfono; nunca viaja en copias) ---------------- */
  let st = null;
  let saveTimer = null;
  let lastStamp = 0;
  const blankState = (code) => ({
    v: 1, code, linkedAt: Date.now(), cursor: 0, pcursor: 0, seenMax: -1, offset: 0,
    hashes: {}, dirty: {}, seed: {}, pre: {}, pending: [], lastSync: null, lastError: null, revoked: false,
  });

  function stamp() {
    const n = Date.now() + (st ? st.offset : 0);
    lastStamp = n > lastStamp ? n : lastStamp + 1;
    return lastStamp;
  }

  function saveNow() {
    clearTimeout(saveTimer); saveTimer = null;
    if (!st) return Promise.resolve();
    const copy = st;
    return DB.tx(['settings'], 'readwrite', (S) => R(S.settings.put({ key: STATE_KEY, value: copy })), { quiet: true }).catch((e) => console.error('cloud: no se pudo guardar el estado', e));
  }
  function saveSoon() {
    if (saveTimer) return;
    saveTimer = setTimeout(saveNow, 800);
  }

  /* ---------------- Estado visible ---------------- */
  const status = { phase: 'off', msg: '' }; // off | ok | syncing | offline | error
  function setStatus(phase, msg) {
    status.phase = phase; status.msg = msg || '';
    renderBadge(); renderCard();
  }
  const pendingCount = () => (st ? Object.keys(st.dirty).length : 0);

  /* ---------------- Red ---------------- */
  async function rpc(fn, args) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), HTTP_MS);
    let r;
    try {
      r = await fetch(`${API_URL}/rest/v1/rpc/${fn}`, {
        method: 'POST',
        headers: { apikey: API_KEY, Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(args),
        signal: ctl.signal,
      });
    } catch (e) {
      throw new CloudErr('net', e && e.name === 'AbortError' ? 'La conexión tardó demasiado.' : 'No hay conexión con la nube.');
    } finally { clearTimeout(timer); }
    if (!r.ok) {
      let m = '';
      try { m = (await r.json()).message || ''; } catch (_) { /* sin cuerpo */ }
      if (/invalid_code/.test(m)) throw new CloudErr('code', 'Código no autorizado.');
      throw new CloudErr('http', m || `Error del servidor (${r.status}).`);
    }
    try { return await r.json(); } catch (_) { throw new CloudErr('net', 'Respuesta incompleta del servidor.'); }
  }

  /* ---------------- Lectura local y detección de cambios ---------------- */
  function readSnap() {
    return DB.tx(STORES, 'readonly', async (S) => ({
      products: await R(S.products.getAll()),
      categories: await R(S.categories.getAll()),
      movements: await R(S.movements.getAll()),
      photos: await R(S.photos.getAll()),
      held: (await R(S.settings.get('heldOrders'))) || null,
    }));
  }

  function project(snap) {
    const cur = new Map();
    for (const c of snap.categories) cur.set(key('category', c.id), { kind: 'category', id: c.id, hash: hashCat(c), rec: c });
    for (const p of snap.products) cur.set(key('product', p.id), { kind: 'product', id: p.id, hash: hashProd(p), rec: p });
    for (const m of snap.movements) cur.set(key('movement', m.id), { kind: 'movement', id: m.id, hash: hashMov(m), rec: m });
    const list = snap.held && Array.isArray(snap.held.value) ? snap.held.value : [];
    for (const o of list) if (o && o.id) cur.set(key('held', o.id), { kind: 'held', id: o.id, hash: hashHeld(o), rec: o });
    for (const ph of snap.photos) cur.set(key('photo', ph.productId), { kind: 'photo', id: ph.productId, hash: photoSig(ph), rec: ph });
    return cur;
  }

  /* Compara lo local con lo último enviado y anota qué está pendiente de enviar. */
  async function scan() {
    if (!st) return false;
    const snap = await readSnap();
    if (!st) return false;
    const cur = project(snap);
    let changed = false;

    // Productos que la nube todavía no conoce: se fija su existencia de partida y su historial actual
    // queda como «ya contado» (solo los movimientos posteriores se suman en los otros teléfonos).
    const fresh = new Set();
    for (const [k, e] of cur) {
      if (e.kind === 'product' && !(k in st.hashes) && !(e.id in st.seed)) {
        st.seed[e.id] = e.rec.quantity === undefined ? null : e.rec.quantity;
        fresh.add(e.id); changed = true;
      }
    }
    if (fresh.size) {
      for (const m of snap.movements) {
        if (fresh.has(m.productId) && !(key('movement', m.id) in st.hashes)) st.pre[m.id] = 1;
      }
    }

    for (const [k, e] of cur) {
      if (st.hashes[k] !== e.hash) {
        const d = st.dirty[k];
        if (!d || d.del || d.h !== e.hash) { st.dirty[k] = { at: stamp(), h: e.hash }; changed = true; }
      } else if (st.dirty[k]) { delete st.dirty[k]; changed = true; }
    }
    for (const k of Object.keys(st.hashes)) {
      if (cur.has(k)) continue;
      const [kind, id] = splitKey(k);
      delete st.hashes[k];
      changed = true;
      if (kind === 'movement') { delete st.pre[id]; delete st.dirty[k]; continue; } // el historial solo desaparece junto con su producto
      if (kind === 'photo' && !cur.has(key('product', id))) { delete st.dirty[k]; continue; }
      st.dirty[k] = { at: stamp(), del: true };
    }
    for (const k of Object.keys(st.dirty)) {
      if (!st.dirty[k].del && !cur.has(k)) { delete st.dirty[k]; changed = true; }
    }
    if (changed) saveSoon();
    return changed;
  }

  /* ---------------- Envío ---------------- */
  function blobToB64(blob) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => { const s = String(fr.result); resolve(s.slice(s.indexOf(',') + 1)); };
      fr.onerror = () => reject(fr.error);
      fr.readAsDataURL(blob);
    });
  }

  async function pushAll() {
    if (!st || !Object.keys(st.dirty).length) return 0;
    const snap = await readSnap();
    const cur = project(snap);
    const orderOf = { category: 0, product: 1, held: 2, movement: 3, photo: 4 };
    const items = [];
    for (const k of Object.keys(st.dirty)) {
      const d = st.dirty[k];
      const [kind, id] = splitKey(k);
      if (d.del) { items.push({ k, kind, id, at: d.at, del: true }); continue; }
      const e = cur.get(k);
      if (!e) continue;
      items.push({ k, kind, id, at: d.at, e });
    }
    items.sort((a, b) => (orderOf[a.kind] - orderOf[b.kind]) || ((a.e && a.e.rec.createdAt) || 0) - ((b.e && b.e.rec.createdAt) || 0));

    const rowFor = (it) => {
      if (it.del) return { kind: it.kind, id: it.id, at: it.at, data: { deleted: true } };
      const r = it.e.rec;
      let data;
      if (it.kind === 'product') { data = omit(r, ['quantity', 'updatedAt']); data.seedQty = st.seed[it.id] === undefined ? null : st.seed[it.id]; }
      else if (it.kind === 'movement') { data = omit(r, ['remote']); if (st.pre[it.id]) data.pre = true; }
      else data = Object.assign({}, r);
      return { kind: it.kind, id: it.id, at: it.at, data };
    };
    const done = (it) => {
      if (it.del) {
        delete st.hashes[it.k];
        if (it.kind === 'product') { delete st.seed[it.id]; }
      } else st.hashes[it.k] = it.e.hash;
      delete st.dirty[it.k];
    };
    const sendRows = async (batch) => {
      await rpc('almacen_push', { p_code: st.code, p_rows: batch.map((x) => x.row) });
      for (const x of batch) done(x.it);
      saveSoon();
    };

    let batch = []; let bytes = 0; let sent = 0;
    for (const it of items) {
      if (it.kind === 'photo' && !it.del) {
        const ph = it.e.rec;
        const b64 = await blobToB64(ph.blob);
        const row = { kind: 'photo', id: it.id, at: it.at, data: { type: ph.type || 'image/jpeg', width: ph.width || 0, height: ph.height || 0, updatedAt: ph.updatedAt || 0, b64 } };
        await sendRows([{ it, row }]);
        sent++;
        continue;
      }
      const row = rowFor(it);
      const size = JSON.stringify(row).length;
      if (batch.length && (batch.length >= BATCH_ROWS || bytes + size > BATCH_BYTES)) { await sendRows(batch); sent += batch.length; batch = []; bytes = 0; }
      batch.push({ it, row }); bytes += size;
    }
    if (batch.length) { await sendRows(batch); sent += batch.length; }
    return sent;
  }

  /* ---------------- Recepción ---------------- */
  function b64ToBlob(b64, type) {
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: type || 'image/jpeg' });
  }

  const localWins = (k, at) => { const d = st.dirty[k]; return !!d && d.at >= at; };

  /* Aplica un lote de datos de otros teléfonos. Todo en UNA transacción; el estado en memoria solo cambia si sale bien. */
  async function applyData(rows) {
    const out = { h: {}, delH: [], seed: {}, delSeed: [], clearDirty: [], pre: [], pending: [], neg: [], changed: 0, gone: new Set() };
    const cats = rows.filter((r) => r.kind === 'category');
    const prods = rows.filter((r) => r.kind === 'product');
    const helds = rows.filter((r) => r.kind === 'held');
    const movs = st.pending.map((p) => p.row).concat(rows.filter((r) => r.kind === 'movement'));
    const pendingSeen = new Map(st.pending.map((p) => [p.row.id, p.t]));

    await DB.tx(STORES, 'readwrite', async (S) => {
      const cache = new Map();
      const touched = new Set();
      const getP = async (id) => {
        if (cache.has(id)) return cache.get(id);
        const p = (await R(S.products.get(id))) || null;
        cache.set(id, p);
        return p;
      };
      const echo = (k, hash) => st.hashes[k] === hash && !st.dirty[k];

      for (const r of cats) {
        const k = key('category', r.id);
        if (localWins(k, r.at)) continue;
        if (r.data.deleted) { await R(S.categories.delete(r.id)); out.delH.push(k); out.clearDirty.push(k); out.changed++; continue; }
        const rec = omit(r.data, ['deleted']);
        if (echo(k, hashCat(rec))) continue;
        await R(S.categories.put(rec));
        out.h[k] = hashCat(rec); out.clearDirty.push(k); out.changed++;
      }

      for (const r of prods) {
        const k = key('product', r.id);
        if (localWins(k, r.at)) continue;
        if (r.data.deleted) {
          const mk = await R(S.movements.index('productId').getAllKeys(IDBKeyRange.only(r.id)));
          for (const m of mk) { await R(S.movements.delete(m)); out.delH.push(key('movement', m)); }
          await R(S.photos.delete(r.id)); out.delH.push(key('photo', r.id));
          await R(S.products.delete(r.id));
          cache.set(r.id, null); touched.delete(r.id);
          out.delH.push(k); out.delSeed.push(r.id); out.clearDirty.push(k); out.gone.add(r.id); out.changed++;
          continue;
        }
        const existing = await getP(r.id);
        const seedQty = r.data.seedQty === undefined ? null : r.data.seedQty;
        const base = omit(r.data, ['seedQty', 'deleted', 'quantity', 'updatedAt']);
        if (existing && echo(k, hashProd(base))) { out.seed[r.id] = seedQty; continue; }
        let rec;
        if (existing) rec = Object.assign({}, base, { quantity: existing.quantity, updatedAt: existing.updatedAt });
        else rec = Object.assign({}, base, { quantity: seedQty, updatedAt: Date.now() });
        if (existing && !existing.thumb && base.thumb === undefined) rec.thumb = existing.thumb;
        await R(S.products.put(rec));
        cache.set(r.id, rec);
        out.h[k] = hashProd(rec); out.seed[r.id] = seedQty; out.clearDirty.push(k); out.changed++;
      }

      if (helds.length) {
        const row = await R(S.settings.get('heldOrders'));
        let list = Array.isArray(row && row.value) ? row.value.slice() : [];
        let dirty = false;
        for (const r of helds) {
          const k = key('held', r.id);
          if (localWins(k, r.at)) continue;
          if (r.data.deleted) { list = list.filter((o) => o.id !== r.id); out.delH.push(k); out.clearDirty.push(k); dirty = true; out.changed++; continue; }
          const rec = omit(r.data, ['deleted']);
          if (echo(k, hashHeld(rec))) continue;
          const i = list.findIndex((o) => o.id === r.id);
          if (i >= 0) list[i] = rec;
          else {
            if (list.some((o) => o.num === rec.num)) rec.num = list.reduce((a, o) => Math.max(a, o.num || 0), 0) + 1;
            list.push(rec);
          }
          out.h[k] = hashHeld(rec); out.clearDirty.push(k); dirty = true; out.changed++;
        }
        if (dirty) await R(S.settings.put({ key: 'heldOrders', value: list }));
      }

      for (const r of movs) {
        const k = key('movement', r.id);
        const d = r.data;
        const existing = await R(S.movements.get(r.id));
        if (existing) {
          if (localWins(k, r.at)) continue;
          const rec = Object.assign({}, omit(d, ['pre', 'deleted']), { before: existing.before, after: existing.after });
          if (existing.remote) rec.remote = true;
          if (hashMov(rec) === hashMov(existing)) continue;
          await R(S.movements.put(rec));
          out.h[k] = hashMov(rec); out.clearDirty.push(k); out.changed++;
          continue;
        }
        const p = await getP(d.productId);
        if (!p) {
          if (out.gone.has(d.productId)) continue;
          const t = pendingSeen.get(r.id) || Date.now();
          if (Date.now() - t < PENDING_MAX_AGE) out.pending.push({ t, row: r });
          continue;
        }
        const rec = omit(d, ['pre', 'deleted']);
        if (!d.pre) {
          rec.remote = true;
          const before = p.quantity === undefined ? null : p.quantity;
          let after = before;
          const q = Number(d.quantity) || 0;
          if (d.discrepancy) after = before;
          else if (d.type === 'ajuste') {
            if (d.before === null || d.before === undefined || before === null) after = d.after === undefined ? before : d.after;
            else after = round6(before + (Number(d.after) - Number(d.before)));
          } else if (before !== null) after = round6(d.type === 'entrada' ? before + q : before - q);
          rec.before = before; rec.after = after;
          if (after !== before) {
            p.quantity = after; p.updatedAt = Date.now(); touched.add(p.id);
            if (typeof after === 'number' && after < 0 && !(typeof before === 'number' && before < 0)) out.neg.push(p.name);
          }
        }
        await R(S.movements.put(rec));
        out.h[k] = hashMov(rec); out.clearDirty.push(k); out.changed++;
        if (d.pre) out.pre.push(r.id);
      }
      for (const id of touched) { const p = cache.get(id); if (p) await R(S.products.put(p)); }
    }, { quiet: true });

    // La transacción salió bien: ahora sí se actualiza el estado en memoria.
    for (const k of out.delH) { delete st.hashes[k]; delete st.dirty[k]; }
    for (const id of out.delSeed) { delete st.seed[id]; }
    Object.assign(st.hashes, out.h);
    for (const [id, q] of Object.entries(out.seed)) if (!(id in st.seed)) st.seed[id] = q;
    for (const k of out.clearDirty) delete st.dirty[k];
    for (const id of out.pre) delete st.pre[id];
    st.pending = out.pending;
    if (out.neg.length) {
      const names = [...new Set(out.neg)];
      UI.toast(`Atención: tras unir los cambios de otro teléfono, ${names.length === 1 ? `«${names[0]}» quedó` : `${names.length} productos quedaron`} con existencia negativa${names.length > 1 ? ` (${names.slice(0, 3).join(', ')}…)` : ''}. Revisa el conteo.`, 'error');
    }
    return out.changed;
  }

  async function applyPhotos(rows) {
    const prepared = [];
    for (const r of rows) {
      if (r.data.deleted) { prepared.push({ r, del: true }); continue; }
      let blob;
      try { blob = b64ToBlob(r.data.b64 || '', r.data.type); } catch (_) { continue; }
      prepared.push({ r, blob });
    }
    const out = { h: {}, delH: [], clearDirty: [], changed: 0 };
    await DB.tx(STORES, 'readwrite', async (S) => {
      for (const it of prepared) {
        const id = it.r.id; const k = key('photo', id);
        if (localWins(k, it.r.at)) continue;
        if (it.del) { await R(S.photos.delete(id)); out.delH.push(k); out.clearDirty.push(k); out.changed++; continue; }
        const prod = await R(S.products.get(id));
        if (!prod) continue;
        const rec = { productId: id, blob: it.blob, type: it.blob.type || it.r.data.type || 'image/jpeg', width: it.r.data.width || 0, height: it.r.data.height || 0, updatedAt: it.r.data.updatedAt || Date.now() };
        const sig = photoSig(rec);
        if (st.hashes[k] === sig && !st.dirty[k]) continue;
        await R(S.photos.put(rec));
        out.h[k] = sig; out.clearDirty.push(k); out.changed++;
      }
    }, { quiet: true });
    for (const k of out.delH) { delete st.hashes[k]; delete st.dirty[k]; }
    Object.assign(st.hashes, out.h);
    for (const k of out.clearDirty) delete st.dirty[k];
    return out.changed;
  }

  async function pullStream(kinds, limit, cursorKey, apply) {
    let changed = 0; let max = 0;
    for (let guard = 0; guard < 2000; guard++) {
      const res = await rpc('almacen_pull', { p_code: st.code, p_since: st[cursorKey], p_limit: limit, p_kinds: kinds });
      max = res.max;
      const rows = res.rows || [];
      if (rows.length) {
        changed += await apply(rows);
        st[cursorKey] = rows[rows.length - 1].seq;
        saveSoon();
      } else if (st.pending.length && cursorKey === 'cursor') {
        changed += await apply([]);
      }
      if (!res.more) break;
    }
    return { changed, max };
  }

  /* ---------------- Ciclo de sincronización ---------------- */
  let chain = Promise.resolve();
  const exclusive = (fn) => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };
  let running = false; let again = false; let touchTimer = null; let afterRefresh = null;

  async function refreshUI() {
    clearTimeout(afterRefresh);
    afterRefresh = setTimeout(async () => {
      try {
        if (globalThis.Settings) await Settings.load();
        if (globalThis.App) await App.refresh();
        if (globalThis.Cart && Cart.reload) Cart.reload();
      } catch (e) { console.error(e); }
    }, 150);
  }

  async function runCycle() {
    if (!st) return;
    await scan();
    if (!navigator.onLine) { setStatus('offline', 'Sin internet: los cambios se guardan aquí y se enviarán solos.'); return; }
    setStatus('syncing', 'Sincronizando…');
    const ping = await rpc('almacen_ping', { p_code: st.code });
    if (!ping.ok) throw new CloudErr('code', 'Código no autorizado.');
    if (typeof ping.now === 'number') st.offset = ping.now - Date.now();
    let changed = 0;
    if (ping.max !== st.seenMax) {
      const a = await pullStream(DATA_KINDS, 200, 'cursor', applyData);
      changed += a.changed;
      if (changed) refreshUI();
      await scan();
    }
    const sent = await pushAll();
    if (ping.max !== st.seenMax || sent) {
      setStatus('syncing', 'Descargando fotos…');
      const b = await pullStream(['photo'], 4, 'pcursor', applyPhotos);
      if (b.changed) { changed += b.changed; refreshUI(); }
      st.seenMax = ping.max;
    }
    st.lastSync = Date.now(); st.lastError = null;
    saveSoon();
    setStatus('ok', '');
  }

  async function cycle() {
    if (!st) return;
    if (running) { again = true; return; }
    running = true;
    try {
      do {
        again = false;
        try {
          await exclusive(runCycle);
        } catch (e) {
          if (e instanceof CloudErr && e.kind === 'net') setStatus('offline', 'Sin conexión con la nube. Se reintentará solo.');
          else if (e instanceof CloudErr && e.kind === 'code') { st.revoked = true; saveSoon(); setStatus('error', 'Este teléfono ya no está autorizado. Vuelve a vincularlo con un código válido.'); }
          else { console.error(e); if (st) { st.lastError = String(e && e.message || e); saveSoon(); } setStatus('error', `No se pudo sincronizar: ${DB.friendlyError(e)}`); }
          again = false;
        }
      } while (again);
    } finally { running = false; }
  }

  function touch() {
    if (!st || st.revoked) return;
    clearTimeout(touchTimer);
    touchTimer = setTimeout(() => cycle(), TOUCH_MS);
  }

  /* ---------------- Vincular, unir y desvincular ---------------- */
  const normCode = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

  async function counts() {
    const snap = await DB.tx(['products', 'categories', 'movements', 'photos'], 'readonly', async (S) => ({
      p: await R(S.products.count()), c: await R(S.categories.count()), m: await R(S.movements.count()), f: await R(S.photos.count()),
    }));
    return snap;
  }

  async function wipeBusinessData() {
    await DB.tx(STORES, 'readwrite', async (S) => {
      for (const n of ['products', 'categories', 'movements', 'photos']) await R(S[n].clear());
      await R(S.settings.delete('heldOrders'));
    }, { quiet: true });
  }

  async function linkFlow() {
    let code = null; let info = null;
    const typed = await UI.prompt({
      title: 'Vincular con la nube',
      message: 'Escribe el código de vinculación de este teléfono (16 letras y números). Solo se hace una vez.',
      label: 'Código', placeholder: 'XXXX-XXXX-XXXX-XXXX', maxlength: 24, okLabel: 'Comprobar',
      async submit(v) {
        const c = normCode(v);
        if (c.length !== 16) throw new AppError('VALIDATION', 'El código tiene 16 letras y números. Revísalo.');
        if (!navigator.onLine) throw new AppError('OFFLINE', 'Necesitas internet para vincular el teléfono.');
        let p;
        try { p = await rpc('almacen_ping', { p_code: c }); } catch (e) { throw new AppError('NET', e instanceof CloudErr ? (e.kind === 'net' ? 'No se pudo conectar con la nube. Revisa tu internet y vuelve a intentarlo.' : e.message) : DB.friendlyError(e)); }
        if (!p.ok) throw new AppError('BAD_CODE', 'Ese código no es válido o ya no está autorizado.');
        code = c; info = p;
      },
    });
    if (typed === null || !code) return false;
    const n = await counts();
    const hasLocal = n.p > 0 || n.c > 0;
    const serverEmpty = !info.max;
    if (serverEmpty) {
      const ok = await UI.confirm({
        title: hasLocal ? 'Subir este inventario a la nube' : 'Vincular teléfono',
        html: hasLocal
          ? `<p>La nube está vacía. Se subirá <b>el inventario de este teléfono</b> (${n.p} productos, ${n.m} movimientos, ${n.f} fotos) y será el inventario compartido.</p><p class="muted">Haz esto solo en el teléfono que tiene el inventario correcto. Los demás se unirán después y tomarán estos datos.</p>`
          : '<p>La nube está vacía y este teléfono también. Quedará vinculado y todo lo que registres se compartirá.</p>',
        okLabel: hasLocal ? 'Subir y vincular' : 'Vincular',
      });
      if (!ok) return false;
    } else {
      const ok = await UI.confirm({
        title: 'Unirse al inventario de la nube',
        html: hasLocal
          ? `<p>La nube ya tiene un inventario. Para unirse, este teléfono <b>reemplazará sus ${n.p} productos</b> por los de la nube.</p><p>Antes se descargará una copia de seguridad de lo que tiene ahora, por si acaso.</p>`
          : '<p>La nube ya tiene un inventario. Este teléfono lo descargará (incluidas las fotos) y quedará sincronizado.</p>',
        okLabel: hasLocal ? 'Descargar copia y unirme' : 'Unirme', danger: hasLocal,
      });
      if (!ok) return false;
      if (hasLocal) {
        try { const done = await Settings.doExport(false); if (done === false) return false; } catch (e) { UI.toast(`No se pudo crear la copia previa: ${DB.friendlyError(e)} No se cambió nada.`, 'error'); return false; }
      }
      await wipeBusinessData();
    }
    st = blankState(code);
    await saveNow();
    if (!serverEmpty) await App.afterRestore();
    start();
    UI.toast(serverEmpty ? 'Teléfono vinculado. Subiendo el inventario…' : 'Teléfono vinculado. Descargando el inventario…', 'ok');
    cycle();
    return true;
  }

  async function unlinkFlow() {
    const ok = await UI.confirm({
      title: 'Desvincular este teléfono', danger: true, okLabel: 'Desvincular',
      html: '<p>Este teléfono dejará de sincronizarse. <b>Conserva todos sus datos</b> y sigue funcionando, pero ya no enviará ni recibirá cambios.</p><p class="muted">Para volver a sincronizar tendrá que unirse de nuevo (reemplazando sus datos por los de la nube).</p>',
    });
    if (!ok) return false;
    await forget(true);
    UI.toast('Teléfono desvinculado.', 'ok');
    return true;
  }

  /* Olvida la vinculación (opcionalmente borra también la fila guardada). */
  async function forget(deleteRow) {
    clearTimeout(touchTimer); clearTimeout(saveTimer); saveTimer = null;
    st = null;
    if (deleteRow) await DB.tx(['settings'], 'readwrite', (S) => R(S.settings.delete(STATE_KEY)), { quiet: true });
    setStatus('off', '');
  }

  /* Al restaurar una copia, los datos locales dejan de coincidir con la nube: se desvincula para no pisarla. */
  async function onRestore() {
    if (!st) return false;
    await forget(true);
    UI.toast('Al restaurar una copia, este teléfono se desvinculó de la nube para no sobrescribirla. Puedes volver a unirte en Configuración.', 'ok');
    return true;
  }

  /* ---------------- Interfaz ---------------- */
  const fmtAgo = (ts) => {
    const s = Math.round((Date.now() - ts) / 1000);
    if (s < 45) return 'hace unos segundos';
    if (s < 3600) return `hace ${Math.round(s / 60)} min`;
    if (s < 86400) return `hace ${Math.round(s / 3600)} h`;
    return new Date(ts).toLocaleString('es', { dateStyle: 'medium', timeStyle: 'short' });
  };
  const esc = (s) => UI.esc(s);

  function cardInner() {
    if (!st) {
      return `<h2>Sincronización por internet</h2>
        <p>Mantiene el mismo inventario en todos tus teléfonos, automáticamente y sin cuentas ni contraseñas. Si no hay internet, sigues trabajando y todo se envía solo cuando vuelva.</p>
        <button type="button" class="btn" data-s="cloud-link">Vincular este teléfono…</button>`;
    }
    const label = { ok: 'Todo sincronizado', syncing: 'Sincronizando…', offline: 'Sin conexión', error: 'Hay un problema', off: '' }[status.phase] || '';
    const pend = pendingCount();
    const line2 = st.lastSync ? `Última sincronización: ${fmtAgo(st.lastSync)}` : 'Todavía no se ha sincronizado.';
    return `<h2>Sincronización por internet</h2>
      <p><b>${esc(label)}</b>${pend ? ` · ${pend} cambio${pend === 1 ? '' : 's'} pendiente${pend === 1 ? '' : 's'} de enviar` : ''}</p>
      ${status.msg ? `<div class="notice ${status.phase === 'error' ? 'danger' : 'info'}">${esc(status.msg)}</div>` : ''}
      <p class="muted small-text">${esc(line2)}</p>
      <div class="stack">
        <button type="button" class="btn" data-s="cloud-now">Sincronizar ahora</button>
        <button type="button" class="btn danger-ghost" data-s="cloud-unlink">Desvincular este teléfono…</button>
      </div>`;
  }
  const cardHtml = () => `<div class="card cfg" id="cloud-card">${cardInner()}</div>`;
  function renderCard() {
    const el = document.getElementById('cloud-card');
    if (el) el.innerHTML = cardInner();
  }
  function renderBadge() {
    const el = document.getElementById('cloud-slot');
    if (!el) return;
    if (!st) { el.innerHTML = ''; return; }
    const map = { ok: ['☁', 'Sincronizado', 'ok'], syncing: ['⟳', 'Sincronizando', 'busy'], offline: ['☁', 'Sin conexión: se enviará al volver', 'off'], error: ['!', 'Problema de sincronización', 'err'], off: ['☁', '', 'off'] };
    const [ic, tip, cls] = map[status.phase] || map.off;
    const pend = pendingCount();
    el.innerHTML = `<button type="button" class="cloud-badge ${cls}" id="cloud-badge" aria-label="${esc(tip)}" title="${esc(tip)}">${ic}${pend ? `<small>${pend > 99 ? '99+' : pend}</small>` : ''}</button>`;
  }

  async function syncNow() {
    if (!st) return;
    if (st.revoked) { UI.toast('Este teléfono no está autorizado. Vuelve a vincularlo.', 'error'); return; }
    if (!navigator.onLine) { UI.toast('No hay internet. Se sincronizará solo cuando vuelva.'); return; }
    await cycle();
    if (status.phase === 'ok') UI.toast('Sincronizado.', 'ok');
  }

  /* ---------------- Arranque ---------------- */
  let started = false;
  function start() {
    if (started) { renderBadge(); return; }
    started = true;
    setInterval(() => { if (st && !st.revoked && !document.hidden && navigator.onLine) cycle(); }, POLL_MS);
    window.addEventListener('online', () => cycle());
    window.addEventListener('offline', () => { if (st) setStatus('offline', 'Sin internet: los cambios se guardan aquí y se enviarán solos.'); });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) cycle(); });
    document.addEventListener('click', (e) => {
      if (e.target.closest('#cloud-badge') && globalThis.App) { App.go('config'); }
    });
  }

  async function init() {
    try {
      const row = await DB.get('settings', STATE_KEY);
      if (row && row.value && row.value.code) {
        st = Object.assign(blankState(row.value.code), row.value);
        start();
        setStatus(st.revoked ? 'error' : (navigator.onLine ? 'syncing' : 'offline'), st.revoked ? 'Este teléfono ya no está autorizado. Vuelve a vincularlo.' : '');
        if (!st.revoked) cycle();
      } else { renderBadge(); }
    } catch (e) { console.error('cloud init', e); }
  }

  globalThis.Cloud = {
    init, touch, cardHtml, renderCard, linkFlow, unlinkFlow, syncNow, onRestore, forget,
    isLinked: () => !!st, status: () => Object.assign({ pending: pendingCount() }, status),
    _debug: () => st,
  };
})();

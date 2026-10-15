'use strict';
/* database.js — Almacenamiento local con IndexedDB.
   Apertura, migraciones y transacciones. Es la única capa que toca IndexedDB. */
(function () {
  const DB_NAME = 'almacen-db';
  const DB_VERSION = 2;
  const STORE_NAMES = ['products', 'categories', 'movements', 'photos', 'settings'];
  let dbPromise = null;
  let dbInstance = null;

  class AppError extends Error {
    constructor(code, message, extra) {
      super(message);
      this.name = 'AppError';
      this.code = code;
      if (extra) this.extra = extra;
    }
  }

  /* Convierte cualquier error en un mensaje comprensible. */
  function friendlyError(err) {
    if (!err) return 'Ocurrió un error desconocido.';
    if (err instanceof AppError) return err.message;
    const name = err.name || '';
    const msg = err.message || '';
    if (name === 'QuotaExceededError' || /quota/i.test(msg)) {
      return 'No hay espacio suficiente en el dispositivo. Libera espacio o usa una foto más pequeña y vuelve a intentarlo. No se perdió ningún dato.';
    }
    if (name === 'VersionError') {
      return 'Los datos guardados pertenecen a una versión más nueva de la aplicación. Actualiza la aplicación antes de continuar.';
    }
    if (name === 'AbortError') return 'La operación se canceló y no se guardó ningún cambio.';
    if (name === 'NotFoundError') return 'Falta una parte de los datos locales. Ve a Configuración › Mantenimiento y comprueba la integridad.';
    if (name === 'SecurityError') return 'El navegador no permite guardar datos en este modo (¿navegación privada?).';
    return msg || String(err);
  }

  function uuid() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    const b = new Uint8Array(16);
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(b);
    else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }

  /* ---- Migraciones: cada versión se aplica en orden, sin borrar datos existentes. ---- */
  const migrations = {
    1(db) {
      const p = db.createObjectStore('products', { keyPath: 'id' });
      p.createIndex('categoryId', 'categoryId');
      p.createIndex('subcategoryId', 'subcategoryId');
      p.createIndex('createdAt', 'createdAt');
      const c = db.createObjectStore('categories', { keyPath: 'id' });
      c.createIndex('parentId', 'parentId');
      const m = db.createObjectStore('movements', { keyPath: 'id' });
      m.createIndex('productId', 'productId');
      m.createIndex('createdAt', 'createdAt');
      m.createIndex('type', 'type');
      db.createObjectStore('photos', { keyPath: 'productId' });
      db.createObjectStore('settings', { keyPath: 'key' });
    },
    /* Versión 2: campos nuevos en los productos (color, presentación, capacidad, campos
       personalizados y estado de la cantidad). Los productos existentes se completan con valores
       neutros; no se borra ni se cambia ningún dato. Se usan callbacks (no await) porque la
       transacción de actualización se cierra sola si no quedan peticiones pendientes. */
    2(db, tx) {
      const store = tx.objectStore('products');
      const cur = store.openCursor();
      cur.onsuccess = () => {
        const c = cur.result;
        if (!c) return;
        const p = c.value;
        if (p.color === undefined) p.color = '';
        if (p.presentation === undefined) p.presentation = '';
        if (p.capacity === undefined) p.capacity = '';
        if (!Array.isArray(p.fields)) p.fields = [];
        if (p.quantityStatus !== 'estimated') p.quantityStatus = 'confirmed';
        c.update(p);
        c.continue();
      };
    },
    /* Futuras versiones: 3(db, tx) { ... } */
  };

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(new AppError('NO_IDB', 'Este navegador no permite guardar datos locales (IndexedDB no disponible).'));
        return;
      }
      let req;
      try {
        req = indexedDB.open(DB_NAME, DB_VERSION);
      } catch (e) {
        reject(e);
        return;
      }
      req.onupgradeneeded = (ev) => {
        const db = req.result;
        const tx = req.transaction;
        for (let v = ev.oldVersion + 1; v <= ev.newVersion; v++) {
          if (migrations[v]) migrations[v](db, tx, ev.oldVersion);
        }
      };
      req.onsuccess = () => {
        dbInstance = req.result;
        dbInstance.onversionchange = () => {
          /* Otra pestaña actualiza la base: cerramos sin borrar nada. */
          dbInstance.close();
          dbInstance = null;
          dbPromise = null;
        };
        resolve(dbInstance);
      };
      req.onerror = () => reject(req.error);
      req.onblocked = () => { /* Hay otra pestaña con una versión anterior abierta. */ };
    }).catch((e) => {
      dbPromise = null;
      throw e;
    });
    return dbPromise;
  }

  function close() {
    if (dbInstance) dbInstance.close();
    dbInstance = null;
    dbPromise = null;
  }

  /* Convierte una petición IDB en promesa. */
  function req(r) {
    return new Promise((resolve, reject) => {
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }

  /* Ejecuta `work(stores, tx)` dentro de UNA transacción. Si `work` lanza un error o la
     transacción falla, se cancela todo: no queda ningún cambio a medias. */
  async function tx(names, mode, work, opts) {
    const db = await open();
    return new Promise((resolve, reject) => {
      let t;
      try {
        t = db.transaction(names, mode);
      } catch (e) {
        reject(e);
        return;
      }
      let result;
      let failure = null;
      t.oncomplete = () => {
        resolve(result);
        // Aviso a la sincronización por internet de que hubo un cambio local.
        if (mode === 'readwrite' && !(opts && opts.quiet) && globalThis.Cloud) { try { globalThis.Cloud.touch(); } catch (_) { /* nunca debe afectar al guardado */ } }
      };
      t.onabort = () => reject(failure || t.error || new AppError('ABORT', 'La operación se canceló.'));
      const stores = {};
      names.forEach((n) => { stores[n] = t.objectStore(n); });
      (async () => {
        try {
          result = await work(stores, t);
        } catch (e) {
          failure = e;
          try { t.abort(); } catch (_) { /* ya cancelada */ }
        }
      })();
    });
  }

  const get = (store, key) => tx([store], 'readonly', (S) => req(S[store].get(key)));
  const getAll = (store) => tx([store], 'readonly', (S) => req(S[store].getAll()));
  const put = (store, value) => tx([store], 'readwrite', async (S) => { await req(S[store].put(value)); return value; });
  const del = (store, key) => tx([store], 'readwrite', (S) => req(S[store].delete(key)));

  /* Lectura consistente de todo el inventario en una sola transacción. */
  function exportSnapshot() {
    return tx(STORE_NAMES, 'readonly', async (S) => {
      const out = {};
      for (const n of STORE_NAMES) out[n] = await req(S[n].getAll());
      return out;
    });
  }

  /* Sustituye TODO el contenido en una sola transacción: si algo falla, se conserva lo anterior.
     keepSettingKeys: ajustes propios de este teléfono que se conservan aunque se restaure otra copia
     (por ejemplo, la identidad para las actualizaciones entre teléfonos). Se leen dentro de la misma
     transacción, antes de vaciar nada. */
  function replaceAll(data, keepSettingKeys) {
    return tx(STORE_NAMES, 'readwrite', async (S) => {
      const kept = [];
      for (const k of keepSettingKeys || []) {
        const row = await req(S.settings.get(k));
        if (row) kept.push(row);
      }
      for (const n of STORE_NAMES) await req(S[n].clear());
      for (const n of STORE_NAMES) {
        for (const rec of data[n] || []) await req(S[n].put(rec));
      }
      for (const row of kept) await req(S.settings.put(row));
    });
  }

  /* Añade registros sin sobrescribir los que ya existen (importación combinada). */
  function addMissing(data) {
    return tx(STORE_NAMES, 'readwrite', async (S) => {
      const added = {};
      for (const n of STORE_NAMES) {
        added[n] = 0;
        const keyPath = S[n].keyPath;
        for (const rec of data[n] || []) {
          const exists = await req(S[n].getKey(rec[keyPath]));
          if (exists === undefined) {
            await req(S[n].add(rec));
            added[n]++;
          }
        }
      }
      return added;
    });
  }

  function wipeAll() {
    return tx(STORE_NAMES, 'readwrite', async (S) => {
      for (const n of STORE_NAMES) await req(S[n].clear());
    });
  }

  async function requestPersist() {
    try {
      if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist();
    } catch (_) { /* no disponible */ }
    return false;
  }

  async function storageEstimate() {
    try {
      if (navigator.storage && navigator.storage.estimate) {
        const e = await navigator.storage.estimate();
        const persisted = navigator.storage.persisted ? await navigator.storage.persisted() : null;
        return { usage: e.usage || 0, quota: e.quota || 0, persisted };
      }
    } catch (_) { /* no disponible */ }
    return null;
  }

  globalThis.AppError = AppError;
  globalThis.DB = {
    NAME: DB_NAME, VERSION: DB_VERSION, STORE_NAMES,
    open, close, req, tx, get, getAll, put, del,
    exportSnapshot, replaceAll, addMissing, wipeAll,
    requestPersist, storageEstimate, uuid, friendlyError,
  };
})();

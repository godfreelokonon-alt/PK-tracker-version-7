/* ==========================================================================
   STORAGE — IndexedDB wrapper for chantiers, signalements, photos, traces
   Handles persistent storage permission & quota monitoring
   ========================================================================== */
(() => {
'use strict';

const DB_NAME = 'pkt_v6';
const DB_VERSION = 1;
const STORES = {
  chantiers: 'chantiers',       // { id, name, line, pk_start, pk_end, ref_trace, created, updated }
  signalements: 'signalements', // { id, chantier_id, pk_m, lat, lon, acc, cap, ts, hash, type, cat, note, photo_id, statut, cluster_id }
  photos: 'photos',             // photo blob by id
  traces: 'traces',             // raw GPS traces by session
  sessions: 'sessions',         // resumable session state
  meta: 'meta'                  // key-value misc
};

let _db = null;

function open() {
  return new Promise((resolve, reject) => {
    if (_db) return resolve(_db);
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORES.chantiers)) {
        const s = db.createObjectStore(STORES.chantiers, { keyPath: 'id' });
        s.createIndex('updated', 'updated');
      }
      if (!db.objectStoreNames.contains(STORES.signalements)) {
        const s = db.createObjectStore(STORES.signalements, { keyPath: 'id' });
        s.createIndex('chantier_id', 'chantier_id');
        s.createIndex('ts', 'ts');
        s.createIndex('cluster_id', 'cluster_id');
      }
      if (!db.objectStoreNames.contains(STORES.photos)) {
        db.createObjectStore(STORES.photos);
      }
      if (!db.objectStoreNames.contains(STORES.traces)) {
        db.createObjectStore(STORES.traces, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORES.sessions)) {
        db.createObjectStore(STORES.sessions, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORES.meta)) {
        db.createObjectStore(STORES.meta);
      }
    };
    req.onsuccess = (e) => { _db = e.target.result; resolve(_db); };
    req.onerror = () => reject(req.error);
  });
}

function tx(store, mode = 'readonly') {
  return open().then(db => db.transaction(store, mode).objectStore(store));
}

async function put(store, value, key) {
  const s = await tx(store, 'readwrite');
  return new Promise((res, rej) => {
    const r = key !== undefined ? s.put(value, key) : s.put(value);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

async function get(store, key) {
  const s = await tx(store);
  return new Promise((res, rej) => {
    const r = s.get(key);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

async function getAll(store, indexName, query) {
  const s = await tx(store);
  return new Promise((res, rej) => {
    const src = indexName ? s.index(indexName) : s;
    const r = query ? src.getAll(query) : src.getAll();
    r.onsuccess = () => res(r.result || []);
    r.onerror = () => rej(r.error);
  });
}

async function del(store, key) {
  const s = await tx(store, 'readwrite');
  return new Promise((res, rej) => {
    const r = s.delete(key);
    r.onsuccess = () => res();
    r.onerror = () => rej(r.error);
  });
}

async function clear(store) {
  const s = await tx(store, 'readwrite');
  return new Promise((res, rej) => {
    const r = s.clear();
    r.onsuccess = () => res();
    r.onerror = () => rej(r.error);
  });
}

async function requestPersistence() {
  try {
    if (navigator.storage && navigator.storage.persist) {
      return await navigator.storage.persist();
    }
  } catch {}
  return false;
}

async function getQuota() {
  try {
    if (navigator.storage && navigator.storage.estimate) {
      const q = await navigator.storage.estimate();
      return { used: q.usage || 0, total: q.quota || 0 };
    }
  } catch {}
  return { used: 0, total: 0 };
}

window.PKT_DB = {
  STORES, open, put, get, getAll, del, clear,
  requestPersistence, getQuota
};

})();

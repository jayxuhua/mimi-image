/**
 * IndexedDB：`pending_tasks` / `records` / `kv`
 */
import {
  DB_NAME,
  DB_VER,
  DB_STORE,
  DB_RECORDS_STORE,
  DB_KV_STORE,
  DB_IMAGES_STORE,
  KV_USAGE_STATS,
} from './config.js';

let _db = null;

function dbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      const oldVersion = e.oldVersion || 0;
      if (!db.objectStoreNames.contains(DB_STORE)) {
        db.createObjectStore(DB_STORE, { keyPath: 'taskId' });
      }
      let recordsStore = null;
      if (!db.objectStoreNames.contains(DB_RECORDS_STORE)) {
        recordsStore = db.createObjectStore(DB_RECORDS_STORE, { keyPath: 'id' });
      } else {
        recordsStore = req.transaction.objectStore(DB_RECORDS_STORE);
      }
      if (recordsStore && !recordsStore.indexNames.contains('ts')) {
        recordsStore.createIndex('ts', 'ts', { unique: false });
      }
      if (!db.objectStoreNames.contains(DB_KV_STORE)) {
        db.createObjectStore(DB_KV_STORE, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(DB_IMAGES_STORE)) {
        db.createObjectStore(DB_IMAGES_STORE, { keyPath: 'id' });
      }
      // 预发布阶段不兼容旧历史：升级到 v4 时直接清空旧记录与挂起任务。
      if (oldVersion > 0 && oldVersion < 4) {
        if (db.objectStoreNames.contains(DB_STORE)) {
          req.transaction.objectStore(DB_STORE).clear();
        }
        if (db.objectStoreNames.contains(DB_RECORDS_STORE)) {
          req.transaction.objectStore(DB_RECORDS_STORE).clear();
        }
        if (db.objectStoreNames.contains(DB_IMAGES_STORE)) {
          req.transaction.objectStore(DB_IMAGES_STORE).clear();
        }
      }
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = () => reject(req.error);
  });
}

function dbRun(mode, fn) {
  if (!_db) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const tx    = _db.transaction(DB_STORE, mode);
    const store = tx.objectStore(DB_STORE);
    const req   = fn(store);
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

function dbRecordsRun(mode, fn) {
  if (!_db) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const tx    = _db.transaction(DB_RECORDS_STORE, mode);
    const store = tx.objectStore(DB_RECORDS_STORE);
    const req   = fn(store);
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

function dbKvRun(mode, fn) {
  if (!_db) return Promise.reject(new Error('no db'));
  return new Promise((resolve, reject) => {
    const tx    = _db.transaction(DB_KV_STORE, mode);
    const store = tx.objectStore(DB_KV_STORE);
    const req   = fn(store);
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

function dbImagesRun(mode, fn) {
  if (!_db) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const tx = _db.transaction(DB_IMAGES_STORE, mode);
    const store = tx.objectStore(DB_IMAGES_STORE);
    const req = fn(store);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveTask(task) {
  return dbRun('readwrite', s => s.put(task));
}

async function deleteTask(id) {
  return dbRun('readwrite', s => s.delete(id));
}

async function getAllTasks() {
  const r = await dbRun('readonly', s => s.getAll());
  return Array.isArray(r) ? r : [];
}

async function getTaskById(id) {
  if (!id) return null;
  const r = await dbRun('readonly', s => s.get(id));
  return r || null;
}

async function putRecord(rec) {
  return dbRecordsRun('readwrite', s => s.put(rec));
}

async function deleteRecordById(id) {
  return dbRecordsRun('readwrite', s => s.delete(id));
}

async function clearRecords() {
  return dbRecordsRun('readwrite', s => s.clear());
}

async function clearPendingTasks() {
  return dbRun('readwrite', s => s.clear());
}

async function putImageAsset(asset) {
  return dbImagesRun('readwrite', s => s.put(asset));
}

async function getImageAssetById(id) {
  if (!id) return null;
  const r = await dbImagesRun('readonly', s => s.get(id));
  return r || null;
}

async function deleteImageAssetById(id) {
  if (!id) return null;
  return dbImagesRun('readwrite', s => s.delete(id));
}

async function clearImageAssets() {
  return dbImagesRun('readwrite', s => s.clear());
}

/** 粗略估算单条记录在 JS 中的序列化体积（非浏览器内部页占用） */
function approxSerializedBytes(value) {
  if (value instanceof Blob) return value.size;
  if (Array.isArray(value)) {
    return value.reduce((sum, item) => sum + approxSerializedBytes(item), 0);
  }
  if (value && typeof value === 'object') {
    let total = 0;
    for (const [key, val] of Object.entries(value)) {
      total += new Blob([key]).size;
      total += approxSerializedBytes(val);
    }
    return total;
  }
  try {
    return new Blob([JSON.stringify(value)]).size;
  } catch {
    try {
      return new Blob([String(value)]).size;
    } catch {
      return 0;
    }
  }
}

/**
 * 遍历本库全部 object store，累加 JSON 序列化体积，作为「整库」量级参考。
 */
async function estimateDbBytes() {
  if (!_db) return 0;
  const names = [..._db.objectStoreNames];
  if (!names.length) return 0;
  return new Promise((resolve, reject) => {
    let total = 0;
    const tx = _db.transaction(names, 'readonly');
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('aborted'));
    let pending = names.length;
    const doneOne = () => {
      pending -= 1;
      if (pending === 0) resolve(total);
    };
    for (const name of names) {
      const store = tx.objectStore(name);
      const req = store.openCursor();
      req.onsuccess = () => {
        const cur = req.result;
        if (cur) {
          total += approxSerializedBytes(cur.value);
          cur.continue();
        } else {
          doneOne();
        }
      };
      req.onerror = () => reject(req.error);
    }
  });
}

async function getAllRecordsRaw() {
  const r = await dbRecordsRun('readonly', s => s.getAll());
  return Array.isArray(r) ? r : [];
}

async function getRecordById(id) {
  if (!id) return null;
  const r = await dbRecordsRun('readonly', s => s.get(id));
  return r || null;
}

async function kvGet(key) {
  if (!_db) return null;
  try {
    const row = await dbKvRun('readonly', s => s.get(key));
    return row && Object.prototype.hasOwnProperty.call(row, 'value') ? row.value : null;
  } catch {
    return null;
  }
}

async function kvSet(key, value) {
  if (!_db) throw new Error('no db');
  await dbKvRun('readwrite', s => s.put({ key, value: value == null ? '' : String(value) }));
}

async function kvRemove(key) {
  if (!_db) return;
  try { await dbKvRun('readwrite', s => s.delete(key)); } catch (_) { /* ignore */ }
}

async function hydrateState(state, CHANNEL) {
  if (!_db) return;
  for (const ch of Object.values(CHANNEL)) {
    const v = await kvGet(ch.lsKey);
    if (v) state.keys[ch.id] = v;
  }
  if (!state.keys.openai) {
    const oldCndKey = await kvGet('cnd_ai_cnd_key');
    if (oldCndKey) state.keys.openai = oldCndKey;
  }

  const uRaw = await kvGet(KV_USAGE_STATS);
  try {
    const o = uRaw ? JSON.parse(uRaw) : {};
    state.usageStats = {
      input:  Number(o.input)  || 0,
      output: Number(o.output) || 0,
      total:  Number(o.total)  || 0,
    };
  } catch {
    state.usageStats = { input: 0, output: 0, total: 0 };
  }
}

async function getRecordsWithCursor({ maxRecords = 0, maxImages = 0 } = {}) {
  if (!_db) return [];
  return new Promise((resolve, reject) => {
    const tx = _db.transaction(DB_RECORDS_STORE, 'readonly');
    const store = tx.objectStore(DB_RECORDS_STORE);
    if (!store.indexNames.contains('ts')) {
      reject(new Error('missing ts index'));
      return;
    }
    const req = store.index('ts').openCursor(null, 'prev');
    const rows = [];
    let totalImages = 0;

    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) {
        resolve(rows);
        return;
      }
      const rec = cur.value;
      rows.push(rec);
      totalImages += Array.isArray(rec.images) ? rec.images.length : 0;

      const hitRecordCap = maxRecords > 0 && rows.length >= maxRecords;
      const hitImageCap = maxImages > 0 && totalImages >= maxImages;
      if (hitRecordCap || hitImageCap) {
        resolve(rows);
        return;
      }
      cur.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

async function getRecordsSorted(limit = 0) {
  if (!_db) return [];
  try {
    if (limit > 0) {
      return await getRecordsWithCursor({ maxRecords: limit });
    }
    return await getRecordsWithCursor();
  } catch {
    try {
      const all = await getAllRecordsRaw();
      if (!all || !all.length) return [];
      const sorted = all.slice().sort((a, b) => (b.ts || 0) - (a.ts || 0));
      return limit > 0 ? sorted.slice(0, limit) : sorted;
    } catch {
      return [];
    }
  }
}

async function getRecentRecordsByImageLimit(maxImages) {
  if (!_db) return [];
  const cap = Math.max(0, Number(maxImages) || 0);
  if (!cap) return [];
  try {
    return await getRecordsWithCursor({ maxImages: cap });
  } catch {
    try {
      const sorted = await getRecordsSorted();
      const picked = [];
      let totalImages = 0;
      for (const rec of sorted) {
        picked.push(rec);
        totalImages += Array.isArray(rec.images) ? rec.images.length : 0;
        if (totalImages >= cap) break;
      }
      return picked;
    } catch {
      return [];
    }
  }
}

export default {
  async init() {
    try {
      _db = await dbOpen();
    } catch (e) {
      console.warn('[IndexedDB]', e);
      _db = null;
    }
    return _db;
  },
  hasDb() {
    return !!_db;
  },
  hydrateState,
  saveTask,
  deleteTask,
  getAllTasks,
  getTaskById,
  putRecord,
  deleteRecordById,
  clearRecords,
  clearPendingTasks,
  putImageAsset,
  getImageAssetById,
  deleteImageAssetById,
  clearImageAssets,
  estimateDbBytes,
  getRecordsSorted,
  getRecentRecordsByImageLimit,
  getRecordById,
  kvGet,
  kvSet,
  kvRemove,
};

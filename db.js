// IndexedDB 轻量封装：notes（笔记）、outbox（离线待同步队列）、kv（设置）
const DB_NAME = 'offline-first-db';
const DB_VERSION = 1;

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('notes')) {
        db.createObjectStore('notes', { keyPath: 'id', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains('outbox')) {
        db.createObjectStore('outbox', { keyPath: 'id', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains('kv')) {
        db.createObjectStore('kv', { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('tx aborted'));
  });
}

function reqResult(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const db = {
  async addNote(note) {
    const d = await openDB();
    const tx = d.transaction('notes', 'readwrite');
    const id = await reqResult(tx.objectStore('notes').add(note));
    await txDone(tx);
    return id;
  },
  async allNotes() {
    const d = await openDB();
    const tx = d.transaction('notes', 'readonly');
    const list = await reqResult(tx.objectStore('notes').getAll());
    await txDone(tx);
    return list.sort((a, b) => b.createdAt - a.createdAt);
  },
  async deleteNote(id) {
    const d = await openDB();
    const tx = d.transaction('notes', 'readwrite');
    tx.objectStore('notes').delete(id);
    await txDone(tx);
  },

  async outboxAdd(item) {
    const d = await openDB();
    const tx = d.transaction('outbox', 'readwrite');
    const id = await reqResult(tx.objectStore('outbox').add(item));
    await txDone(tx);
    return id;
  },
  async outboxAll() {
    const d = await openDB();
    const tx = d.transaction('outbox', 'readonly');
    const list = await reqResult(tx.objectStore('outbox').getAll());
    await txDone(tx);
    return list;
  },
  async outboxRemove(id) {
    const d = await openDB();
    const tx = d.transaction('outbox', 'readwrite');
    tx.objectStore('outbox').delete(id);
    await txDone(tx);
  },

  async kvSet(key, value) {
    const d = await openDB();
    const tx = d.transaction('kv', 'readwrite');
    tx.objectStore('kv').put({ key, value });
    await txDone(tx);
  },
  async kvGet(key) {
    const d = await openDB();
    const tx = d.transaction('kv', 'readonly');
    const row = await reqResult(tx.objectStore('kv').get(key));
    await txDone(tx);
    return row ? row.value : undefined;
  },
};

// 统一捕获配额错误，向上抛出可识别的类型，页面层据此提示
function isQuotaError(err) {
  return (
    err &&
    (err.name === 'QuotaExceededError' ||
      err.name === 'NS_ERROR_DOM_QUOTA_REACHED')
  );
}

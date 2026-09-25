// IndexedDB 轻量封装，同时可在页面 (window) 与 Service Worker 中使用。
(function (global) {
  'use strict';

  var DB_NAME = 'offline-first-db';
  var DB_VERSION = 1;
  var OUTBOX_STORE = 'outbox'; // 离线待同步队列（后台同步模拟）
  var KV_STORE = 'kv';         // 多标签页共享的设置

  function openDB() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function (event) {
        var db = event.target.result;
        if (!db.objectStoreNames.contains(OUTBOX_STORE)) {
          db.createObjectStore(OUTBOX_STORE, { keyPath: 'id', autoIncrement: true });
        }
        if (!db.objectStoreNames.contains(KV_STORE)) {
          db.createObjectStore(KV_STORE, { keyPath: 'key' });
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function tx(db, store, mode, fn) {
    return new Promise(function (resolve, reject) {
      var t = db.transaction(store, mode);
      var result = fn(t.objectStore(store));
      t.oncomplete = function () { resolve(result && result._value !== undefined ? result._value : result); };
      t.onerror = function () { reject(t.error); };
      t.onabort = function () { reject(t.error || new Error('transaction aborted')); };
    });
  }

  function requestToPromise(req) {
    return new Promise(function (resolve, reject) {
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  var AppDB = {
    addToOutbox: function (item) {
      return openDB().then(function (db) {
        return tx(db, OUTBOX_STORE, 'readwrite', function (store) {
          return requestToPromise(store.add(Object.assign({ createdAt: Date.now() }, item)));
        });
      });
    },
    getOutbox: function () {
      return openDB().then(function (db) {
        return tx(db, OUTBOX_STORE, 'readonly', function (store) {
          return requestToPromise(store.getAll());
        });
      });
    },
    deleteOutboxItem: function (id) {
      return openDB().then(function (db) {
        return tx(db, OUTBOX_STORE, 'readwrite', function (store) {
          store.delete(id);
        });
      });
    },
    clearOutbox: function () {
      return openDB().then(function (db) {
        return tx(db, OUTBOX_STORE, 'readwrite', function (store) { store.clear(); });
      });
    },
    putKV: function (key, value) {
      return openDB().then(function (db) {
        return tx(db, KV_STORE, 'readwrite', function (store) {
          store.put({ key: key, value: value });
        });
      });
    },
    getKV: function (key) {
      return openDB().then(function (db) {
        return tx(db, KV_STORE, 'readonly', function (store) {
          return requestToPromise(store.get(key));
        });
      }).then(function (row) { return row ? row.value : undefined; });
    }
  };

  global.AppDB = AppDB;
})(self);

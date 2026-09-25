'use strict';

importScripts('./js/version.js', './js/db.js');

var VERSION = self.APP_VERSION;
var STATIC_CACHE = 'static-v' + VERSION;
var RUNTIME_CACHE = 'runtime-v' + VERSION;
var KNOWN_PREFIXES = ['static-v', 'runtime-v']; // 只清理自己管理的缓存，避免误删

var OFFLINE_URL = './offline.html';
var PRECACHE = [
  './',
  './index.html',
  './offline.html',
  './manifest.webmanifest',
  './css/styles.css',
  './js/version.js',
  './js/db.js',
  './js/app.js'
];

// 多标签页通知通道（SW 侧）。BroadcastChannel 不可用时退化为 clients.postMessage。
var channel = null;
try {
  if (typeof BroadcastChannel !== 'undefined') {
    channel = new BroadcastChannel('offline-app');
  }
} catch (e) { /* 忽略，走 postMessage 兜底 */ }

function notifyClients(message) {
  if (channel) {
    try { channel.postMessage(message); } catch (e) { /* noop */ }
  }
  self.clients.matchAll({ includeUncontrolled: true }).then(function (clients) {
    clients.forEach(function (client) { client.postMessage(message); });
  });
}

function isQuotaError(err) {
  return err && (err.name === 'QuotaExceededError' || err.code === 22);
}

// 预缓存：逐个写入，单个资源失败不拖垮整个 install；配额不足时通知页面。
function precache() {
  return caches.open(STATIC_CACHE).then(function (cache) {
    return Promise.all(PRECACHE.map(function (url) {
      return cache.add(url).catch(function (err) {
        if (isQuotaError(err)) {
          notifyClients({ type: 'QUOTA_EXCEEDED', payload: { url: url } });
        }
        // 离线兜底页必须存在，其它资源允许失败（安装仍可完成）
        if (url === OFFLINE_URL || url === './index.html' || url === './') {
          throw err;
        }
        console.warn('[SW] 预缓存失败，已跳过:', url, err);
      });
    }));
  });
}

self.addEventListener('install', function (event) {
  console.log('[SW] install v' + VERSION);
  event.waitUntil(precache());
  // 注意：不自动 skipWaiting，等待页面确认（用户点击“立即更新”），
  // 避免多标签页场景下正在使用的页面被强行切换 SW。
});

self.addEventListener('activate', function (event) {
  console.log('[SW] activate v' + VERSION);
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (key) {
        var isOurs = KNOWN_PREFIXES.some(function (p) { return key.indexOf(p) === 0; });
        var isCurrent = key === STATIC_CACHE || key === RUNTIME_CACHE;
        if (isOurs && !isCurrent) {
          console.log('[SW] 清理旧缓存:', key);
          return caches.delete(key);
        }
      }));
    }).then(function () {
      return self.clients.claim();
    }).then(function () {
      notifyClients({ type: 'SW_ACTIVATED', payload: { version: VERSION } });
    })
  );
});

function isCacheableRequest(request) {
  if (request.method !== 'GET') return false;                 // 不拦截写请求
  var url = new URL(request.url);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false; // 跳过 chrome-extension: 等
  if (url.origin !== self.location.origin) return false;      // 不缓存跨域请求
  if (url.searchParams.has('nocache')) return false;          // 显式绕过
  return true;
}

// 导航请求：网络优先 → 缓存 → 离线降级页
function handleNavigation(request) {
  return fetch(request).then(function (response) {
    if (response && response.ok) {
      var copy = response.clone();
      caches.open(RUNTIME_CACHE).then(function (cache) {
        cache.put('./index.html', copy).catch(function () {});
      });
    }
    return response;
  }).catch(function () {
    return caches.match(request).then(function (cached) {
      if (cached) return cached;
      return caches.match('./index.html').then(function (shell) {
        // 应用外壳也没有（首次访问即离线）→ 降级页
        return shell || caches.match(OFFLINE_URL);
      });
    });
  });
}

// 静态资源：缓存优先 → 网络（写入运行时缓存，配额失败静默降级）→ 离线占位
function handleStatic(request) {
  return caches.match(request).then(function (cached) {
    if (cached) return cached;
    return fetch(request).then(function (response) {
      if (response && response.ok && response.type === 'basic') {
        var copy = response.clone();
        caches.open(RUNTIME_CACHE).then(function (cache) {
          cache.put(request, copy).catch(function (err) {
            if (isQuotaError(err)) {
              notifyClients({ type: 'QUOTA_EXCEEDED', payload: { url: request.url } });
            }
          });
        });
      }
      return response;
    }).catch(function () {
      // 离线且资源缺失：图片给占位响应，其它给 503 JSON
      if (request.destination === 'image') {
        return new Response(
          '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180">' +
          '<rect width="100%" height="100%" fill="#e2e8f0"/>' +
          '<text x="50%" y="50%" text-anchor="middle" fill="#64748b" font-size="14">离线 - 图片不可用</text></svg>',
          { headers: { 'Content-Type': 'image/svg+xml' } }
        );
      }
      return new Response(
        JSON.stringify({ error: 'offline', message: '资源未缓存且当前离线' }),
        { status: 503, headers: { 'Content-Type': 'application/json' } }
      );
    });
  });
}

self.addEventListener('fetch', function (event) {
  var request = event.request;
  if (!isCacheableRequest(request)) return; // 不污染正常请求：非 GET / 跨域 / 特殊协议直接放行

  if (request.mode === 'navigate') {
    event.respondWith(handleNavigation(request));
    return;
  }
  event.respondWith(handleStatic(request));
});

// 后台同步模拟：处理 IndexedDB outbox 队列。
// 真实 Background Sync API 仅 Chromium 支持，这里用 message + online 事件模拟，跨浏览器一致。
function processOutbox() {
  return self.AppDB.getOutbox().then(function (items) {
    if (!items.length) return { synced: 0 };
    // 模拟逐条“发送到服务器”（真实场景替换为 fetch('/api/...')）
    return items.reduce(function (chain, item) {
      return chain.then(function (count) {
        return new Promise(function (resolve) { setTimeout(resolve, 300); })
          .then(function () { return self.AppDB.deleteOutboxItem(item.id); })
          .then(function () {
            notifyClients({ type: 'SYNC_ITEM_DONE', payload: { id: item.id } });
            return count + 1;
          });
      });
    }, Promise.resolve(0)).then(function (count) { return { synced: count }; });
  }).then(function (result) {
    notifyClients({ type: 'SYNC_COMPLETE', payload: result });
    return result;
  });
}

self.addEventListener('message', function (event) {
  var data = event.data || {};
  switch (data.type) {
    case 'SKIP_WAITING':
      self.skipWaiting();
      break;
    case 'GET_VERSION':
      event.source && event.source.postMessage({ type: 'VERSION', payload: { version: VERSION } });
      break;
    case 'SYNC_QUEUE':
      event.waitUntil ? event.waitUntil(processOutbox()) : processOutbox();
      break;
    case 'CLEAR_CACHES':
      event.waitUntil(
        caches.keys().then(function (keys) {
          return Promise.all(keys.map(function (k) {
            if (KNOWN_PREFIXES.some(function (p) { return k.indexOf(p) === 0; })) {
              return caches.delete(k);
            }
          }));
        }).then(function () { return precache(); })
          .then(function () { notifyClients({ type: 'CACHES_RESET' }); })
      );
      break;
  }
});

// 真实 Background Sync（支持的浏览器上作为增强，不依赖）
self.addEventListener('sync', function (event) {
  if (event.tag === 'outbox-sync') {
    event.waitUntil(processOutbox());
  }
});

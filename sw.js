/* global APP_VERSION */
importScripts('./version.js');

const VERSION = APP_VERSION;
const STATIC_CACHE = `static-v${VERSION}`;
const RUNTIME_CACHE = `runtime-v${VERSION}`;
const CURRENT_CACHES = [STATIC_CACHE, RUNTIME_CACHE];
const OFFLINE_URL = './offline.html';

// 预缓存清单：应用外壳（App Shell）
const PRECACHE_URLS = [
  './',
  './index.html',
  './offline.html',
  './styles.css',
  './app.js',
  './db.js',
  './version.js',
  './manifest.webmanifest',
];

// ---------- install：预缓存，逐条容错（单个资源失败不阻塞安装） ----------
self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(STATIC_CACHE);
      await Promise.all(
        PRECACHE_URLS.map(async (url) => {
          try {
            const res = await fetch(url, { cache: 'reload' });
            if (res.ok) await cache.put(url, res);
          } catch (err) {
            // 离线安装或单文件缺失时忽略，保证 SW 能装上
            console.warn('[SW] precache failed:', url, err);
          }
        })
      );
      // 注意：不自动 skipWaiting，等待页面确认（见 message 事件），
      // 避免多标签页场景下被强行接管导致状态不一致。
    })()
  );
});

// ---------- activate：清理旧版本缓存（解决旧缓存残留 / 版本冲突） ----------
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => !CURRENT_CACHES.includes(key))
          .map((key) => {
            console.log('[SW] delete stale cache:', key);
            return caches.delete(key);
          })
      );
      await self.clients.claim();
      // 通知所有客户端当前版本，便于页面校验 SW 与页面版本是否一致
      const clients = await self.clients.matchAll({ type: 'window' });
      clients.forEach((client) =>
        client.postMessage({ type: 'SW_ACTIVATED', version: VERSION })
      );
    })()
  );
});

// ---------- fetch：分层策略，且绝不污染正常请求 ----------
self.addEventListener('fetch', (event) => {
  const { request } = event;

  // 只处理 GET；非 http(s)（如 chrome-extension://）直接放行
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (!url.protocol.startsWith('http')) return;

  // API 请求：network-only，绝不进缓存 -> “缓存不污染正常请求”
  if (url.pathname.startsWith('/api/')) return;

  // 显式绕过：?no-sw=1
  if (url.searchParams.has('no-sw')) return;

  // 跨域请求：network-first，失败才回退缓存，且不写缓存
  if (url.origin !== self.location.origin) {
    event.respondWith(fetch(request).catch(() => caches.match(request)));
    return;
  }

  // 页面导航：network-first（带超时），离线回退缓存，缺失回退离线页
  if (request.mode === 'navigate') {
    event.respondWith(handleNavigation(request));
    return;
  }

  // 同源静态资源：cache-first，网络命中后写入运行时缓存（带配额保护）
  event.respondWith(handleStatic(request));
});

async function handleNavigation(request) {
  try {
    const res = await timeoutFetch(request, 3000);
    if (res.ok) {
      const cache = await caches.open(RUNTIME_CACHE);
      safePut(cache, request, res.clone());
    }
    return res;
  } catch (err) {
    const cached = await caches.match(request, { ignoreSearch: true });
    if (cached) return cached;
    const offline = await caches.match(OFFLINE_URL);
    if (offline) return offline;
    return new Response('Offline', { status: 503, statusText: 'Offline' });
  }
}

async function handleStatic(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const res = await fetch(request);
    if (res.ok && res.status === 200) {
      const cache = await caches.open(RUNTIME_CACHE);
      safePut(cache, request, res.clone());
    }
    return res;
  } catch (err) {
    // 离线且资源缺失 -> 按类型降级
    if (request.destination === 'image') return placeholderImage();
    if (request.destination === 'document') {
      const offline = await caches.match(OFFLINE_URL);
      if (offline) return offline;
    }
    return new Response('', {
      status: 503,
      statusText: 'Offline: resource not cached',
    });
  }
}

function timeoutFetch(request, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('network timeout')), ms);
    fetch(request).then(
      (res) => { clearTimeout(timer); resolve(res); },
      (err) => { clearTimeout(timer); reject(err); }
    );
  });
}

// 配额不足时静默失败并通知页面，绝不让缓存写入拖垮正常请求
async function safePut(cache, request, response) {
  try {
    await cache.put(request, response);
  } catch (err) {
    console.warn('[SW] cache.put failed (quota?):', err && err.name);
    const clients = await self.clients.matchAll({ type: 'window' });
    clients.forEach((client) =>
      client.postMessage({ type: 'CACHE_QUOTA_EXCEEDED' })
    );
  }
}

function placeholderImage() {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180">' +
    '<rect width="100%" height="100%" fill="#e2e8f0"/>' +
    '<text x="50%" y="50%" text-anchor="middle" fill="#64748b" ' +
    'font-family="sans-serif" font-size="14">offline - image unavailable</text></svg>';
  return new Response(svg, { headers: { 'Content-Type': 'image/svg+xml' } });
}

// ---------- message：页面控制 SW 生命周期 ----------
self.addEventListener('message', (event) => {
  const data = event.data || {};
  switch (data.type) {
    case 'SKIP_WAITING':
      self.skipWaiting();
      break;
    case 'GET_VERSION':
      if (event.source) {
        event.source.postMessage({ type: 'VERSION', version: VERSION });
      }
      break;
    case 'CLEAN_CACHES':
      // 手动清理：删除所有非当前版本缓存（旧缓存残留的兜底手段）
      event.waitUntil(
        caches.keys().then((keys) =>
          Promise.all(
            keys
              .filter((k) => !CURRENT_CACHES.includes(k))
              .map((k) => caches.delete(k))
          )
        )
      );
      break;
  }
});

// ---------- 后台同步（SyncManager 可用时；否则页面端降级为 online 事件） ----------
self.addEventListener('sync', (event) => {
  if (event.tag === 'sync-outbox') {
    event.waitUntil(notifyClientsToFlush());
  }
});

async function notifyClientsToFlush() {
  const clients = await self.clients.matchAll({
    type: 'window',
    includeUncontrolled: true,
  });
  clients.forEach((client) => client.postMessage({ type: 'FLUSH_OUTBOX' }));
}

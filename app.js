/* global db, isQuotaError, APP_VERSION */

// ================= 兼容性检测 =================
const compat = {
  serviceWorker: 'serviceWorker' in navigator,
  cacheAPI: 'caches' in window,
  indexedDB: 'indexedDB' in window,
  broadcastChannel: 'BroadcastChannel' in window,
  syncManager: 'serviceWorker' in navigator && 'SyncManager' in window,
  storageEstimate: !!(navigator.storage && navigator.storage.estimate),
};

const TAB_ID = `tab-${Math.random().toString(36).slice(2, 8)}`;
const $ = (sel) => document.querySelector(sel);

// ================= Toast 提示 =================
function toast(message, kind = 'info', duration = 4000) {
  const box = $('#toasts');
  const el = document.createElement('div');
  el.className = `toast toast-${kind}`;
  el.textContent = message;
  box.appendChild(el);
  setTimeout(() => el.remove(), duration);
}

// ================= Service Worker 注册与更新流程 =================
let swRegistration = null;
let refreshing = false; // 防止 controllerchange 导致的重复刷新

async function registerSW() {
  if (!compat.serviceWorker) {
    toast('当前浏览器不支持 Service Worker，离线能力不可用', 'warn', 8000);
    $('#compat-warning').hidden = false;
    return;
  }
  try {
    swRegistration = await navigator.serviceWorker.register('./sw.js');
  } catch (err) {
    toast(`SW 注册失败：${err.message}`, 'error', 8000);
    return;
  }

  // 已存在等待中的 SW（例如另一标签页已触发更新）
  if (swRegistration.waiting) showUpdateBanner();

  swRegistration.addEventListener('updatefound', () => {
    const newWorker = swRegistration.installing;
    if (!newWorker) return;
    setSwStatus('installing');
    newWorker.addEventListener('statechange', () => {
      setSwStatus(newWorker.state);
      // 有旧 controller 说明是“升级”而非首装 -> 提示用户刷新
      if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
        showUpdateBanner();
      }
    });
  });

  // 新 SW 接管 -> 刷新页面拿到新版本资源（只刷一次）
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (refreshing) return;
    refreshing = true;
    toast('新版本已激活，正在刷新…', 'info', 1500);
    setTimeout(() => window.location.reload(), 300);
  });

  // 来自 SW 的消息
  navigator.serviceWorker.addEventListener('message', (event) => {
    const data = event.data || {};
    if (data.type === 'FLUSH_OUTBOX') flushOutbox('sw-sync');
    if (data.type === 'CACHE_QUOTA_EXCEEDED') {
      toast('缓存写入失败：存储配额不足，请清理站点数据', 'error', 8000);
    }
    if (data.type === 'SW_ACTIVATED') {
      setSwStatus(`activated (v${data.version})`);
    }
  });

  // 周期检查更新（也可手动点“检查更新”）
  setInterval(() => swRegistration.update(), 60 * 1000);
}

function setSwStatus(text) {
  $('#sw-status').textContent = text;
}

function showUpdateBanner() {
  $('#update-banner').hidden = false;
}

async function applyUpdate() {
  if (swRegistration && swRegistration.waiting) {
    // 通知等待中的 SW 跳过等待 -> 触发 controllerchange -> 页面刷新
    swRegistration.waiting.postMessage({ type: 'SKIP_WAITING' });
  }
}

// ================= 多标签页同步（BroadcastChannel + localStorage 降级） =================
const bus = createBus('offline-first-bus');
const knownTabs = new Map(); // tabId -> lastSeen

function createBus(name) {
  if (compat.broadcastChannel) {
    const channel = new BroadcastChannel(name);
    return {
      post: (msg) => channel.postMessage(msg),
      onMessage: (fn) => (channel.onmessage = (e) => fn(e.data)),
    };
  }
  // 降级：localStorage + storage 事件（Safari 旧版本等）
  return {
    post: (msg) =>
      localStorage.setItem(`${name}:msg`, JSON.stringify({ ...msg, _t: Date.now() })),
    onMessage: (fn) =>
      window.addEventListener('storage', (e) => {
        if (e.key === `${name}:msg` && e.newValue) {
          try { fn(JSON.parse(e.newValue)); } catch (_) { /* ignore */ }
        }
      }),
  };
}

function setupBus() {
  bus.onMessage((msg) => {
    if (!msg || msg.from === TAB_ID) return;
    switch (msg.type) {
      case 'tab-join':
        knownTabs.set(msg.from, Date.now());
        bus.post({ type: 'tab-ack', from: TAB_ID });
        renderTabs();
        break;
      case 'tab-ack':
        knownTabs.set(msg.from, Date.now());
        renderTabs();
        break;
      case 'tab-leave':
        knownTabs.delete(msg.from);
        renderTabs();
        break;
      case 'settings-changed':
        applySettings(msg.value, /* broadcast = */ false);
        toast('设置已从其他标签页同步', 'info', 2000);
        break;
      case 'notes-changed':
        renderNotes();
        break;
    }
  });
  bus.post({ type: 'tab-join', from: TAB_ID });
  window.addEventListener('beforeunload', () =>
    bus.post({ type: 'tab-leave', from: TAB_ID })
  );
  // 心跳清理：10s 没消息的标签视为已关闭
  setInterval(() => {
    const now = Date.now();
    for (const [id, seen] of knownTabs) {
      if (now - seen > 10000) knownTabs.delete(id);
    }
    renderTabs();
  }, 5000);
  setInterval(() => bus.post({ type: 'tab-ack', from: TAB_ID }), 4000);
}

function renderTabs() {
  $('#tab-count').textContent = String(knownTabs.size + 1);
}

// ================= 设置（多标签“规则同步”示例：主题） =================
async function applySettings(settings, broadcast) {
  document.body.dataset.theme = settings.theme || 'light';
  $('#theme-toggle').checked = settings.theme === 'dark';
  try {
    await db.kvSet('settings', settings);
  } catch (err) {
    handleQuotaError(err);
  }
  if (broadcast) {
    bus.post({ type: 'settings-changed', from: TAB_ID, value: settings, ts: Date.now() });
  }
}

async function loadSettings() {
  let settings = { theme: 'light' };
  try {
    settings = (await db.kvGet('settings')) || settings;
  } catch (err) {
    console.warn('load settings failed', err);
  }
  applySettings(settings, false);
}

// ================= 笔记 + 离线发件箱（后台同步模拟） =================
async function addNote(text) {
  const note = { text, createdAt: Date.now(), synced: false };
  try {
    note.id = await db.addNote(note);
  } catch (err) {
    if (handleQuotaError(err)) return;
    throw err;
  }
  bus.post({ type: 'notes-changed', from: TAB_ID });
  await trySend(note);
  await renderNotes();
}

// 模拟服务器：在线则“发送成功”，离线则失败进入 outbox
function fakeSendToServer(note) {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      if (navigator.onLine) resolve({ ok: true });
      else reject(new Error('offline'));
    }, 300);
  });
}

async function trySend(note) {
  try {
    await fakeSendToServer(note);
    note.synced = true;
    const d = await db.allNotes();
    const stored = d.find((n) => n.id === note.id);
    if (stored) {
      await db.deleteNote(note.id);
      await db.addNote({ ...stored, synced: true });
    }
  } catch (err) {
    // 发送失败 -> 进入 outbox，等待后台同步
    try {
      await db.outboxAdd({ noteId: note.id, text: note.text, queuedAt: Date.now() });
      await registerBackgroundSync();
      toast('已离线保存，恢复网络后自动同步', 'info');
    } catch (e2) {
      handleQuotaError(e2);
    }
  }
}

async function registerBackgroundSync() {
  if (compat.syncManager && swRegistration) {
    try {
      await swRegistration.sync.register('sync-outbox');
      return;
    } catch (err) {
      console.warn('Background Sync 注册失败，降级为 online 事件', err);
    }
  }
  // 降级：依赖 online 事件（见下方监听）
}

async function flushOutbox(reason) {
  const items = await db.outboxAll();
  if (!items.length) return;
  let sent = 0;
  for (const item of items) {
    try {
      await fakeSendToServer(item);
      await db.outboxRemove(item.id);
      sent += 1;
    } catch (err) {
      break; // 仍然离线，保留剩余队列
    }
  }
  if (sent > 0) {
    toast(`后台同步（${reason}）：已发送 ${sent} 条离线数据`, 'success');
    bus.post({ type: 'notes-changed', from: TAB_ID });
  }
  await renderOutbox();
}

async function renderNotes() {
  const notes = await db.allNotes();
  const list = $('#notes');
  list.innerHTML = '';
  for (const note of notes) {
    const li = document.createElement('li');
    li.className = 'note';
    const time = new Date(note.createdAt).toLocaleString();
    li.innerHTML =
      `<span class="note-text"></span>` +
      `<span class="note-meta">${time} · ${note.synced ? '已同步' : '待同步'}</span>` +
      `<button class="note-del" data-id="${note.id}">删除</button>`;
    li.querySelector('.note-text').textContent = note.text;
    list.appendChild(li);
  }
  await renderOutbox();
}

async function renderOutbox() {
  const items = await db.outboxAll();
  $('#outbox-count').textContent = String(items.length);
}

// ================= 配额与存储 =================
function handleQuotaError(err) {
  if (isQuotaError(err)) {
    toast('存储配额不足：请删除部分数据或清理站点存储', 'error', 8000);
    return true;
  }
  return false;
}

async function renderStorageEstimate() {
  if (!compat.storageEstimate) {
    $('#storage-usage').textContent = '不支持估算';
    return;
  }
  try {
    const { usage = 0, quota = 0 } = await navigator.storage.estimate();
    const pct = quota ? Math.round((usage / quota) * 100) : 0;
    $('#storage-usage').textContent =
      `${formatBytes(usage)} / ${formatBytes(quota)} (${pct}%)`;
    if (pct > 90) toast('存储用量已超过 90%，请注意清理', 'warn', 6000);
  } catch (err) {
    $('#storage-usage').textContent = '估算失败';
  }
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// ================= 在线状态 =================
function renderOnlineStatus() {
  const online = navigator.onLine;
  const el = $('#net-status');
  el.textContent = online ? '在线' : '离线';
  el.className = online ? 'badge online' : 'badge offline';
}

// ================= 初始化 =================
async function init() {
  $('#app-version').textContent = `v${APP_VERSION}`;
  $('#tab-id').textContent = TAB_ID;

  renderOnlineStatus();
  window.addEventListener('online', () => {
    renderOnlineStatus();
    flushOutbox('online-event'); // Background Sync 的降级路径
  });
  window.addEventListener('offline', renderOnlineStatus);

  setupBus();
  await registerSW();
  await loadSettings();
  await renderNotes();
  await renderStorageEstimate();

  // 事件绑定
  $('#note-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('#note-input');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    await addNote(text);
    renderStorageEstimate();
  });

  $('#notes').addEventListener('click', async (e) => {
    const btn = e.target.closest('.note-del');
    if (!btn) return;
    await db.deleteNote(Number(btn.dataset.id));
    bus.post({ type: 'notes-changed', from: TAB_ID });
    await renderNotes();
  });

  $('#theme-toggle').addEventListener('change', (e) => {
    applySettings({ theme: e.target.checked ? 'dark' : 'light' }, true);
  });

  $('#update-btn').addEventListener('click', applyUpdate);
  $('#check-update-btn').addEventListener('click', async () => {
    if (swRegistration) {
      await swRegistration.update();
      toast('已检查更新', 'info', 1500);
    }
  });
  $('#flush-btn').addEventListener('click', () => flushOutbox('manual'));
  $('#clean-cache-btn').addEventListener('click', () => {
    if (navigator.serviceWorker.controller) {
      navigator.serviceWorker.controller.postMessage({ type: 'CLEAN_CACHES' });
      toast('已请求清理旧缓存', 'success');
    }
  });

  // 兼容性提示
  if (!compat.indexedDB) toast('不支持 IndexedDB，数据无法持久化', 'error', 8000);
  if (!compat.broadcastChannel) {
    toast('不支持 BroadcastChannel，多标签同步使用 localStorage 降级', 'warn', 6000);
  }
  if (!compat.syncManager) {
    toast('不支持 Background Sync，将使用 online 事件降级同步', 'info', 5000);
  }
}

document.addEventListener('DOMContentLoaded', init);

(function () {
  'use strict';

  // ---------- 兼容性检测 ----------
  var compat = {
    serviceWorker: 'serviceWorker' in navigator,
    cacheAPI: 'caches' in window,
    indexedDB: 'indexedDB' in window,
    broadcastChannel: 'BroadcastChannel' in window,
    storageEstimate: !!(navigator.storage && navigator.storage.estimate)
  };

  function $(sel) { return document.querySelector(sel); }

  function toast(message, kind) {
    var el = document.createElement('div');
    el.className = 'toast toast-' + (kind || 'info');
    el.textContent = message;
    $('#toasts').appendChild(el);
    setTimeout(function () { el.classList.add('show'); }, 10);
    setTimeout(function () {
      el.classList.remove('show');
      setTimeout(function () { el.remove(); }, 300);
    }, 4000);
  }

  function showCompatWarnings() {
    var missing = [];
    if (!compat.serviceWorker) missing.push('Service Worker');
    if (!compat.cacheAPI) missing.push('Cache API');
    if (!compat.indexedDB) missing.push('IndexedDB');
    if (missing.length) {
      var banner = $('#compat-banner');
      banner.hidden = false;
      banner.textContent = '当前浏览器不支持 ' + missing.join('、') +
        '，离线能力不可用。请使用最新版 Chrome / Edge / Firefox / Safari。';
    }
    if (!compat.broadcastChannel) {
      console.log('[App] BroadcastChannel 不可用，使用 localStorage 事件兜底多标签页通信');
    }
  }

  // ---------- 多标签页通信（BroadcastChannel + localStorage 兜底） ----------
  var bus = {
    channel: null,
    init: function (onMessage) {
      this.onMessage = onMessage;
      if (compat.broadcastChannel) {
        this.channel = new BroadcastChannel('offline-app');
        this.channel.onmessage = function (e) { onMessage(e.data); };
      } else {
        window.addEventListener('storage', function (e) {
          if (e.key !== 'offline-app-bus' || !e.newValue) return;
          try { onMessage(JSON.parse(e.newValue).msg); } catch (err) { /* noop */ }
        });
      }
    },
    post: function (message) {
      if (this.channel) {
        this.channel.postMessage(message);
      } else {
        try {
          // 附加 nonce 保证相同消息重复发送也能触发 storage 事件
          localStorage.setItem('offline-app-bus', JSON.stringify({ msg: message, nonce: Date.now() + Math.random() }));
        } catch (err) { /* 隐私模式下可能抛错，忽略 */ }
      }
    }
  };

  // ---------- 设置（多标签页同步的“规则”） ----------
  var settings = { theme: 'light', cacheEnabled: true };

  function applySettings(next) {
    settings = Object.assign(settings, next);
    document.documentElement.dataset.theme = settings.theme;
    $('#setting-theme').checked = settings.theme === 'dark';
    $('#setting-cache').checked = settings.cacheEnabled;
  }

  function persistAndBroadcast(patch) {
    applySettings(patch);
    if (compat.indexedDB) {
      AppDB.putKV('settings', settings).catch(function (err) {
        if (err && err.name === 'QuotaExceededError') toast('存储配额不足，设置未能持久化', 'error');
      });
    }
    bus.post({ type: 'SETTINGS_CHANGED', payload: settings });
  }

  // ---------- SW 注册与更新生命周期 ----------
  var refreshing = false;

  function promptUpdate(worker) {
    var banner = $('#update-banner');
    banner.hidden = false;
    $('#update-now').onclick = function () {
      banner.hidden = true;
      // 通知其它标签页：即将更新，收到 SW_ACTIVATED / controllerchange 后各自刷新
      bus.post({ type: 'SW_UPDATE_APPLIED' });
      worker.postMessage({ type: 'SKIP_WAITING' });
    };
    $('#update-later').onclick = function () { banner.hidden = true; };
  }

  function trackInstalling(worker) {
    worker.addEventListener('statechange', function () {
      if (worker.state === 'installed' && navigator.serviceWorker.controller) {
        // 已有旧 SW 控制页面 → 这是“更新”而非首次安装
        promptUpdate(worker);
      }
    });
  }

  function registerSW() {
    if (!compat.serviceWorker) return;
    navigator.serviceWorker.register('./sw.js').then(function (reg) {
      $('#sw-version').textContent = 'v' + self.APP_VERSION;

      if (reg.waiting && navigator.serviceWorker.controller) promptUpdate(reg.waiting);
      if (reg.installing) trackInstalling(reg.installing);

      reg.addEventListener('updatefound', function () {
        trackInstalling(reg.installing);
      });

      // 页面可见时检查更新（也可 reg.update() 定时轮询）
      document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'visible') reg.update().catch(function () {});
      });
    }).catch(function (err) {
      console.error('[App] SW 注册失败:', err);
      toast('Service Worker 注册失败：' + err.message, 'error');
    });

    // 新 SW 接管 → 刷新页面加载新版本资源（防重复刷新）
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (refreshing) return;
      refreshing = true;
      window.location.reload();
    });

    navigator.serviceWorker.addEventListener('message', function (event) {
      handleBusMessage(event.data);
    });
  }

  // ---------- 总线消息处理（来自其它标签页或 SW） ----------
  function handleBusMessage(msg) {
    if (!msg || !msg.type) return;
    switch (msg.type) {
      case 'SETTINGS_CHANGED':
        applySettings(msg.payload);
        toast('设置已从其它标签页同步', 'info');
        break;
      case 'SW_UPDATE_APPLIED':
        // 其它标签页已应用更新；本页若有等待中的 SW 也立即激活
        if (navigator.serviceWorker.controller) {
          navigator.serviceWorker.getRegistration().then(function (reg) {
            if (reg && reg.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' });
          });
        }
        break;
      case 'SW_ACTIVATED':
        console.log('[App] SW v' + msg.payload.version + ' 已激活，旧缓存已清理');
        break;
      case 'QUOTA_EXCEEDED':
        toast('存储配额不足，部分资源缓存失败。请清理站点数据。', 'error');
        break;
      case 'SYNC_ITEM_DONE':
        renderOutbox();
        break;
      case 'SYNC_COMPLETE':
        toast('后台同步完成，共同步 ' + msg.payload.synced + ' 条记录', 'success');
        renderOutbox();
        break;
      case 'CACHES_RESET':
        toast('缓存已重建', 'success');
        break;
    }
  }

  // ---------- 在线状态 + 后台同步模拟 ----------
  function updateOnlineStatus() {
    var online = navigator.onLine;
    var badge = $('#net-status');
    badge.textContent = online ? '在线' : '离线';
    badge.className = 'badge ' + (online ? 'badge-online' : 'badge-offline');
    return online;
  }

  function triggerSync() {
    if (!compat.serviceWorker) return;
    navigator.serviceWorker.ready.then(function (reg) {
      // 优先使用真实 Background Sync（Chromium），否则 postMessage 模拟
      if ('sync' in reg) {
        reg.sync.register('outbox-sync').catch(function () {
          reg.active && reg.active.postMessage({ type: 'SYNC_QUEUE' });
        });
      } else {
        reg.active && reg.active.postMessage({ type: 'SYNC_QUEUE' });
      }
    });
  }

  // ---------- 离线便签（写入 IndexedDB outbox，联网后同步） ----------
  function renderOutbox() {
    if (!compat.indexedDB) return;
    AppDB.getOutbox().then(function (items) {
      var list = $('#outbox-list');
      list.innerHTML = '';
      $('#outbox-count').textContent = items.length;
      items.slice().reverse().forEach(function (item) {
        var li = document.createElement('li');
        li.textContent = item.text;
        var time = document.createElement('time');
        time.textContent = new Date(item.createdAt).toLocaleTimeString();
        li.appendChild(time);
        list.appendChild(li);
      });
    }).catch(function () {});
  }

  function addNote(text) {
    if (!compat.indexedDB) {
      toast('IndexedDB 不可用，无法离线暂存', 'error');
      return;
    }
    AppDB.addToOutbox({ text: text }).then(function () {
      toast(navigator.onLine ? '已加入同步队列' : '已离线暂存，联网后自动同步', 'success');
      renderOutbox();
      if (navigator.onLine) triggerSync();
    }).catch(function (err) {
      if (err && err.name === 'QuotaExceededError') {
        toast('存储配额不足，无法保存。请清理数据后重试。', 'error');
      } else {
        toast('保存失败：' + err.message, 'error');
      }
    });
  }

  // ---------- 存储配额 ----------
  function refreshStorageEstimate() {
    if (!compat.storageEstimate) {
      $('#storage-info').textContent = '当前浏览器不支持 Storage Estimate API';
      return;
    }
    navigator.storage.estimate().then(function (est) {
      var usage = est.usage || 0;
      var quota = est.quota || 0;
      var pct = quota ? Math.min(100, (usage / quota) * 100) : 0;
      $('#storage-bar').style.width = pct.toFixed(1) + '%';
      $('#storage-bar').classList.toggle('danger', pct > 80);
      $('#storage-info').textContent =
        '已用 ' + (usage / 1048576).toFixed(2) + ' MB / 配额 ' +
        (quota / 1048576).toFixed(0) + ' MB（' + pct.toFixed(1) + '%）';
      if (pct > 90) toast('存储配额即将耗尽（>90%），建议清理数据', 'error');
    });
  }

  // ---------- 初始化 ----------
  function init() {
    showCompatWarnings();
    registerSW();
    bus.init(handleBusMessage);

    // 恢复共享设置
    if (compat.indexedDB) {
      AppDB.getKV('settings').then(function (saved) {
        if (saved) applySettings(saved);
      }).catch(function () {});
    }

    updateOnlineStatus();
    window.addEventListener('online', function () {
      updateOnlineStatus();
      toast('网络已恢复，开始后台同步', 'success');
      triggerSync();
    });
    window.addEventListener('offline', function () {
      updateOnlineStatus();
      toast('已进入离线模式，内容来自本地缓存', 'info');
    });

    $('#note-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var input = $('#note-input');
      var text = input.value.trim();
      if (!text) return;
      input.value = '';
      addNote(text);
    });

    $('#setting-theme').addEventListener('change', function (e) {
      persistAndBroadcast({ theme: e.target.checked ? 'dark' : 'light' });
    });
    $('#setting-cache').addEventListener('change', function (e) {
      persistAndBroadcast({ cacheEnabled: e.target.checked });
    });

    $('#btn-sync').addEventListener('click', triggerSync);
    $('#btn-reset-cache').addEventListener('click', function () {
      navigator.serviceWorker.ready.then(function (reg) {
        reg.active && reg.active.postMessage({ type: 'CLEAR_CACHES' });
      });
    });
    $('#btn-persist').addEventListener('click', function () {
      if (navigator.storage && navigator.storage.persist) {
        navigator.storage.persist().then(function (granted) {
          toast(granted ? '已获得持久化存储权限' : '持久化存储请求被拒绝', granted ? 'success' : 'info');
        });
      }
    });

    renderOutbox();
    refreshStorageEstimate();
    setInterval(refreshStorageEstimate, 30000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

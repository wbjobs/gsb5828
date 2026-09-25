# 离线优先网页应用（离线笔记）

技术栈：Service Worker + Cache API + IndexedDB + BroadcastChannel + postMessage。

## 运行

Service Worker 要求安全上下文（`localhost` 或 HTTPS）：

```bash
python3 -m http.server 8080
# 打开 http://localhost:8080
```

## 架构

| 文件 | 职责 |
| --- | --- |
| `version.js` | 单一版本来源，页面与 SW 共用（SW 用 `importScripts` 读取） |
| `sw.js` | SW 生命周期、版本化缓存、旧缓存清理、离线降级、后台同步事件 |
| `app.js` | SW 注册与更新流程、多标签同步、发件箱、配额处理、兼容性降级 |
| `db.js` | IndexedDB 封装：`notes` / `outbox` / `kv` 三个 store |
| `offline.html` | 离线降级页（导航请求离线且未缓存时返回） |

## 缓存策略（不污染正常请求）

- 仅拦截 `GET` + `http(s)`；`/api/` 一律 network-only 不进缓存；`?no-sw=1` 显式绕过。
- 导航请求：network-first（3s 超时）→ 缓存 → `offline.html`。
- 同源静态资源：cache-first，网络命中后写入 `runtime-v{版本}` 运行时缓存。
- 跨域请求：network-first，失败回退缓存，不写缓存。
- 离线缺失资源按类型降级：图片返回占位 SVG，文档返回离线页，其余返回 503。

## SW 生命周期与更新流程

1. `install`：逐条容错预缓存 App Shell；**不自动 `skipWaiting`**，避免多标签页被强行接管。
2. 页面发现 `waiting` 状态的新 SW → 显示更新横幅 → 用户点击「立即更新」→ `postMessage({type:'SKIP_WAITING'})`。
3. `activate`：删除所有非当前版本缓存（白名单机制）→ `clients.claim()` → 广播 `SW_ACTIVATED`。
4. 页面监听 `controllerchange`，带一次性守卫（`refreshing` 标志）刷新页面，防止刷新循环。

## 验收标准对照与测试方法

| 验收标准 | 测试方法 |
| --- | --- |
| 离线可访问 | DevTools → Network → Offline，刷新页面仍可用 |
| 版本升级后旧缓存被清理 | 修改 `version.js` 版本号 → 刷新 → 点「立即更新」→ Application → Cache Storage 中只剩 `static/runtime-v{新版本}` |
| 离线资源缺失有降级页面 | 离线状态下点击「打开未缓存页面」→ 显示 `offline.html` |
| SW 更新时页面正确刷新 | 改版本号后刷新，出现更新横幅，点击后页面自动刷新一次且版本号更新 |
| 多标签页规则同步 | 开两个标签页，切换深色模式，另一标签页实时同步；标签页计数实时变化 |
| 兼容主流浏览器 | 无 BroadcastChannel / SyncManager 时自动降级（localStorage 事件 / online 事件）并提示 |
| 配额不足有提示 | DevTools → Application → Storage 中模拟配额，或写满存储后保存笔记 → 出现配额提示 |
| 缓存不污染正常请求 | `/api/` 请求 network-only；非 GET、跨域、`?no-sw=1` 均不拦截 |

## 后台同步模拟

- 离线写笔记 → 进入 IndexedDB `outbox` → 尝试注册 `SyncManager` 的 `sync-outbox` 事件。
- 浏览器不支持 Background Sync 时降级为 `online` 事件触发；也可点「手动同步」。
- SW 收到 `sync` 事件后通过 `postMessage` 通知页面执行 `flushOutbox`。

## 多标签页同步

- `BroadcastChannel('offline-first-bus')`：设置（主题）变更、笔记变更、标签页在线计数。
- 不支持 BroadcastChannel 的浏览器降级为 `localStorage` + `storage` 事件。
- 心跳机制清理已关闭的标签页（4s 心跳，10s 超时）。

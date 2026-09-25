# 离线优先 Web 应用

一个离线优先（Offline-First）的演示应用，覆盖 Service Worker 全生命周期、版本化缓存、
离线降级、后台同步模拟、多标签页协同与存储配额处理。

## 运行

Service Worker 要求安全上下文（`localhost` 或 HTTPS），请通过本地服务器访问：

```bash
python3 -m http.server 8080
# 打开 http://localhost:8080
```

## 技术栈

- **Service Worker**（`sw.js`）：install / activate / fetch / message / sync 全生命周期
- **Cache API**：版本化缓存 `static-v{版本}` / `runtime-v{版本}`
- **IndexedDB**（`js/db.js`）：离线 outbox 队列 + 共享设置，页面与 SW 共用
- **BroadcastChannel**：多标签页消息总线（不可用时自动降级为 `localStorage` 事件）
- **postMessage**：页面 ↔ SW 双向通信（SKIP_WAITING / SYNC_QUEUE / QUOTA_EXCEEDED 等）

## 版本升级

只需修改 `js/version.js` 中的 `APP_VERSION`（如 `1.0.0` → `1.1.0`）：

1. `sw.js` importScripts 该文件，字节变化触发浏览器 SW 更新检查；
2. 新 SW 安装完成后进入 waiting，页面弹出更新横幅（不强制打断用户）；
3. 点击“立即更新”→ `SKIP_WAITING` → `controllerchange` → 页面自动刷新（防重复刷新）；
4. 新 SW `activate` 时删除所有非当前版本的自有缓存（只认 `static-v` / `runtime-v` 前缀，不误删他人缓存）。

## 验收标准对照

| 标准 | 实现 |
| --- | --- |
| 离线可访问 | 预缓存应用外壳；导航请求网络优先、缓存兜底 |
| 旧缓存清理 | `activate` 中按版本号清理旧缓存 |
| 离线资源缺失降级 | 导航 → `offline.html`；图片 → SVG 占位；其它 → 503 JSON |
| SW 更新页面刷新 | 更新横幅 → `SKIP_WAITING` → `controllerchange` 刷新一次 |
| 多标签页规则同步 | BroadcastChannel 同步设置；一个标签页应用更新会广播其它标签页 |
| 浏览器兼容性 | 特性检测 + 警告横幅；BroadcastChannel / Background Sync 均有降级 |
| 配额不足提示 | 捕获 `QuotaExceededError`（缓存与 IDB），toast 提示；`storage.estimate()` 用量条 |
| 缓存不污染正常请求 | 仅拦截同源 GET，跳过非 http(s)、跨域、`?nocache` 请求 |

## 手动验证建议

- **离线访问**：DevTools → Network → Offline，刷新页面仍可用；
- **缓存清理**：改版本号 → 更新 → DevTools → Application → Cache Storage 只剩新版本；
- **降级页**：离线访问未缓存的 URL（如 `/?nocache` 外的未知路径）显示 `offline.html`；
- **多标签页**：开两个标签页，切换深色模式，另一标签页实时同步；
- **后台同步**：离线提交便签 → 恢复网络 → 自动同步并弹出完成提示；
- **配额**：DevTools → Application → Storage 可模拟配额压力，观察提示。

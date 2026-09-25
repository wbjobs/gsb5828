// 单一版本来源：页面通过 <script> 引入，Service Worker 通过 importScripts 引入。
// 升级应用时只需修改这里的版本号，SW 字节变化会触发浏览器更新流程，
// 新 SW 激活后会按版本号清理旧缓存。
self.APP_VERSION = '1.0.0';

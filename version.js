// 单一版本来源：页面与 Service Worker 共用（SW 通过 importScripts 读取）。
// 升级版本号即可触发：新 SW 安装 -> 旧缓存清理 -> 页面刷新提示。
self.APP_VERSION = '1.0.0';

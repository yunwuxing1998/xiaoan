/* Service Worker — 小安知识库
 * 策略：
 *  - 核心文件（index/styles/app/data/manifest/icon）安装时预缓存
 *  - data.js 采用「网络优先、缓存兜底」：内容更新后手机能立刻拉到新版，离线也能看旧版
 *  - 图片/视频等媒体采用「缓存优先、网络回源」：加速重复访问，首次访问时顺手缓存
 * 版本号：内容/脚本更新时把 KB_VERSION 递增，即可让所有手机强制换用新缓存。
 * 核心文件（html/js/css/manifest）已改为「网络优先」，正常情况下无需手动升版本号，
 * 升版本号仅用于清掉历史遗留的旧缓存。
 */
const KB_VERSION = "kb-v19";
const CACHE = KB_VERSION;
const CORE = ["./", "./index.html", "./styles.css", "./app.js", "./data.js",
              "./manifest.json", "./icon-192.png", "./icon-512.png"];

self.addEventListener("install", function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) { return c.addAll(CORE); })
  );
  self.skipWaiting();
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys.filter(function (k) { return k !== CACHE; })
            .map(function (k) { return caches.delete(k); })
      );
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return;
  var url = new URL(req.url);
  if (url.origin !== location.origin) return;

  var isCore = /(\/index\.html|\/|\.html|\.js|\.css|\.json|\.png|\.svg)$/i.test(url.pathname) ||
                url.pathname.endsWith("/");
  var isMedia = url.pathname.indexOf("assets/") !== -1 &&
                /\.(mp4|webm|jpg|jpeg|png|gif|svg|webp)$/i.test(url.pathname);

  // 核心文件（HTML/JS/CSS/JSON/图标）一律「网络优先」，保证脚本/样式更新即时生效；
  // 离线时回退缓存。媒体（视频/图片）仍为「缓存优先」，加速重复访问。
  // 用 cache:'no-cache' 强制每次都向服务器校验，绝不使用浏览器本地的过期副本。
  if (isCore && !isMedia) {
    e.respondWith(
      fetch(req, { cache: "no-cache" }).then(function (res) {
        if (res && res.status === 200) {
          var clone = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, clone); });
        }
        return res;
      }).catch(function () {
        return caches.match(req).then(function (hit) {
          return hit || caches.match("./index.html");
        });
      })
    );
    return;
  }

  // 媒体（视频/图片）：缓存优先，命中直接返回，否则网络拉取并缓存
  e.respondWith(
    caches.match(req).then(function (hit) {
      if (hit) return hit;
      return fetch(req).then(function (res) {
        if (res && res.status === 200) {
          var clone = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, clone); });
        }
        return res;
      }).catch(function () {
        if (req.mode === "navigate") return caches.match("./index.html");
        return new Response("", { status: 503 });
      });
    })
  );
});

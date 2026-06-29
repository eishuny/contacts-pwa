// アプリ本体だけをオフラインキャッシュ（API応答はキャッシュしない）
const CACHE = "contacts-pwa-v2";
const ASSETS = ["./", "./index.html", "./styles.css", "./app.js", "./config.js", "./manifest.json"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) =>
    Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // Google API / 認証はネットワークのみ
  if (url.hostname.includes("googleapis.com") || url.hostname.includes("google.com")) return;
  // アプリ資産はネットワーク優先（更新を常に取得）。オフライン時のみキャッシュにフォールバック。
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});

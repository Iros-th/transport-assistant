/* Service worker: cache-first app shell, network-first API (cached GETs, then a
 * clear 503 offline JSON). Bump VERSION to invalidate old caches on deploy. */
var VERSION = "v5";
var SHELL = "transit-shell-" + VERSION;
var API = "transit-api-" + VERSION;
var SHELL_FILES = [
  "./", "index.html", "styles.css", "api.js", "app.js",
  "pwa.js", "manifest.webmanifest",
  "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png"
];

self.addEventListener("install", function (e) {
  e.waitUntil(caches.open(SHELL).then(function (c) { return c.addAll(SHELL_FILES); })
    .then(function () { return self.skipWaiting(); }));
});

self.addEventListener("activate", function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== SHELL && k !== API; })
      .map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

function isApi(url) { return /\/api\//.test(url.pathname) || /\/demo\//.test(url.pathname); }

self.addEventListener("fetch", function (e) {
  var req = e.request;
  var url = new URL(req.url);
  if (url.origin !== location.origin) return;

  if (isApi(url)) {
    // Non-GET (POST /demo/plan) is left to the page, which falls back to its
    // in-browser demo engine when the network is down.
    if (req.method !== "GET") return;
    e.respondWith(fetch(req).then(function (res) {
      var copy = res.clone();
      if (res.ok) caches.open(API).then(function (c) { c.put(req, copy); });
      return res;
    }).catch(function () {
      return caches.match(req).then(function (hit) {
        return hit || new Response(JSON.stringify({ detail: "offline" }),
          { status: 503, headers: { "Content-Type": "application/json", "X-Offline": "1" } });
      });
    }));
    return;
  }

  if (req.method !== "GET") return;
  if (req.mode === "navigate") {
    e.respondWith(fetch(req).catch(function () { return caches.match("index.html"); }));
    return;
  }
  // Network-first for the app shell: a deploy is visible on the next load, and the cache is only the
  // offline fallback. (Cache-first under a never-bumped VERSION served a stale app.js after redesigns.)
  e.respondWith(fetch(req).then(function (res) {
    var copy = res.clone();
    if (res.ok) caches.open(SHELL).then(function (c) { c.put(req, copy); });
    return res;
  }).catch(function () { return caches.match(req); }));
});

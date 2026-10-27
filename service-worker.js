const CACHE = 'mchs-search-v31';

const ASSETS = [
  './',
  './main.html',
  './design.css',
  './logic.js',
  './ui-sheet.js',
  './tsp.worker.js',
  './manifest.json',
  './fonts/inter-cyrillic-wght-normal.woff2',
  './fonts/inter-latin-wght-normal.woff2',
  './icons/icon-192.png',
  './icons/icon-512.png',

  './vendor/leaflet/leaflet.js',
  './vendor/leaflet/leaflet.css',
  './vendor/leaflet/images/marker-icon.png',
  './vendor/leaflet/images/marker-shadow.png',
  './vendor/turf.min.js',
  './vendor/qrcode.min.js',
  './vendor/jsqr.min.js'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) {

      return Promise.all(ASSETS.map(function (u) {
        return c.add(new Request(u, { mode: 'no-cors' })).catch(function () { });
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        return k === CACHE ? null : caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

function skipCache(url) {
  return url.hostname.indexOf('openstreetmap') !== -1 ||
         url.hostname.indexOf('overpass') !== -1 ||
         url.hostname.indexOf('mail.ru') !== -1 ||
         url.hostname.indexOf('tile.') === 0;
}

self.addEventListener('fetch', function (e) {
  if (e.request.method !== 'GET') return;
  var url = new URL(e.request.url);
  if (skipCache(url)) return;

  var sameOrigin = url.origin === self.location.origin;

  // Свой домен: сначала сеть, чтобы обновление приложения было видно сразу.
  // Это убирает баг «старая версия из кэша». Офлайн — кэш (точный → без ?v →
  // запасной main.html).
  if (sameOrigin) {
    e.respondWith(
      fetch(e.request).then(function (resp) {
        if (resp && resp.status === 200) {
          var copy = resp.clone();
          caches.open(CACHE).then(function (c) { c.put(e.request, copy); }).catch(function () { });
        }
        return resp;
      }).catch(function () {
        return caches.match(e.request).then(function (hit) {
          return hit || caches.match(url.origin + url.pathname) || caches.match('./main.html');
        });
      })
    );
    return;
  }

  // Чужой домен (не тайлы): кэш → сеть, как было.
  e.respondWith(
    caches.match(e.request).then(function (hit) {
      if (hit) return hit;
      return fetch(e.request).then(function (resp) {
        if (resp && (resp.status === 200 || resp.type === 'opaque')) {
          var copy = resp.clone();
          caches.open(CACHE).then(function (c) { c.put(e.request, copy); }).catch(function () { });
        }
        return resp;
      }).catch(function () {
        return caches.match('./main.html');
      });
    })
  );
});

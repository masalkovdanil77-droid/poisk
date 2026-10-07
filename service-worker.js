const CACHE = 'mchs-search-v21';

const ASSETS = [
  './',
  './main.html',
  './design.css',
  './logic.js',
  './ui-sheet.js',
  './tsp.worker.js',
  './manifest.json',
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

  e.respondWith(
    caches.match(e.request).then(function (hit) {
      if (hit) return hit;

      var sameOrigin = url.origin === self.location.origin;
      var bare = sameOrigin ? caches.match(url.origin + url.pathname) : Promise.resolve(null);
      return bare.then(function (bareHit) {
        if (bareHit) return bareHit;
        return fetch(e.request).then(function (resp) {
          if (resp && (resp.status === 200 || resp.type === 'opaque')) {
            var copy = resp.clone();
            caches.open(CACHE).then(function (c) { c.put(e.request, copy); }).catch(function () { });
          }
          return resp;
        }).catch(function () {

          return caches.match('./main.html');
        });
      });
    })
  );
});

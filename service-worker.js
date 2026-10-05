/* Service Worker приложения «Поиск людей в лесу».
   Задача: после первого открытия приложение работает БЕЗ интернета
   (кэшируются сам сайт и библиотеки Leaflet/Turf).

   ВАЖНО: тайлы карты OpenStreetMap НЕ кэшируются — правилами OSM
   запрещена предварительная загрузка тайлов и офлайн-использование.
   Поэтому без интернета карта будет пустой, но программа, маршрут,
   точки и навигатор (GPS) продолжат работать. */

const CACHE = 'mchs-search-v17';

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
  // библиотеки лежат рядом с приложением — внешние CDN не нужны
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
      // каждый файл кэшируем отдельно: если один недоступен, остальные всё равно сохранятся
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

/* Запросы, которые НЕ кэшируем: данные OSM (нужна свежесть) и тайлы карты. */
function skipCache(url) {
  return url.hostname.indexOf('openstreetmap') !== -1 ||
         url.hostname.indexOf('overpass') !== -1 ||
         url.hostname.indexOf('mail.ru') !== -1 ||
         url.hostname.indexOf('tile.') === 0;
}

self.addEventListener('fetch', function (e) {
  if (e.request.method !== 'GET') return;
  var url = new URL(e.request.url);
  if (skipCache(url)) return; // идём напрямую в сеть

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
        // нет сети: отдаём сохранённую страницу приложения
        return caches.match('./main.html');
      });
    })
  );
});

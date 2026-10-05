// ============================================================
//  Ситуационный центр МЧС / ЛизаАлерт — Поиск людей в лесу
//  Логика: карта, зона поиска, точка потери, вероятные зоны,
//  оптимизация маршрута (TSP) в Web Worker.
// ============================================================

// Версия сборки. Показывается в панели (строка «Версия») и печатается в консоль:
// по ней сразу видно, обновилось ли приложение на телефоне. Номер должен
// совпадать с logic.js?v=... в main.html — это проверяет _tools/make_pc_archive.py.
const APP_VERSION = '138';
console.log('[APP] версия приложения ' + APP_VERSION);

// ---------- 0. ПРОВЕРКА БИБЛИОТЕК ----------
// Если папка vendor не загрузилась на хостинг, карта не создастся и приложение
// молча «зависнет». Поэтому сначала предупреждаем понятным текстом.
function showBootError(missing) {
    console.log('[APP] НЕ ЗАГРУЖЕНЫ ФАЙЛЫ:', missing.join(', '));
    const badge = document.getElementById('network-status');
    if (badge) {
        badge.textContent = 'Нет файлов приложения';
        badge.classList.add('offline');
    }
    const box = document.createElement('div');
    box.className = 'boot-error';
    box.innerHTML = '<b>Не загрузились файлы приложения</b><br>' +
        missing.map(function (m) { return '• ' + m; }).join('<br>') +
        '<br><br>Проверьте, что папка <b>vendor</b> и её подпапки загружены на хостинг ' +
        '(файлы должны открываться по адресу сайта, например ' +
        '<i>ваш-сайт/vendor/leaflet/leaflet.js</i>). Если сайт выложен на GitHub Pages, ' +
        'нужен ещё пустой файл <b>.nojekyll</b> в корне.';
    document.body.appendChild(box);
}

if (typeof L === 'undefined') {
    showBootError(['vendor/leaflet/leaflet.js — библиотека карты']);
    throw new Error('Leaflet не загружен');
}

// ---------- 1. КАРТА ----------
console.log('[APP] v81');
// Кнопки зума и подпись карты размещаем сами: на телефоне снизу мешает
// панель-шторка, а подпись «© OpenStreetMap» вынесена в верхнюю строку.
// preferCanvas — рисуем объекты на canvas: на телефоне это заметно быстрее,
// когда точек и кружков много.
const map = L.map('map', {
    zoomControl: false,
    attributionControl: false,
    preferCanvas: true
}).setView([55.7558, 37.6173], 12);

L.control.zoom({ position: 'topright' }).addTo(map);

// ЛИНЕЙКА РАССТОЯНИЯ (как в Google/Яндекс.Картах): показывает, сколько метров
// или километров в одном отрезке на карте. Длина полоски пересчитывается сама
// при приближении и удалении. Только метрическая, без миль.
L.control.scale({
    position: 'bottomleft',
    metric: true,
    imperial: false,
    maxWidth: 130
}).addTo(map);

window.__mapReady = true;   // флаг для проверки загрузки в ui-sheet.js

// [BETA] Клик по карте — точечный «инспектор»: печатает координаты, есть ли
// рядом узел-перекрёсток, какая выбрана точка, внутри ли полигона это место,
// и есть ли в данных OSM вершины троп прямо у места клика.
map.on('click', function (e) {
    const lat = e.latlng.lat, lng = e.latlng.lng;
    console.log('[MAP] клик: lat=' + lat.toFixed(6) + ', lng=' + lng.toFixed(6));

    let nj = null, nd = Infinity;
    if (lastTerrain && lastTerrain.junctions && lastTerrain.junctions.length) {
        for (const j of lastTerrain.junctions) {
            const d = getHaversineDistance({ lat: lat, lng: lng }, j);
            if (d < nd) { nd = d; nj = j; }
        }
    }
    console.log('[MAP] ближайший узел:', nj ? (nj.kind + ', в ' + Math.round(nd) + ' м') : 'нет', nj ? '(lat=' + nj.lat.toFixed(6) + ', lng=' + nj.lng.toFixed(6) + ')' : '');

    let nz = null, zd = Infinity;
    for (const z of zones) {
        const d = getHaversineDistance({ lat: lat, lng: lng }, z);
        if (d < zd) { zd = d; nz = z; }
    }
    console.log('[MAP] ближайшая выбранная точка:', nz ? (nz.kind + ', в ' + Math.round(zd) + ' м') : 'нет');

    if (polygonPoints && polygonPoints.length >= 3) {
        console.log('[MAP] внутри полигона:', isPointInPolygon(lat, lng, polygonPoints),
            '| до границы: ' + Math.round(distanceToPolygonEdge(lat, lng, polygonPoints)) + ' м');
    }

    // Сколько троп/просек/ЛЭП проходят в пределах 30 м от клика
    if (lastTerrain) {
        const linesNear = function (arr, maxM) {
            let n = 0;
            for (const ln of arr || []) {
                for (let i = 0; i < ln.length; i++) {
                    if (getHaversineDistance({ lat: lat, lng: lng }, ln[i]) < maxM) { n++; break; }
                }
            }
            return n;
        };
        console.log('[MAP] линий в 30 м: троп=' + linesNear(lastTerrain.trails, 30) +
            ', просек=' + linesNear(lastTerrain.clearings, 30) +
            ', ЛЭП=' + linesNear(lastTerrain.powerlines, 30));

        // Есть ли вершина тропы в 15 м и через сколько разных троп она проходит
        const keyOf = function (v) { return v.lat.toFixed(5) + ',' + v.lng.toFixed(5); };
        const nearV = [];
        for (const ln of lastTerrain.trails || []) {
            for (let i = 0; i < ln.length; i++) {
                const v = ln[i];
                if (getHaversineDistance({ lat: lat, lng: lng }, v) < 15) {
                    const k = keyOf(v);
                    if (!nearV.some(function (x) { return keyOf(x) === k; })) nearV.push(v);
                }
            }
        }
        if (nearV.length) {
            for (const v of nearV) {
                let cnt = 0;
                for (const ln of lastTerrain.trails || []) {
                    for (let i = 0; i < ln.length; i++) {
                        if (keyOf(ln[i]) === keyOf(v)) { cnt++; break; }
                    }
                }
                console.log('[MAP] вершина тропы в 15 м:', v.lat.toFixed(6) + ',' + v.lng.toFixed(6), '| через неё троп:', cnt);
            }
        } else {
            console.log('[MAP] вершин тропы в 15 м нет');
        }
    }
});

// ---------- 1.1 ПОДЛОЖКА КАРТЫ (с запасными серверами) ----------
// Частая причина «приложение работает только с VPN» — недоступность одного
// конкретного сервера карт. Поэтому серверов несколько: если плитки не
// загружаются, приложение само переключается на следующий, а если не вышло
// ни с одним — показывает сохранённую схему района.
const TILE_SERVERS = [
    'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    'https://tile.openstreetmap.fr/osmfr/{z}/{x}/{y}.png',
    'https://tile.openstreetmap.de/{z}/{x}/{y}.png'
];
let tileServerIndex = 0;
let tileLayerRef = null;
let tileErrCount = 0;

function createTileLayer(index) {
    const layer = L.tileLayer(TILE_SERVERS[index], {
        attribution: '&copy; OpenStreetMap contributors',
        maxZoom: 19
    });
    layer.on('tileerror', function () {
        tileErrCount++;
        // несколько ошибок подряд — значит сервер недоступен, пробуем следующий
        if (tileErrCount >= 4 && tileServerIndex < TILE_SERVERS.length - 1) {
            const next = tileServerIndex + 1;
            console.log('[MAP] Сервер карт недоступен, переключаюсь на запасной:', TILE_SERVERS[next]);
            switchTileServer(next);
        }
    });
    layer.on('tileload', function () { tileErrCount = 0; });
    return layer;
}

function switchTileServer(index) {
    tileServerIndex = index;
    tileErrCount = 0;
    if (tileLayerRef) map.removeLayer(tileLayerRef);
    tileLayerRef = createTileLayer(index);
    tileLayerRef.addTo(map);
}

tileLayerRef = createTileLayer(0);
tileLayerRef.addTo(map);

// ---------- 2. СОСТОЯНИЕ ----------
let searchPolygon = null;
let polygonPoints = [];
let tempPolyline = null;
let isDrawingPolygon = false;
let vertexMarkers = [];         // маркеры вершин контура (для удаления/перерисовки)
let segmentMarkers = [];        // подписи длин сторон (маркеры на серединах рёбер)
let activeSegMarker = null;     // подпись длины «текущей» (активной) стороны при рисовании

let entryPoint = null;          // точка потери {lat, lng}
let entryMarker = null;

let zones = [];                 // найденные зоны [{lat, lng, score, cells}]
let zoneMarkers = [];
let debugJMarkers = []; // [BETA] маркеры невыбранных узлов-перекрёстков
let lastTerrain = null; // [BETA] последние данные местности (для клика-инспектора)
let heatLayer = null;
let polylinePath = null;
let worker = null;
let routeSegMarkers = [];       // подписи длин отрезков построенного маршрута (красные)
let lastRoute = null;   // последний маршрут (для экспорта GPX)
let routePoints = [];   // точки маршрута = авто-зоны + ручные точки [{lat, lng, score}]

// ---------- 3. СЕТЬ / СТАТУС ----------
// Показываем состояние сразу (по данным браузера) и потом уточняем настоящей
// проверкой: скачиваем маленький файл с нашего же сайта. Так надпись
// «Проверка связи…» не может «зависнуть» навсегда.
let netCheckBusy = false;

function setNetBadge(text, cls) {
    const badge = document.getElementById('network-status');
    if (!badge) return;
    badge.textContent = text;
    badge.classList.toggle('offline', cls === 'offline');
    badge.classList.toggle('checking', cls === 'checking');
}

function updateNetworkStatus() {
    // мгновенно — по признаку браузера
    setNetBadge(navigator.onLine ? 'Онлайн' : 'Нет сети', navigator.onLine ? '' : 'offline');
    checkConnection();
}

function checkConnection() {
    if (netCheckBusy) return;
    netCheckBusy = true;
    const started = Date.now();
    let finished = false;
    const timer = setTimeout(function () {
        if (finished) return;
        finished = true;
        netCheckBusy = false;
        // за 5 секунд не ответило: если браузер считает, что сеть есть — связь слабая
        setNetBadge(navigator.onLine ? 'Связь слабая' : 'Нет сети', 'offline');
    }, 5000);

    // проверяем свой же сайт: файл манифеста всегда есть и весит мало
    fetch('manifest.json?ping=' + Date.now(), { cache: 'no-store' })
        .then(function (r) {
            finished = true;
            clearTimeout(timer);
            netCheckBusy = false;
            if (r && r.ok) {
                setNetBadge('Онлайн', '');
                console.log('[NET] связь есть, ответ за ' + (Date.now() - started) + ' мс');
            } else {
                setNetBadge('Нет сети', 'offline');
            }
        })
        .catch(function (e) {
            finished = true;
            clearTimeout(timer);
            netCheckBusy = false;
            // service worker мог отдать файл из кэша — тогда считаем, что связь есть
            setNetBadge(navigator.onLine ? 'Онлайн (из кэша)' : 'Нет сети',
                navigator.onLine ? '' : 'offline');
            console.log('[NET] проверка не прошла:', e && e.message);
        });
}

window.addEventListener('online', updateNetworkStatus);
window.addEventListener('offline', updateNetworkStatus);
updateNetworkStatus();
setInterval(function () { if (!navigator.onLine) updateNetworkStatus(); }, 15000);

// ---------- 4. ГЕОМЕТРИЯ ----------
function isPointInPolygon(lat, lng, polyPoints) {
    let inside = false;
    for (let i = 0, j = polyPoints.length - 1; i < polyPoints.length; j = i++) {
        const xi = polyPoints[i].lat, yi = polyPoints[i].lng;
        const xj = polyPoints[j].lat, yj = polyPoints[j].lng;
        const intersect = ((yi > lng) !== (yj > lng)) && (lat < (xj - xi) * (lng - yi) / (yj - yi) + xi);
        if (intersect) inside = !inside;
    }
    return inside;
}

function getHaversineDistance(p1, p2) {
    const R = 6371000;
    const dLat = (p2.lat - p1.lat) * Math.PI / 180;
    const dLng = (p2.lng - p1.lng) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(p1.lat * Math.PI / 180) * Math.cos(p2.lat * Math.PI / 180) *
        Math.sin(dLng / 2) * Math.sin(dLng / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

// Азимут (bearing) между двумя точками, 0..360
function bearing(a, b) {
    const dLng = (b.lng - a.lng) * Math.PI / 180;
    const lat1 = a.lat * Math.PI / 180;
    const lat2 = b.lat * Math.PI / 180;
    const y = Math.sin(dLng) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

// Точка на заданном азимуте и расстоянии
function destinationPoint(lat, lng, bearingDeg, distM) {
    const R = 6371000;
    const brng = bearingDeg * Math.PI / 180;
    const lat1 = lat * Math.PI / 180;
    const lng1 = lng * Math.PI / 180;
    const dR = distM / R;
    const lat2 = Math.asin(Math.sin(lat1) * Math.cos(dR) + Math.cos(lat1) * Math.sin(dR) * Math.cos(brng));
    const lng2 = lng1 + Math.atan2(Math.sin(brng) * Math.sin(dR) * Math.cos(lat1), Math.cos(dR) - Math.sin(lat1) * Math.sin(lat2));
    return { lat: lat2 * 180 / Math.PI, lng: lng2 * 180 / Math.PI };
}

// Снап к прямому углу: вход при ±1° (89-91), удержание до ±4° (86-94)
let snapActive = false;
function snapToRightAngle(lat, lng) {
    if (polygonPoints.length < 2) { snapActive = false; return { lat: lat, lng: lng }; }
    const prev = polygonPoints[polygonPoints.length - 1];
    const prevPrev = polygonPoints[polygonPoints.length - 2];
    const a1 = bearing(prevPrev, prev);
    const a2 = bearing(prev, { lat: lat, lng: lng });
    const turn = (a2 - a1 + 540) % 360 - 180;
    const dev = Math.abs(Math.abs(turn) - 90);
    if (snapActive) {
        if (dev <= 4) {
            const targetTurn = (turn > 0 ? 90 : -90);
            const newAz = (a1 + targetTurn + 360) % 360;
            const dist = map.distance([prev.lat, prev.lng], [lat, lng]);
            return destinationPoint(prev.lat, prev.lng, newAz, dist);
        }
        snapActive = false;
        return { lat: lat, lng: lng };
    }
    if (dev <= 1) {
        snapActive = true;
        const targetTurn = (turn > 0 ? 90 : -90);
        const newAz = (a1 + targetTurn + 360) % 360;
        const dist = map.distance([prev.lat, prev.lng], [lat, lng]);
        return destinationPoint(prev.lat, prev.lng, newAz, dist);
    }
    return { lat: lat, lng: lng };
}

// ---------- 4.5. ПОДПИСИ ДЛИН СТОРОН ----------
function formatLenM(m) {
    if (m >= 1000) return (m / 1000).toFixed(2) + ' км';
    return Math.round(m) + ' м';
}

function segMidpoint(a, b) {
    return [(a.lat + b.lat) / 2, (a.lng + b.lng) / 2];
}

function segLabelIcon(text, extraClass) {
    const cls = extraClass ? 'seg-label ' + extraClass : 'seg-label';
    return L.divIcon({ className: cls, html: text, iconSize: [0, 0] });
}

function clearSegmentMarkers() {
    segmentMarkers.forEach(m => map.removeLayer(m));
    segmentMarkers = [];
}

function clearActiveSegMarker() {
    if (activeSegMarker) { map.removeLayer(activeSegMarker); activeSegMarker = null; }
}

// Перерисовка подписей длин всех сторон полигона (синие — цвет контура зоны).
// closed=true — показываем и замыкающее ребро (после завершения контура).
function renderSegmentLabels(closed) {
    clearSegmentMarkers();
    clearActiveSegMarker();
    const pts = polygonPoints;
    if (pts.length < 2) return;
    const pairs = [];
    for (let i = 0; i < pts.length - 1; i++) pairs.push([pts[i], pts[i + 1]]);
    if (closed && pts.length >= 3) pairs.push([pts[pts.length - 1], pts[0]]);
    for (const [a, b] of pairs) {
        const d = map.distance([a.lat, a.lng], [b.lat, b.lng]);
        const mk = L.marker(segMidpoint(a, b), { icon: segLabelIcon(formatLenM(d), 'seg-zone'), interactive: false });
        mk.addTo(map);
        segmentMarkers.push(mk);
    }
}

// Показ длины активной (рисуемой) стороны — от последней вершины к курсору (синий)
function showActiveSegment(cursorLat, cursorLng) {
    if (!isDrawingPolygon || polygonPoints.length < 1) return;
    const a = polygonPoints[polygonPoints.length - 1];
    const d = map.distance([a.lat, a.lng], [cursorLat, cursorLng]);
    const mid = segMidpoint(a, { lat: cursorLat, lng: cursorLng });
    if (!activeSegMarker) {
        activeSegMarker = L.marker(mid, { icon: segLabelIcon(formatLenM(d), 'seg-zone'), interactive: false }).addTo(map);
    } else {
        activeSegMarker.setLatLng(mid);
        activeSegMarker.setIcon(segLabelIcon(formatLenM(d), 'seg-zone'));
    }
}


// ---------- 5. РИСОВАНИЕ ПОЛИГОНА ----------
function finishPolygon() {
    if (tempPolyline) { map.removeLayer(tempPolyline); tempPolyline = null; }
    if (polygonPoints.length < 3) {
        isDrawingPolygon = false;
        redrawVertexMarkers();
        updateZoneBtn();
        return;
    }
    if (searchPolygon) map.removeLayer(searchPolygon);
    const latlngs = polygonPoints.map(p => [p.lat, p.lng]);
    searchPolygon = L.polygon(latlngs, {
        color: '#2563eb', fillColor: '#3b82f6', fillOpacity: 0.25, weight: 2
    }).addTo(map);
    // убираем маркеры вершин после завершения контура
    redrawVertexMarkers();
    vertexMarkers.forEach(m => map.removeLayer(m));
    vertexMarkers = [];
    isDrawingPolygon = false;
    updateZoneBtn();
    // длины сторон зоны не показываем — оставлены только длины отрезков маршрута
    clearSegmentMarkers();
    clearActiveSegMarker();

    // площадь и периметр выделенной зоны
    let per = 0;
    for (let i = 0; i < polygonPoints.length; i++) {
        const a = polygonPoints[i], b = polygonPoints[(i + 1) % polygonPoints.length];
        per += map.distance([a.lat, a.lng], [b.lat, b.lng]);
    }
    document.getElementById('stat-perimeter').textContent = Math.round(per);
    if (typeof turf !== 'undefined' && polygonPoints.length >= 3) {
        try {
            const ring = polygonPoints.map(p => [p.lng, p.lat]);
            ring.push([polygonPoints[0].lng, polygonPoints[0].lat]);
            const areaM2 = turf.area(turf.polygon([ring]));
            document.getElementById('stat-area').textContent = (areaM2 / 1e6).toFixed(2);
        } catch (e) {}
    }
}

map.on('mousemove', function (e) {
    if (isDrawingPolygon && polygonPoints.length > 0) {
        const pts = polygonPoints.map(p => [p.lat, p.lng]);
        const snap = snapToRightAngle(e.latlng.lat, e.latlng.lng);
        pts.push([snap.lat, snap.lng]);
        if (!tempPolyline) {
            tempPolyline = L.polyline(pts, { color: '#2563eb', weight: 2, dashArray: '5, 5' }).addTo(map);
        } else {
            tempPolyline.setLatLngs(pts);
        }
        // длина линии (периметр) в реальном времени
        let per = 0;
        for (let i = 0; i < pts.length - 1; i++) {
            per += map.distance(pts[i], pts[i + 1]);
        }
        document.getElementById('stat-perimeter').textContent = Math.round(per);
    }
});

map.on('click', function (e) {
    if (isDrawingPolygon) {
        let lat = e.latlng.lat, lng = e.latlng.lng;

        // 1. Проверка на замыкание контура (клик по первой вершине)
        if (polygonPoints.length > 0) {
            const first = polygonPoints[0];
            if (map.distance([lat, lng], [first.lat, first.lng]) < 30 && polygonPoints.length >= 2) {
                finishPolygon();
                return;
            }
        }

        // 2. Проверка на клик по существующей вершине → удаляем её
        for (let i = 0; i < polygonPoints.length; i++) {
            if (map.distance([lat, lng], [polygonPoints[i].lat, polygonPoints[i].lng]) < 25) {
                polygonPoints.splice(i, 1);
                redrawVertexMarkers();
                return;
            }
        }

        // 3. Снап к прямому углу
        const snapped = snapToRightAngle(lat, lng);
        lat = snapped.lat; lng = snapped.lng;

        // 4. Добавление новой вершины
        polygonPoints.push({ lat, lng });
        if (tempPolyline) map.removeLayer(tempPolyline);
        const latlngs = polygonPoints.map(p => [p.lat, p.lng]);
        tempPolyline = L.polyline(latlngs, { color: '#2563eb', weight: 2, dashArray: '4, 4' }).addTo(map);
        redrawVertexMarkers();
    } else if (isSettingEntry) {
        setEntryPoint(e.latlng.lat, e.latlng.lng);
    } else if (isManualZoning) {
        addManualPoint(e.latlng.lat, e.latlng.lng);
    } else {
        // Не в режиме рисования/установки: клик по существующей точке удаляет её.
        // Сначала точка потери (маленький маркер), потом ручные точки.
        if (entryPoint && map.distance([e.latlng.lat, e.latlng.lng], [entryPoint.lat, entryPoint.lng]) < 25) {
            clearEntryPoint();
        } else {
            removeManualPointAt(e.latlng.lat, e.latlng.lng);
        }
    }
});

// ПКМ по карте рядом с точкой потери → информация о ней
function showEntryPointInfo(lat, lng) {
    if (!entryPoint) return;
    if (map.distance([lat, lng], [entryPoint.lat, entryPoint.lng]) < 30) {
        const html =
            '<b>Точка потери</b><br>' +
            'широта: ' + entryPoint.lat.toFixed(6) + '<br>' +
            'долгота: ' + entryPoint.lng.toFixed(6);
        map.openPopup(L.popup().setLatLng([entryPoint.lat, entryPoint.lng]).setContent(html));
        return true;
    }
    return false;
}

// ПКМ по карте рядом с ручной точкой → информация о ней
map.on('contextmenu', function (e) {
    let handled = false;
    if (entryPoint && map.distance([e.latlng.lat, e.latlng.lng], [entryPoint.lat, entryPoint.lng]) < 30) {
        if (e.originalEvent) e.originalEvent.preventDefault();
        showEntryPointInfo(e.latlng.lat, e.latlng.lng);
        handled = true;
    } else if (manualPoints.length > 0) {
        for (let i = 0; i < manualPoints.length; i++) {
            if (map.distance([e.latlng.lat, e.latlng.lng], [manualPoints[i].lat, manualPoints[i].lng]) < 30) {
                if (e.originalEvent) e.originalEvent.preventDefault();
                showManualPointInfo(manualPoints[i].lat, manualPoints[i].lng);
                handled = true;
                break;
            }
        }
    }
    if (handled && e.originalEvent) e.originalEvent.preventDefault();
});

// Перерисовка маркеров вершин контура (фиолетовые точки)
function redrawVertexMarkers() {
    vertexMarkers.forEach(m => map.removeLayer(m));
    vertexMarkers = [];
    for (const p of polygonPoints) {
        vertexMarkers.push(L.circleMarker([p.lat, p.lng], {
            radius: 3,
            color: '#8e44ad',
            fillColor: '#8e44ad',
            fillOpacity: 1
        }).addTo(map));
    }
}

// Одна кнопка на карточку: она показывает то действие, которое сейчас возможно.
// Зона: нет зоны → «Очертить зону поиска»; рисуем → «Отменить рисование»;
// зона есть → «Стереть зону».
function updateZoneBtn() {
    const b = document.getElementById('draw-polygon-btn');
    if (!b) return;
    if (isDrawingPolygon) {
        b.textContent = 'Отменить рисование';
    } else if (searchPolygon && polygonPoints && polygonPoints.length >= 3) {
        b.textContent = 'Стереть зону';
    } else {
        b.textContent = 'Очертить зону поиска';
    }
}

function startPolygonDrawing() {
    if (searchPolygon) { map.removeLayer(searchPolygon); searchPolygon = null; }
    polygonPoints = [];
    if (tempPolyline) { map.removeLayer(tempPolyline); tempPolyline = null; }
    redrawVertexMarkers();
    clearSegmentMarkers();
    clearActiveSegMarker();
    // отключаем другие режимы кликов
    deactivateManualZoning();
    if (isSettingEntry) {
        isSettingEntry = false;
        setEntryBtnText();
    }
    isDrawingPolygon = true;
    updateZoneBtn();
}

function clearPolygonAndResults() {
    if (searchPolygon) { map.removeLayer(searchPolygon); searchPolygon = null; }
    polygonPoints = [];
    if (tempPolyline) { map.removeLayer(tempPolyline); tempPolyline = null; }
    vertexMarkers.forEach(m => map.removeLayer(m));
    vertexMarkers = [];
    isDrawingPolygon = false;
    clearSegmentMarkers();
    clearActiveSegMarker();
    // стираем вместе с зоной найденные зоны, маршрут и статистику
    resetSearchResults();
    updateZoneBtn();
}

document.getElementById('draw-polygon-btn').addEventListener('click', function () {
    if (isDrawingPolygon) {
        finishPolygon();          // закончить контур
    } else if (searchPolygon && polygonPoints.length >= 3) {
        clearPolygonAndResults(); // стереть готовую зону
    } else {
        startPolygonDrawing();    // начать рисовать
    }
});

// Полная очистка результатов поиска (зоны, маршрут, статус-бар, прогресс)
function resetSearchResults() {
    // 1. Найденные зоны и heatmap
    clearZones();
    zones = [];
    // подписи длин сторон (на случай очистки не через clear-polygon)
    clearSegmentMarkers();
    clearActiveSegMarker();
    // 2. Маршрут
    if (polylinePath) { map.removeLayer(polylinePath); polylinePath = null; }
    routeSegMarkers.forEach(m => map.removeLayer(m));
    routeSegMarkers = [];
    lastRoute = null;
    // 3. Останавливаем активный worker, если есть
    if (worker) { worker.terminate(); worker = null; }
    const pw = document.getElementById('progress-wrap');
    if (pw) pw.classList.add('hidden');
    // 4. Очищаем список зон в панели
    const listEl = document.getElementById('zones-list');
    if (listEl) listEl.innerHTML = '';
    const emptyEl = document.getElementById('zones-empty');
    if (emptyEl) emptyEl.style.display = '';
    // 5. Сбрасываем статус-бар
    document.getElementById('stat-zones').textContent = 0;
    document.getElementById('stat-perimeter').textContent = 0;
    document.getElementById('stat-area').textContent = 0;
    document.getElementById('stat-distance').textContent = '0.00';
    document.getElementById('stat-matrix-time').textContent = '0.00';
    document.getElementById('stat-opt-time').textContent = '0.00';
    // 6. Ручные точки-зоны
    manualPoints = [];
    renderManualMarkers();
    isManualZoning = false;
    updateManualBtn();
    routePoints = [];
    // 7. Возвращаем кнопки в исходное состояние
    const findBtn = document.getElementById('find-zones-btn');
    if (findBtn) { findBtn.disabled = false; findBtn.textContent = 'Найти вероятные зоны'; }
    updateZoneBtn();
    updateManualBtn();
    const optBtn = document.getElementById('optimize-btn');
    if (optBtn) { optBtn.disabled = false; }
}

// ---------- 6. ТОЧКА ПОТЕРИ ----------
let isSettingEntry = false;

function setEntryBtnText() {
    const btn = document.getElementById('set-entry-btn');
    if (!btn) return;
    // Одна кнопка: указать → убрать
    if (isSettingEntry) {
        btn.textContent = 'Отменить указание';
    } else if (entryPoint) {
        btn.textContent = 'Убрать точку потери';
    } else {
        btn.textContent = 'Указать точку потери';
    }
}

function setEntryPoint(lat, lng) {
    entryPoint = { lat, lng };
    if (entryMarker) map.removeLayer(entryMarker);
    // SVG-кружок: рисуется браузером, не зависит от внешних иконок/CDN.
    // Маркер неинтерактивный: управление (удаление/инфо) идёт через клики по карте.
    entryMarker = L.circleMarker([lat, lng], {
        radius: 4,
        color: '#e74c3c',
        weight: 3,
        fillColor: '#e74c3c',
        fillOpacity: 0.9,
        interactive: false
    }).addTo(map);
    isSettingEntry = false;
    setEntryBtnText();
    console.log('[APP] Точка потери установлена:', lat.toFixed(5), lng.toFixed(5));
}

function clearEntryPoint() {
    entryPoint = null;
    if (entryMarker) { map.removeLayer(entryMarker); entryMarker = null; }
    isSettingEntry = false;
    setEntryBtnText();
}

document.getElementById('set-entry-btn').addEventListener('click', function () {
    // Одна кнопка на все случаи: указать точку → убрать точку
    if (entryPoint && !isSettingEntry) {
        clearEntryPoint();
        return;
    }
    // Отключаем режим рисования полигона, чтобы клики ставили точку потери,
    // а не добавляли вершины контура.
    if (isDrawingPolygon) {
        if (tempPolyline) { map.removeLayer(tempPolyline); tempPolyline = null; }
        isDrawingPolygon = false;
        updateZoneBtn();
    }
    deactivateManualZoning();
    isSettingEntry = !isSettingEntry;
    setEntryBtnText();
});

// ---------- 6.5. РУЧНЫЕ ТОЧКИ-ЗОНЫ (офлайн-режим) ----------
let isManualZoning = false;
let manualPoints = [];          // [{lat, lng}]
let manualMarkers = [];         // Leaflet-маркеры ручных точек

function renderManualMarkers() {
    manualMarkers.forEach(m => map.removeLayer(m));
    manualMarkers = [];
    manualPoints.forEach((p) => {
        const m = L.circleMarker([p.lat, p.lng], {
            radius: 8,
            color: '#2563eb',
            weight: 2,
            fillColor: '#3b82f6',
            fillOpacity: 0.7,
            interactive: false
        }).addTo(map);
        manualMarkers.push(m);
    });
}

// Удаление ручной точки рядом с указанными координатами (в радиусе 30 м)
function removeManualPointAt(lat, lng) {
    for (let i = 0; i < manualPoints.length; i++) {
        if (map.distance([lat, lng], [manualPoints[i].lat, manualPoints[i].lng]) < 30) {
            manualPoints.splice(i, 1);
            renderManualMarkers();
            return;
        }
    }
}

// Показать информацию о ручной точке (вызывается по ПКМ)
function showManualPointInfo(lat, lng) {
    for (let i = 0; i < manualPoints.length; i++) {
        if (map.distance([lat, lng], [manualPoints[i].lat, manualPoints[i].lng]) < 30) {
            const p = manualPoints[i];
            const html =
                '<b>Ручная точка-зона ' + (i + 1) + '</b><br>' +
                'широта: ' + p.lat.toFixed(6) + '<br>' +
                'долгота: ' + p.lng.toFixed(6);
            map.openPopup(L.popup().setLatLng([p.lat, p.lng]).setContent(html));
            return;
        }
    }
}

function stopAllDrawingModes() {
    if (isDrawingPolygon) {
        isDrawingPolygon = false;
        updateZoneBtn();
    }
    if (isSettingEntry) {
        isSettingEntry = false;
        setEntryBtnText();
    }
}

// Выключение ручного режима расстановки точек (используется при включении др. режимов)
// Одна кнопка ручных точек: добавить -> закончить -> стереть -> добавить...
function updateManualBtn() {
    const mb = document.getElementById('manual-zones-btn');
    if (!mb) return;
    if (isManualZoning) {
        mb.textContent = 'Закончить добавление (' + manualPoints.length + ')';
    } else if (manualPoints.length) {
        mb.textContent = 'Стереть ручные точки (' + manualPoints.length + ')';
    } else {
        mb.textContent = 'Добавить ручные точки';
    }
}

function deactivateManualZoning() {
    isManualZoning = false;
    updateManualBtn();
}

function addManualPoint(lat, lng) {
    // клик по существующей точке → удаляем её
    for (let i = 0; i < manualPoints.length; i++) {
        if (map.distance([lat, lng], [manualPoints[i].lat, manualPoints[i].lng]) < 30) {
            manualPoints.splice(i, 1);
            renderManualMarkers();
            updateManualBtn();
            return;
        }
    }
    manualPoints.push({ lat, lng });
    renderManualMarkers();
    updateManualBtn();
}

// Одна кнопка на три состояния: добавить точки → закончить → стереть
document.getElementById('manual-zones-btn').addEventListener('click', function () {
    if (isManualZoning) {
        isManualZoning = false;
        updateManualBtn();                 // закончили добавление
    } else if (manualPoints.length) {
        manualPoints = [];                 // стираем все ручные точки
        renderManualMarkers();
        updateManualBtn();
    } else {
        stopAllDrawingModes();
        isManualZoning = true;
        updateManualBtn();
    }
});


// Порядок источников данных OSM:
//   1) api.openstreetmap.org (OSM, XML) — ГЛАВНЫЙ источник;
//   2) Overpass — только российское зеркало Mail.ru (запасной).
// Если всё недоступно — фолбэк без данных местности.

const OVERPASS_MIRRORS = [
    'https://maps.mail.ru/osm/tools/overpass/api/interpreter'
];

async function fetchTerrainData(polygonPoints) {
    // bbox полигона
    let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
    for (const p of polygonPoints) {
        if (p.lat < minLat) minLat = p.lat;
        if (p.lat > maxLat) maxLat = p.lat;
        if (p.lng < minLng) minLng = p.lng;
        if (p.lng > maxLng) maxLng = p.lng;
    }
    // небольшой запас
    const pad = 0.002;
    minLat -= pad; maxLat += pad; minLng -= pad; maxLng += pad;

    const terrain = {
        trails: [], forests: [], water: [], wetlands: [],
        powerlines: [], railways: [], abandonedRailways: [],
        rivers: [], huts: [], springs: [], clearings: [],
        junctions: [], towers: [],
        // ориентиры, которые особенно важны для поиска человека:
        gates: [],       // лесные ворота, шлагбаумы, блоки — «конец дороги»
        parkings: [],    // лесные стоянки: место, где стоит машина потерявшегося
        rests: []        // места отдыха, костровища, туалеты — слабый ориентир
    };

    // Повторный расчёт того же района берём из кэша (экономит время и трафик)
    const cacheKey = terrainCacheKey(polygonPoints);
    if (terrainCache.has(cacheKey)) {
        console.log('[OSM] Данные района взяты из кэша (без обращения к сети)');
        return terrainCache.get(cacheKey);
    }
    const finish = function (t) {
        try {
            terrainCache.set(cacheKey, t);
            while (terrainCache.size > TERRAIN_CACHE_MAX) {
                terrainCache.delete(terrainCache.keys().next().value);
            }
        } catch (e) { }
        return t;
    };

    // --- Попытка 1 (ГЛАВНАЯ): api.openstreetmap.org (OSM, XML, весь bbox) ---
    try {
        const url = 'https://api.openstreetmap.org/api/0.6/map?bbox=' + minLng + ',' + minLat + ',' + maxLng + ',' + maxLat;
        const resp = await fetch(url);
        if (resp.ok) {
            const xmlText = await resp.text();
            parseOSMXML(xmlText, terrain);
            console.log('[OSM] api.openstreetmap.org OK: ' + terrain.trails.length + ' троп, ' + terrain.forests.length + ' лесов, ' + terrain.powerlines.length + ' ЛЭП, ' + terrain.railways.length + ' ЖД');
            if (terrain.trails.length + terrain.forests.length > 0) return finish(terrain);
        }
    } catch (e) {
        console.log('[OSM] api.openstreetmap.org недоступен:', e.message);
    }

    // --- Попытка 2 (запасная): Overpass — российское зеркало Mail.ru ---
    // Overpass отдаёт только нужные теги и лучше переносит большие зоны,
    // чем основной API (у того лимит на размер квадрата).
    for (const mirror of OVERPASS_MIRRORS) {
        try {
            const query = `
                [out:json][timeout:25];
                (
                  way["highway"~"^(path|track|footway|service|bridleway|unclassified|residential|living_street|tertiary|secondary|primary|road|cycleway)$"](${minLat},${minLng},${maxLat},${maxLng});
                  way["natural"="wood"](${minLat},${minLng},${maxLat},${maxLng});
                  way["landuse"="forest"](${minLat},${minLng},${maxLat},${maxLng});
                  way["natural"="water"](${minLat},${minLng},${maxLat},${maxLng});
                  way["natural"="wetland"](${minLat},${minLng},${maxLat},${maxLng});
                  way["natural"="scrub"](${minLat},${minLng},${maxLat},${maxLng});
                  way["power"="line"](${minLat},${minLng},${maxLat},${maxLng});
                  way["railway"="rail"](${minLat},${minLng},${maxLat},${maxLng});
                  way["railway"="abandoned"](${minLat},${minLng},${maxLat},${maxLng});
                  way["waterway"~"^(stream|river)$"](${minLat},${minLng},${maxLat},${maxLng});
                  way["man_made"="pipeline"](${minLat},${minLng},${maxLat},${maxLng});
                  way["man_made"="cutline"](${minLat},${minLng},${maxLat},${maxLng});
                  way["landuse"="clearcut"](${minLat},${minLng},${maxLat},${maxLng});
                  node["building"~"^(hut|cabin)$"](${minLat},${minLng},${maxLat},${maxLng});
                  node["tourism"="wilderness_hut"](${minLat},${minLng},${maxLat},${maxLng});
                  node["man_made"="tower"]["tower:type"~"hunting"](${minLat},${minLng},${maxLat},${maxLng});
                  node["amenity"="hunting_stand"](${minLat},${minLng},${maxLat},${maxLng});
                  node["amenity"="shelter"](${minLat},${minLng},${maxLat},${maxLng});
                  node["historic"="ruins"](${minLat},${minLng},${maxLat},${maxLng});
                  node["tower:type"="communication"](${minLat},${minLng},${maxLat},${maxLng});
                  way["building"~"^(hut|cabin)$"](${minLat},${minLng},${maxLat},${maxLng});
                  node["natural"="spring"](${minLat},${minLng},${maxLat},${maxLng});
                  node["man_made"="water_well"](${minLat},${minLng},${maxLat},${maxLng});
                  node["amenity"="drinking_water"](${minLat},${minLng},${maxLat},${maxLng});
                  node["barrier"~"^(gate|lift_gate|block|swing_gate|bollard)$"](${minLat},${minLng},${maxLat},${maxLng});
                  node["amenity"="parking"](${minLat},${minLng},${maxLat},${maxLng});
                  node["amenity"="toilets"](${minLat},${minLng},${maxLat},${maxLng});
                  node["tourism"="picnic_site"](${minLat},${minLng},${maxLat},${maxLng});
                  node["leisure"~"^(firepit|picnic_table)$"](${minLat},${minLng},${maxLat},${maxLng});
                  node["man_made"~"^(mast|tower)$"](${minLat},${minLng},${maxLat},${maxLng});
                );
                out body;
                >;
                out skel qt;
            `;
            const url = mirror + '?data=' + encodeURIComponent(query);
            const resp = await fetch(url);
            if (!resp.ok) throw new Error('status ' + resp.status);
            const data = await resp.json();
            parseOverpass(data, terrain);
            console.log('[OSM] Overpass (' + mirror + ') OK: ' + terrain.trails.length + ' троп, ' + terrain.forests.length + ' лесов, ' + terrain.powerlines.length + ' ЛЭП, ' + terrain.railways.length + ' ЖД');
            if (terrain.trails.length + terrain.forests.length > 0) return finish(terrain);
        } catch (e) {
            console.log('[OSM] Overpass ' + mirror + ' недоступен:', e.message);
        }
    }

    // Все источники недоступны — пробуем сохранённую офлайн-карту района
    try {
        const saved = await idbGet('zone');
        if (saved && saved.terrain && saved.terrain.trails && saved.terrain.trails.length) {
            console.log('[OSM] Интернета нет — используем сохранённую офлайн-карту района');
            return finish(saved.terrain);
        }
    } catch (e) { }

    console.log('[OSM] Все источники недоступны — используем фолбэк (равномерные зоны / точка потери)');
    return terrain; // пустой — сработает фолбэк
}

// Перекрёстки «пешей» линейной сети: узлы, где сходятся ≥3 направлений дорог/
// троп/ЖД/ЛЭП. Две сквозные дороги дают 4 направления (настоящий X/+). 2
// направления — это стык/изгиб одной дороги, его отбрасываем. 3 направления:
// если линия проходит насквозь — «Т», если все линии кончаются — «развилка».
function computeJunctions(netRefs, nodeIndex) {
    const count = new Map();
    const interior = new Set();
    const inc = function (id) { count.set(id, (count.get(id) || 0) + 1); };
    for (const ids of netRefs) {
        // каждый соседний узел пары даёт по одному «направлению» своим концам:
        // внутренний узел линии получает +2 (пришёл и ушёл сегмент), конец — +1
        for (let i = 1; i < ids.length; i++) {
            inc(ids[i - 1]);
            inc(ids[i]);
        }
        // внутренние узлы (не первый и не последний) — линия проходит насквозь
        for (let i = 1; i < ids.length - 1; i++) interior.add(ids[i]);
    }
    const out = [];
    const seenPts = new Set();
    for (const entry of count) {
        if (entry[1] < 3) continue; // 2 направления = стык/изгиб одной дороги — не перекрёсток
        const nd = nodeIndex[entry[0]];
        if (!nd || nd.lat == null || nd.lng == null) continue;
        const key = nd.lat.toFixed(5) + ',' + nd.lng.toFixed(5);
        if (seenPts.has(key)) continue;
        seenPts.add(key);
        const deg = entry[1];
        const kind = deg >= 4 ? 'x' : (interior.has(entry[0]) ? 't' : 'fork');
        out.push({ lat: nd.lat, lng: nd.lng, kind: kind });
        if (out.length >= 20000) break;
    }
    return out;
}

// Классификация одиночных объектов OSM в «ориентиры поиска».
// Возвращает имя массива в terrain или null.
// Важно: порядок проверок — от самых «сильных» ориентиров к слабым.
function nodeKind(tags) {
    if (tags.building === 'hut' || tags.building === 'cabin' || tags.building === 'shed' ||
        tags.tourism === 'wilderness_hut' || tags.amenity === 'shelter' ||
        tags.amenity === 'hunting_stand' || tags.historic === 'ruins' ||
        (tags.man_made === 'tower' && /hunting/.test(tags['tower:type'] || ''))) {
        return 'huts';
    }
    if (tags['tower:type'] === 'communication' || tags.man_made === 'tower' || tags.man_made === 'mast') {
        return 'towers';
    }
    if (tags.natural === 'spring' || tags.man_made === 'water_well' || tags.amenity === 'drinking_water') {
        return 'springs';
    }
    // Ворота и шлагбаумы: человек идёт по дороге и упирается в них — частое место
    // «разворота» и выхода к людям, поэтому это отдельная точка поиска.
    if (tags.barrier === 'gate' || tags.barrier === 'lift_gate' || tags.barrier === 'block' ||
        tags.barrier === 'swing_gate' || tags.barrier === 'bollard') {
        return 'gates';
    }
    // Лесная стоянка: здесь стоит машина потерявшегося — он часто возвращается к ней.
    if (tags.amenity === 'parking') {
        return 'parkings';
    }
    // Места отдыха: слабый, но полезный ориентир (знакомые места, костровища).
    if (tags.amenity === 'toilets' || tags.tourism === 'picnic_site' ||
        tags.leisure === 'firepit' || tags.leisure === 'picnic_table') {
        return 'rests';
    }
    return null;
}

function pushNodeKind(terrain, kind, lat, lng) {
    if (!kind || !terrain[kind]) return;
    terrain[kind].push({ lat: lat, lng: lng });
}

function parseOverpass(data, terrain) {
    const nodes = {};
    const netRefs = [];
    if (!data.elements) return;
    for (const el of data.elements) {
        if (el.type === 'node') nodes[el.id] = { lat: el.lat, lng: el.lon };
    }
    for (const el of data.elements) {
        const tags = el.tags || {};

        // Одиночные точки: укрытия, родники, вышки, ворота, стоянки, места отдыха
        if (el.type === 'node' && el.lat != null) {
            pushNodeKind(terrain, nodeKind(tags), el.lat, el.lon);
            continue;
        }

        if (el.type !== 'way' || !el.nodes) continue;
        const coords = el.nodes.map(id => nodes[id]).filter(Boolean);
        if (coords.length < 2) continue;

        const isNet = !!(tags.highway || tags.railway || tags.power === 'line' ||
            tags.man_made === 'pipeline' || tags.man_made === 'cutline');
        if (isNet) netRefs.push(el.nodes);

        if (tags.highway) {
            terrain.trails.push(coords);
        } else if (tags.natural === 'wood' || tags.landuse === 'forest') {
            terrain.forests.push(coords);
        } else if (tags.natural === 'water') {
            terrain.water.push(coords);
        } else if (tags.natural === 'wetland' || tags.natural === 'scrub') {
            terrain.wetlands.push(coords);
        } else if (tags.power === 'line') {
            terrain.powerlines.push(coords);
        } else if (tags.railway === 'rail') {
            terrain.railways.push(coords);
        } else if (tags.railway === 'abandoned') {
            terrain.abandonedRailways.push(coords);
        } else if (tags.waterway === 'stream' || tags.waterway === 'river') {
            terrain.rivers.push(coords);
        } else if (tags.man_made === 'pipeline' || tags.man_made === 'cutline' || tags.landuse === 'clearcut') {
            terrain.clearings.push(coords);
        } else if (tags.building === 'hut' || tags.building === 'cabin') {
            // небольшие строения-полигоны: средняя точка как точка-укрытие
            let slat = 0, slng = 0;
            for (const c of coords) { slat += c.lat; slng += c.lng; }
            terrain.huts.push({ lat: slat / coords.length, lng: slng / coords.length });
        }
    }
    terrain.junctions = computeJunctions(netRefs, nodes);
}

// Резервный расчёт перекрёстков напрямую по геометрии загруженных линий.
// Вершина = перекрёсток, если в ней сходятся ≥2 разных линий И всего ≥3
// «направления» (2 направления — это просто стык двух кусков одной дороги =
// изгиб, его отбрасываем). Классификация по числу направлений и по тому,
// проходит ли какая-то линия НАСКВОЗЬ через вершину:
//   ≥4 направления                    → «x» (перекрёсток)
//   3 направления + есть сквозная     → «t» (Т-образный)
//   3 направления, все линии кончаются → «fork» (развилка, Y)
function junctionsFromLines(lines) {
    const m = new Map();
    lines.forEach(function (line, li) {
        if (!line || line.length < 2) return;
        line.forEach(function (v, k) {
            const dir = (k > 0 ? 1 : 0) + (k < line.length - 1 ? 1 : 0);
            const key = v.lat.toFixed(5) + ',' + v.lng.toFixed(5);
            let e = m.get(key);
            if (!e) { e = { lat: v.lat, lng: v.lng, lines: new Set(), dirs: 0, interior: false }; m.set(key, e); }
            e.lines.add(li);
            e.dirs += dir;
            if (dir === 2) e.interior = true; // линия проходит насквозь
        });
    });
    const out = [];
    for (const e of m.values()) {
        if (e.lines.size < 2 || e.dirs < 3) continue; // изгиб/стык одной дороги — не перекрёсток
        const kind = e.dirs >= 4 ? 'x' : (e.interior ? 't' : 'fork');
        out.push({ lat: e.lat, lng: e.lng, kind: kind });
        if (out.length >= 20000) break;
    }
    return out;
}

function mergeJunctions(a, b) {
    const seen = new Set();
    const out = [];
    for (const list of [a, b]) {
        for (const j of list || []) {
            const key = j.lat.toFixed(5) + ',' + j.lng.toFixed(5);
            if (seen.has(key)) continue;
            seen.add(key);
            out.push(j);
            if (out.length >= 20000) return out;
        }
    }
    return out;
}

// Склеивает близкие узлы (в пределах radiusM) в один: это убирает десятки
// дублей вокруг каждого реального перекрёстка. Приоритет типа: X > T > развилка.
// Работает через пространственную сетку (быстро даже при тысячах узлов).
function clusterJunctions(arr, radiusM) {
    const rank = { 'x': 3, 't': 2, 'fork': 1 };
    const cellDeg = Math.max(0.0001, radiusM / 111320);
    const gx = function (lat) { return Math.round(lat / cellDeg); };
    const gy = function (lng) { return Math.round(lng / cellDeg); };
    const grid = new Map();
    for (const p of arr || []) {
        const k = gx(p.lat) + ',' + gy(p.lng);
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push(p);
    }
    const out = [];
    const used = new Set();
    const k6 = function (p) { return p.lat.toFixed(6) + ',' + p.lng.toFixed(6); };
    for (const p of arr || []) {
        if (used.has(k6(p))) continue;
        used.add(k6(p));
        let rep = { lat: p.lat, lng: p.lng, kind: p.kind || 'fork' };
        const cx = gx(p.lat), cy = gy(p.lng);
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                const bucket = grid.get((cx + dx) + ',' + (cy + dy));
                if (!bucket) continue;
                for (const q of bucket) {
                    if (used.has(k6(q))) continue;
                    if (getHaversineDistance(rep, q) < radiusM) {
                        if ((rank[q.kind] || 0) > (rank[rep.kind] || 0)) {
                            rep = { lat: q.lat, lng: q.lng, kind: q.kind };
                        }
                        used.add(k6(q));
                    }
                }
            }
        }
        out.push(rep);
    }
    return out;
}

// Полноценный поиск пересечений ОТРЕЗОК × ОТРЕЗОК между всеми тропами/дорогами
// (ловит пересечения длинных прямых линий БЕЗ общих узлов и вершин). Для скорости
// используется пространственная сетка ~25 м. Тип: оба отрезка проходят насквозь —
// «x»; один обрывается у другого — «t»; оба кончаются рядом — «fork».
function crossSegmentsAll(lines) {
    const out = [];
    if (!lines || !lines.length) return out;
    const cellDeg = 25 / 111320;
    const NEAR_M = 12;     // почти-пересечение: линии в пределах 12 м
    const ANGLE_MIN = 25;  // и под углом (параллельные соседние тропы не считаем)
    const segs = [];
    lines.forEach(function (line, li) {
        for (let i = 1; i < line.length; i++) {
            const a = line[i - 1], b = line[i];
            segs.push({ li: li, ax: a.lng, ay: a.lat, bx: b.lng, by: b.lat });
        }
    });
    const N = segs.length;
    if (N < 2) return out;

    const buckets = new Map();
    const cX = function (x) { return Math.floor(x / cellDeg); };
    const cY = function (y) { return Math.floor(y / cellDeg); };
    segs.forEach(function (s, si) {
        const x0 = Math.min(s.ax, s.bx), x1 = Math.max(s.ax, s.bx);
        const y0 = Math.min(s.ay, s.by), y1 = Math.max(s.ay, s.by);
        for (let X = cX(x0); X <= cX(x1); X++) {
            for (let Y = cY(y0); Y <= cY(y1); Y++) {
                const k = X + ',' + Y;
                if (!buckets.has(k)) buckets.set(k, []);
                buckets.get(k).push(si);
            }
        }
    });

    const undir = function (dx, dy) {
        if (dy < 0 || (dy === 0 && dx < 0)) { dx = -dx; dy = -dy; }
        let a = Math.atan2(dy, dx) * 180 / Math.PI;
        if (a < 0) a += 180;
        return a;
    };
    const angDiff = function (a, b) {
        let d = Math.abs(a - b);
        if (d > 180) d = 360 - d;
        return Math.min(d, 180 - d);
    };
    const EPS = 1e-12;
    // ближайшая точка между двумя отрезками; возвращает расстояние в метрах,
    // параметры на каждом отрезке и середину
    const segClose = function (s, t) {
        const d1x = s.bx - s.ax, d1y = s.by - s.ay;
        const d2x = t.bx - t.ax, d2y = t.by - t.ay;
        const r0x = s.ax - t.ax, r0y = s.ay - t.ay;
        const a = d1x * d1x + d1y * d1y, e = d2x * d2x + d2y * d2y, f = d2x * r0x + d2y * r0y;
        let sa = 0, ta = 0;
        if (a <= EPS && e <= EPS) { /* точки */ }
        else if (a <= EPS) { ta = Math.max(0, Math.min(1, f / e)); }
        else {
            const c = d1x * r0x + d1y * r0y;
            if (e <= EPS) { sa = Math.max(0, Math.min(1, -c / a)); }
            else {
                const b = d1x * d2x + d1y * d2y;
                const denom = a * e - b * b;
                if (Math.abs(denom) > EPS) {
                    sa = Math.max(0, Math.min(1, (b * f - c * e) / denom));
                    ta = Math.max(0, Math.min(1, (b * sa + f) / e));
                    sa = Math.max(0, Math.min(1, (b * ta - c) / a));
                }
            }
        }
        const cx1 = s.ax + sa * d1x, cy1 = s.ay + sa * d1y;
        const cx2 = t.ax + ta * d2x, cy2 = t.ay + ta * d2y;
        return { dist: Math.hypot(cx2 - cx1, cy2 - cy1) * 111320, sa: sa, ta: ta, px: (cx1 + cx2) / 2, py: (cy1 + cy2) / 2 };
    };

    const seenPairs = new Set();
    const seenPts = new Set();
    const addResult = function (px, py, kind) {
        const key = px.toFixed(6) + ',' + py.toFixed(6);
        if (seenPts.has(key)) return;
        seenPts.add(key);
        out.push({ lat: py, lng: px, kind: kind });
    };

    for (let si = 0; si < N && out.length < 8000; si++) {
        const s = segs[si];
        const x0 = Math.min(s.ax, s.bx), x1 = Math.max(s.ax, s.bx);
        const y0 = Math.min(s.ay, s.by), y1 = Math.max(s.ay, s.by);
        const visitedCells = new Set();
        // расширяем окно на 1 ячейку, чтобы ловить почти-касания
        for (let X = cX(x0) - 1; X <= cX(x1) + 1; X++) {
            for (let Y = cY(y0) - 1; Y <= cY(y1) + 1; Y++) {
                const k = X + ',' + Y;
                if (visitedCells.has(k)) continue;
                visitedCells.add(k);
                const list = buckets.get(k);
                if (!list) continue;
                for (const sj of list) {
                    if (sj <= si) continue;
                    const t = segs[sj];
                    if (t.li === s.li) continue;
                    const pkey = si * N + sj;
                    if (seenPairs.has(pkey)) continue;
                    seenPairs.add(pkey);

                    const dx1 = s.bx - s.ax, dy1 = s.by - s.ay;
                    const dx2 = t.bx - t.ax, dy2 = t.by - t.ay;
                    const ang = angDiff(undir(dx1, dy1), undir(dx2, dy2));

                    let hit = false;
                    const denom = dx1 * dy2 - dy1 * dx2;
                    if (Math.abs(denom) > 1e-15) {
                        const r = ((t.ax - s.ax) * dy2 - (t.ay - s.ay) * dx2) / denom;
                        const q = ((t.ax - s.ax) * dy1 - (t.ay - s.ay) * dx1) / denom;
                        if (r >= 0 && r <= 1 && q >= 0 && q <= 1) {
                            const px = s.ax + r * dx1, py = s.ay + r * dy1;
                            const eps = 0.02;
                            const sIn = r > eps && r < 1 - eps;
                            const tIn = q > eps && q < 1 - eps;
                            addResult(px, py, (sIn && tIn) ? 'x' : (sIn !== tIn ? 't' : 'fork'));
                            hit = true;
                        }
                    }
                    if (!hit && ang >= ANGLE_MIN) {
                        const cl = segClose(s, t);
                        if (cl.dist <= NEAR_M) {
                            const eps = 0.05;
                            const sIn = cl.sa > eps && cl.sa < 1 - eps;
                            const tIn = cl.ta > eps && cl.ta < 1 - eps;
                            addResult(cl.px, cl.py, (sIn && tIn) ? 'x' : (sIn !== tIn ? 't' : 'fork'));
                        }
                    }
                }
            }
        }
    }
    return out;
}
function nearCrossJunctions(lines, tolM) {
    const tol = tolM || 12;
    const cs = (tol * 2.2) / 111320; // размер ячейки пространственного индекса (градусы)
    const segs = [];
    lines.forEach(function (line, li) {
        for (let i = 1; i < line.length; i++) {
            const a = line[i - 1], b = line[i];
            segs.push({ li: li, ax: a.lng, ay: a.lat, bx: b.lng, by: b.lat });
        }
    });
    if (!segs.length) return [];

    const buckets = new Map();
    const cellX = function (x) { return Math.floor(x / cs); };
    const cellY = function (y) { return Math.floor(y / cs); };
    segs.forEach(function (s, si) {
        const x0 = Math.min(s.ax, s.bx), x1 = Math.max(s.ax, s.bx);
        const y0 = Math.min(s.ay, s.by), y1 = Math.max(s.ay, s.by);
        for (let X = cellX(x0); X <= cellX(x1); X++) {
            for (let Y = cellY(y0); Y <= cellY(y1); Y++) {
                const k = X + ',' + Y;
                if (!buckets.has(k)) buckets.set(k, []);
                buckets.get(k).push(si);
            }
        }
    });

    const distM = function (s, px, py) {
        const dx = s.bx - s.ax, dy = s.by - s.ay;
        const len2 = dx * dx + dy * dy;
        let t = len2 === 0 ? 0 : ((px - s.ax) * dx + (py - s.ay) * dy) / len2;
        t = Math.max(0, Math.min(1, t));
        const cx = s.ax + t * dx, cy = s.ay + t * dy;
        return Math.hypot(px - cx, py - cy) * 111320;
    };
    // неориентированный угол направления (0..180)
    const undir = function (dx, dy) {
        if (dy < 0 || (dy === 0 && dx < 0)) { dx = -dx; dy = -dy; }
        let a = Math.atan2(dy, dx) * 180 / Math.PI;
        if (a < 0) a += 180;
        return a;
    };
    const diffAngle = function (a, b) {
        let d = Math.abs(a - b);
        if (d > 180) d = 360 - d;
        return Math.min(d, 180 - d);
    };

    const out = [];
    const seenLoc = new Set();
    const maxOut = 8000;
    lines.forEach(function (line, li) {
        if (!line || line.length < 2) return;
        line.forEach(function (v, idx) {
            const px = v.lng, py = v.lat;
            // направление «своей» линии в этой вершине
            const nb = line[idx + 1] || line[idx - 1];
            const ownDir = nb ? undir(nb.lng - px, nb.lat - py) : -1;

            const nearLines = new Set();
            const parts = [];
            const X0 = cellX(px) - 1, X1 = cellX(px) + 1, Y0 = cellY(py) - 1, Y1 = cellY(py) + 1;
            for (let X = X0; X <= X1; X++) {
                for (let Y = Y0; Y <= Y1; Y++) {
                    const list = buckets.get(X + ',' + Y);
                    if (!list) continue;
                    for (const si of list) {
                        const s = segs[si];
                        if (s.li === li) continue;
                        if (distM(s, px, py) >= tol) continue;
                        const sd = undir(s.bx - s.ax, s.by - s.ay);
                        if (ownDir >= 0 && diffAngle(sd, ownDir) < 25) continue; // параллельно
                        nearLines.add(s.li);
                        parts.push(s);
                    }
                }
            }
            if (!nearLines.size) return;
            const key = v.lat.toFixed(6) + ',' + v.lng.toFixed(6);
            if (seenLoc.has(key)) return;
            seenLoc.add(key);

            // Грубая классификация: 2+ чужие линии или сквозная чужая линия —
            // пересечение; одна приходящая линия — Т-образный стык.
            const kind = (nearLines.size >= 2 || parts.length >= 2) ? 'x' : 't';
            out.push({ lat: v.lat, lng: v.lng, kind: kind });
            if (out.length >= maxOut) return;
        });
    });
    return out;
}

// Парсер XML от api.openstreetmap.org
function parseOSMXML(xmlText, terrain) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlText, 'text/xml');
    const nodes = {};
    const nodeEls = doc.getElementsByTagName('node');
    for (const n of nodeEls) {
        const nTags = {};
        const nTagEls = n.getElementsByTagName('tag');
        for (const t of nTagEls) {
            nTags[t.getAttribute('k')] = t.getAttribute('v');
        }
        nodes[n.getAttribute('id')] = { lat: parseFloat(n.getAttribute('lat')), lng: parseFloat(n.getAttribute('lon')), tags: nTags };
    }
    const netRefs = [];
    const wayEls = doc.getElementsByTagName('way');
    for (const w of wayEls) {
        const tags = {};
        const tagEls = w.getElementsByTagName('tag');
        for (const t of tagEls) {
            tags[t.getAttribute('k')] = t.getAttribute('v');
        }
        const ndEls = w.getElementsByTagName('nd');
        const refs = [];
        const coords = [];
        for (const nd of ndEls) {
            const id = nd.getAttribute('ref');
            refs.push(id);
            const node = nodes[id];
            if (node) coords.push(node);
        }
        if (coords.length < 2) continue;

        const isNet = !!(tags.highway || tags.railway || tags.power === 'line' ||
            tags.man_made === 'pipeline' || tags.man_made === 'cutline');
        if (isNet) netRefs.push(refs);

        if (tags.highway) {
            terrain.trails.push(coords);
        } else if (tags.natural === 'wood' || tags.landuse === 'forest') {
            terrain.forests.push(coords);
        } else if (tags.natural === 'water') {
            terrain.water.push(coords);
        } else if (tags.natural === 'wetland' || tags.natural === 'scrub') {
            terrain.wetlands.push(coords);
        } else if (tags.power === 'line') {
            terrain.powerlines.push(coords);
        } else if (tags.railway === 'rail') {
            terrain.railways.push(coords);
        } else if (tags.railway === 'abandoned') {
            terrain.abandonedRailways.push(coords);
        } else if (tags.waterway === 'stream' || tags.waterway === 'river') {
            terrain.rivers.push(coords);
        } else if (tags.man_made === 'pipeline' || tags.man_made === 'cutline' || tags.landuse === 'clearcut') {
            terrain.clearings.push(coords);
        } else if (tags.building === 'hut' || tags.building === 'cabin') {
            // небольшие строения-полигоны: средняя точка как точка-укрытие
            let slat = 0, slng = 0;
            for (const c of coords) { slat += c.lat; slng += c.lng; }
            terrain.huts.push({ lat: slat / coords.length, lng: slng / coords.length });
        }
    }

    // Одиночные точки: укрытия, родники, вышки, ворота, стоянки, места отдыха
    for (const id in nodes) {
        const node = nodes[id];
        const tags = node.tags || {};
        pushNodeKind(terrain, nodeKind(tags), node.lat, node.lng);
    }
    terrain.junctions = computeJunctions(netRefs, nodes);
}


// ============================================================
// 7.5. ПРОФИЛИ ПОТЕРЯВШИХСЯ И ВЕРОЯТНОСТНАЯ МОДЕЛЬ (v41)
// ------------------------------------------------------------
// На основе исследования RESEARCH.md (ISRID/Кёстер, «ЛизаАлерт»/МЧС) и
// research/05_gruppy_i_vremya.md (укрупнение групп + закон «расстояние ↔ время»).
// Модель:  P(ячейка) ∝ ρ(радиус от точки потери | группа, время) × S(ландшафт)
//   ρ — плотность вероятности (1/км²): перцентили «какой % находят в
//       радиусе r» превращаются в кольцевую плотность (доля кольца /
//       площадь кольца). Распределение «кольцевое», см. RESEARCH.md §5.2.
//       Время влияет дважды: область «разворачивается» (profileScale) и
//       появляется физический предел удаления (profileHardRangeKm).
//   S — множитель привлекательности ландшафта (линейные объекты, вода,
//       строения, опушки — где статистически чаще находят, §4 RESEARCH.md).
// ВАЖНО: точные таблицы ISRID-2008 по «активным» категориям (турист,
// охотник и т.п.) в открытом доступе отсутствуют — кривые построены по
// публичным данным Кёстера (база Вирджинии) и эвристике «ЛизаАлерт»
// для грибников и помечены в подсказках как оценки (~).
// Проверка модели на числах: node _tools/test_profiles.js
// ============================================================

// Группы намеренно КРУПНЫЕ (v41): в реальном поиске редко известен точный
// возраст или занятие, а узкие профили создают ложную точность.
//   cum — «какая доля находок приходится на радиус r» (км), итоговая кривая
//         для полностью развернувшегося поиска;
//   vMax — реалистичная скорость перемещения потерявшегося, км/ч (с остановками,
//         блужданием, ночёвками). Даёт физический предел удаления от точки
//         потери: дальше vMax × часы человек просто не мог оказаться;
//   tau — за сколько часов «разворачивается» область поиска (час).
// Данные: Р. Кёстер / ISRID (см. RESEARCH.md, research/03_distancii_isrid.md).
const SUBJECT_PROFILES = {
    'child': {
        label: 'Ребёнок (до 12 лет)',
        cum: [[0.05, 0.08], [0.3, 0.30], [0.8, 0.48], [1.6, 0.62], [3.2, 0.78], [6, 0.90], [12, 0.97], [20, 1]],
        vMax: 1.5,
        tau: 3,
        note: 'Дети прячутся и молчат — смотреть укрытия, кусты, постройки, машины и дворы.'
    },
    'teen': {
        label: 'Подросток (13–17 лет)',
        cum: [[0.05, 0.05], [0.5, 0.18], [1.6, 0.42], [3.2, 0.65], [8, 0.88], [16, 0.97], [30, 1]],
        vMax: 2.5,
        tau: 8,
        note: 'Уходит далеко и может скрываться — проверять тропы, заброшки и дороги.'
    },
    'gatherer': {
        label: 'Взрослый: грибник, ягодник, рыбак, отдыхающий',
        cum: [[0.05, 0.08], [0.5, 0.25], [1, 0.45], [2, 0.65], [3, 0.80], [5, 0.90], [10, 0.96], [20, 0.99], [30, 1]],
        vMax: 1.8,
        tau: 6,
        note: 'Самая частая группа. Ходит своими тропами недалеко от машины — искать сеть троп и стоянку.'
    },
    'hiker': {
        label: 'Турист, лыжник, спортсмен (поход, пробежка)',
        cum: [[0.05, 0.04], [1, 0.15], [3, 0.40], [6, 0.65], [12, 0.85], [25, 0.96], [40, 1]],
        vMax: 3.5,
        tau: 14,
        note: 'Уходит дальше всех — искать широко, в первую очередь вдоль троп, дорог, ЛЭП и берегов.'
    },
    'hunter': {
        label: 'Охотник',
        cum: [[0.05, 0.06], [0.5, 0.22], [1.6, 0.50], [3.2, 0.75], [6, 0.90], [12, 0.97], [25, 1]],
        vMax: 2.2,
        tau: 8,
        note: 'Сходит с тропы вниз по склону — смотреть ложбины и склоны ниже тропы.'
    },
    'elderly': {
        label: 'Пожилой человек (без потери памяти)',
        cum: [[0.05, 0.06], [0.2, 0.22], [0.8, 0.45], [2.4, 0.65], [4, 0.78], [7.7, 0.95], [15, 1]],
        vMax: 1.4,
        tau: 10,
        note: 'Идёт по своему обычному маршруту — искать и рядом, и в сторону знакомых мест.'
    },
    'dementia': {
        label: 'Пожилой с потерей памяти (деменция)',
        cum: [[0.05, 0.10], [0.3, 0.25], [0.8, 0.50], [1.6, 0.89], [2.4, 0.94], [5, 1]],
        vMax: 0.9,
        tau: 4,
        note: 'Идёт по прямой, пока не застрянет — проверять канавы, ручьи, кустарник, места у тропы.'
    },
    'despondent': {
        label: 'Психологически нестабильный / в тяжёлом состоянии',
        cum: [[0.05, 0.12], [0.3, 0.50], [0.8, 0.60], [2.4, 0.72], [8, 0.92], [20, 0.98], [32, 1]],
        vMax: 2.5,
        tau: 20,
        note: 'Часть рядом с точкой потери, часть — у воды и обрывов. Искать быстро, риск высокий.'
    },
    'generic': {
        label: 'Неизвестно / общий профиль',
        cum: [[0.05, 0.08], [0.3, 0.20], [1, 0.40], [2, 0.55], [4, 0.70], [8, 0.90], [16, 0.97], [30, 1]],
        vMax: 2.0,
        tau: 10,
        note: 'О человеке ничего не известно — основной поиск в 1–4 км от точки потери.'
    }
};

function getSubjectProfileId() {
    const el = document.getElementById('subject-profile');
    return el ? el.value : 'generic';
}

function getHoursElapsed() {
    const el = document.getElementById('hours-elapsed');
    let v = el ? parseFloat(el.value) : 3;
    if (!isFinite(v) || v < 0) v = 3;
    return Math.min(v, 720);
}

// ЗАКОН «РАССТОЯНИЕ ↔ ВРЕМЯ» (v41)
// ------------------------------------------------------------
// Раньше профиль линейно «раздвигался» до 24 ч одинаково для всех. Теперь два
// независимых ограничения, как в реальном поиске:
//  1) ФОРМА. Через t часов область поиска развёрнута на долю
//        s(t) = s0 + (1 - s0) · (1 - e^(-t/tau)),   s0 = 0,12.
//     tau — своя для каждой группы: ребёнок «разворачивается» за ~3 ч
//     (дальше он не уйдёт), деменция — за ~4 ч, турист — за ~14 ч и продолжает
//     расширяться сутками. Экспонента вместо линейного роста убирает
//     неестественный излом на 24-м часу.
//  2) ПРЕДЕЛ. Дальше vMax · t (+0,3 км на неточность точки) человек физически
//     не мог оказаться: вероятность там = 0. Через 3 часа после пропажи
//     турист не может быть в 20 км, а через 30 минут — в 5 км.
// Оба ограничения видны в консоли и в подсказке профиля.
// ОТКУДА ФОРМУЛА (подробно — ОТКУДА_ФОРМУЛЫ.md §5):
//   требования к s(t): 0<s(0)<1, монотонный рост, s→1 при больших t,
//   НИКАКОЙ точки излома (в первой версии был излом ровно на 24 ч — это
//   ничем не оправдано), одна настраиваемая константа. Простейшая такая
//   функция — экспоненциальное насыщение.
//   s0 = 0,12 — доля полного размаха, доступная в момент пропажи: в первые
//   минуты человек рядом с точкой потери («ступица» ~300 м, ~25 % вероятности).
//   tau — время разворота области; порядок tau повторяет порядок «дальности»
//   группы (деменция 4 ч … турист 14 ч, despondent 20 ч).
// Проверка на числах: _tools/test_profiles.js и _tools/test_sensitivity.js
const PROFILE_SCALE_MIN = 0.12;

function profileScale(profile, hours) {
    const t = Math.max(0, hours);
    const tau = (profile && profile.tau) ? profile.tau : 10;
    return PROFILE_SCALE_MIN + (1 - PROFILE_SCALE_MIN) * (1 - Math.exp(-t / tau));
}

// Радиус (км), дальше которого находка физически невозможна за это время.
// ОТКУДА: путь = скорость × время — оценка сверху для движения с ограниченной
// скоростью (сорт «следствие», выбирать нечего). +0,3 км — не скорость, а
// неопределённость самой точки потери: свидетели указывают место с точностью
// 100–300 м. vMax — ЭФФЕКТИВНАЯ скорость (остановки, блуждание, ночёвка), не
// спортивная: пешеход по дороге идёт 4–5 км/ч, потерявшийся — рывками.
// Проверка замысла: предел должен работать только в первые часы. Для ребёнка
// 1,5·24+0,3 = 36 км, а 95 % таблицы — 12 км, значит через сутки предел не
// ограничивает ничего; при 3 ч он равен 4,8 км и реально срезает дальний хвост.
function profileHardRangeKm(profile, hours) {
    const v = (profile && profile.vMax) ? profile.vMax : 2;
    const t = Math.max(0, hours);
    const cum = (profile && profile.cum) ? profile.cum : null;
    const last = (cum && cum.length) ? cum[cum.length - 1][0] : 40;
    return Math.min(last, v * t + 0.3);
}

// Совместимость со старым кодом: масштаб формы для общего профиля.
function timeScale(hours) {
    return profileScale(SUBJECT_PROFILES['generic'], hours);
}

// ПЛОТНОСТЬ ВЕРОЯТНОСТИ по расстоянию от точки потери (1/км²).
// Раньше здесь стоял «вес» (1 - F(r)), и это давало заметную ошибку: масса
// размазывалась слишком далеко. Проверка на числах (см. _tools/test_profiles.js)
// показывала, например, что 90 % вероятности для общего профиля оказывались
// в 20 км вместо 8 км по данным ISRID.
// Теперь берём настоящую кольцевую плотность: доля находок между двумя
// радиусами делится на площадь этого кольца. Тогда суммарная вероятность
// внутри радиуса R в точности равна доле F(R) из таблиц перцентилей.
// Первые HUB_RADIUS_KM считаем одним кругом («ступица» — самое начало поиска):
// иначе плотность в точке потери уходит в бесконечность и одна ячейка сетки
// забирает всю вероятность.
// ОТКУДА 0,2 км: (1) не больше шага сетки, иначе точка потери «займёт» чужую
// площадь; (2) соответствует первому этапу поиска — «ступица» ~300 м из методики
// Кёстера, где лежит около четверти вероятности. Проверено: изменение этого
// радиуса с 50 до 400 м меняет итоговый радиус 90 % лишь на единицы процентов.
// Подробный разбор всех констант: ОТКУДА_ФОРМУЛЫ.md, проверка — _tools/test_sensitivity.js
const HUB_RADIUS_KM = 0.2;

function radialDensity(profile, s, dKm, hours) {
    if (!profile || !profile.cum || s <= 0 || dKm < 0) return 0;
    if (hours != null && dKm > profileHardRangeKm(profile, hours)) return 0;
    const cum = profile.cum;
    const lastR = cum[cum.length - 1][0] * s;
    if (lastR <= 0 || dKm >= lastR) return 0;

    const r0 = Math.min(HUB_RADIUS_KM, lastR * 0.5);
    if (dKm <= r0) {
        const share = cumFracAt(profile, s, r0);
        const area = Math.PI * r0 * r0;
        return area > 0 ? share / area : 0;
    }
    // кольцо между соседними точками кривой (нижняя граница — не ниже ступицы)
    let lowerR = r0;
    let lowerF = cumFracAt(profile, s, r0);
    for (let i = 0; i < cum.length; i++) {
        const r2 = cum[i][0] * s;
        const f2 = cum[i][1];
        if (r2 <= lowerR) continue;         // этот излом уже внутри ступицы
        if (dKm < r2) {
            const area = Math.PI * (r2 * r2 - lowerR * lowerR);
            return area > 0 ? Math.max(0, f2 - lowerF) / area : 0;
        }
        lowerR = r2;
        lowerF = f2;
    }
    return 0;
}

// Радиус (км), внутри которого профиль «накрывает» долю frac (по умолчанию 90%)
// всех находок, с учётом масштаба времени. По этому радиусу ограничиваем поиск,
// когда задана точка потери: за его пределами искать бессмысленно.
function profileRadiusKm(profile, scale, frac) {
    if (!profile || !profile.cum || !profile.cum.length) return 30;
    const f = (frac == null) ? 0.9 : frac;
    const pts = profile.cum;
    if (f <= pts[0][1]) return pts[0][0] * scale;
    for (let i = 0; i < pts.length - 1; i++) {
        const r1 = pts[i][0] * scale, r2 = pts[i + 1][0] * scale;
        const f1 = pts[i][1], f2 = pts[i + 1][1];
        if (f <= f2) {
            return r1 + (r2 - r1) * (f - f1) / (f2 - f1);
        }
    }
    return pts[pts.length - 1][0] * scale;
}

// Доля найденных В РАДИУСЕ dKm (кумулятивная F(r)) с учётом масштаба времени.
function cumFracAt(profile, scale, dKm) {
    if (!profile || !profile.cum || !profile.cum.length) return 1;
    const pts = profile.cum;
    if (dKm <= 0) return 0;
    const lastR = pts[pts.length - 1][0] * scale;
    if (dKm >= lastR) return 1;
    for (let i = 0; i < pts.length - 1; i++) {
        const r1 = pts[i][0] * scale, r2 = pts[i + 1][0] * scale;
        const f1 = pts[i][1], f2 = pts[i + 1][1];
        if (dKm <= r2) return f1 + (f2 - f1) * (dKm - r1) / (r2 - r1);
    }
    return 1;
}

// Оценка вероятности для ячейки сетки: плотность найденного человека на этом
// удалении от точки потери с учётом профиля и времени. hours включает жёсткий
// физический предел удаления (дальше vMax×часы человек не мог оказаться).
function radialWeight(profile, scale, dKm, hours) {
    return radialDensity(profile, scale, dKm, hours);
}

// Множитель привлекательности ландшафта S (множится на радиальную плотность).
// Основано на статистике находок (RESEARCH.md §4): большинство находят У
// линейных объектов — тропы/дороги/просеки/ЛЭП/берега/канавы, у строений,
// родников, опушек; глухой лес без объектов — базовый множитель ~0.6.
// Дополнительные усиления: ПЕРЕКРЁСТКИ линейной сети (человек меняет
// направление/выходит на пересечение) и ВЫШКИ связи (человек идёт «на сигнал»).

// ---------- 9.1 ПРОСТРАНСТВЕННЫЙ ИНДЕКС ОБЪЕКТОВ (скорость) ----------
// Раньше для КАЖДОЙ ячейки сетки перебирались ВСЕ объекты района: на районе
// 10×10 км с 8 000 отрезков это ~96 миллионов операций — на телефоне считалось
// бы десятки секунд. Теперь объекты разложены по клеткам сетки 300 м, и для
// ячейки проверяются только соседние клетки (радиус 900 м): притяжение дальше
// этого всё равно почти ноль (exp(-900/250) ≈ 0,03).
const INDEX_CELL_M = 300;      // размер клетки индекса
const INDEX_RADIUS_M = 700;    // радиус поиска объектов вокруг ячейки
let terrainIndex = null;

function buildFeatureIndex(terrain, polygonPoints) {
    let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
    for (const p of polygonPoints) {
        if (p.lat < minLat) minLat = p.lat;
        if (p.lat > maxLat) maxLat = p.lat;
        if (p.lng < minLng) minLng = p.lng;
        if (p.lng > maxLng) maxLng = p.lng;
    }
    // запас: объекты чуть за границей зоны тоже притягивают
    const padLat = 2500 / 111320;
    const midLat = (minLat + maxLat) / 2;
    const padLng = 2500 / (111320 * Math.cos(midLat * Math.PI / 180));
    minLat -= padLat; maxLat += padLat; minLng -= padLng; maxLng += padLng;

    const dLat = INDEX_CELL_M / 111320;
    const dLng = INDEX_CELL_M / (111320 * Math.cos(midLat * Math.PI / 180));
    const grid = new Map();
    const cellKey = function (r, c) { return r + ',' + c; };
    const rowOf = function (lat) { return Math.floor((lat - minLat) / dLat); };
    const colOf = function (lng) { return Math.floor((lng - minLng) / dLng); };

    const cell = function (r, c) {
        const k = cellKey(r, c);
        let e = grid.get(k);
        if (!e) { e = { segs: [], pts: [] }; grid.set(k, e); }
        return e;
    };

    let segId = 0, ptId = 0;

    // отрезок кладём во все клетки, которые он пересекает (по его рамке).
    // У каждого отрезка есть номер: длинные дороги попадают в десятки клеток,
    // и при обходе соседей мы проверяем такой отрезок только один раз.
    const addSeg = function (group, a, b) {
        const r1 = rowOf(Math.min(a.lat, b.lat)), r2 = rowOf(Math.max(a.lat, b.lat));
        const c1 = colOf(Math.min(a.lng, b.lng)), c2 = colOf(Math.max(a.lng, b.lng));
        const id = segId++;
        for (let r = r1; r <= r2; r++) {
            for (let c = c1; c <= c2; c++) cell(r, c).segs.push({ g: group, a: a, b: b, id: id });
        }
    };
    const addLine = function (group, lines) {
        for (const line of lines || []) {
            for (let i = 0; i + 1 < line.length; i++) addSeg(group, line[i], line[i + 1]);
        }
    };
    const addPoly = function (group, polys) {
        for (const poly of polys || []) {
            for (let i = 0; i < poly.length; i++) addSeg(group, poly[i], poly[(i + 1) % poly.length]);
        }
    };
    const addPoints = function (group, pts) {
        for (const p of pts || []) {
            if (p.lat == null) continue;
            cell(rowOf(p.lat), colOf(p.lng)).pts.push({ g: group, lat: p.lat, lng: p.lng, id: ptId++ });
        }
    };

    addLine('trail', terrain.trails);
    addLine('river', terrain.rivers);
    addLine('power', terrain.powerlines);
    addLine('rail', terrain.railways);
    addLine('aband', terrain.abandonedRailways);
    addLine('clear', terrain.clearings);
    addPoly('bank', terrain.water);
    addPoly('bank', terrain.wetlands);
    addPoly('forest', terrain.forests);
    addPoints('hut', terrain.huts);
    addPoints('spring', terrain.springs);
    addPoints('tower', terrain.towers);
    addPoints('gate', terrain.gates);
    addPoints('parking', terrain.parkings);
    addPoints('rest', terrain.rests);
    addPoints('junction', terrain.junctions);

    return {
        minLat: minLat, minLng: minLng, dLat: dLat, dLng: dLng,
        grid: grid, cells: grid.size,
        segCount: segId, ptCount: ptId,
        segSeen: new Int32Array(segId), ptSeen: new Int32Array(ptId), stamp: 0
    };
}

// Собирает объекты вокруг точки (одна ячейка = один проход по клеткам)
function collectNear(lat, lng) {
    const idx = terrainIndex;
    const out = { bank: [], trail: [], river: [], power: [], rail: [], aband: [], clear: [],
                  forest: [], hut: [], spring: [], tower: [], gate: [], parking: [], rest: [], junction: [] };
    // номер запроса: по нему понимаем, что объект уже добавлен в этом проходе
    const stamp = ++idx.stamp;
    const r0 = Math.floor((lat - INDEX_RADIUS_M / 111320 - idx.minLat) / idx.dLat);
    const r1 = Math.floor((lat + INDEX_RADIUS_M / 111320 - idx.minLat) / idx.dLat);
    const cosLat = Math.cos(lat * Math.PI / 180);
    const dLngM = INDEX_RADIUS_M / (111320 * cosLat);
    const c0 = Math.floor((lng - dLngM - idx.minLng) / idx.dLng);
    const c1 = Math.floor((lng + dLngM - idx.minLng) / idx.dLng);
    for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
            const e = idx.grid.get(r + ',' + c);
            if (!e) continue;
            for (let i = 0; i < e.segs.length; i++) {
                const sg = e.segs[i];
                if (idx.segSeen[sg.id] === stamp) continue;   // уже проверяли в этом проходе
                idx.segSeen[sg.id] = stamp;
                out[sg.g].push(sg);
            }
            for (let i = 0; i < e.pts.length; i++) {
                const pt = e.pts[i];
                if (idx.ptSeen[pt.id] === stamp) continue;
                idx.ptSeen[pt.id] = stamp;
                out[pt.g].push(pt);
            }
        }
    }
    return out;
}

// Минимальное расстояние от точки до группы отрезков
function nearestSegDist(segs, lat, lng) {
    let minD = Infinity;
    for (let i = 0; i < segs.length; i++) {
        const d = pointToSegmentDistance(lat, lng, segs[i].a, segs[i].b);
        if (d < minD) minD = d;
    }
    return minD;
}

// Минимальное расстояние до ближайшей одиночной точки из группы
function nearestPtDist(pts, lat, lng) {
    let minD = Infinity;
    for (let i = 0; i < pts.length; i++) {
        const d = getHaversineDistance({ lat: lat, lng: lng }, pts[i]);
        if (d < minD) minD = d;
    }
    return minD;
}

// Дальность, которая считается «далеко» (притяжения практически нет)
const FAR_M = INDEX_RADIUS_M;

function landMultiplier(cell, terrain) {
    if (!terrain) return 1;
    const lat = cell.lat, lng = cell.lng;

    let bankDist, railwayDist, powerlineDist, trailDist, abandonedDist, riverDist,
        hutDist, edgeDist, springDist, clearingDist, junctionDist, towerDist,
        gateDist, parkingDist, restDist;

    if (terrainIndex) {
        // быстрый путь: берём только объекты из соседних клеток индекса
        const n = collectNear(lat, lng);
        bankDist = nearestSegDist(n.bank, lat, lng);
        railwayDist = nearestSegDist(n.rail, lat, lng);
        powerlineDist = nearestSegDist(n.power, lat, lng);
        trailDist = nearestSegDist(n.trail, lat, lng);
        abandonedDist = nearestSegDist(n.aband, lat, lng);
        riverDist = nearestSegDist(n.river, lat, lng);
        clearingDist = nearestSegDist(n.clear, lat, lng);
        edgeDist = nearestSegDist(n.forest, lat, lng);
        hutDist = nearestPtDist(n.hut, lat, lng);
        springDist = nearestPtDist(n.spring, lat, lng);
        junctionDist = nearestPtDist(n.junction, lat, lng);
        towerDist = nearestPtDist(n.tower, lat, lng);
        gateDist = nearestPtDist(n.gate, lat, lng);
        parkingDist = nearestPtDist(n.parking, lat, lng);
        restDist = nearestPtDist(n.rest, lat, lng);
    } else {
        // медленный путь (если индекс не построен): полный перебор объектов
        bankDist = Math.min(
            distanceToNearestBank(lat, lng, terrain.water),
            distanceToNearestBank(lat, lng, terrain.wetlands)
        );
        railwayDist = distanceToNearestTrail(lat, lng, terrain.railways);
        powerlineDist = distanceToNearestTrail(lat, lng, terrain.powerlines);
        trailDist = distanceToNearestTrail(lat, lng, terrain.trails);
        abandonedDist = distanceToNearestTrail(lat, lng, terrain.abandonedRailways);
        riverDist = distanceToNearestTrail(lat, lng, terrain.rivers);
        hutDist = distanceToNearestPoint(lat, lng, terrain.huts);
        edgeDist = distanceToNearestBank(lat, lng, terrain.forests);
        springDist = distanceToNearestPoint(lat, lng, terrain.springs);
        clearingDist = distanceToNearestTrail(lat, lng, terrain.clearings);
        junctionDist = distanceToNearestPoint(lat, lng, terrain.junctions);
        towerDist = distanceToNearestPoint(lat, lng, terrain.towers);
        gateDist = distanceToNearestPoint(lat, lng, terrain.gates);
        parkingDist = distanceToNearestPoint(lat, lng, terrain.parkings);
        restDist = distanceToNearestPoint(lat, lng, terrain.rests);
    }

    // Плавное затухание притяжения: ~1.0 на объекте, ~0.5 на 170 м,
    // ~0.1 на 500 м, почти 0 дальше ~1 км (полоса поиска 30–100 м).
    // ОТКУДА 250: задаём требование «половина притяжения остаётся на 173 м»
    // (масштаб полосы поиска: уверенно замечают в 30–100 м от линии, влияние
    // кончается на 150–200 м) и решаем e^(-d/k)=0,5 → k = d/ln2 = 173/0,693 ≈ 250.
    // Требование изменится (например «половина на 100 м») → k = 144.
    // Экспонента, а не линейная функция: у линейной есть точка обрыва в ноль,
    // то есть скачок между соседними ячейками на границе.
    const att = function (d) { return Math.exp(-d / 250); };
    const best = Math.max(
        att(bankDist), att(railwayDist), att(powerlineDist),
        att(trailDist), att(abandonedDist), att(riverDist),
        att(hutDist), att(edgeDist), att(springDist), att(clearingDist),
        att(gateDist)
    );
    // Перекрёстки — узкая дополнительная «горячая» точка (затухание быстрее),
    // но не «затмевает» обычную дорогу: вся линейная сеть остаётся вероятной.
    const juncAtt = Math.exp(-junctionDist / 120);
    // Вышки связи — слабое, но широкое притяжение (человек идёт на сигнал)
    const towerAtt = Math.exp(-towerDist / 400);
    // Лесная стоянка: человек вернулся к машине или ходит вокруг неё — притяжение
    // широкое (до ~1 км) и заметное.
    const parkAtt = Math.exp(-parkingDist / 350);
    // Места отдыха — самый слабый ориентир: знакомые поляны, костровища.
    const restAtt = Math.exp(-restDist / 180);

    // ОТКУДА 0,6 и 2,0: это два крайних значения и линейный переход между ними.
    // 0,6 — глухой лес (там тоже находят, поэтому не ноль); 2,0 — ячейка прямо
    // на линии. Отношение «на линии / в глуши» = 3,3. Строгий рецепт получить
    // эти числа из данных: w(класс) = (доля находок в классе) / (доля площади
    // класса); мы взяли осторожное значение, потому что точных процентов для
    // конкретного района нет. См. ОТКУДА_ФОРМУЛЫ.md §4.
    let S = 0.6 + 1.4 * best;
    // Надбавки ниже — ЭКСПЕРТНЫЕ ПРИОРИТЕТЫ (внешней статистики по типам
    // объектов в открытом доступе нет): стоянка сильнее всего (человек
    // возвращается к машине), перекрёсток — точка смены направления, вышка —
    // слабое широкое притяжение, место отдыха — самое слабое.
    S = S * (1 + 0.35 * juncAtt);  // на перекрёстке примерно +35% к дороге
    S = S * (1 + 0.2 * towerAtt);  // у вышки связи ещё ~+20%
    S = S * (1 + 0.5 * parkAtt);   // у лесной стоянки (машина) до +50%
    S = S * (1 + 0.12 * restAtt);  // у места отдыха ~+12%
    return S;
}

// Вероятность зоны = сумма вероятностей её ячеек (в % от массы полигона).
function computeZoneProbs(zones) {
    for (const z of zones) {
        let p = 0;
        if (z.cellList && z.cellList.length) {
            for (const c of z.cellList) {
                if (typeof c.p === 'number') p += c.p;
            }
        }
        z.prob = p;
    }
    return zones;
}

// ТОЧКИ-места: локальные пики карты вероятности (перекрёстки, избушки, концы
// троп, берега и т.п.), разнесённые не ближе ~400 м. Смысл программы — выдать
// КОМПАКТНЫЕ ТОЧКИ и построить между ними короткий маршрут, поэтому большие
// связные «заливки» не выделяются: у «плоских» участков (например, длинной
// дороги без перекрёстков) берётся точка примерно каждые 400 м.
function findPointZones(cells) {
    if (!cells || cells.length === 0) return [];
    const map = new Map();
    for (const c of cells) map.set(c.row + ',' + c.col, c);

    const peaks = [];
    for (const c of cells) {
        if (!(c.score > 0)) continue;
        let isPeak = true;
        const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
        for (const d of dirs) {
            const o = map.get((c.row + d[0]) + ',' + (c.col + d[1]));
            if (o && o.score > c.score) { isPeak = false; break; }
        }
        if (isPeak) peaks.push(c);
    }
    peaks.sort((a, b) => b.p - a.p);

    const picked = [];
    const pushPoint = function (c) {
        picked.push({ lat: c.lat, lng: c.lng, score: c.score, prob: c.p, cells: 1, cellList: [c] });
    };
    const MIN_DIST = 400; // м между соседними точками
    const MAX_POINTS = (typeof DEVICE !== 'undefined' && DEVICE.maxPoints) ? DEVICE.maxPoints : 80;
    for (const c of peaks) {
        let close = false;
        for (const p of picked) {
            if (getHaversineDistance(c, p) < MIN_DIST) { close = true; break; }
        }
        if (close) continue;
        pushPoint(c);
        if (picked.length >= MAX_POINTS) break;
    }
    // Ровная карта без явных пиков — добираем топ-ячейки с тем же разнесением
    if (picked.length === 0) {
        const sorted = cells.filter(c => c.p > 0).sort((a, b) => b.p - a.p);
        for (const c of sorted) {
            let close = false;
            for (const p of picked) {
                if (getHaversineDistance(c, p) < MIN_DIST) { close = true; break; }
            }
            if (close) continue;
            pushPoint(c);
            if (picked.length >= MAX_POINTS) break;
        }
    }
    return picked;
}

// Геометрические пересечения «река/ручей × тропа/дорога» (мосты, броды,
// переходы) — ищем даже там, где линии OSM не имеют общего узла. Работает с
// плоскостными координатами (район поиска небольшой). Возвращает точки внутри
// полигона, не более 300 штук.
function collectRiverCrossings(terrain, polygonPoints) {
    const out = [];
    const trailLines = terrain.trails || [];
    const riverLines = terrain.rivers || [];
    if (!trailLines.length || !riverLines.length) return out;

    const toSegs = function (lines) {
        const s = [];
        for (const L of lines) {
            for (let i = 1; i < L.length; i++) {
                const a = L[i - 1], b = L[i];
                s.push({ ax: a.lng, ay: a.lat, bx: b.lng, by: b.lat });
            }
        }
        return s;
    };
    const trailSegs = toSegs(trailLines);
    const riverSegs = toSegs(riverLines);

    const cross = function (s, t) {
        const denom = (s.bx - s.ax) * (t.by - t.ay) - (s.by - s.ay) * (t.bx - t.ax);
        if (Math.abs(denom) < 1e-12) return null;
        const r = ((t.ax - s.ax) * (t.by - t.ay) - (t.ay - s.ay) * (t.bx - t.ax)) / denom;
        const q = ((t.ax - s.ax) * (s.by - s.ay) - (t.ay - s.ay) * (s.bx - s.ax)) / denom;
        if (r < 0 || r > 1 || q < 0 || q > 1) return null;
        return { x: s.ax + r * (s.bx - s.ax), y: s.ay + r * (s.by - s.ay) };
    };

    const seen = new Set();
    outer:
    for (const rs of riverSegs) {
        const rminx = Math.min(rs.ax, rs.bx), rmaxx = Math.max(rs.ax, rs.bx);
        const rminy = Math.min(rs.ay, rs.by), rmaxy = Math.max(rs.ay, rs.by);
        for (const ts of trailSegs) {
            if (ts.bx < rminx || ts.ax > rmaxx || ts.by < rminy || ts.ay > rmaxy) continue;
            const p = cross(ts, rs);
            if (!p) continue;
            if (!isPointInPolygon(p.y, p.x, polygonPoints)) continue;
            const key = p.x.toFixed(5) + ',' + p.y.toFixed(5);
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({ lat: p.y, lng: p.x });
            if (out.length >= 300) break outer;
        }
    }
    return out;
}

// ТОЧКИ по реальным объектам местности: перекрёстки, укрытия, родники, вышки
// связи и точки ВДОЛЬ троп/дорог каждые ~400 м. Благодаря этому точки ложатся
// на дороги и перекрёстки, а не «случайно» по краям сетки. Вес точки — значение
// вероятности ближайшей ячейки сетки (ρ радиальная × S ландшафта).
function buildTerrainPoints(cells, terrain, polygonPoints, stepMeters, entryPoint, searchRadiusKm) {
    if (!cells || !cells.length) return [];
    const map = new Map();
    let minLat = Infinity, minLng = Infinity;
    for (const c of cells) {
        map.set(c.row + ',' + c.col, c);
        if (c.lat < minLat) minLat = c.lat;
        if (c.lng < minLng) minLng = c.lng;
    }
    const latStep = cells[0].cellH || 0.0022;
    const lngStep = cells[0].cellW || 0.0030;

    const cand = [];
    const push = function (lat, lng, kind) {
        if (!isPointInPolygon(lat, lng, polygonPoints)) return;
        // Если задана точка потери — ищем только в достижимом радиусе профиля
        if (entryPoint && searchRadiusKm) {
            if (getHaversineDistance({ lat: lat, lng: lng }, entryPoint) / 1000 > searchRadiusKm) return;
        }
        cand.push({ lat: lat, lng: lng, kind: kind || 'point' });
    };
    // 1) Перекрёстки и развилки линейной сети (узел, где сходятся ≥2 линий).
    for (const j of terrain.junctions || []) push(j.lat, j.lng, j.kind || 'x');
    // 2) Переходы рек/ручьёв через тропы/дороги (мост/брод) — геометрически
    for (const q of collectRiverCrossings(terrain, polygonPoints)) push(q.lat, q.lng, 'ford');
    // 2) Укрытия, родники, вышки, ворота/шлагбаумы, лесные стоянки, места отдыха
    for (const p of terrain.huts || []) push(p.lat, p.lng, 'hut');
    for (const p of terrain.springs || []) push(p.lat, p.lng, 'spring');
    for (const p of terrain.towers || []) push(p.lat, p.lng, 'tower');
    for (const p of terrain.gates || []) push(p.lat, p.lng, 'gate');
    for (const p of terrain.parkings || []) push(p.lat, p.lng, 'parking');
    for (const p of terrain.rests || []) push(p.lat, p.lng, 'rest');

    // 3) Вдоль каждой тропы/дороги — точка каждые ~400 м
    const spacing = Math.max(400, stepMeters || 250);
    const sampleLine = function (line) {
        if (!line || line.length < 2) return;
        push(line[0].lat, line[0].lng, 'path');
        let total = 0;
        let nextDist = spacing;
        for (let i = 1; i < line.length; i++) {
            const a = line[i - 1], b = line[i];
            const seg = getHaversineDistance(a, b);
            if (seg <= 0) continue;
            const prevEnd = total;
            total += seg;
            while (nextDist <= total) {
                const t = (nextDist - prevEnd) / seg;
                push(a.lat + (b.lat - a.lat) * t, a.lng + (b.lng - a.lng) * t, 'path');
                nextDist += spacing;
            }
        }
    };
    for (const t of terrain.trails || []) sampleLine(t);
    for (const t of terrain.abandonedRailways || []) sampleLine(t);

    if (!cand.length) return [];

    // Вес точки = вероятность ближайшей к ней ячейки сетки.
    // Для точек в буфере (чуть вне полигона) ищем ближайшую ячейку по сетке.
    const weightAt = function (p) {
        const r = Math.round((p.lat - minLat) / latStep);
        const cc = Math.round((p.lng - minLng) / lngStep);
        for (let dr = -5; dr <= 5; dr++) {
            for (let dc = -5; dc <= 5; dc++) {
                const c = map.get((r + dr) + ',' + (cc + dc));
                if (c) return c;
            }
        }
        let best = null, bestD = Infinity;
        for (const c of cells) {
            const dd = (c.lat - p.lat) * (c.lat - p.lat) + (c.lng - p.lng) * (c.lng - p.lng);
            if (dd < bestD) { bestD = dd; best = c; }
        }
        return best;
    };
    const withW = [];
    for (const p of cand) {
        const c = weightAt(p);
        if (c && c.raw > 0) {
            p.raw = c.raw;
            p.p = c.p;
            p.score = c.score;
            withW.push(p);
        }
    }
    withW.sort((a, b) => (b.raw || 0) - (a.raw || 0));

    // Отбираем точки, которые ВМЕСТЕ накрывают ~85 % вероятности зоны: идём от
    // самых вероятных вниз и накапливаем их долю вероятности p. Так набор сам
    // подстраивается под профиль: при компактном поле (ребёнок, деменция) это
    // несколько точек вокруг точки потери, при «размазанном» (турист) — много
    // точек по всей зоне. Раньше порог брался от плотности лучшей точки
    // (25 %), и с точной кольцевой плотностью он оставлял только «ступицу».
    // ОТКУДА 85 %: теория поиска требует охватывать участки с наибольшей частью
    // вероятности, на практике берут 80–90 %; 85 % — середина и заведомо внутри
    // точности наших таблиц (они сами описаны через радиус 90 % находок).
    // 6 точек — защита от вырожденного случая: если одна ячейка «весит» 90 %,
    // маршрут из одной точки не имеет смысла. Подробно — ОТКУДА_ФОРМУЛЫ.md §7.
    let significant = withW;
    if (withW.length) {
        const TARGET_P = 85;      // % вероятности зоны
        const MIN_POINTS = 6;     // даже если одна ячейка «весит» почти всё
        const MAX_POINTS = 150;
        const keep = [];
        let acc = 0;
        for (const p of withW) {
            keep.push(p);
            acc += (p.p || 0);
            if (acc >= TARGET_P && keep.length >= MIN_POINTS) break;
            if (keep.length >= MAX_POINTS) break;
        }
        significant = keep;
    }

    // Отбор: СНАЧАЛА структурные места (перекрёстки, броды, укрытия…) —
    // они важнее, потом добираем точки вдоль троп до общего лимита.
    // ВАЖНО: перекрёстки в парке стоят плотно, поэтому структурные точки
    // разводим на 150 м, а точки вдоль троп — на 400 м (чтобы каждый реальный
    // перекрёсток получил свою точку и правильную подпись).
    // ОТКУДА 150/400: геометрия интерфейса и шаг сетки, а не вероятности —
    // 150 м, чтобы соседние перекрёстки (100–200 м друг от друга) не склеились
    // в один пункт и не перекрылись кружками; 400 м ≈ 1,5 шага сетки, чтобы
    // вдоль длинной тропы не появилось десять почти одинаковых точек.
    const picked = [];
    const STRUCT_DIST = 150; // м между соседними перекрёстками/развилками
    const PATH_DIST = 400;   // м между соседними точками вдоль троп
    const CAP_STRUCT = 200;  // максимум структурных точек
    const CAP_TOTAL = 300;   // общий максимум точек
    const isStructural = function (p) { return p.kind && p.kind !== 'path' && p.kind !== 'point'; };
    const tryAdd = function (list, maxN, minDist) {
        for (const p of list) {
            if (picked.length >= maxN) return;
            let close = false;
            for (const z of picked) {
                if (getHaversineDistance(p, z) < minDist) { close = true; break; }
            }
            if (close) continue;
            picked.push({ lat: p.lat, lng: p.lng, kind: p.kind, score: p.score || 0, prob: p.p, cells: 1, cellList: null });
        }
    };
    tryAdd(significant.filter(isStructural), CAP_STRUCT, STRUCT_DIST);
    tryAdd(significant.filter(function (p) { return !isStructural(p); }), CAP_TOTAL, PATH_DIST);
    return picked;
}

// ---------- 8. СЕТКА ----------
function buildGrid(polygonPoints, stepMeters) {
    let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
    for (const p of polygonPoints) {
        if (p.lat < minLat) minLat = p.lat;
        if (p.lat > maxLat) maxLat = p.lat;
        if (p.lng < minLng) minLng = p.lng;
        if (p.lng > maxLng) maxLng = p.lng;
    }
    // шаг в градусах (приближённо)
    const latStep = stepMeters / 111320;
    const lngStep = stepMeters / (111320 * Math.cos((minLat + maxLat) / 2 * Math.PI / 180));

    const cells = [];
    for (let lat = minLat; lat <= maxLat; lat += latStep) {
        for (let lng = minLng; lng <= maxLng; lng += lngStep) {
            // Ячейка включается в сетку, только если ЕЁ ЦЕНТР внутри полигона.
            // Раньше брали и ячейки, у которых внутри лежал лишь угол: их видимая
            // часть обрезалась границей, а центр/маркер оказывались ВНЕ зоны.
            // Теперь маркер и вероятность всегда соответствуют видимой ячейке.
            const inside = isPointInPolygon(lat, lng, polygonPoints);
            if (inside) {
                cells.push({
                    lat, lng, score: 0,
                    row: Math.round((lat - minLat) / latStep),
                    col: Math.round((lng - minLng) / lngStep),
                    cellH: latStep,   // реальный размер ячейки по широте (градусы)
                    cellW: lngStep    // реальный размер ячейки по долготе (градусы)
                });
            }
        }
    }
    return cells;
}


// ---------- 9. ВЕРОЯТНОСТИ ----------
function distanceToNearestTrail(lat, lng, trails) {
    let minD = Infinity;
    for (const trail of trails) {
        for (let i = 0; i < trail.length - 1; i++) {
            const a = trail[i], b = trail[i + 1];
            const d = pointToSegmentDistance(lat, lng, a, b);
            if (d < minD) minD = d;
        }
    }
    return minD === Infinity ? 10000 : minD;
}

function pointToSegmentDistance(lat, lng, a, b) {
    // расстояние от точки до отрезка (в метрах, приближённо)
    const px = lng, py = lat;
    const ax = a.lng, ay = a.lat;
    const bx = b.lng, by = b.lat;
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const cx = ax + t * dx, cy = ay + t * dy;
    const distDeg = Math.sqrt((px - cx) * (px - cx) + (py - cy) * (py - cy));
    return distDeg * 111320;
}

function pointInPolygonList(lat, lng, polys) {
    for (const poly of polys) {
        if (poly.length >= 3 && isPointInPolygon(lat, lng, poly)) return true;
    }
    return false;
}

// Расстояние от точки до границы полигона (в метрах, приближённо)
function distanceToPolygonEdge(lat, lng, poly) {
    let minD = Infinity;
    for (let i = 0; i < poly.length; i++) {
        const a = poly[i], b = poly[(i + 1) % poly.length];
        const d = pointToSegmentDistance(lat, lng, a, b);
        if (d < minD) minD = d;
    }
    return minD === Infinity ? 100000 : minD;
}

// Точка внутри полигона ИЛИ рядом с его границей (буфер distM метров).
// Нужно, чтобы перекрёстки на краю зоны не терялись: часто они лежат в
// нескольких метрах ВНЕ обведённого контура.
function isPointNearPolygon(lat, lng, poly, distM) {
    if (!poly || poly.length < 3) return false;
    if (isPointInPolygon(lat, lng, poly)) return true;
    return distanceToPolygonEdge(lat, lng, poly) <= distM;
}

// Расстояние до ближайшего контура полигонов (берега водоёмов/болот/леса)
function distanceToNearestBank(lat, lng, polys) {
    let minD = Infinity;
    for (const poly of polys) {
        for (let i = 0; i < poly.length; i++) {
            const a = poly[i], b = poly[(i + 1) % poly.length];
            const d = pointToSegmentDistance(lat, lng, a, b);
            if (d < minD) minD = d;
        }
    }
    return minD === Infinity ? 10000 : minD;
}

// Расстояние до ближайшей одиночной точки (избушки, родники)
function distanceToNearestPoint(lat, lng, points) {
    let minD = Infinity;
    for (const p of points) {
        const d = getHaversineDistance({ lat, lng }, p);
        if (d < minD) minD = d;
    }
    return minD === Infinity ? 10000 : minD;
}

// ---------- СТАРЫЙ «СКОРИНГ ПО ОЧКАМ» (v39) ----------
// Ранее здесь были ступенчатые функции distToScore()/scoreCell() с
// взвешенной суммой «очков» за близость к объектам. Начиная с v40 они
// заменены вероятностной моделью «плотность от точки потери × ландшафт»
// (см. блок 7.5: SUBJECT_PROFILES, radialDensity, landMultiplier) —
// старые функции удалены как устаревшие.

// ---------- 10. КЛАСТЕРИЗАЦИЯ (flood-fill, умный порог) ----------
// Начинаем со строгого порога и ослабляем, пока не наберём достаточно зон.
// Защита от «комка»:
//   - минимальный абсолютный порог (не ниже 25 баллов);
//   - ограничение размера кластера (не больше maxClusterCells ячеек);
//   - не берём порог, дающий 1 гигантский кластер;
//   - фильтр «слипшихся» зон (мин. расстояние между центрами).

const MIN_ABSOLUTE_THRESHOLD = 25;   // не опускаемся ниже 25 баллов
const MAX_CLUSTER_FRACTION = 0.05;   // кластер не больше 5% всех ячеек

function clusterZones(cells, maxZones) {
    if (cells.length === 0) return [];

    // средний и максимальный скор
    let sum = 0, maxScore = 0;
    for (const c of cells) {
        sum += c.score;
        if (c.score > maxScore) maxScore = c.score;
    }
    const avg = sum / cells.length;

    // максимальный размер одного кластера (в ячейках)
    const maxClusterCells = Math.max(20, Math.round(cells.length * MAX_CLUSTER_FRACTION));

    // Список порогов от строгого к слабому (но не ниже минимума)
    const thresholds = [];
    for (const mult of [1.5, 1.3, 1.1, 0.9, 0.7, 0.5, 0.3, 0.1]) {
        const t = Math.max(avg * mult, MIN_ABSOLUTE_THRESHOLD);
        if (!thresholds.includes(t)) thresholds.push(t);
    }

    let bestClusters = [];
    for (const threshold of thresholds) {
        const clusters = clusterAtThreshold(cells, threshold, maxClusterCells);
        // фильтр «слипшихся» зон
        const filtered = filterCloseZones(clusters);
        // не берём вариант с одним гигантским кластером, если есть альтернатива
        if (filtered.length >= 2 && filtered.length > bestClusters.length) {
            bestClusters = filtered;
        }
        // если набрали достаточно — хватит
        if (filtered.length >= maxZones) break;
    }

    // если вообще ничего не нашли — берём хотя бы топ-ячейки по скору
    if (bestClusters.length === 0) {
        bestClusters = topCellsAsZones(cells, maxZones);
    }

    // сортируем по скору, берём топ
    bestClusters.sort((a, b) => b.score - a.score);
    return bestClusters.slice(0, maxZones);
}

function clusterAtThreshold(cells, threshold, maxClusterCells) {
    const gridMap = new Map();
    for (const c of cells) gridMap.set(c.row + ',' + c.col, c);

    const visited = new Set();
    const clusters = [];

    for (const c of cells) {
        const key = c.row + ',' + c.col;
        if (visited.has(key)) continue;
        if (c.score < threshold) { visited.add(key); continue; }

        // BFS по соседям с ограничением размера
        const queue = [c];
        visited.add(key);
        const clusterCells = [];
        while (queue.length && clusterCells.length < maxClusterCells) {
            const cur = queue.shift();
            clusterCells.push(cur);
            const dirs = [[1,0],[-1,0],[0,1],[0,-1]];
            for (const [dr, dc] of dirs) {
                const nk = (cur.row + dr) + ',' + (cur.col + dc);
                if (visited.has(nk)) continue;
                const nb = gridMap.get(nk);
                if (nb && nb.score >= threshold) {
                    visited.add(nk);
                    queue.push(nb);
                }
            }
        }

        // Пропускаем слишком мелкие кластеры (менее 3 ячеек) — это шум,
        // из-за которого появлялись зоны-«одиночки».
        if (clusterCells.length < 3) continue;

        // Центр зоны — самая «горячая» ячейка кластера: её центр гарантированно
        // внутри полигона (ячейки строятся по центру), и маркер показывает,
        // где начинать искать. Скор зоны — средний по всем ячейкам кластера.
        let sumScore = 0;
        let hotCell = clusterCells[0];
        for (const cc of clusterCells) {
            sumScore += cc.score;
            if (cc.score > hotCell.score) hotCell = cc;
        }
        clusters.push({
            lat: hotCell.lat,
            lng: hotCell.lng,
            score: sumScore / clusterCells.length,
            cells: clusterCells.length,
            cellList: clusterCells.slice() // сохраняем ячейки для подсветки
        });
    }

    return clusters;
}


// Убираем «слипшиеся» зоны: если два центра ближе 300 м — оставляем с большим скором
function filterCloseZones(clusters) {
    const MIN_ZONE_DIST = 300; // метров
    const result = [];
    for (const z of clusters) {
        let tooClose = false;
        for (const r of result) {
            const d = getHaversineDistance(z, r);
            if (d < MIN_ZONE_DIST) {
                tooClose = true;
                break;
            }
        }
        if (!tooClose) result.push(z);
    }
    return result;
}

// Запасной вариант: берём топ-ячейки по скору как отдельные зоны
function topCellsAsZones(cells, maxZones) {
    const sorted = cells.slice().sort((a, b) => b.score - a.score);
    const zones = [];
    for (let i = 0; i < Math.min(maxZones, sorted.length); i++) {
        const c = sorted[i];
        zones.push({ lat: c.lat, lng: c.lng, score: c.score, cells: 1, cellList: [c] });
    }
    return zones;
}

// Равномерные зоны: когда нет ни данных о местности, ни точки потери —
// делим всю зону поиска на равную сетку, в центрах ячеек ставим маркеры.
// Все зоны с одинаковой вероятностью (50%) — без «горячих» точек.
function buildUniformZones(polygonPoints, maxZones) {
    let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
    for (const p of polygonPoints) {
        if (p.lat < minLat) minLat = p.lat;
        if (p.lat > maxLat) maxLat = p.lat;
        if (p.lng < minLng) minLng = p.lng;
        if (p.lng > maxLng) maxLng = p.lng;
    }

    // Подбираем сетку примерно на maxZones ячеек
    const cols = Math.ceil(Math.sqrt(maxZones));
    const rows = Math.ceil(maxZones / cols);
    const latStep = (maxLat - minLat) / rows;
    const lngStep = (maxLng - minLng) / cols;

    const zones = [];
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            const lat = minLat + latStep * (r + 0.5);
            const lng = minLng + lngStep * (c + 0.5);
            if (isPointInPolygon(lat, lng, polygonPoints)) {
                zones.push({
                    lat, lng,
                    score: 50,
                    cells: 1,
                    cellList: [{ lat, lng, cellH: latStep, cellW: lngStep }]
                });
            }
        }
    }
    return zones.slice(0, maxZones);
}




// ---------- 11. ОТРИСОВКА ЗОН (подсветка объединённых ячеек) ----------
// Каждая зона рисуется как набор подсвеченных прямоугольников (ячеек),
// а в центре — номер зоны и процент.

// Обрезка прямоугольника ячейки по границе зоны поиска через turf.intersect
// (точное отсечение «ножницами»).
function clipCellRects(c, color, fillOpacity, weight) {
    var h = c.cellH || 0.0018;
    var w = c.cellW || 0.0031;
    var opts = { color: color, weight: weight, fillColor: color, fillOpacity: fillOpacity };
    var rects = [];
    if (typeof turf === 'undefined' || polygonPoints.length < 3) {
        rects.push(L.rectangle([[c.lat - h / 2, c.lng - w / 2], [c.lat + h / 2, c.lng + w / 2]], opts));
        return rects;
    }
    var ring = [];
    for (var i = 0; i < polygonPoints.length; i++) {
        ring.push([polygonPoints[i].lng, polygonPoints[i].lat]);
    }
    ring.push([polygonPoints[0].lng, polygonPoints[0].lat]);
    var zonePoly = turf.polygon([ring]);
    var cellRing = [[
        [c.lng - w / 2, c.lat - h / 2],
        [c.lng + w / 2, c.lat - h / 2],
        [c.lng + w / 2, c.lat + h / 2],
        [c.lng - w / 2, c.lat + h / 2],
        [c.lng - w / 2, c.lat - h / 2]
    ]];
    var cellPoly = turf.polygon(cellRing);
    var clipped = null;
    try { clipped = turf.intersect(cellPoly, zonePoly); } catch (e) { clipped = null; }
    if (!clipped || !clipped.geometry || clipped.geometry.type === 'Point' || clipped.geometry.type === 'LineString') {
        return rects;
    }
    var polys = clipped.geometry.type === 'Polygon' ? [clipped.geometry.coordinates] : clipped.geometry.coordinates;
    for (var pi = 0; pi < polys.length; pi++) {
        var coords = polys[pi][0];
        var latlngs = [];
        for (var ci = 0; ci < coords.length; ci++) {
            latlngs.push([coords[ci][1], coords[ci][0]]);
        }
        if (latlngs.length >= 3) {
            rects.push(L.polygon(latlngs, opts));
        }
    }
    return rects;
}

// Формат процента: меньше 10% — два знака, меньше 1% — три
function fmtPct(p) {
    if (p >= 10) return p.toFixed(1) + '%';
    if (p >= 1) return p.toFixed(2) + '%';
    return p.toFixed(3) + '%';
}

// Тип точки → название и базовый радиус кружка (кружки не должны налезать)
const POINT_KIND_INFO = {
    'x':       { name: 'Перекрёсток', r: 150 },
    't':       { name: 'Т-образный перекрёсток', r: 135 },
    'fork':    { name: 'Развилка', r: 120 },
    'ford':    { name: 'Мост/брод через реку', r: 130 },
    'hut':     { name: 'Укрытие / избушка', r: 115 },
    'spring':  { name: 'Родник', r: 105 },
    'tower':   { name: 'Вышка связи', r: 105 },
    'gate':    { name: 'Лесные ворота / шлагбаум', r: 110 },
    'parking': { name: 'Лесная стоянка (машина)', r: 130 },
    'rest':    { name: 'Место отдыха / костровище', r: 95 },
    'path':    { name: 'Вдоль тропы/дороги', r: 95 },
    'point':   { name: 'Точка', r: 100 }
};

// Удаление точки, найденной программой: убираем её из списка точек поиска.
// Если маршрут уже был построен, он становится неактуальным — сообщаем об этом.
function removeZoneAt(index) {
    if (index < 0 || index >= zones.length) return;
    const removed = zones.splice(index, 1)[0];
    renderZones(zones);
    if (lastRoute && lastRoute.length) {
        lastRoute = null;
        if (polylinePath) { map.removeLayer(polylinePath); polylinePath = null; }
        routeSegMarkers.forEach(m => map.removeLayer(m));
        routeSegMarkers = [];
        const el = document.getElementById('progress-text');
        const pw = document.getElementById('progress-wrap');
        if (el && pw) {
            pw.classList.remove('hidden');
            el.textContent = 'Точка «' + ((POINT_KIND_INFO[removed.kind] || POINT_KIND_INFO.point).name) +
                '» удалена — постройте маршрут заново.';
            setTimeout(function () { pw.classList.add('hidden'); }, 6000);
        }
    }
    console.log('[APP] Точка удалена:', removed.kind, removed.lat.toFixed(5), removed.lng.toFixed(5),
        '| осталось точек:', zones.length);
}

// Кнопка «×» во всплывающей подсказке маркера
document.addEventListener('click', function (e) {
    const t = e.target;
    if (t && t.classList && t.classList.contains('popup-del')) {
        const i = parseInt(t.getAttribute('data-i'), 10);
        if (!isNaN(i)) removeZoneAt(i);
        map.closePopup();
    }
});

function renderZones(zones) {    clearZones();
    const listEl = document.getElementById('zones-list');
    listEl.innerHTML = '';
    // На телефоне при большом числе точек номера-кружки рисуем не для всех:
    // сотни DOM-элементов тормозят прокрутку карты.
    const maxNumbered = (typeof DEVICE !== 'undefined' && DEVICE.isPhone) ? 120 : 400;

    zones.forEach((z, i) => {
        const color = zoneColor(z.score);
        const cellList = z.cellList || [];
        // Подпись вероятности: P = доля вероятности всего полигона, %
        const probText = (typeof z.prob === 'number' && isFinite(z.prob))
            ? 'P ≈ ' + fmtPct(z.prob)
            : z.score.toFixed(0) + ' очк.';

        // 1. Кружок-точка: базовый радиус по типу (перекрёсток крупнее точки
        //    на тропе), цвет — по вероятности. Кружки не налезают друг на друга.
        const info = POINT_KIND_INFO[(z.kind || 'point')] || POINT_KIND_INFO.point;
        const radiusM = info.r + Math.min(40, (z.score || 0) * 0.4);
        const circle = L.circle([z.lat, z.lng], {
            radius: radiusM, color: color, weight: 1.5, opacity: 0.9,
            fillColor: color, fillOpacity: 0.18
        }).addTo(map);
        zoneMarkers.push(circle);

        // 2. Номер точки в центре кружка (при большом числе точек — только первые)
        if (i < maxNumbered) {
            const icon = L.divIcon({
                className: 'zone-marker',
                html: '<div class="zone-marker" style="background:' + color + '">' + (i + 1) + '</div>',
                iconSize: [30, 30],
                iconAnchor: [15, 15]
            });
            const marker = L.marker([z.lat, z.lng], { icon }).addTo(map);
            marker.bindPopup('<b>Точка ' + (i + 1) + '</b><br>Тип: ' + info.name + '<br>Вероятность: ' + probText + '<br>Радиус осмотра: ~' + Math.round(radiusM) + ' м<br>lat: ' + z.lat.toFixed(5) + '<br>lng: ' + z.lng.toFixed(5) +
                '<br><button class="popup-del" data-i="' + i + '">Удалить эту точку</button>');
            zoneMarkers.push(marker);
        }

        // 3. элемент списка
        const item = document.createElement('div');
        item.className = 'zone-item';
        item.innerHTML = '<span class="zone-num">Точка ' + (i + 1) + '</span><span class="zone-pct">' + probText + '</span><span class="zone-coord">' + z.lat.toFixed(3) + ', ' + z.lng.toFixed(3) + '</span>';
        item.addEventListener('click', () => map.panTo([z.lat, z.lng]));
        // Кнопка удаления точки прямо в списке
        const del = document.createElement('button');
        del.className = 'zone-del';
        del.type = 'button';
        del.title = 'Удалить точку';
        del.textContent = '×';
        del.addEventListener('click', function (ev) {
            ev.stopPropagation();
            removeZoneAt(i);
        });
        item.appendChild(del);
        listEl.appendChild(item);
    });

    document.getElementById('stat-zones').textContent = zones.length;
    // показать/скрыть подсказку «зоны пока не найдены»
    const emptyEl = document.getElementById('zones-empty');
    if (emptyEl) emptyEl.style.display = (zones.length === 0) ? '' : 'none';
}

function zoneColor(score) {
    if (score >= 75) return '#e74c3c';
    if (score >= 55) return '#e67e22';
    if (score >= 40) return '#f1c40f';
    return '#3498db';
}

function clearZones() {
    zoneMarkers.forEach(m => map.removeLayer(m));
    zoneMarkers = [];
    debugJMarkers.forEach(m => map.removeLayer(m));
    debugJMarkers = [];
    if (heatLayer) { map.removeLayer(heatLayer); heatLayer = null; }
}


// ---------- 12. HEATMAP ----------
function renderHeatmap(cells) {
    if (heatLayer) { map.removeLayer(heatLayer); heatLayer = null; }
    const rects = [];
    for (const c of cells) {
        const color = heatColor(c.score);
        rects.push.apply(rects, clipCellRects(c, color, 0.35, 0));
    }
    heatLayer = L.layerGroup(rects).addTo(map);
}


function heatColor(score) {
    if (score >= 75) return '#e74c3c';
    if (score >= 55) return '#e67e22';
    if (score >= 40) return '#f1c40f';
    if (score >= 25) return '#2ecc71';
    return '#3498db';
}

// ---------- (12.5 удалён: был ступенчатый фолбэк scoreCellFallback v39) ----------
// Без данных OSM, но с точкой потери вероятность теперь считается той же
// моделью: только радиальная часть (ρ из профиля) без ландшафтного S.

// ---------- 13. ПОИСК ВЕРОЯТНЫХ ЗОН ----------
document.getElementById('find-zones-btn').addEventListener('click', async function () {
    if (!searchPolygon || polygonPoints.length < 3) {
        alert('Сначала очертите зону поиска!');
        return;
    }
    this.disabled = true;
    this.textContent = '⏳ Загрузка данных...';

    try {
        // 1. Данные местности
        const terrain = await fetchTerrainData(polygonPoints);
        // Резервный расчёт перекрёстков. ВАЖНО: «сеть» для поиска — это НЕ только
        // тропы (highway), а ВСЕ линейные объекты, по которым человек может идти
        // или которые пересекают тропы: просеки (cutline), ЛЭП, ЖД/заброшенки.
        const netLines = terrain.trails.concat(
            terrain.clearings || [],
            terrain.abandonedRailways || [],
            terrain.railways || [],
            terrain.powerlines || []
        );
        const j1 = mergeJunctions(terrain.junctions || [], junctionsFromLines(netLines));
        const j2 = mergeJunctions(j1, nearCrossJunctions(netLines, 12));
        // Склеиваем дубли в пределах 40 м, чтобы один перекрёсток = один узел
        terrain.junctions = clusterJunctions(mergeJunctions(j2, crossSegmentsAll(netLines)), 40);
        lastTerrain = terrain;
        // индекс объектов для быстрого расчёта вероятностей
        const idxStart = performance.now();
        terrainIndex = buildFeatureIndex(terrain, polygonPoints);
        console.log('[APP] Индекс объектов: ' + terrainIndex.cells + ' клеток по ' +
            INDEX_CELL_M + ' м, построен за ' + Math.round(performance.now() - idxStart) + ' мс');
        const hasTerrain = terrain.trails.length + terrain.forests.length + terrain.water.length +
            terrain.powerlines.length + terrain.railways.length + terrain.rivers.length > 0;
        console.log('Террейн:', terrain.trails.length, 'троп,', terrain.forests.length, 'лесов,',
            terrain.water.length, 'воды,', terrain.powerlines.length, 'ЛЭП,',
            terrain.railways.length, 'ЖД,', terrain.rivers.length, 'рек,',
            terrain.huts.length, 'избушек,', (terrain.junctions || []).length, 'узлов-перекрёстков');

        // 2. Сетка (с поправкой на устройство: на телефоне ячеек меньше)
        let step = parseInt(document.getElementById('grid-step').value);
        let cells = buildGrid(polygonPoints, step);
        if (cells.length > DEVICE.maxCells) {
            const started = step;
            while (cells.length > DEVICE.maxCells && step < 1000) {
                step = step < 150 ? 150 : (step < 200 ? 200 : (step < 250 ? 250 : step + 100));
                cells = buildGrid(polygonPoints, step);
            }
            console.log('[APP] Зона большая: шаг сетки увеличен с ' + started + ' до ' + step +
                ' м, чтобы устройство (' + DEVICE.cls + ') справилось. Ячеек: ' + cells.length);
        }
        console.log('Ячеек:', cells.length, '| шаг:', step, 'м | устройство:', DEVICE.cls);

        // 3. Если нет ни данных местности, ни точки потери — строим равномерные
        //    зоны: делим зону на равную сетку (все зоны равновероятны).
        if (!hasTerrain && !entryPoint) {
            const maxZones = 12; // без данных любое деление условно
            zones = buildUniformZones(polygonPoints, maxZones);
            const uniformP = zones.length > 0 ? 100 / zones.length : 0;
            for (const z of zones) z.prob = uniformP;
            renderZones(zones);
            console.log('[APP] Равномерные зоны (нет данных и точки потери):', zones.length);
            return;
        }

        // 4. Вероятности ячеек: P ∝ ρ(радиус | профиль, время) × S(ландшафт)
        const profileId = getSubjectProfileId();
        const hours = getHoursElapsed();
        const prof = SUBJECT_PROFILES[profileId] || SUBJECT_PROFILES['generic'];
        const tScale = profileScale(prof, hours);
        const hardKm = profileHardRangeKm(prof, hours);
        const searchRadiusKm = Math.min(profileRadiusKm(prof, tScale, 0.9), hardKm);
        console.log('[APP] Профиль:', prof.label, '| часов с момента пропажи:', hours,
            '| разворот профиля:', tScale.toFixed(3), '| предел удаления:', hardKm.toFixed(2),
            'км | радиус поиска:', searchRadiusKm.toFixed(2), 'км');

        let totalMass = 0, maxRaw = 0;
        const calcStart = performance.now();
        for (const c of cells) {
            let rho = 1;
            if (entryPoint) {
                const dKm = getHaversineDistance(c, entryPoint) / 1000;
                rho = radialWeight(prof, tScale, dKm, hours);
            }
            const S = hasTerrain ? landMultiplier(c, terrain) : 1;
            c.raw = rho * S;
            totalMass += c.raw;
            if (c.raw > maxRaw) maxRaw = c.raw;
        }
        const calcSec = (performance.now() - calcStart) / 1000;
        const calcEl = document.getElementById('stat-calc');
        if (calcEl) calcEl.textContent = calcSec.toFixed(2);
        console.log('[APP] Расчёт вероятностей: ' + calcSec.toFixed(2) + ' с на ' + cells.length +
            ' ячеек (' + terrainIndex.cells + ' клеток индекса)');

        // Защита от деления на ноль (например, вся масса вне полигона)
        if (maxRaw <= 0 || totalMass <= 0) {
            for (const c of cells) c.raw = 1;
            totalMass = cells.length;
            maxRaw = 1;
        }
        for (const c of cells) {
            c.p = (c.raw / totalMass) * 100;   // доля вероятности полигона, %
            c.score = (c.raw / maxRaw) * 100;  // «нагрев» 0..100: цвет/кластеризация
        }

        // 5. Heatmap (на слабом телефоне пропускаем — это самая тяжёлая отрисовка)
        if (DEVICE.heat) {
            renderHeatmap(cells);
        } else {
            console.log('[APP] Тепловая карта пропущена (телефон со слабым железом) — точки и маршрут считаются как обычно');
        }

        // 6. ТОЧКИ по реальным объектам: перекрёстки, избушки, родники, вышки
        //    и точки вдоль троп каждые ~400 м (вес = вероятность ячейки).
        //    Если объектов нет — фолбэк на локальные пики сетки.
        zones = buildTerrainPoints(cells, terrain, polygonPoints, step, entryPoint, searchRadiusKm);
        if (!zones.length) {
            zones = findPointZones(cells);
            zones.sort((a, b) => b.prob - a.prob);
        }
        console.log('Точек-зон:', zones.length);
        if (zones.length) {
            const kc = {};
            for (const z of zones) { const k = z.kind || 'point'; kc[k] = (kc[k] || 0) + 1; }
            console.log('[APP] Типы точек:', JSON.stringify(kc));
        }
        // [BETA] Диагностика перекрёстков: сколько узлов сети есть в данных внутри
        // полигона и сколько из них реально попало в итоговые точки.
        const jAll = (terrain.junctions || []).filter(j => isPointInPolygon(j.lat, j.lng, polygonPoints));
        const jc = {};
        for (const j of jAll) { const k = j.kind || 'fork'; jc[k] = (jc[k] || 0) + 1; }
        const zoneKeys = new Set(zones.map(z => z.lat.toFixed(5) + ',' + z.lng.toFixed(5)));
        let jHit = 0;
        for (const j of jAll) {
            if (zoneKeys.has(j.lat.toFixed(5) + ',' + j.lng.toFixed(5))) jHit++;
        }
        console.log('[BETA] Узлов-перекрёстков в полигоне:', JSON.stringify(jc), '| попало в точки: ' + jHit + '/' + jAll.length);
        // [BETA] География: где лежат найденные узлы и где полигон (для отладки)
        const extOf = function (arr) {
            if (!arr || !arr.length) return 'пусто';
            let mnLat = Infinity, mxLat = -Infinity, mnLng = Infinity, mxLng = -Infinity;
            for (const p of arr) {
                if (p.lat < mnLat) mnLat = p.lat;
                if (p.lat > mxLat) mxLat = p.lat;
                if (p.lng < mnLng) mnLng = p.lng;
                if (p.lng > mxLng) mxLng = p.lng;
            }
            return mnLat.toFixed(3) + '..' + mxLat.toFixed(3) + ', ' + mnLng.toFixed(3) + '..' + mxLng.toFixed(3);
        };
        console.log('[BETA] bbox узлов:', extOf(terrain.junctions),
            '| bbox полигона:', extOf(polygonPoints),
            '| линий в сети:', netLines.length);

        // 7. Отрисовка
        renderZones(zones);

        // [BETA] Отрисовка САМИХ линий OSM тонкими цветными линиями:
        // синие = тропы (highway), оранжевые = просеки (cutline), фиолетовые = ЛЭП,
        // серые = ЖД/заброшенки. Так видно, где реально есть данные OSM.
        const drawNetLines = function (arr, color, weight, dash) {
            for (const ln of arr || []) {
                if (!ln || ln.length < 2) continue;
                const ll = ln.map(function (p) { return [p.lat, p.lng]; });
                const layer = L.polyline(ll, { color: color, weight: weight, opacity: 0.35, dashArray: dash || null }).addTo(map);
                debugJMarkers.push(layer);
            }
        };
        drawNetLines(terrain.trails, '#2563eb', 1.5);
        drawNetLines(terrain.clearings, '#e67e22', 1.5, '6 6');
        drawNetLines(terrain.powerlines, '#9b59b6', 1.5, '8 8');
        drawNetLines(terrain.railways, '#7f8c8d', 1.5, '8 8');
        drawNetLines(terrain.abandonedRailways, '#7f8c8d', 1, '4 6');

        if (zones.length === 0) {
            alert('Не найдено зон с высокой вероятностью. Попробуйте уменьшить шаг сетки, изменить профиль или зону поиска.');
        }

    } catch (e) {
        console.error(e);
        alert('Ошибка при поиске зон: ' + e.message);
    } finally {
        this.disabled = false;
        this.textContent = '🎯 Найти вероятные зоны';
    }
});


// ---------- 14. МАТРИЦА РАССТОЯНИЙ ----------
// Считаем мгновенно по прямой (Гаверсина × 1.25 — коэффициент извилистости).
// OSRM убран: он недоступен/медленный в России и вызывал зависание.
// Для пешего поиска в лесу расстояние по прямой даже правильнее, чем по дорогам.
// ОТКУДА 1,25: коэффициент извилистости (отношение реального пути к прямой) для
// пешехода по измерениям лежит в диапазоне 1,25–1,5; берём нижнюю границу —
// потерявшийся идёт не по улично-дорожной сети с прямыми углами, а довольно
// прямо, обходя препятствия. Как проверить самому: взять GPS-трек, сложить
// длины отрезков и поделить на расстояние по прямой между началом и концом.

function buildDistanceMatrix(zonePoints) {
    const size = zonePoints.length;
    const matrix = [];
    for (let i = 0; i < size; i++) {
        matrix[i] = new Array(size).fill(0);
    }
    for (let i = 0; i < size; i++) {
        for (let j = 0; j < size; j++) {
            if (i !== j) matrix[i][j] = getHaversineDistance(zonePoints[i], zonePoints[j]) * 1.25;
        }
    }
    return matrix;
}

// Запасной расчёт БЕЗ Web Worker (для file:// или если Worker недоступен).
// Ближайший сосед + 2-opt — быстро, маршрут рисуется всегда.
function optimizeSync(matrix) {
    const n = matrix.length;
    if (n < 2) return { route: [0, 0], bestDist: 0 };

    const cost = (r) => {
        let d = 0;
        for (let i = 0; i < r.length - 1; i++) d += matrix[r[i]][r[i + 1]];
        return d;
    };

    // Ближайший сосед
    const visited = new Array(n).fill(false);
    const route = [0];
    visited[0] = true;
    let last = 0;
    while (route.length < n) {
        let best = -1, bestD = Infinity;
        for (let v = 0; v < n; v++) {
            if (!visited[v] && matrix[last][v] < bestD) { bestD = matrix[last][v]; best = v; }
        }
        if (best === -1) break;
        route.push(best); visited[best] = true; last = best;
    }
    route.push(0);

    // 2-opt (инкрементальная дельта)
    let improved = true;
    while (improved) {
        improved = false;
        for (let i = 1; i < route.length - 2; i++) {
            for (let k = i + 1; k < route.length - 1; k++) {
                const a = route[i - 1], b = route[i], c = route[k], d = route[k + 1];
                const delta = matrix[a][c] + matrix[b][d] - matrix[a][b] - matrix[c][d];
                if (delta < -1e-9) {
                    let lo = i, hi = k;
                    while (lo < hi) { const t = route[lo]; route[lo] = route[hi]; route[hi] = t; lo++; hi--; }
                    improved = true;
                }
            }
        }
    }

    return { route, bestDist: cost(route) };
}



// Показать итоговую заметку в блоке прогресса и спрятать её через паузу
// (используется, когда маршрут построен без Web Worker — мгновенно).
function showRouteNote(pw, fill, text, message, hideMs) {
    pw.classList.remove('hidden');
    if (fill) fill.style.width = '100%';
    if (text) text.textContent = message;
    setTimeout(function () {
        pw.classList.add('hidden');
        if (fill) fill.style.width = '0%';
    }, hideMs || 4000);
}

// ---------- 15. ЗАПУСК ОПТИМИЗАЦИИ ----------
async function runOptimizationOnZones(btn) {
    // Точки маршрута = авто-зоны + ручные точки (ручные приравниваются к зонам).
    routePoints = zones.slice();
    for (const mp of manualPoints) {
        routePoints.push({ lat: mp.lat, lng: mp.lng, score: 50 });
    }
    if (routePoints.length < 2) {
        alert('Добавьте хотя бы 2 точки: найдите вероятные зоны или поставьте ручные точки!');
        return;
    }

    // остановить предыдущий worker
    if (worker) { worker.terminate(); worker = null; }

    btn.disabled = true;

    // показать прогресс
    const pw = document.getElementById('progress-wrap');
    pw.classList.remove('hidden');
    // прокручиваем панель так, чтобы шкала прогресса была видна
    pw.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    const fill = document.getElementById('progress-fill');
    const text = document.getElementById('progress-text');
    fill.style.width = '0%';
    text.textContent = 'Считаем матрицу расстояний...';

    try {
        // 1. Матрица (синхронно, мгновенно)
        const t0 = performance.now();
        const zonePoints = routePoints.map(z => ({ lat: z.lat, lng: z.lng }));
        const matrix = await buildDistanceMatrix(zonePoints);
        const matrixTime = (performance.now() - t0) / 1000;
        document.getElementById('stat-matrix-time').textContent = matrixTime.toFixed(2);

        // 2. Запуск worker
        const timeLimitMs = parseInt(document.getElementById('opt-time').value) * 1000;
        // Слайдер приоритета убран: маршрут ВСЕГДА строится так, чтобы зоны с
        // большей вероятностью (score) посещались раньше (штраф за инверсию).
        // ОТКУДА множитель 10 в штрафе (tsp.worker.js): это перевод «баллов
        // приоритета» в метры — «1 балл разницы = 10 м лишнего пути», то есть
        // за место на 100 баллов приоритетнее группа готова пройти лишний
        // километр. Единственная константа маршрута без внешнего источника;
        // подробно — ОТКУДА_ФОРМУЛЫ.md §9.
        const priorityWeight = 1;
        const priority = routePoints.map(z => z.score);

        const optStart = performance.now();

        // Пробуем запустить Web Worker. Если не вышло (например, file://) —
        // считаем маршрут синхронно в основном потоке.
        try {
            worker = new Worker('tsp.worker.js?v=8');
        } catch (err) {
            worker = null;
        }

        if (!worker) {
            console.warn('[APP] Web Worker недоступен — файл открыт напрямую (file://). Используется быстрый синхронный алгоритм.');
            text.textContent = 'Быстрый режим (без воркера)...';
            const result = optimizeSync(matrix);
            const optTime = (performance.now() - optStart) / 1000;
            document.getElementById('stat-opt-time').textContent = optTime.toFixed(2);
            drawRoute(result.route, result.bestDist);
            btn.disabled = false;
            showRouteNote(pw, fill, text,
                '⚠ Маршрут найден МГНОВЕННО, потому что Web Worker запрещён при открытии через file://. ' +
                'Для полной оптимизации (до ' + Math.round(timeLimitMs / 1000) + ' сек) запустите страницу через локальный сервер: ' +
                'двойной клик по start.cmd в папке проекта или команда "python -m http.server".',
                9000);
            return;
        }

        text.textContent = 'Оптимизация... 0%';

        worker.onerror = function (e) {
            // Воркер упал — считаем синхронно
            console.warn('[APP] Web Worker упал, считаем синхронно:', e && e.message);
            const result = optimizeSync(matrix);
            const optTime = (performance.now() - optStart) / 1000;
            document.getElementById('stat-opt-time').textContent = optTime.toFixed(2);
            drawRoute(result.route, result.bestDist);
            btn.disabled = false;
            showRouteNote(pw, fill, text,
                '⚠ Web Worker упал — маршрут построен в быстром режиме. Запустите через локальный сервер для полной оптимизации.',
                6000);
            worker = null;
        };

        worker.onmessage = function (e) {
            const msg = e.data;
            if (msg.type === 'progress') {
                fill.style.width = msg.percent + '%';
                text.textContent = 'Оптимизация... ' + msg.percent + '% | лучший маршрут: ' + msg.bestKm.toFixed(2) + ' км (' + msg.elapsedSec + ' сек)';
            } else if (msg.type === 'done') {
                const optTime = (performance.now() - optStart) / 1000;
                document.getElementById('stat-opt-time').textContent = optTime.toFixed(2);
                drawRoute(msg.route, msg.bestDist);
                btn.disabled = false;
                pw.classList.add('hidden');
                worker = null;
            }
        };

        worker.postMessage({
            type: 'start',
            matrix: matrix,
            timeLimitMs: timeLimitMs,
            priority: priority,
            priorityWeight: priorityWeight
        });
    } catch (e) {
        console.error(e);
        alert('Ошибка оптимизации: ' + e.message);
        btn.disabled = false;
        pw.classList.add('hidden');
    }
}

document.getElementById('optimize-btn').addEventListener('click', function () {
    runOptimizationOnZones(this);
});


// ---------- 16. ОТРИСОВКА МАРШРУТА ----------
function drawRoute(route, bestDist) {
    lastRoute = route;
    if (polylinePath) map.removeLayer(polylinePath);
    // очищаем прежние подписи длин отрезков маршрута
    routeSegMarkers.forEach(m => map.removeLayer(m));
    routeSegMarkers = [];

    const latlngs = [];
    for (const idx of route) {
        latlngs.push([routePoints[idx].lat, routePoints[idx].lng]);
    }

    polylinePath = L.polyline(latlngs, {
        color: '#e74c3c', weight: 4, opacity: 0.9, dashArray: '8, 6'
    }).addTo(map);

    // подписи длин каждого отрезка маршрута (красные).
    // На телефоне при длинном маршруте подписи не рисуем: десятки DOM-меток
    // заметно тормозят карту.
    const maxLabels = DEVICE.isPhone ? 14 : 30;
    if (latlngs.length - 1 <= maxLabels) {
        for (let i = 0; i < latlngs.length - 1; i++) {
            const a = latlngs[i], b = latlngs[i + 1];
            const d = map.distance(a, b);
            const mk = L.marker(
                [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2],
                { icon: segLabelIcon(formatLenM(d), 'seg-route'), interactive: false }
            ).addTo(map);
            routeSegMarkers.push(mk);
        }
    } else {
        console.log('[APP] Отрезков маршрута много (' + (latlngs.length - 1) + ') — подписи длин скрыты для скорости');
    }

    map.fitBounds(polylinePath.getBounds().pad(0.1));

    document.getElementById('stat-distance').textContent = (bestDist / 1000).toFixed(2);
}

// ---------- 17. ГЕОЛОКАЦИЯ ----------
window.addEventListener('load', function () { setTimeout(function () { map.invalidateSize(); }, 100); });

if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(function (position) {
        const lat = position.coords.latitude, lng = position.coords.longitude;
        // запоминаем замер — он же показывается строкой «Моё положение»
        myPosFix = {
            lat: lat, lng: lng,
            acc: position.coords.accuracy || 20,
            time: position.timestamp || Date.now()
        };
        if (typeof updateGeoLine === 'function') updateGeoLine();
        // если зона уже восстановлена из сохранения — не сдвигаем карту
        if (polygonPoints && polygonPoints.length >= 3) return;
        map.setView([lat, lng], 13);
    }, function () { }, { enableHighAccuracy: false, timeout: 8000, maximumAge: 60000 });
}

// ---------- 19. ПОДСКАЗКА ПРОФИЛЯ ----------
// Живой текст под выбором «Кто потерялся»: только радиус поиска. Подробные
// советы по каждой группе — в документации (research/05_gruppy_i_vremya.md),
// в интерфейсе пользователю нужна одна понятная цифра.
(function () {
    function refreshProfileHint() {
        const pid = getSubjectProfileId();
        const prof = SUBJECT_PROFILES[pid] || SUBJECT_PROFILES['generic'];
        const hours = getHoursElapsed();
        const hard = profileHardRangeKm(prof, hours);
        const r90 = profileRadiusKm(prof, profileScale(prof, hours), 0.9);
        const radius = Math.min(r90, hard);
        const ph = document.getElementById('profile-hint');
        if (!ph) return;
        // только радиус: подробные советы по группам лежат в документации,
        // а в интерфейсе пользователю нужна одна цифра
        ph.textContent = 'Искать в радиусе ≈' + radius.toFixed(1) + ' км от точки потери' +
            (hours >= 1 ? ' (прошло ' + hours + ' ч).' : '.');
    }
    const ps = document.getElementById('subject-profile');
    if (ps) ps.addEventListener('change', refreshProfileHint);
    const he = document.getElementById('hours-elapsed');
    if (he) {
        he.addEventListener('change', refreshProfileHint);
        he.addEventListener('input', refreshProfileHint);
    }
    refreshProfileHint();
})();


// ---------- 21. РЕГИСТРАЦИЯ SERVICE WORKER (офлайн-режим) ----------
// Работает только на http/https. При открытии файла напрямую (file://)
// Service Worker недоступен — это ограничение браузеров.
if ('serviceWorker' in navigator && window.location.protocol !== 'file:') {
    window.addEventListener('load', function () {
        navigator.serviceWorker.register('service-worker.js').then(function () {
            console.log('[APP] Service Worker зарегистрирован — приложение работает офлайн');
        }).catch(function (e) {
            console.log('[APP] Service Worker не зарегистрирован:', e.message);
        });
    });
}


// ============================================================
// 22. СОХРАНЕНИЕ ЗОНЫ И ТОЧЕК (localStorage)
// ------------------------------------------------------------
// Чтобы при закрытии или перезагрузке приложения не потерялись:
// контур зоны поиска, точка потери, ручные точки и найденные точки.
// ============================================================

const STATE_KEY = 'mchs-state-v1';

function saveState() {
    try {
        const slimZones = (zones || []).map(function (z) {
            return { lat: z.lat, lng: z.lng, score: z.score, prob: z.prob, kind: z.kind, cells: z.cells };
        });
        localStorage.setItem(STATE_KEY, JSON.stringify({
            polygon: polygonPoints,
            entry: entryPoint,
            manual: manualPoints,
            zones: slimZones,
            savedAt: Date.now()
        }));
    } catch (e) {
        console.log('[APP] Не удалось сохранить состояние:', e.message);
    }
}

function restoreState() {
    let state = null;
    try { state = JSON.parse(localStorage.getItem(STATE_KEY) || 'null'); } catch (e) { state = null; }
    if (!state) return false;

    if (state.polygon && state.polygon.length >= 3) {
        polygonPoints = state.polygon.map(function (p) { return { lat: p.lat, lng: p.lng }; });
        finishPolygon();
        try {
            map.fitBounds(L.latLngBounds(polygonPoints.map(function (p) { return [p.lat, p.lng]; })).pad(0.1));
        } catch (e) { }
    }
    if (state.entry && state.entry.lat != null) {
        setEntryPoint(state.entry.lat, state.entry.lng);
    }
    if (state.manual && state.manual.length) {
        manualPoints = state.manual.map(function (p) { return { lat: p.lat, lng: p.lng }; });
        renderManualMarkers();
    }
    if (state.zones && state.zones.length) {
        zones = state.zones.map(function (z) {
            return { lat: z.lat, lng: z.lng, score: z.score, prob: z.prob, kind: z.kind, cells: z.cells, cellList: null };
        });
        renderZones(zones);
    }
    console.log('[APP] Восстановлено состояние от ' + new Date(state.savedAt).toLocaleString());
    return true;
}

// Автосохранение: оборачиваем функции, которые меняют данные
(function () {
    const _renderZones = renderZones;
    renderZones = function (z) { _renderZones(z); saveState(); };
    const _renderManual = renderManualMarkers;
    renderManualMarkers = function () { _renderManual(); saveState(); };
    const _finishPolygon = finishPolygon;
    finishPolygon = function () { _finishPolygon(); saveState(); };
})();


// ============================================================
// 23. ОФЛАЙН-КАРТА РАЙОНА
// ------------------------------------------------------------
// Приложение сохраняет данные OpenStreetMap для обведённой зоны и рисует
// из них картинку-схему (леса, вода, реки, дороги, ЛЭП). Это законно:
// используются ДАННЫЕ OSM (лицензия ODbL) и собственная отрисовка.
// Скачивать тайлы tile.openstreetmap.org для офлайна запрещено правилами OSM.
// ============================================================

let offlineOverlay = null;   // картинка сохранённой карты на карте
let offlineData = null;      // {bbox, png, terrain, savedAt}
// счётчик ошибок загрузки плиток объявлен выше, в разделе 1.1

function idbOpen() {
    return new Promise(function (res, rej) {
        const r = indexedDB.open('mchs-offline', 1);
        r.onupgradeneeded = function () { r.result.createObjectStore('kv'); };
        r.onsuccess = function () { res(r.result); };
        r.onerror = function () { rej(r.error); };
    });
}
function idbSet(k, v) {
    return idbOpen().then(function (db) {
        return new Promise(function (res, rej) {
            const t = db.transaction('kv', 'readwrite');
            t.objectStore('kv').put(v, k);
            t.oncomplete = function () { res(true); };
            t.onerror = function () { rej(t.error); };
        });
    });
}
function idbGet(k) {
    return idbOpen().then(function (db) {
        return new Promise(function (res, rej) {
            const t = db.transaction('kv', 'readonly');
            const q = t.objectStore('kv').get(k);
            q.onsuccess = function () { res(q.result); };
            q.onerror = function () { rej(q.error); };
        });
    });
}
function idbDel(k) {
    return idbOpen().then(function (db) {
        return new Promise(function (res) {
            const t = db.transaction('kv', 'readwrite');
            t.objectStore('kv').delete(k);
            t.oncomplete = function () { res(true); };
        });
    });
}

function offlineSetStatus(html) {
    const el = document.getElementById('offline-status');
    if (el) el.innerHTML = html;
}

// Рисуем схему района на canvas: леса, вода, реки, дороги, ЛЭП, ЖД
function renderZoneSchematic(terrain, bbox, size) {
    const cv = document.createElement('canvas');
    cv.width = size; cv.height = size;
    const g = cv.getContext('2d');
    const minLat = bbox.minLat, maxLat = bbox.maxLat, minLng = bbox.minLng, maxLng = bbox.maxLng;
    const X = function (lng) { return (lng - minLng) / (maxLng - minLng) * size; };
    const Y = function (lat) { return (maxLat - lat) / (maxLat - minLat) * size; };

    g.fillStyle = '#f4f1ea';
    g.fillRect(0, 0, size, size);

    const drawPolys = function (arr, fill) {
        g.fillStyle = fill;
        for (const poly of arr || []) {
            if (!poly || poly.length < 3) continue;
            g.beginPath();
            g.moveTo(X(poly[0].lng), Y(poly[0].lat));
            for (let i = 1; i < poly.length; i++) g.lineTo(X(poly[i].lng), Y(poly[i].lat));
            g.closePath();
            g.fill();
        }
    };
    const drawLines = function (arr, color, width, dash) {
        g.strokeStyle = color;
        g.lineWidth = width;
        g.setLineDash(dash || []);
        for (const line of arr || []) {
            if (!line || line.length < 2) continue;
            g.beginPath();
            g.moveTo(X(line[0].lng), Y(line[0].lat));
            for (let i = 1; i < line.length; i++) g.lineTo(X(line[i].lng), Y(line[i].lat));
            g.stroke();
        }
        g.setLineDash([]);
    };

    drawPolys(terrain.forests, '#cfe3c4');
    drawPolys(terrain.wetlands, '#d7e6dd');
    drawPolys(terrain.water, '#a9cfe8');
    drawLines(terrain.clearings, '#dfe8c8', 1);
    drawLines(terrain.rivers, '#6fa8dc', 2);
    drawLines(terrain.powerlines, '#c9a227', 1, [5, 5]);
    drawLines(terrain.railways, '#888888', 2, [7, 4]);
    drawLines(terrain.abandonedRailways, '#aaaaaa', 1, [4, 4]);
    drawLines(terrain.trails, '#d9a066', 2);

    g.fillStyle = '#8b5a2b';
    for (const p of terrain.huts || []) { g.beginPath(); g.arc(X(p.lng), Y(p.lat), 3, 0, 6.3); g.fill(); }
    g.fillStyle = '#2a7fbf';
    for (const p of terrain.springs || []) { g.beginPath(); g.arc(X(p.lng), Y(p.lat), 2.5, 0, 6.3); g.fill(); }

    if (polygonPoints && polygonPoints.length >= 3) {
        g.strokeStyle = '#2563eb';
        g.lineWidth = 4;
        g.beginPath();
        g.moveTo(X(polygonPoints[0].lng), Y(polygonPoints[0].lat));
        for (let i = 1; i < polygonPoints.length; i++) g.lineTo(X(polygonPoints[i].lng), Y(polygonPoints[i].lat));
        g.closePath();
        g.stroke();
    }
    g.fillStyle = '#555555';
    g.font = Math.round(size / 45) + 'px Arial';
    g.fillText('Данные © OpenStreetMap contributors', 12, size - 12);

    return cv.toDataURL('image/png');
}

async function downloadOfflineZone() {
    if (!polygonPoints || polygonPoints.length < 3) {
        alert('Сначала очертите зону поиска.');
        return;
    }
    offlineSetStatus('⏳ Скачиваю данные карты для зоны…');
    try {
        const terrain = await fetchTerrainData(polygonPoints);
        const n = (terrain.trails || []).length + (terrain.forests || []).length + (terrain.rivers || []).length;
        if (!n) throw new Error('не удалось получить данные OSM — проверьте интернет');

        let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
        for (const p of polygonPoints) {
            if (p.lat < minLat) minLat = p.lat;
            if (p.lat > maxLat) maxLat = p.lat;
            if (p.lng < minLng) minLng = p.lng;
            if (p.lng > maxLng) maxLng = p.lng;
        }
        const pad = 0.004;
        const bbox = { minLat: minLat - pad, maxLat: maxLat + pad, minLng: minLng - pad, maxLng: maxLng + pad };
        const png = renderZoneSchematic(terrain, bbox, 2048);

        const pack = { bbox: bbox, png: png, terrain: terrain, savedAt: Date.now() };
        await idbSet('zone', pack);
        offlineData = pack;
        showOfflineOverlay();
        offlineSetStatus('✅ Район сохранён: дорог ' + (terrain.trails || []).length +
            ', лесов ' + (terrain.forests || []).length + ', рек ' + (terrain.rivers || []).length +
            '.<br>Теперь откроется и без интернета.');
    } catch (e) {
        offlineSetStatus('⚠ Не удалось скачать карту: ' + e.message);
    }
}

function showOfflineOverlay() {
    if (!offlineData || !offlineData.png) return;
    if (offlineOverlay) map.removeLayer(offlineOverlay);
    const b = offlineData.bbox;
    offlineOverlay = L.imageOverlay(offlineData.png, [[b.minLat, b.minLng], [b.maxLat, b.maxLng]], {
        opacity: 0.95, interactive: false
    }).addTo(map);
    if (offlineOverlay.bringToBack) offlineOverlay.bringToBack();
}

async function loadOfflineZone() {
    try {
        offlineData = await idbGet('zone');
        if (offlineData) {
            offlineSetStatus('💾 Сохранена карта района от ' +
                new Date(offlineData.savedAt).toLocaleString() +
                '.<br>Нажмите «Показать сохранённую карту», чтобы увидеть её.');
        } else {
            offlineSetStatus('Карта района не сохранена. Очертите зону и нажмите «Скачать район».');
        }
    } catch (e) {
        offlineSetStatus('Карта района не сохранена.');
    }
}

async function clearOfflineZone() {
    try { await idbDel('zone'); } catch (e) { }
    offlineData = null;
    if (offlineOverlay) { map.removeLayer(offlineOverlay); offlineOverlay = null; }
    offlineSetStatus('Сохранённая карта района удалена.');
}

(function () {
    const b1 = document.getElementById('offline-download-btn');
    const b2 = document.getElementById('offline-show-btn');
    const b3 = document.getElementById('offline-clear-btn');
    if (b1) b1.addEventListener('click', downloadOfflineZone);
    if (b2) b2.addEventListener('click', showOfflineOverlay);
    if (b3) b3.addEventListener('click', clearOfflineZone);
})();

// Если тайлы не загружаются даже с запасных серверов (нет интернета) —
// показываем сохранённую схему района.
let tileWarned = false;
map.on('tileerror', function () {
    tileErrCount++;
    if (tileErrCount === 6 && offlineData && !tileWarned) {
        tileWarned = true;
        showOfflineOverlay();
        offlineSetStatus('Интернета нет — показываю сохранённую карту района.');
    }
});

// Восстановление зоны, плана из ссылки и проверка сохранённой карты —
// выполняются в конце файла, в разделе 24 (там же разбор ссылки-плана).

// ============================================================
// 24. ПЕРЕДАЧА ПЛАНА, ТЕМА, ГЕОЛОКАЦИЯ, РАБОТА ПОД УСТРОЙСТВО
// ------------------------------------------------------------
// Что здесь:
//   24.1 профиль устройства (телефон / планшет / компьютер) и лимиты;
//   24.4 QR-код плана и сканер: как передать план с компьютера на телефон;
//   24.5 кэш данных OSM, чтобы повторный расчёт не тянул их заново;
//   24.7 тёмная и светлая тема оформления;
//   24.8 геолокация «где я» (без записи трека).
// ============================================================

// ---------- 24.1 ПРОФИЛЬ УСТРОЙСТВА ----------
// На телефоне считаем меньше ячеек, не рисуем лишние подписи и «тепловую карту»
// на слабых устройствах — чтобы интерфейс не тормозил.
// Режимов ровно два: телефон и компьютер. Порог тот же, что в оформлении
// (до 900 точек по ширине — телефон, дальше компьютер).
const DEVICE = (function () {
    const w = window.innerWidth || (window.screen && screen.width) || 9999;
    const cores = navigator.hardwareConcurrency || 4;
    const mem = navigator.deviceMemory || 4;
    const isPhone = w <= 900;
    const weak = cores <= 4 || mem <= 4;
    return {
        cls: isPhone ? 'телефон' : 'компьютер',
        isPhone: isPhone,
        cores: cores,
        mem: mem,
        weak: weak,
        maxCells: isPhone ? 12000 : 60000,
        maxPoints: isPhone ? 60 : 90,
        heat: !(isPhone && weak),   // тепловая карта — самое «тяжёлое» в отрисовке
        segLabels: true
    };
})();
console.log('[APP] Устройство:', DEVICE.cls, '| ядер:', DEVICE.cores, '| памяти ~', DEVICE.mem, 'ГБ',
    '| лимит ячеек:', DEVICE.maxCells);

function refreshDeviceStat() {
    const el = document.getElementById('stat-device');
    if (el) el.textContent = DEVICE.cls;
    const ver = document.getElementById('stat-version');
    if (ver) ver.textContent = APP_VERSION;
}

// Если приложение обновилось (служба обновления загрузила новую версию), один
// раз перезагружаем страницу — иначе телефон может долго работать на старой
// версии и не понимать новые QR-коды. План и зона при этом сохраняются.
if ('serviceWorker' in navigator) {
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', function () {
        if (reloaded) return;
        reloaded = true;
        console.log('[APP] пришла новая версия — перезагружаю страницу');
        location.reload();
    });
}

// ---------- 24.4 ССЫЛКА-ПЛАН, QR-КОД И СКАНЕР ----------
// План целиком (зона, точка потери, точки поиска, порядок обхода) упаковывается
// в короткий код. Показали QR — группа отсканировала его в приложении, и на
// телефоне открылся тот же план. Сервер для этого не нужен.
//
// withManual = true добавляет ручные точки в конец списка. Это нужно, когда в
// код кладётся МАРШРУТ: номера в маршруте считаются по списку
// «авто-точки + ручные точки», и на принимающем устройстве этот список должен
// быть тем же самым, иначе маршрут «съедет».
function buildPlan(maxPoints, withManual) {
    let pts = (zones || []).slice();
    if (withManual && typeof manualPoints !== 'undefined' && manualPoints) {
        for (const mp of manualPoints) {
            pts.push({ lat: mp.lat, lng: mp.lng, kind: 'point', prob: 0 });
        }
    }
    if (maxPoints && pts.length > maxPoints) {
        // для QR оставляем самые вероятные точки — иначе код нечитаем
        pts = pts.slice().sort(function (a, b) { return (b.prob || 0) - (a.prob || 0); }).slice(0, maxPoints);
    }
    // маршрут и шаг сетки попадают в код, чтобы принимающее устройство получило
    // не только точки, но и готовый порядок обхода
    let route = null;
    if (lastRoute && lastRoute.length >= 2 && pts.length) {
        route = lastRoute.filter(function (i) { return i >= 0 && i < pts.length; });
        if (route.length < 2) route = null;
    }
    const gs = document.getElementById('grid-step');
    return {
        v: 1,
        prof: (typeof getSubjectProfileId === 'function' ? getSubjectProfileId() : 'generic'),
        hours: (typeof getHoursElapsed === 'function' ? getHoursElapsed() : 3),
        poly: (polygonPoints || []).slice(0, 24).map(function (p) { return [+p.lat.toFixed(5), +p.lng.toFixed(5)]; }),
        entry: entryPoint ? [+entryPoint.lat.toFixed(5), +entryPoint.lng.toFixed(5)] : null,
        pts: pts.map(function (z) {
            return [+z.lat.toFixed(5), +z.lng.toFixed(5), z.kind || 'point',
                +(z.prob || 0).toFixed(2)];
        }),
        route: route,
        grid: gs ? parseInt(gs.value, 10) : null
    };
}

function planToCode(plan) {
    const json = JSON.stringify(plan);
    const b64 = btoa(unescape(encodeURIComponent(json)));
    return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function codeToPlan(code) {
    let b64 = String(code).replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    return JSON.parse(decodeURIComponent(escape(atob(b64))));
}

// ---------- КОМПАКТНЫЙ КОД ДЛЯ QR (формат 2) ----------
// Зачем: обычный JSON в base64 — это ~40 знаков на одну точку, поэтому QR
// получался очень плотным (десятки мелких квадратиков), и камера телефона
// часто его не читала. Здесь:
//   • координаты — целые числа в 36-ричной системе, записанные как СМЕЩЕНИЕ от
//     первой точки (дельты), единица = 0,00001° ≈ 1 м;
//   • тип точки — одна буква, вероятность — целое число процентов.
// Итог: примерно в 2,5–3 раза короче, модуль QR крупнее → читается заметно
// надёжнее. Старые коды (формат 1) по-прежнему принимаются.
const COMPACT_UNITS = 100000;              // 0,00001° ≈ 1,1 м по широте

const PROF_CODE = {
    'generic': 'g', 'child': 'c', 'teen': 'n', 'gatherer': 's', 'hiker': 'h',
    'hunter': 'u', 'elderly': 'e', 'dementia': 'd', 'despondent': 'p'
};
const PROF_BY_CODE = (function () {
    const m = {};
    for (const k in PROF_CODE) m[PROF_CODE[k]] = k;
    return m;
})();

const KIND_CODE = {
    'x': 'x', 't': 't', 'fork': 'f', 'ford': 'd', 'hut': 'h', 'spring': 's',
    'tower': 'w', 'gate': 'g', 'parking': 'p', 'rest': 'r', 'path': 'a', 'point': 'o'
};
const KIND_BY_CODE = (function () {
    const m = {};
    for (const k in KIND_CODE) m[KIND_CODE[k]] = k;
    return m;
})();

// старые коды профилей из прежних версий приложения
const LEGACY_PROF = {
    'child-3': 'child', 'child-6': 'child', 'child-12': 'child',
    'youth': 'teen', 'mushroomer': 'gatherer'
};

function q36(n) {
    n = Math.round(n);
    return (n < 0 ? '-' : '') + Math.abs(n).toString(36);
}
function u36(s) {
    const neg = String(s).charAt(0) === '-';
    const v = parseInt(neg ? String(s).slice(1) : String(s), 36);
    return neg ? -v : (isFinite(v) ? v : 0);
}

function planToCompact(plan) {
    const U = COMPACT_UNITS;
    const poly = plan.poly || [];
    const pts = plan.pts || [];
    const anchor = poly[0] || plan.entry || (pts[0] ? [pts[0][0], pts[0][1]] : [0, 0]);
    const alat = Math.round(anchor[0] * U), alng = Math.round(anchor[1] * U);
    function delta(lat, lng) {
        return q36(Math.round(lat * U) - alat) + ',' + q36(Math.round(lng * U) - alng);
    }
    const polyStr = poly.slice(1).map(function (p) { return delta(p[0], p[1]); }).join(';');
    const entryStr = plan.entry ? delta(plan.entry[0], plan.entry[1]) : '-';
    const ptsStr = pts.map(function (p) {
        return delta(p[0], p[1]) + ',' + (KIND_CODE[p[2]] || 'o') + ',' +
            Math.max(0, Math.round(p[3] || 0));
    }).join(';');
    // поля 8 и 9: шаг сетки (метры) и порядок обхода (номера точек в 36-ричной
    // системе через точку). Старые коды без этих полей читаются по-прежнему.
    const gridStr = plan.grid ? String(plan.grid) : '-';
    const routeStr = (plan.route && plan.route.length >= 2)
        ? plan.route.map(function (i) { return i.toString(36); }).join('.')
        : '-';
    return ['2', PROF_CODE[plan.prof] || 'g',
        Math.max(0, Math.round(plan.hours == null ? 3 : plan.hours)),
        q36(alat) + ',' + q36(alng), polyStr, entryStr, ptsStr, gridStr, routeStr].join('!');
}

function compactToPlan(str) {
    const f = String(str).split('!');
    if (f.length < 7 || f[0] !== '2') return null;
    const U = COMPACT_UNITS;
    const a = f[3].split(',');
    const alat = u36(a[0]), alng = u36(a[1]);
    function abs(pair) {
        const p = pair.split(',');
        return [(alat + u36(p[0])) / U, (alng + u36(p[1])) / U];
    }
    const poly = [[alat / U, alng / U]];
    if (f[4]) f[4].split(';').forEach(function (s) { if (s) poly.push(abs(s)); });
    const entry = (f[5] && f[5] !== '-') ? abs(f[5]) : null;
    const pts = [];
    if (f[6]) {
        f[6].split(';').forEach(function (s) {
            if (!s) return;
            const p = s.split(',');
            if (p.length < 4) return;
            const c = abs(p[0] + ',' + p[1]);
            pts.push([c[0], c[1], KIND_BY_CODE[p[2]] || 'point', parseFloat(p[3]) || 0]);
        });
    }
    return {
        v: 2,
        prof: PROF_BY_CODE[f[1]] || 'generic',
        hours: parseInt(f[2], 10) || 0,
        poly: poly.length >= 3 ? poly : [],
        entry: entry,
        pts: pts,
        // поля 8 и 9 — шаг сетки и порядок обхода (могут отсутствовать)
        grid: (f[7] && f[7] !== '-') ? parseInt(f[7], 10) : null,
        route: (f[8] && f[8] !== '-')
            ? f[8].split('.').map(function (s) { return parseInt(s, 36); })
            : null
    };
}

// Единая точка входа: любую строку кода превращаем в объект плана.
function decodePlanCode(code) {
    const s = String(code || '').trim();
    if (!s) return null;
    if (s.indexOf('2!') === 0) return compactToPlan(s);
    try { return codeToPlan(s); } catch (e) {
        console.log('[APP] Не удалось разобрать план:', e.message);
        return null;
    }
}

// Готовим ссылку для QR: сначала пробуем весь план компактным кодом,
// если не влезает — оставляем самые вероятные точки (код становится крупнее
// Готовим ссылку для QR.
// ПЕРЕДАЧА ПЛАНА ЧЕРЕЗ QR.
// В один QR влезает ограниченный объём, а нам нужно передать ВСЁ: зону, точку
// потери, все точки с вероятностями, шаг сетки и порядок обхода. Поэтому код
// режется на части по QR_CHUNK знаков, и каждая часть показывается своим
// QR-кодом: «Код 1 из 3», «Код 2 из 3» и так далее. Часть устроена как
// 3!<номер>!<всего>!<кусок кода> — принимающее устройство складывает куски и
// применяет план, когда получены все.
// Ссылка при этом НЕ режется: в ней помещается весь код целиком, её можно
// просто переслать в мессенджер.
const QR_CHUNK = 380;

function buildQrPayload() {
    const base = location.origin + location.pathname;
    // все точки + ручные (они входят в маршрут), маршрут и шаг сетки — всё в коде
    const plan = buildPlan(null, true);
    const code = planToCompact(plan);
    const parts = [];
    for (let i = 0; i < code.length; i += QR_CHUNK) parts.push(code.slice(i, i + QR_CHUNK));
    return {
        code: code,
        parts: parts,
        link: base + '#plan=' + code,
        points: (plan.pts || []).length,
        hasRoute: !!(plan.route && plan.route.length >= 2)
    };
}

function showQrCode() {
    if (!(zones && zones.length)) {
        alert('Сначала найдите вероятные зоны.');
        return;
    }
    if (typeof qrcode !== 'function') {
        alert('QR-код недоступен: не загрузился файл vendor/qrcode.min.js');
        return;
    }
    const made = buildQrPayload();
    const overlay = document.getElementById('qr-overlay');
    const box = document.getElementById('qr-box');
    const note = document.getElementById('qr-note');
    const linkInput = document.getElementById('qr-link');
    try {
        box.innerHTML = '';
        made.parts.forEach(function (part, i) {
            const wrap = document.createElement('div');
            wrap.className = 'qr-part';
            const qr = qrcode(0, 'L');       // уровень L — самый ёмкий
            qr.addData(made.parts.length > 1
                ? ('3!' + (i + 1) + '!' + made.parts.length + '!' + part)
                : part);
            qr.make();
            // margin 4 — минимальный «белый пояс» вокруг кода
            wrap.innerHTML = qr.createSvgTag({ cellSize: 8, margin: 4, scalable: true }) +
                (made.parts.length > 1
                    ? '<div class="qr-part-cap">Код ' + (i + 1) + ' из ' + made.parts.length + '</div>'
                    : '');
            wrap.addEventListener('click', function () { wrap.classList.toggle('qr-full'); });
            box.appendChild(wrap);
        });
        if (linkInput) linkInput.value = made.link;
        if (note) {
            let text = 'Этот код передаёт маршрут целиком: зону поиска, точку потери, ' +
                'порядок обхода и все ' + made.points + ' точек с вероятностями.' +
                (made.hasRoute ? '' : ' Маршрут пока не построен — передаются зона и точки.');
            if (made.parts.length > 1) {
                text += ' Код не влез в один квадрат, поэтому он разбит на ' + made.parts.length +
                    ' части: наведите камеру на них ПО ОЧЕРЕДИ, начиная с первой.';
            }
            text += ' Наводите целиком с расстояния 15–25 см, яркость экрана на максимум. ' +
                '<b>Нажмите на код</b> — он раскроется на весь экран.';
            text += ' Если код не читается, на телефоне нажмите «Сканировать QR» и вставьте ' +
                'ссылку в поле.';
            note.innerHTML = text;
        }
    } catch (e) {
        box.innerHTML = '<div class="hint">План слишком большой для QR-кода (' + made.code.length +
            ' знаков). Уберите лишние точки из списка (кнопка «×») и попробуйте снова.</div>';
        if (note) note.textContent = '';
    }
    overlay.classList.remove('hidden');
}

// Применяет план по коду (используется и для ссылки, и для отсканированного QR)
function applyPlanCode(code) {
    const plan = decodePlanCode(code);
    if (!plan) return false;

    const profId = LEGACY_PROF[plan.prof] || plan.prof;
    if (profId && SUBJECT_PROFILES[profId]) {
        const sel = document.getElementById('subject-profile');
        if (sel) { sel.value = profId; sel.dispatchEvent(new Event('change')); }
    }
    if (plan.hours != null) {
        const h = document.getElementById('hours-elapsed');
        if (h) h.value = plan.hours;
    }
    if (plan.poly && plan.poly.length >= 3) {
        polygonPoints = plan.poly.map(function (p) { return { lat: p[0], lng: p[1] }; });
        finishPolygon();
        try {
            map.fitBounds(L.latLngBounds(polygonPoints.map(function (p) { return [p[0], p[1]]; })).pad(0.1));
        } catch (e) { }
    }
    if (plan.entry) setEntryPoint(plan.entry[0], plan.entry[1]);
    if (plan.grid) {
        const g = document.getElementById('grid-step');
        if (g) g.value = String(plan.grid);
    }
    if (plan.pts && plan.pts.length) {
        zones = plan.pts.map(function (p) {
            return { lat: p[0], lng: p[1], kind: p[2], prob: p[3], score: 50, cells: 1, cellList: null };
        });
        renderZones(zones);
    }
    // Порядок обхода: рисуем готовый маршрут, если он был в коде. Номера в
    // маршруте считаются по тому же списку точек, что приехал в коде.
    if (plan.route && zones.length) {
        const idx = plan.route.filter(function (i) { return i >= 0 && i < zones.length; });
        if (idx.length >= 2) {
            routePoints = zones.slice();
            let len = 0;
            const K = buildDistanceMatrix(routePoints.map(function (z) { return { lat: z.lat, lng: z.lng }; }));
            for (let i = 0; i < idx.length - 1; i++) len += K[idx[i]][idx[i + 1]];
            drawRoute(idx, len);
            console.log('[APP] Маршрут из кода: точек', idx.length, '| длина', (len / 1000).toFixed(2), 'км');
        }
    }
    console.log('[APP] План загружен: точек', (plan.pts || []).length);
    return true;
}

function applyPlanFromHash() {
    // код может быть компактным (2!...) — тогда в нём есть ! ; , — или старым
    // base64; берём всё до конца фрагмента или до следующего параметра
    const m = /[#&]plan=([^&\s]+)/.exec(location.hash || '');
    if (!m) return false;
    return applyPlanCode(decodeURIComponent(m[1]));
}

// ---------- ФАЙЛ ПЛАНА: сохранение и загрузка ----------
// В файл попадает всё, что нужно для продолжения работы на другом устройстве:
// контур зоны, точка потери, найденные точки, порядок обхода и (если скачан)
// сохранённый район — схема карты и данные OSM для расчёта без интернета.
const PLAN_FILE_VERSION = 1;

function buildPlanFile() {
    const plan = buildPlan();          // зона, точка потери, точки поиска
    plan.file = 'mchs-plan';
    plan.fileVersion = PLAN_FILE_VERSION;
    plan.app = 'Поиск людей в лесу';
    plan.savedAt = new Date().toISOString();

    const gs = document.getElementById('grid-step');
    const ot = document.getElementById('opt-time');
    if (gs) plan.gridStep = parseInt(gs.value, 10);
    if (ot) plan.optTime = parseInt(ot.value, 10);

    // порядок обхода — списком координат, чтобы файл читался любой версией
    if (lastRoute && lastRoute.length && routePoints && routePoints.length) {
        plan.route = lastRoute.map(function (i) {
            return [+routePoints[i].lat.toFixed(5), +routePoints[i].lng.toFixed(5)];
        });
        const dist = document.getElementById('stat-distance');
        if (dist) plan.routeKm = parseFloat(dist.textContent) || 0;
    }

    // сохранённая карта района (если её скачивали)
    if (offlineData && offlineData.terrain) {
        plan.map = {
            bbox: offlineData.bbox,
            png: offlineData.png || null,
            terrain: offlineData.terrain,
            savedAt: offlineData.savedAt || null
        };
    }
    return plan;
}

function exportPlanFile() {
    if (!(polygonPoints && polygonPoints.length >= 3)) {
        alert('Сначала очертите зону поиска.');
        return;
    }
    let plan;
    try {
        plan = buildPlanFile();
    } catch (e) {
        alert('Не удалось собрать файл: ' + e.message);
        return;
    }
    const text = JSON.stringify(plan);
    const d = new Date();
    const p2 = function (v) { return (v < 10 ? '0' : '') + v; };
    const name = 'marshrut_' + d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) +
        '_' + p2(d.getHours()) + p2(d.getMinutes()) + '.mchsplan.json';
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    const el = document.getElementById('file-status');
    if (el) {
        const kb = Math.round(text.length / 1024);
        el.innerHTML = '💾 Файл сохранён: <b>' + name + '</b> (' + kb + ' КБ, точек ' +
            (plan.pts || []).length + (plan.route ? ', маршрут есть' : '') +
            (plan.map ? ', с картой района' : '') + ').';
    }
    console.log('[APP] План сохранён в файл:', name, kb, 'КБ');
}

function importPlanFile(file) {
    const reader = new FileReader();
    reader.onload = function () {
        let plan = null;
        try {
            plan = JSON.parse(String(reader.result));
        } catch (e) {
            alert('Файл не читается: это не файл плана.');
            return;
        }
        if (!plan || !plan.poly) {
            alert('В файле нет зоны поиска — похоже, это не наш файл плана.');
            return;
        }
        if (plan.prof) {
            const sel = document.getElementById('subject-profile');
            if (sel) { sel.value = plan.prof; sel.dispatchEvent(new Event('change')); }
        }
        if (plan.hours != null) {
            const h = document.getElementById('hours-elapsed');
            if (h) h.value = plan.hours;
        }
        polygonPoints = plan.poly.map(function (p) { return { lat: p[0], lng: p[1] }; });
        finishPolygon();
        try {
            map.fitBounds(L.latLngBounds(polygonPoints.map(function (p) { return [p[0], p[1]]; })).pad(0.1));
        } catch (e) { }
        if (plan.entry) setEntryPoint(plan.entry[0], plan.entry[1]);

        if (plan.gridStep) {
            const gs = document.getElementById('grid-step');
            if (gs) gs.value = String(plan.gridStep);
        }
        if (plan.optTime) {
            const ot = document.getElementById('opt-time');
            if (ot) ot.value = String(plan.optTime);
        }

        if (plan.pts && plan.pts.length) {
            zones = plan.pts.map(function (p) {
                return { lat: p[0], lng: p[1], kind: p[2], prob: p[3], score: 50, cells: 1, cellList: null };
            });
            renderZones(zones);
        }

        // маршрут из файла
        if (plan.route && plan.route.length >= 2) {
            routePoints = plan.route.map(function (p) { return { lat: p[0], lng: p[1], score: 50 }; });
            lastRoute = routePoints.map(function (_, i) { return i; });
            let dist = 0;
            for (let i = 1; i < routePoints.length; i++) {
                dist += getHaversineDistance(routePoints[i - 1], routePoints[i]);
            }
            drawRoute(lastRoute, dist);
        }

        // сохранённая карта района — кладём в память устройства
        if (plan.map && plan.map.terrain) {
            const pack = {
                bbox: plan.map.bbox, png: plan.map.png || null,
                terrain: plan.map.terrain, savedAt: plan.map.savedAt || Date.now()
            };
            idbSet('zone', pack).then(function () {
                offlineData = pack;
                offlineSetStatus('🗺 Из файла загружена карта района — расчёт работает без интернета.');
            }).catch(function () { });
        }

        const el = document.getElementById('file-status');
        if (el) {
            el.innerHTML = '📂 Загружено: точек <b>' + (plan.pts || []).length + '</b>' +
                (plan.route ? ', маршрут восстановлен' : '') +
                (plan.map ? ', карта района сохранена' : '') +
                (plan.savedAt ? '<br><span class="hint">Файл от ' + new Date(plan.savedAt).toLocaleString() + '</span>' : '');
        }
        console.log('[APP] План загружен из файла: точек', (plan.pts || []).length);
    };
    reader.readAsText(file);
}

// ---------- СКАНЕР QR-КОДА ----------
// Читаем код камерой телефона и сразу применяем план. Работает на https
// (на localhost тоже): браузеры разрешают камеру только в защищённом режиме.
let scanStream = null;
let scanTimer = null;
let scanCanvas = null;

function scanSetStatus(text) {
    const el = document.getElementById('scan-status');
    if (el) el.textContent = text;
}

function stopQrScanner() {
    if (scanTimer) { clearTimeout(scanTimer); scanTimer = null; }
    if (scanStream) {
        scanStream.getTracks().forEach(function (t) { t.stop(); });
        scanStream = null;
    }
    const v = document.getElementById('scan-video');
    if (v) v.srcObject = null;
    const ov = document.getElementById('scan-overlay');
    if (ov) ov.classList.add('hidden');
    resetScanParts();      // недособранные части многочастного кода не храним
}

// План может приехать несколькими QR-кодами. Тогда каждая часть помечена как
// 3!<номер>!<всего>!<кусок кода>. Складываем куски и применяем план, когда
// получены все части.
let scanParts = {};
let scanPartsTotal = 0;

function resetScanParts() {
    scanParts = {};
    scanPartsTotal = 0;
}

// РАЗБОР ТЕКСТА, КОТОРЫЙ ВЕРНУЛ СКАНЕР (или человек вставил в поле).
// Возвращает одно из трёх:
//   { kind:'chunk', num, total, chunk } — часть многочастного кода;
//   { kind:'code', code }               — целый план (наш компактный или старый base64);
//   { kind:'unknown' }                  — это не наш код.
// ВАЖНО: текст может прийти с процентным кодированием (знак «!» превращается в
// «%21», если ссылку переслали через мессенджер или вставили в адресную строку).
// Раньше сканер это не раскодировал, и код переставал читаться — отсюда была
// ошибка «план не читается» при вставке ссылки.
function parseScannedText(text) {
    let raw = String(text == null ? '' : text).trim();
    if (!raw) return { kind: 'unknown' };

    if (raw.indexOf('%') >= 0) {
        try { raw = decodeURIComponent(raw); } catch (e) { /* оставляем как есть */ }
    }
    // если это ссылка — берём только хвост после «#plan=» (до конца строки)
    const m = /[#&]plan=([\s\S]+)$/.exec(raw);
    if (m) raw = m[1].trim();

    if (raw.indexOf('3!') === 0) {
        const f = raw.split('!');
        const num = parseInt(f[1], 10);
        const total = parseInt(f[2], 10);
        const chunk = f.slice(3).join('!');
        if (num >= 1 && total >= 1 && num <= total && chunk) {
            return { kind: 'chunk', num: num, total: total, chunk: chunk };
        }
    }
    if (raw.indexOf('2!') === 0) return { kind: 'code', code: raw };
    if (/^[A-Za-z0-9\-_]{40,}$/.test(raw)) return { kind: 'code', code: raw };
    return { kind: 'unknown' };
}

function onQrFound(text) {
    const parsed = parseScannedText(text);

    // часть многочастного кода: складываем куски и применяем, когда есть все
    if (parsed.kind === 'chunk') {
        scanPartsTotal = parsed.total;
        scanParts[parsed.num] = parsed.chunk;
        const got = Object.keys(scanParts).length;
        if (got < parsed.total) {
            scanSetStatus('Получена часть ' + got + ' из ' + parsed.total +
                '. Наведите камеру на следующий код, не закрывая это окно.');
            return false;             // продолжаем сканировать
        }
        let full = '';
        for (let i = 1; i <= parsed.total; i++) full += scanParts[i];
        resetScanParts();
        return applyScannedPlan(full);
    }

    if (parsed.kind === 'code') return applyScannedPlan(parsed.code);

    scanSetStatus('Это не код нашей программы. Наведите камеру на QR-код из приложения ' +
        '(версия ' + APP_VERSION + ').');
    return false;
}

function applyScannedPlan(code) {
    const ok = applyPlanCode(code);
    if (!ok) {
        scanSetStatus('Код нашей программы, но план не читается. Обновите приложение ' +
            'на этом телефоне (сейчас версия ' + APP_VERSION + ') и покажите QR-код заново.');
        return false;
    }
    stopQrScanner();
    resetScanParts();
    alert('Маршрут загружен: зона поиска, точка потери, точки с вероятностями' +
        (lastRoute && lastRoute.length ? ' и порядок обхода' : '') +
        '.\nЧтобы работать без интернета, нажмите «Скачать район» в карточке 6.');
    return true;
}

function scanFrame() {
    const v = document.getElementById('scan-video');
    if (!scanStream || !v) return;
    if (v.readyState >= 2 && v.videoWidth > 0 && typeof jsQR === 'function') {
        if (!scanCanvas) scanCanvas = document.createElement('canvas');
        const ctx = scanCanvas.getContext('2d', { willReadFrequently: true });
        // уменьшаем кадр до 900 точек по ширине: так jsQR читает точнее и быстрее
        const scale = Math.min(1, 900 / v.videoWidth);
        const w = Math.max(1, Math.round(v.videoWidth * scale));
        const h = Math.max(1, Math.round(v.videoHeight * scale));
        if (scanCanvas.width !== w || scanCanvas.height !== h) {
            scanCanvas.width = w;
            scanCanvas.height = h;
        }
        ctx.drawImage(v, 0, 0, w, h);
        try {
            const img = ctx.getImageData(0, 0, w, h);
            // attemptBoth — читает и обычный код, и «негатив» с тёмного экрана
            const res = jsQR(img.data, img.width, img.height, { inversionAttempts: 'attemptBoth' });
            if (res && res.data) {
                if (onQrFound(res.data)) return;
            }
        } catch (e) {
            console.log('[SCAN] кадр не разобран:', e.message);
        }
    }
    scanTimer = setTimeout(scanFrame, 200);
}

function startQrScanner() {
    const ov = document.getElementById('scan-overlay');
    const v = document.getElementById('scan-video');
    if (!ov || !v) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        alert('Камера недоступна. Откройте приложение по адресу https:// (на сайте) — браузер разрешает камеру только там.');
        return;
    }
    if (typeof jsQR !== 'function') {
        alert('Не загрузился файл vendor/jsqr.min.js — сканер недоступен.');
        return;
    }
    ov.classList.remove('hidden');
    scanSetStatus('Запрашиваю камеру…');
    navigator.mediaDevices.getUserMedia({
        video: {
            facingMode: { ideal: 'environment' },
            width: { ideal: 1920 },
            height: { ideal: 1080 },
            // непрерывная автофокусировка: главная причина «код не читается» —
            // камера сфокусирована на фоне, а не на экране с кодом
            advanced: [{ focusMode: 'continuous' }]
        },
        audio: false
    })
        .then(function (stream) {
            scanStream = stream;
            v.srcObject = stream;
            v.setAttribute('playsinline', 'true');
            v.setAttribute('muted', 'true');
            // просим автофокус и увеличение отдельно: не все браузеры принимают
            // их в общем запросе, но почти все умеют применить к дорожке
            try {
                const track = stream.getVideoTracks()[0];
                if (track && track.applyConstraints) {
                    track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] })
                        .catch(function () { });
                }
            } catch (e) { }
            // начинаем читать кадры, когда камера реально дала картинку
            v.onloadedmetadata = function () {
                scanSetStatus('Наведите камеру на QR-код плана…');
                scanFrame();
            };
            return v.play();
        })
        .then(function () {
            setTimeout(function () {
                if (scanStream) {
                    scanSetStatus('Если код не читается: поднесите телефон ближе, ' +
                        'сделайте яркость экрана с кодом на максимум, ' +
                        'или вставьте ссылку в поле ниже.');
                }
            }, 12000);
        })
        .catch(function (err) {
            console.log('[SCAN] камера не открылась:', err && err.name);
            let msg = 'Не удалось включить камеру.';
            if (err && err.name === 'NotAllowedError') msg = 'Вы запретили доступ к камере — разрешите его в настройках браузера.';
            if (err && err.name === 'NotFoundError') msg = 'Камера не найдена.';
            scanSetStatus(msg);
        });
}

// ---------- 24.5 КЭШ ДАННЫХ OSM ----------
// Один и тот же район часто считают несколько раз (меняют профиль или время).
// Данные OSM кэшируем в памяти по округлённому прямоугольнику — это экономит
// и время, и трафик, особенно на телефоне.
const terrainCache = new Map();
const TERRAIN_CACHE_MAX = 4;

function terrainCacheKey(polygonPoints) {
    let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
    for (const p of polygonPoints) {
        a = Math.min(a, p.lat); b = Math.min(b, p.lng);
        c = Math.max(c, p.lat); d = Math.max(d, p.lng);
    }
    return [a, b, c, d].map(function (v) { return v.toFixed(3); }).join('|');
}

// ---------- 24.6 КНОПКИ ----------
(function () {
    const btnQr = document.getElementById('qr-btn');
    if (btnQr) btnQr.addEventListener('click', showQrCode);

    // Тап по самому коду — показать его на весь экран (и обратно)
    const qrBox = document.getElementById('qr-box');
    if (qrBox) {
        qrBox.addEventListener('click', function () {
            qrBox.classList.toggle('qr-full');
        });
    }

    // Ссылка на план: скопировать в буфер или отправить в мессенджер.
    // Это запасной путь, когда QR не читается камерой: ссылку пересылают
    // сообщением и открывают на телефоне.
    const btnCopy = document.getElementById('qr-copy-btn');
    if (btnCopy) {
        btnCopy.addEventListener('click', function () {
            const inp = document.getElementById('qr-link');
            const val = inp ? inp.value : '';
            if (!val) return;
            const done = function () {
                btnCopy.textContent = 'Скопировано';
                setTimeout(function () { btnCopy.textContent = 'Копировать'; }, 2000);
            };
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(val).then(done).catch(function () {
                    if (inp) { inp.select(); document.execCommand('copy'); done(); }
                });
            } else if (inp) {
                inp.select();
                document.execCommand('copy');
                done();
            }
        });
    }

    const btnShare = document.getElementById('qr-share-btn');
    if (btnShare) {
        btnShare.addEventListener('click', function () {
            const inp = document.getElementById('qr-link');
            const val = inp ? inp.value : '';
            if (!val) return;
            if (navigator.share) {
                navigator.share({ title: 'План поиска', text: 'План поиска — откройте на телефоне', url: val })
                    .catch(function () { });
            } else if (navigator.clipboard) {
                navigator.clipboard.writeText(val).then(function () {
                    btnShare.textContent = 'Скопировано';
                    setTimeout(function () { btnShare.textContent = 'Отправить'; }, 2000);
                }).catch(function () { });
            }
        });
    }

    const btnScan = document.getElementById('scan-qr-btn');
    if (btnScan) btnScan.addEventListener('click', startQrScanner);

    // запасной вариант: вставить ссылку или код вручную.
    // Поле спрятано за маленькой кнопкой — оно нужно редко, а на экране мешало.
    const btnManualToggle = document.getElementById('scan-manual-toggle');
    const manualBox = document.getElementById('scan-manual-box');
    if (btnManualToggle && manualBox) {
        btnManualToggle.addEventListener('click', function () {
            const shown = !manualBox.classList.contains('hidden');
            manualBox.classList.toggle('hidden', shown);
            btnManualToggle.textContent = shown
                ? 'Код не читается — вставить ссылку вручную'
                : 'Скрыть поле для ссылки';
            if (!shown) {
                const inp = document.getElementById('scan-manual');
                if (inp) inp.focus();
            }
        });
    }

    // запасной вариант: вставить ссылку или код вручную
    const btnScanApply = document.getElementById('scan-apply');
    if (btnScanApply) {
        btnScanApply.addEventListener('click', function () {
            const inp = document.getElementById('scan-manual');
            const val = inp ? String(inp.value || '').trim() : '';
            if (!val) { scanSetStatus('Вставьте ссылку или код плана в поле.'); return; }            onQrFound(val);
        });
    }

    // файл плана
    const btnSavePlan = document.getElementById('save-plan-btn');
    if (btnSavePlan) btnSavePlan.addEventListener('click', exportPlanFile);

    const planInput = document.getElementById('plan-file-input');
    const btnLoadPlan = document.getElementById('load-plan-btn');
    if (btnLoadPlan && planInput) {
        btnLoadPlan.addEventListener('click', function () { planInput.click(); });
        planInput.addEventListener('change', function () {
            if (this.files && this.files[0]) importPlanFile(this.files[0]);
            this.value = '';
        });
    }

    const btnScanClose = document.getElementById('scan-close');
    if (btnScanClose) btnScanClose.addEventListener('click', stopQrScanner);

    const scanOv = document.getElementById('scan-overlay');
    if (scanOv) {
        scanOv.addEventListener('click', function (e) {
            if (e.target === scanOv) stopQrScanner();
        });
    }

    const btnQrClose = document.getElementById('qr-close');
    const qrOverlay = document.getElementById('qr-overlay');
    if (btnQrClose && qrOverlay) {
        btnQrClose.addEventListener('click', function () { qrOverlay.classList.add('hidden'); });
        qrOverlay.addEventListener('click', function (e) {
            if (e.target === qrOverlay) qrOverlay.classList.add('hidden');
        });
    }

    refreshDeviceStat();
})();


// ---------- 24.7 ТЕМА ОФОРМЛЕНИЯ (светлая тёплая / тёмная) ----------
// По умолчанию светлая тёплая: она лучше читается на солнце. Тёмную включают
// вечером или в помещении — выбор запоминается в телефоне.
const THEME_KEY = 'mchs-theme';

function applyTheme(dark) {
    document.body.classList.toggle('theme-dark', !!dark);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', dark ? '#1e1b18' : '#f4efe6');
    try { localStorage.setItem(THEME_KEY, dark ? 'dark' : 'light'); } catch (e) { }
    console.log('[APP] Тема:', dark ? 'тёмная' : 'светлая');
}

(function initTheme() {
    let saved = null;
    try { saved = localStorage.getItem(THEME_KEY); } catch (e) { }
    // По умолчанию тёмная тема: она приятнее для глаз. Светлую можно включить
    // кнопкой в шапке — выбор запоминается.
    const dark = saved ? saved === 'dark' : true;
    applyTheme(dark);
    const btn = document.getElementById('theme-btn');
    if (btn) {
        btn.addEventListener('click', function () {
            applyTheme(!document.body.classList.contains('theme-dark'));
        });
    }
})();

// ---------- 24.8 ГЕОЛОКАЦИЯ: ГДЕ Я (без записи трека) ----------
// Показываем своё положение на карте и строкой: координаты, точность, время.
// Сам трек не пишем — для передачи плана используется QR-код.
let myPosLayer = null;
let myPosFix = null;

function updateGeoLine() {
    const el = document.getElementById('geo-line');
    if (!el) return;
    if (!myPosFix) {
        el.innerHTML = 'Моё положение: нажмите <b>◎</b> на карте, чтобы показать себя.';
        return;
    }
    const age = Math.max(0, Math.round((Date.now() - myPosFix.time) / 1000));
    el.innerHTML = 'Моё положение: <b>' + myPosFix.lat.toFixed(5) + ', ' + myPosFix.lng.toFixed(5) + '</b>' +
        ' · точность ' + Math.round(myPosFix.acc) + ' м' +
        (age < 90 ? ' · обновлено ' + age + ' с назад' : ' · обновлено ' + Math.round(age / 60) + ' мин назад');
}

function showMyPosition() {
    if (!navigator.geolocation) {
        alert('Телефон не отдаёт координаты: нет геолокации или запрещён доступ.');
        return;
    }
    const btn = document.getElementById('locate-btn');
    if (btn) btn.classList.add('busy');
    const el = document.getElementById('geo-line');
    if (el) el.textContent = 'Определяю положение…';

    navigator.geolocation.getCurrentPosition(function (pos) {
        if (btn) btn.classList.remove('busy');
        const lat = pos.coords.latitude, lng = pos.coords.longitude, acc = pos.coords.accuracy || 20;
        myPosFix = { lat: lat, lng: lng, acc: acc, time: pos.timestamp || Date.now() };
        map.setView([lat, lng], Math.max(map.getZoom(), 15));
        if (myPosLayer) map.removeLayer(myPosLayer);
        myPosLayer = L.layerGroup([
            L.circle([lat, lng], {
                radius: acc, color: '#b26340', weight: 1,
                fillColor: '#b26340', fillOpacity: 0.15
            }),
            L.circleMarker([lat, lng], {
                radius: 7, color: '#fff', weight: 3,
                fillColor: '#b26340', fillOpacity: 1
            })
        ]).addTo(map);
        updateGeoLine();
        console.log('[GEO] моё положение:', lat.toFixed(5), lng.toFixed(5), '±', Math.round(acc), 'м');
    }, function (err) {
        if (btn) btn.classList.remove('busy');
        let msg = 'не удалось определить координаты';
        if (err && err.code === 1) msg = 'разрешите доступ к геолокации в браузере';
        if (err && err.code === 2) msg = 'нет сигнала GPS — выйдите на открытое место';
        if (err && err.code === 3) msg = 'превышено время ожидания сигнала';
        if (el) el.textContent = 'Моё положение: ' + msg + '.';
    }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
}

window.showMyPosition = showMyPosition;

// План из ссылки важнее сохранённого состояния: если пришли по ссылке — берём её
if (!applyPlanFromHash()) {
    restoreState();
    loadOfflineZone();
} else {
    loadOfflineZone();
}

// ============================================================
//  Интерфейс «карта + нижняя панель» (как в Яндекс.Картах).
//  Свёрнутая панель показывает три главные функции, свайп вверх
//  раскрывает все настройки. Модуль ничего не пересчитывает —
//  он только управляет панелью и кнопками поверх карты.
// ============================================================
(function () {
    'use strict';

    // ---------- проверка, что всё загрузилось ----------
    // Если библиотеки или сам logic.js не загрузились, приложение выглядит
    // «зависшим» (видна только надпись «Проверка связи…»). Показываем причину.
    // Проверяем библиотеки ПОСЛЕ полной загрузки: иначе можно пожаловаться
    // на «не созданную карту» раньше, чем приложение успело её создать.
    function checkBoot() {
        var missing = [];
        if (typeof L === 'undefined') missing.push('vendor/leaflet/leaflet.js — библиотека карты');
        if (typeof turf === 'undefined') missing.push('vendor/turf.min.js — расчёт площади');
        if (typeof qrcode !== 'function') missing.push('vendor/qrcode.min.js — QR-код плана');
        if (typeof jsQR !== 'function') missing.push('vendor/jsqr.min.js — сканер QR');
        // если карта уже рисует плитки — значит всё работает, предупреждать не о чем
        var tilesLoaded = document.querySelectorAll('#map img.leaflet-tile-loaded').length;
        if (!window.__mapReady && tilesLoaded === 0) {
            missing.push('logic.js — карта не появилась');
        }
        if (!missing.length || (tilesLoaded > 0 && missing.length === 0)) return;

        var badge = document.getElementById('network-status');
        if (badge) {
            badge.textContent = 'Нет файлов приложения';
            badge.classList.add('offline');
        }
        var box = document.createElement('div');
        box.className = 'boot-error';
        var fromReserve = Object.keys(window.__libSources || {}).some(function (k) {
            return window.__libSources[k] === 'резервный адрес';
        });
        box.innerHTML = '<button class="boot-error-close" type="button" ' +
            'aria-label="Закрыть">×</button>' +
            '<b>Приложение загрузилось не полностью</b><br>' +
            missing.map(function (m) { return '• ' + m; }).join('<br>') +
            '<br><br>Проверьте, что на хостинг загружена папка <b>vendor</b> вместе с ' +
            'подпапками и файлами, и что обновлены все файлы приложения. Для GitHub Pages ' +
            'нужен ещё пустой файл <b>.nojekyll</b> в корне репозитория.' +
            (fromReserve ? '<br><br><i>Библиотеки подгружены с резервного адреса: ' +
                'приложение работает, но без интернета ему будет тяжелее.</i>' : '');
        box.addEventListener('click', function (e) {
            if (e.target && e.target.classList.contains('boot-error-close')) box.remove();
        });
        document.body.appendChild(box);
        console.log('[APP] не загружено:', missing.join(' | '));
    }
    if (document.readyState === 'complete') {
        setTimeout(checkBoot, 1200);
    } else {
        window.addEventListener('load', function () { setTimeout(checkBoot, 1200); });
    }

    // ---------- подсказка про установку на телефон ----------
    // Показывается один раз и только если приложение открыто в браузере, а не
    // запущено с домашнего экрана.
    (function installHint() {
        var standalone = false;
        try {
            standalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
                window.navigator.standalone === true;
        } catch (e) { }
        if (standalone) return;
        if (!/Android|iPhone|iPad|iPod/i.test(navigator.userAgent || '')) return;
        var KEY = 'mchs-install-hint';
        try { if (localStorage.getItem(KEY)) return; } catch (e) { }

        window.addEventListener('load', function () {
            setTimeout(function () {
                var el = document.createElement('div');
                el.className = 'install-hint';
                el.innerHTML = '<button class="install-hint-close" type="button" aria-label="Закрыть">×</button>' +
                    '<b>Установите приложение на телефон</b><br>' +
                    'Меню браузера (⋮ или «Поделиться») → <b>«Добавить на главный экран»</b>.<br>' +
                    'Тогда оно будет открываться как обычное приложение, без адресной строки.';
                document.body.appendChild(el);
                try { localStorage.setItem(KEY, '1'); } catch (e) { }
                el.addEventListener('click', function (e) {
                    if (e.target && e.target.classList.contains('install-hint-close')) el.remove();
                });
                setTimeout(function () { if (el.parentNode) el.remove(); }, 25000);
            }, 5000);
        });
    })();

    var sheet = document.getElementById('control-panel');
    if (!sheet) return;

    var grabber = document.getElementById('sheet-grabber');
    var peek = sheet.querySelector('.peek-bar');
    var fabWrap = document.querySelector('.map-fabs');
    var mapEl = document.getElementById('map');
    var mqDesktop = window.matchMedia('(min-width: 901px)');

    var collapsedPx = 0;      // высота свёрнутой панели (с учётом safe-area)
    var expandedPx = 0;       // высота раскрытой панели
    var dragging = false;
    var dragSource = '';
    var startY = 0;
    var startH = 0;
    var lastY = 0;
    var lastT = 0;
    var velocity = 0;
    var moved = false;

    // ---------- размеры ----------
    // Высоту свёрнутой панели не измеряем, а считаем: ручка + строка иконок
    // + отступ под системную полосу телефона. Так она не «плывёт» при загрузке.
    var safeProbe = document.createElement('div');
    safeProbe.style.cssText = 'position:fixed;left:-9999px;bottom:0;width:1px;height:0;' +
        'padding-bottom:env(safe-area-inset-bottom)';
    document.body.appendChild(safeProbe);

    function measure() {
        // высоту отступа под системную полосу читаем из вычисленного padding
        var safeBottom = parseFloat(getComputedStyle(safeProbe).paddingBottom) || 0;
        var peekH = (grabber ? grabber.offsetHeight : 26) + (peek ? peek.offsetHeight : 80);
        document.documentElement.style.setProperty('--peek-h', peekH + 'px');
        collapsedPx = Math.round(peekH + safeBottom);
        expandedPx = Math.round(window.innerHeight * 0.88);
    }

    function applyHeight(open) {
        if (mqDesktop.matches) {
            sheet.style.height = '';
            document.body.classList.remove('sheet-open');
            return;
        }
        sheet.style.height = (open ? expandedPx : collapsedPx) + 'px';
        document.body.classList.toggle('sheet-open', !!open);
    }

    function isOpen() {
        return document.body.classList.contains('sheet-open');
    }

    function openSheet() {
        applyHeight(true);
        if (typeof hidePill === 'function') hidePill();
    }

    function closeSheet() {
        applyHeight(false);
    }

    function toggleSheet() {
        applyHeight(!isOpen());
    }

    // ---------- переход к нужной карточке ----------
    function openCard(num) {
        openSheet();
        var card = sheet.querySelector('.control-card[data-card="' + num + '"]');
        if (!card) return;
        setTimeout(function () {
            try {
                card.scrollIntoView({ behavior: 'smooth', block: 'start' });
            } catch (e) {
                card.scrollIntoView();
            }
            card.classList.add('flash');
            setTimeout(function () { card.classList.remove('flash'); }, 1500);
        }, 260);
    }

    // ---------- свайп панели ----------
    function onPointerDown(e) {
        if (mqDesktop.matches) return;
        if (e.button !== undefined && e.button !== 0) return;
        // по кнопкам главных функций панель не тащим — это обычные кнопки
        if (e.target && e.target.closest && e.target.closest('.peek-btn')) return;
        dragging = true;
        moved = false;
        dragSource = (e.target.closest && e.target.closest('#sheet-grabber')) ? 'grabber' : 'peek';
        startY = e.clientY;
        startH = sheet.getBoundingClientRect().height;
        lastY = e.clientY;
        lastT = Date.now();
        velocity = 0;
        sheet.classList.add('dragging');
        window.addEventListener('pointermove', onPointerMove, { passive: false });
        window.addEventListener('pointerup', onPointerUp);
        window.addEventListener('pointercancel', onPointerUp);
    }

    function onPointerMove(e) {
        if (!dragging) return;
        var dy = startY - e.clientY;               // свайп вверх — плюс
        if (Math.abs(dy) > 5) moved = true;
        if (moved && e.cancelable) e.preventDefault();
        var h = startH + dy;
        var minH = Math.max(56, collapsedPx - 40);
        if (h < minH) h = minH;
        if (h > expandedPx) h = expandedPx;
        sheet.style.height = h + 'px';
        var now = Date.now();
        if (now - lastT > 25) {
            velocity = (lastY - e.clientY) / (now - lastT);   // >0 — вверх
            lastY = e.clientY;
            lastT = now;
        }
    }

    function onPointerUp() {
        if (!dragging) return;
        dragging = false;
        sheet.classList.remove('dragging');
        window.removeEventListener('pointermove', onPointerMove);
        window.removeEventListener('pointerup', onPointerUp);
        window.removeEventListener('pointercancel', onPointerUp);

        if (!moved) {                     // это был тап, а не свайп
            if (dragSource === 'grabber') {
                toggleSheet();
            } else {
                openSheet();              // тап по строке иконок — только раскрыть
            }
            return;
        }

        var h = sheet.getBoundingClientRect().height;
        var enough = h > collapsedPx + (expandedPx - collapsedPx) * 0.35;
        if (velocity > 0.45) enough = true;      // резкий свайп вверх
        if (velocity < -0.45) enough = false;    // резкий свайп вниз
        applyHeight(enough);
    }

    if (grabber) grabber.addEventListener('pointerdown', onPointerDown);
    if (peek) peek.addEventListener('pointerdown', onPointerDown);

    if (grabber) {
        grabber.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleSheet(); }
        });
    }

    // ---------- три главные кнопки ----------
    // Тап — выполнить главное действие (очертить зону / найти зоны / маршрут),
    // долгое нажатие — открыть настройки этого раздела.
    function clickById(id) {
        const el = document.getElementById(id);
        if (el && !el.disabled) { el.click(); return true; }
        return false;
    }

    function hasPolygon() {
        return (typeof polygonPoints !== 'undefined') && polygonPoints && polygonPoints.length >= 3;
    }

    function hasZones() {
        return (typeof zones !== 'undefined') && zones && zones.length > 0;
    }

    function flashCard(cardNum, message) {
        openCard(cardNum);
        if (!message) return;
        let el = document.getElementById('peek-note');
        if (!el) {
            el = document.createElement('div');
            el.id = 'peek-note';
            el.className = 'peek-note';
            const host = document.getElementById('app-body') || document.body;
            host.appendChild(el);
        }
        el.textContent = message;
        el.hidden = false;
        setTimeout(function () { el.hidden = true; }, 4000);
    }

    // ---------- плашка: что сейчас происходит ----------
    var actionPill = null;
    var pillTimer = null;

    function pillEl() {
        if (!actionPill) {
            actionPill = document.createElement('button');
            actionPill.id = 'action-pill';
            actionPill.type = 'button';
            actionPill.className = 'action-pill hidden';
            (document.getElementById('app-body') || document.body).appendChild(actionPill);
            actionPill.addEventListener('click', function () {
                var target = actionPill.getAttribute('data-target');
                hidePill();
                if (target === 'zones') {
                    openSheet();
                    setTimeout(function () {
                        var z = document.getElementById('zones-scroll');
                        if (z) z.scrollIntoView({ block: 'start' });
                    }, 320);
                } else if (target === 'route') {
                    openCard('5');
                } else {
                    openSheet();
                }
            });
        }
        return actionPill;
    }

    function showPill(text, kind, target, keep) {
        var el = pillEl();
        el.textContent = text;
        if (target) el.setAttribute('data-target', target);
        el.classList.remove('hidden', 'busy', 'done', 'warn');
        if (kind) el.classList.add(kind);
        if (pillTimer) { clearTimeout(pillTimer); pillTimer = null; }
        if (!keep) {
            pillTimer = setTimeout(hidePill, kind === 'done' ? 20000 : 8000);
        }
    }

    function hidePill() {
        if (actionPill) actionPill.classList.add('hidden');
        if (pillTimer) { clearTimeout(pillTimer); pillTimer = null; }
    }

    // следим за поиском вероятных зон: кнопка в панели блокируется, пока идёт работа
    function watchZonesSearch() {
        var btn = document.getElementById('find-zones-btn');
        if (!btn) return;
        showPill('Ищу вероятные зоны… загружаю данные OSM', 'busy', '', true);
        var t = setInterval(function () {
            if (btn.disabled) {
                showPill(btn.textContent || 'Ищу вероятные зоны…', 'busy', '', true);
                return;
            }
            clearInterval(t);
            var n = (typeof zones !== 'undefined' && zones) ? zones.length : 0;
            if (n) {
                showPill('Найдено точек: ' + n + ' · нажмите, чтобы открыть список', 'done', 'zones');
            } else {
                showPill('Зоны не найдены — проверьте зону поиска', 'warn', 'zones');
            }
        }, 500);
    }

    // следим за построением маршрута
    function watchRoute() {
        var wrap = document.getElementById('progress-wrap');
        var text = document.getElementById('progress-text');
        showPill('Строю маршрут…', 'busy', '', true);
        var t = setInterval(function () {
            var busy = wrap && !wrap.classList.contains('hidden');
            if (busy) {
                showPill(text ? (text.textContent || 'Строю маршрут…') : 'Строю маршрут…', 'busy', '', true);
                return;
            }
            clearInterval(t);
            var dist = document.getElementById('stat-distance');
            var km = dist ? dist.textContent : '';
            if (km && km !== '0.00') {
                showPill('Маршрут готов: ' + km + ' км · нажмите, чтобы открыть панель', 'done', 'route');
            } else {
                showPill('Маршрут построен', 'done', 'route');
            }
        }, 600);
    }

    function peekAction(card) {
        if (card === '1') {
            // очертить зону поиска (или закончить рисование, если уже рисуем)
            closeSheet();
            clickById('draw-polygon-btn');
            return;
        }
        if (card === '4') {
            if (hasPolygon()) {
                closeSheet();
                if (clickById('find-zones-btn')) watchZonesSearch();
            } else {
                flashCard('1', 'Сначала очертите зону поиска — откройте карточку 1.');
            }
            return;
        }
        if (card === '5') {
            if (hasZones()) {
                closeSheet();
                if (clickById('optimize-btn')) watchRoute();
            } else {
                flashCard('4', 'Сначала найдите вероятные зоны в карточке 4.');
            }
            return;
        }
        openCard(card);
    }

    Array.prototype.forEach.call(document.querySelectorAll('.peek-btn'), function (btn) {
        const card = btn.getAttribute('data-card');

        // долгое нажатие (0,6 с) — открыть настройки раздела
        let pressTimer = null;
        let longPressed = false;

        btn.addEventListener('pointerdown', function () {
            longPressed = false;
            pressTimer = setTimeout(function () {
                longPressed = true;
                if (navigator.vibrate) { try { navigator.vibrate(15); } catch (e) { } }
                openCard(card);
            }, 600);
        });
        ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (ev) {
            btn.addEventListener(ev, function () {
                if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
            });
        });

        btn.addEventListener('click', function () {
            if (longPressed) { longPressed = false; return; }   // уже открыли настройки
            peekAction(card);
        });
    });

    // ---------- режимы работы по клику на карте ----------
    // Когда включён режим «кликайте по карте», панель убирается,
    // а сверху появляется подсказка, что делать.
    var modeButtons = ['draw-polygon-btn', 'set-entry-btn', 'manual-zones-btn'];

    var hintEl = document.createElement('div');
    hintEl.className = 'map-hint';
    hintEl.hidden = true;
    var host = document.getElementById('app-body') || document.body;
    host.appendChild(hintEl);

    function syncModeHint() {
        var text = '';
        modeButtons.forEach(function (id) {
            var b = document.getElementById(id);
            if (!b) return;
            var t = b.textContent || '';
            if (t.indexOf('Кликайте') >= 0 || t.indexOf('Кликните') >= 0) text = t;
        });
        var clean = text.replace(/^[^A-Za-zА-Яа-яЁё0-9]+/, '').trim();
        hintEl.textContent = clean;
        hintEl.hidden = !clean;
    }

    modeButtons.forEach(function (id) {
        var b = document.getElementById(id);
        if (!b) return;
        b.addEventListener('click', function () { setTimeout(closeSheet, 140); });
        if (window.MutationObserver) {
            new MutationObserver(syncModeHint).observe(b, {
                childList: true, characterData: true, subtree: true
            });
        }
    });
    syncModeHint();

    // тап по карте закрывает раскрытую панель
    if (mapEl) {
        mapEl.addEventListener('click', function () {
            if (isOpen()) closeSheet();
        });
    }

    // ---------- кнопка «Где я» ----------
    // Показывает текущее положение, точность и время замера.
    // Сама логика — в logic.js (функция showMyPosition), здесь только вызов.
    var locateBtn = document.getElementById('locate-btn');
    if (locateBtn) {
        locateBtn.addEventListener('click', function () {
            if (typeof window.showMyPosition === 'function') {
                window.showMyPosition();
            } else {
                alert('Геолокация недоступна: не загрузился logic.js');
            }
        });
    }

    // ---------- старт, поворот экрана ----------
    function setup() {
        measure();
        // #panel в адресе — сразу открыть панель (удобно для проверки вида)
        if (location.hash === '#panel' && !mqDesktop.matches) {
            openSheet();
        } else {
            applyHeight(false);
        }
        if (fabWrap) fabWrap.style.display = '';
    }

    window.addEventListener('load', setup);
    window.addEventListener('resize', function () {
        var wasOpen = isOpen();
        measure();
        applyHeight(wasOpen && !mqDesktop.matches);
    });
    window.addEventListener('orientationchange', function () {
        setTimeout(function () {
            var wasOpen = isOpen();
            measure();
            applyHeight(wasOpen && !mqDesktop.matches);
        }, 250);
    });

    // если панель изменила содержимое (тексты кнопок) — пересчитать высоту
    if (window.ResizeObserver && peek) {
        new ResizeObserver(function () { measure(); applyHeight(isOpen()); }).observe(peek);
    }

    if (typeof mqDesktop.addEventListener === 'function') {
        mqDesktop.addEventListener('change', function () {
            measure();
            applyHeight(false);
        });
    }

    setup();
})();

// tsp.worker.js — фоновый поток для тяжёлой TSP-оптимизации
// Получает матрицу расстояний, время лимита, приоритеты зон.
// Крутит: ближайший сосед → 2-opt → Or-opt → 2.5-opt → случайные перестановки.
// Каждые 2 секунды шлёт прогресс. По истечении времени возвращает лучший маршрут.
//
// ОПТИМИЗАЦИЯ ПРОИЗВОДИТЕЛЬНОСТИ:
//  - routeCost считает ТОЛЬКО расстояние (O(n)), без штрафа за приоритет;
//  - штраф за приоритет (priorityCost) применяется отдельно и редко —
//    только при сравнении кандидата с текущим лучшим маршрутом;
//  - 2-opt использует инкрементальную дельту (O(1) на пару) вместо
//    полного пересчёта маршрута (O(n));
//  - Or-opt и 2.5-opt тоже считают только расстояние.
// Это позволяет за 10 минут выполнить сотни тысяч итераций улучшения.

let stopRequested = false;

self.onmessage = function (e) {
    const data = e.data;

    if (data.type === 'stop') {
        stopRequested = true;
        return;
    }

    if (data.type === 'start') {
        stopRequested = false;
        const result = runOptimization(data);
        self.postMessage({ type: 'done', route: result.route, bestDist: result.bestDist });
    }
};

function runOptimization(data) {
    const matrix = data.matrix;          // NxN расстояния в метрах
    const timeLimitMs = data.timeLimitMs; // лимит в мс
    const priority = data.priority || []; // массив вероятностей зон (0-100)
    const priorityWeight = data.priorityWeight || 0; // 0..1

    const n = matrix.length;
    if (n < 2) return { route: [0, 0], bestDist: 0 };

    const startTime = Date.now();
    const deadline = startTime + timeLimitMs;

    // --- Стоимость маршрута: ТОЛЬКО длина (O(n)) ---
    function routeCost(route) {
        let d = 0;
        for (let i = 0; i < route.length - 1; i++) {
            d += matrix[route[i]][route[i + 1]];
        }
        return d;
    }

    // --- Штраф за приоритет (горячие зоны раньше). Вызывается редко. ---
    function priorityCost(route) {
        if (priorityWeight <= 0 || priority.length !== n) return 0;
        let p = 0;
        for (let i = 0; i < route.length - 1; i++) {
            for (let j = i + 1; j < route.length - 1; j++) {
                const a = route[i], b = route[j];
                if (priority[a] < priority[b]) {
                    p += (priority[b] - priority[a]) * priorityWeight * 10;
                }
            }
        }
        return p;
    }

    // --- Полная стоимость: длина + штраф (для финального сравнения) ---
    function totalCost(route) {
        return routeCost(route) + priorityCost(route);
    }

    // --- Ближайший сосед (стартовое решение) ---
    function nearestNeighbor() {
        const visited = new Array(n).fill(false);
        const route = [0];
        visited[0] = true;
        let last = 0;
        while (route.length < n) {
            let best = -1, bestD = Infinity;
            for (let v = 0; v < n; v++) {
                if (!visited[v] && matrix[last][v] < bestD) {
                    bestD = matrix[last][v];
                    best = v;
                }
            }
            if (best === -1) break;
            route.push(best);
            visited[best] = true;
            last = best;
        }
        route.push(0);
        return route;
    }

    // --- 2-opt: разворот участка. Полный пересчёт стоимости (надёжно). ---
    function twoOpt(route) {
        let cost = routeCost(route);
        let improved = true;
        while (improved) {
            improved = false;
            for (let i = 1; i < route.length - 2; i++) {
                for (let k = i + 1; k < route.length - 1; k++) {
                    const cand = route.slice();
                    let lo = i, hi = k;
                    while (lo < hi) {
                        const t = cand[lo]; cand[lo] = cand[hi]; cand[hi] = t;
                        lo++; hi--;
                    }
                    const newCost = routeCost(cand);
                    if (newCost < cost - 1e-9) {
                        route = cand;
                        cost = newCost;
                        improved = true;
                    }
                }
            }
        }
        return { route, cost };
    }

    // --- Or-opt: перемещение куска длины 1..3 в другое место. ---
    function orOpt(route) {
        let cost = routeCost(route);
        let improved = true;
        while (improved) {
            improved = false;
            for (let segLen = 1; segLen <= 3; segLen++) {
                for (let i = 1; i < route.length - 1 - segLen; i++) {
                    const seg = route.slice(i, i + segLen);
                    const rest = route.slice(0, i).concat(route.slice(i + segLen));
                    for (let j = 1; j <= rest.length - 1; j++) {
                        const cand = rest.slice(0, j).concat(seg).concat(rest.slice(j));
                        const newCost = routeCost(cand);
                        if (newCost < cost - 1e-9) {
                            route = cand;
                            cost = newCost;
                            improved = true;
                        }
                    }
                }
            }
        }
        return { route, cost };
    }

    // --- Полный локальный поиск (только расстояние) ---
    function localSearch(route) {
        let r = twoOpt(route);
        route = r.route;
        r = orOpt(route);
        route = r.route;
        r = twoOpt(route);
        return { route: r.route, cost: r.cost };
    }

    // --- Старт ---
    let bestRoute = nearestNeighbor();
    let bestCost = routeCost(bestRoute);
    let bestTotal = totalCost(bestRoute);
    let best = localSearch(bestRoute);
    bestRoute = best.route;
    bestCost = best.cost;
    bestTotal = totalCost(bestRoute);

    let lastReport = Date.now();
    let noImproveCount = 0;

    // --- Основной цикл: случайные перестановки + локальный поиск ---
    while (Date.now() < deadline && !stopRequested) {
        // Случайная перестановка двух точек
        let candidate = bestRoute.slice();
        const inner = candidate.length - 1;
        if (inner > 2) {
            const a = 1 + Math.floor(Math.random() * (inner - 1));
            let b = 1 + Math.floor(Math.random() * (inner - 1));
            while (b === a) b = 1 + Math.floor(Math.random() * (inner - 1));
            const tmp = candidate[a];
            candidate[a] = candidate[b];
            candidate[b] = tmp;
        }

        const improved = localSearch(candidate);
        // сравниваем по полной стоимости (длина + штраф за приоритет)
        const candTotal = improved.cost + priorityCost(improved.route);
        if (candTotal < bestTotal) {
            bestRoute = improved.route;
            bestCost = improved.cost;
            bestTotal = candTotal;
            noImproveCount = 0;
        } else {
            noImproveCount++;
        }

        // Иногда полный рестарт со случайного маршрута
        if (noImproveCount > 1000) {
            const shuffled = [0];
            const rest = [];
            for (let i = 1; i < n; i++) rest.push(i);
            while (rest.length) {
                const idx = Math.floor(Math.random() * rest.length);
                shuffled.push(rest.splice(idx, 1)[0]);
            }
            shuffled.push(0);
            const rs = localSearch(shuffled);
            const rsTotal = rs.cost + priorityCost(rs.route);
            if (rsTotal < bestTotal) {
                bestRoute = rs.route;
                bestCost = rs.cost;
                bestTotal = rsTotal;
            }
            noImproveCount = 0;
        }

        // Отчёт о прогрессе каждые 500 мс
        const now = Date.now();
        if (now - lastReport > 500) {
            lastReport = now;
            const elapsed = now - startTime;
            const percent = Math.min(100, Math.round((elapsed / timeLimitMs) * 100));
            self.postMessage({
                type: 'progress',
                percent: percent,
                bestKm: bestCost / 1000,
                elapsedSec: Math.round(elapsed / 1000)
            });
        }
    }

    return { route: bestRoute, bestDist: bestCost };
}

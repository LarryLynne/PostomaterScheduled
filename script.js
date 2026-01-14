// Глобальний кеш для зон, щоб не рахувати математику при кожному чиху
let zonesCache = {}; 

let wavesConfig = [];

    // --- WAVE MANAGEMENT ---
function renderWaves() {
    const container = document.getElementById('wavesList');
    if(!container) return;
    container.innerHTML = '';

    wavesConfig.sort(); // Сортуємо за часом

    wavesConfig.forEach((time, index) => {
        const tag = document.createElement('div');
        tag.className = 'wave-tag';
        tag.innerHTML = `
            <span>${index + 1}.</span> ${time}
            <div class="wave-del" onclick="removeWave(${index})">×</div>
        `;
        container.appendChild(tag);
    });
}

function addWave() {
    const inp = document.getElementById('newWaveTime');
    const val = inp.value;
    if (val && !wavesConfig.includes(val)) {
        wavesConfig.push(val);
        renderWaves();
    }
}

function removeWave(index) {
    wavesConfig.splice(index, 1);
    renderWaves();
}

function calculateZoneMetrics() {
    zonesCache = {}; 
    const tempGroups = {};
    

// Запускаємо рендер при старті
document.addEventListener("DOMContentLoaded", function() {
    wavesConfig = ["07:00"];
    renderWaves();
});

    // 1. Групуємо точки (як і раніше)
    pointsData.forEach(p => {
        if (!p.assignedHub || p.groupIndex === 0) return;
        const key = `${p.assignedHub}_${p.groupIndex}`;
        
        if (!tempGroups[key]) {
            tempGroups[key] = {
                hubId: p.assignedHub,
                groupId: p.groupIndex,
                pts: [],
                load: 0,
                count: 0,
                color: p.color
            };
        }
        tempGroups[key].pts.push([p.lng, p.lat]);
        tempGroups[key].load += p.load;
        tempGroups[key].count++;
    });

    // --- НОВЕ: Читаємо налаштування з інтерфейсу ---
    const tInput = document.getElementById('timePerPoint');
    const sInput = document.getElementById('travelSpeed');

    // Якщо інпути знайдені - беремо їх значення, інакше - стандарт (3 хв, 15 км/год)
    const TIME_PER_POINT = tInput ? (parseFloat(tInput.value) || 3) : 3;
    const SPEED_KMH = sInput ? (parseFloat(sInput.value) || 15) : 15;
    const COEFF_CURV = 1.3;

    // 2. Рахуємо метрики
    Object.keys(tempGroups).forEach(key => {
        const g = tempGroups[key];
        const tp = turf.points(g.pts);
        
        let areaSqKmNum = 0;
        let polyFeature = null;

        // Геометрія
        if (g.pts.length >= 3) {
            polyFeature = turf.convex(tp);
        }
        if (!polyFeature) {
            const bbox = turf.bbox(tp);
            polyFeature = turf.bboxPolygon(bbox);
        }

        // Площа
        if (polyFeature) {
            areaSqKmNum = turf.area(polyFeature) / 1000000;
        }

        // Центр
        let centerPoint;
        if (polyFeature) {
            centerPoint = turf.centerOfMass(polyFeature);
        } else {
            centerPoint = turf.center(tp);
        }
        const cLat = centerPoint.geometry.coordinates[1];
        const cLng = centerPoint.geometry.coordinates[0];

        // --- Формула часу (з динамічними параметрами) ---
        const estDistKm = COEFF_CURV * Math.sqrt(g.count * areaSqKmNum);
        const travelTimeMin = (estDistKm / SPEED_KMH) * 60;
        const serviceTimeMin = g.count * TIME_PER_POINT;
        
        let totalMin = Math.round((travelTimeMin + serviceTimeMin) / 5) * 5;
        if (totalMin === 0 && (travelTimeMin + serviceTimeMin) > 0) totalMin = 5;

        const h = Math.floor(totalMin / 60);
        const m = totalMin % 60;
        const timeStr = h > 0 ? `${h}год ${m}хв` : `${m} хв`;

        zonesCache[key] = {
            ...g,
            polygon: polyFeature,
            areaStr: areaSqKmNum.toFixed(2),
            timeStr: timeStr,
            centerLat: cLat,
            centerLng: cLng
        };
    });
}

// --- УПРАВЛЕНИЕ МОДАЛЬНЫМИ ОКНАМИ ---
let modalResolve = null; // Сюда сохраним функцию "что делать после ОК"
function showPrompt(title, desc, defaultValue = "") {
    return new Promise((resolve) => {
        const overlay = document.getElementById('customModal');
        const inp = document.getElementById('modalInput');
        
        document.getElementById('modalTitle').innerText = title;
        document.getElementById('modalDesc').innerText = desc;
        
        // Настраиваем режим "Prompt" (с вводом)
        inp.style.display = 'block';
        inp.value = defaultValue;
        
        overlay.style.display = 'flex';
        inp.focus();
        inp.select();
        
        modalResolve = resolve; // Запоминаем промис

        // Enter нажимает OK
        inp.onkeydown = (e) => { if(e.key === 'Enter') confirmModal(); };
    });
}

function showAlert(title, desc) {
    return new Promise((resolve) => {
        const overlay = document.getElementById('customModal');
        document.getElementById('modalTitle').innerText = title;
        document.getElementById('modalDesc').innerText = desc;
        document.getElementById('modalInput').style.display = 'none'; // Скрываем ввод
        
        overlay.style.display = 'flex';
        modalResolve = resolve;
    });
}

function closeModal(value) {
    document.getElementById('customModal').style.display = 'none';
    if (modalResolve) modalResolve(value); // Возвращаем null если отмена
    modalResolve = null;
}

function confirmModal() {
    const inp = document.getElementById('modalInput');
    const val = inp.style.display === 'none' ? true : inp.value; // Если это alert - вернем true, если prompt - текст
    closeModal(val);
}

// --- ОСНОВНА ЛОГІКА МАПИ ---
let map;
let hubsData = [];
let pointsData = [];
let markersMap = {}; // Для швидкого пошуку маркерів за ID
let layers = {
    hubs: L.layerGroup(),
    points: L.layerGroup(),
    polygons: L.layerGroup(),
    labels: L.layerGroup()
};
let selectionMode = false;
let selectedIds = new Set();
let historyStack = [];
const MAX_HISTORY = 20;

function initMap() {
    map = L.map('map', {zoomControl: false}).setView([50.4501, 30.5234], 11);
    L.control.zoom({ position: 'topright' }).addTo(map);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap' }).addTo(map);
    layers.polygons.addTo(map);
    layers.hubs.addTo(map);
    layers.points.addTo(map);
    layers.labels.addTo(map);
    
    initSearch(); // Запуск слухачів пошуку
}
initMap();

// --- SEARCH LOGIC ---
function initSearch() {
    const pInp = document.getElementById('searchPointInp');
    const zInp = document.getElementById('searchZoneInp');

    // Пошук точки
    pInp.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') {
            const val = this.value.trim().toLowerCase();
            if (!val) return;

            // Шукаємо по точному співпадінню або входженню
            const found = pointsData.find(p => String(p.id).toLowerCase().includes(val));
            
            if (found) {
                // 1. Летимо до точки
                map.flyTo([found.lat, found.lng], 18, { duration: 1.5 });
                
                const m = markersMap[found.id];
                if (m) {
                    // 2. Створюємо і відкриваємо яскравий тултіп
                    m.bindTooltip(String(found.id), {
                        permanent: true,      
                        direction: 'top',     
                        className: 'flash-tooltip', 
                        offset: [0, -15],     
                        opacity: 1
                    }).openTooltip();

                    // 3. Через 3 секунди видаляємо тултіп
                    setTimeout(() => {
                        m.closeTooltip();
                        m.unbindTooltip();
                    }, 3000);
                }
                
                this.value = ''; 
                this.blur(); 
            } else {
                showAlert('Пошук', 'Точку не знайдено!');
            }
        }
    });

    // Пошук зони
    zInp.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') {
            const val = parseInt(this.value);
            if (!val && val !== 0) return;

            const groupPoints = pointsData.filter(p => p.groupIndex === val);
            
            if (groupPoints.length > 0) {
                const lats = groupPoints.map(p => p.lat);
                const lngs = groupPoints.map(p => p.lng);
                const bounds = L.latLngBounds(
                    [Math.min(...lats), Math.min(...lngs)],
                    [Math.max(...lats), Math.max(...lngs)]
                );
                map.fitBounds(bounds, {padding: [50, 50], maxZoom: 18});
                this.value = '';
                this.blur();
            } else {
                showAlert('Пошук', `Зону №${val} не знайдено!`);
            }
        }
    });
}

// --- FILE PROCESSING ---
document.getElementById('fileInput').addEventListener('change', function(e) {
    const file = e.target.files[0];
    if (file) {
        document.getElementById('fileName').innerText = file.name;
        const reader = new FileReader();
        reader.onload = function(e) {
            const data = new Uint8Array(e.target.result);
            const wb = XLSX.read(data, {type: 'array'});
            if (wb.SheetNames.includes("Saved_Points") && wb.SheetNames.includes("Saved_Hubs")) {
                restoreWork(wb);
            } else {
                parseNewFile(wb);
            }
        };
        reader.readAsArrayBuffer(file);
    }
});

function parseNewFile(wb) {
    const names = wb.SheetNames;
    let hName = names.find(n => n.toLowerCase().includes('служб') || n.toLowerCase().includes('hubs')) || names[0];
    let pName = names.find(n => n.toLowerCase().includes('пошт') || n.toLowerCase().includes('points')) || names[1] || names[0];
    const hRaw = XLSX.utils.sheet_to_json(wb.Sheets[hName]);
    const pRaw = XLSX.utils.sheet_to_json(wb.Sheets[pName]);
    processData(hRaw, pRaw, false);
}

function restoreWork(wb) {
    const hRaw = XLSX.utils.sheet_to_json(wb.Sheets["Saved_Hubs"]);
    const pRaw = XLSX.utils.sheet_to_json(wb.Sheets["Saved_Points"]);
    
    hubsData = hRaw.map(h => ({ id: h.id, lat: h.lat, lng: h.lng }));
    
    pointsData = pRaw.map(p => ({
        id: p.id, lat: p.lat, lng: p.lng,
        assignedHub: p.assignedHub, groupIndex: p.groupIndex, 
        color: p.color,
        load: p.load || 0
    }));
    
    historyStack = []; 
    updateUndoUI();
    
    drawHubs(); 
    redrawMap(); // <--- ОСЬ ЦЕ ГОЛОВНЕ: воно запустить calculateZoneMetrics
    
    const statusEl = document.getElementById('fileStatus');
    statusEl.innerHTML = "Відновлено! <span class='status-ok'>✔ Saved</span>";
    statusEl.classList.add('status-ok');
}


function processData(hRaw, pRaw, isRestored) {
    if(!isRestored) {
        hubsData = hRaw.filter(r => r['Широта']).map(h => ({
            id: h['Склад'] || h['Название'] || h['ID'] || 'Unknown',
            lat: parseFloat(h['Широта']), lng: parseFloat(h['Довгота'])
        }));

        if (pRaw.length > 0) {
            const keys = Object.keys(pRaw[0]);
            var loadKey = keys.find(k => /вага|weight|кг|kg|об'?єм|vol|груз|load/i.test(k));
            console.log("Load column detected:", loadKey);
        }

        pointsData = pRaw.filter(r => r['Широта']).map(p => ({
            id: p['Склад'] || p['ID'] || 'Unknown',
            lat: parseFloat(p['Широта']), lng: parseFloat(p['Довгота']),
            assignedHub: null, groupIndex: 0, color: '#475569',
            load: loadKey ? (parseFloat(p[loadKey]) || 0) : 0
        }));
    }
    historyStack = []; updateUndoUI();
    
    let totalLoad = pointsData.reduce((acc, p) => acc + p.load, 0);
    document.getElementById('fileStatus').innerText = `Т: ${pointsData.length} | Вага: ${totalLoad.toFixed(0)}`;
    document.getElementById('fileStatus').classList.remove('status-ok');
    drawHubs(); drawPoints();
}

// --- ALGORITHMS ---
function calculateDistribution() {
    if(!hubsData.length) return alert('Завантажте файл!');
    saveState(); 

    const maxPts = parseInt(document.getElementById('maxCapacity').value) || 50;
    const maxLoad = parseInt(document.getElementById('maxLoad').value) || 100000;
    const algo = document.getElementById('algoSelect').value;

    pointsData.forEach(p => {
        if (p.isLocked) return; 

        let nearest = null, min = Infinity;
        const pt = turf.point([p.lng, p.lat]);
        hubsData.forEach(h => {
            const d = turf.distance(pt, turf.point([h.lng, h.lat]));
            if(d < min) { min = d; nearest = h.id; }
        });
        p.assignedHub = nearest;
        p.groupIndex = 0; 
    });

    hubsData.forEach(h => {
        let hubPoints = pointsData.filter(p => p.assignedHub === h.id && !p.isLocked);
        if (!hubPoints.length) return;
        if (algo === 'greedy') applyGreedyAlgo(h, hubPoints, maxPts, maxLoad);
        else applyKMeansAlgo(h, hubPoints, maxPts, maxLoad);
    });
    redrawMap();
}

function applyKMeansAlgo(hub, pts, maxPts, maxLoad) {
    const totalLoad = pts.reduce((sum, p) => sum + p.load, 0);
    const kLoad = Math.ceil(totalLoad / maxLoad);
    const kCount = Math.ceil(pts.length / maxPts);
    const k = Math.max(kLoad, kCount);

    if(k <= 1) {
        const col = getDistinctColor(1);
        pts.forEach(p => { p.groupIndex = 1; p.color = col; });
    } else {
        const fc = turf.featureCollection(pts.map(p => turf.point([p.lng, p.lat], {oid: p.id})));
        const clustered = turf.clustersKmeans(fc, {numberOfClusters: k});
        const mapCol = {}; let localC = 0;
        clustered.features.forEach(f => {
            const cid = f.properties.cluster; 
            if(!mapCol[cid]) { localC++; mapCol[cid] = getDistinctColor((hub.id.length + localC) * 5); }
            const p = pts.find(x => x.id === f.properties.oid);
            if(p) { p.groupIndex = cid + 1; p.color = mapCol[cid]; }
        });
    }
}

function applyGreedyAlgo(hub, pts, maxPts, maxLoad) {
    let pool = [...pts]; let gCounter = 1;
    const hubPt = turf.point([hub.lng, hub.lat]);
    
    while(pool.length > 0) {
        let farthestPt = pool[0]; let maxDist = -1;
        pool.forEach(p => {
            const d = turf.distance(hubPt, turf.point([p.lng, p.lat]));
            if(d > maxDist) { maxDist = d; farthestPt = p; }
        });
        
        const anchorGeo = turf.point([farthestPt.lng, farthestPt.lat]);
        const withDist = pool.map(p => ({ p: p, d: turf.distance(anchorGeo, turf.point([p.lng, p.lat])) }));
        withDist.sort((a, b) => a.d - b.d);
        
        let currentChunk = [];
        let currentCount = 0;
        let currentLoad = 0;
        
        for (let i = 0; i < withDist.length; i++) {
            const cand = withDist[i].p;
            if (currentCount === 0 || 
               (currentCount + 1 <= maxPts && currentLoad + cand.load <= maxLoad)) {
                currentChunk.push(cand);
                currentCount++;
                currentLoad += cand.load;
            }
        }

        const chunkIds = new Set(currentChunk.map(x => x.id));
        const col = getDistinctColor((hub.id.length + gCounter) * 7);
        currentChunk.forEach(p => { p.groupIndex = gCounter; p.color = col; });
        
        pool = pool.filter(p => !chunkIds.has(p.id));
        gCounter++;
    }
}

// --- DRAWING & UI ---
function drawHubs() {
    layers.hubs.clearLayers();
    const icon = L.divIcon({
        className: '',
        html: "<div style='background:#0f172a; color:#fff; width:24px; height:24px; border-radius:50%; display:flex; align-items:center; justify-content:center; border:2px solid #fff; font-weight:bold;'>H</div>",
        iconSize: [28,28]
    });
    hubsData.forEach(h => L.marker([h.lat, h.lng], {icon}).addTo(layers.hubs));
}

function drawPoints() {
    layers.points.clearLayers();
    markersMap = {}; // Очищуємо карту маркерів
    pointsData.forEach(p => {
        const isSelected = selectedIds.has(p.id);
        const extraClass = isSelected ? 'selected-marker' : '';
        const hexColor = getCurrentHexColor(p.color); 

        const icon = L.divIcon({
            className: '', 
            html: `<div class="pt-marker ${extraClass}" id="marker-${p.id}" style='background:${p.color}; width:10px; height:10px; border-radius:50%; border:1px solid #1e293b; transition:all 0.1s;'></div>`,
            iconSize: [12,12]
        });
        const m = L.marker([p.lat, p.lng], {icon});
        
        // ЗБЕРІГАЄМО ПОСИЛАННЯ НА МАРКЕР
        markersMap[p.id] = m; 

        m.on('click', function(e) {
            if (selectionMode) togglePointSelection(p.id);
            else {
                const popupContent = `
                    <b>${p.id}</b><br>
                    СД: ${p.assignedHub}<br>
                    Вага: ${p.load}<br>
                    Група: <span style='font-size:1.2em; font-weight:bold'>${p.groupIndex}</span>
                    <hr style="border-color:#334155; margin:8px 0;">
                    
                    <div style="font-size:0.7rem; color:#94a3b8; margin-bottom:2px;">Переміщення:</div>
                    <div class="popup-row">
                        <input type="number" id="m-${p.id}" value="${p.groupIndex}" style="width:60px">
                        <button class="small-btn" onclick="movePt('${p.id}')">OK</button>
                    </div>

                    <div style="font-size:0.7rem; color:#94a3b8; margin-bottom:2px; margin-top:8px;">Об'єднання груп:</div>
                    <div class="popup-row">
                        <input type="number" id="mg-${p.id}" placeholder="№" style="width:60px">
                        <button class="small-btn" onclick="mergeGr('${p.id}')">Поєднати</button>
                    </div>
                    
                    <div style="font-size:0.7rem; color:#94a3b8; margin-bottom:2px; margin-top:8px;">Колір групи:</div>
                    <div class="popup-row">
                        <input type="color" id="clr-${p.id}" value="${hexColor}" style="width:40px; height:24px; cursor:pointer; border:none; padding:0;">
                        <button class="small-btn" onclick="changeGroupColor('${p.id}')" style="flex-grow:1;">Змінити колір</button>
                    </div>
                    `;
                L.popup().setLatLng(e.latlng).setContent(popupContent).openOn(map);
            }
        });
        m.addTo(layers.points);
    });
}

function drawBoundaries() {
    layers.polygons.clearLayers(); 
    layers.labels.clearLayers();
    
    Object.values(zonesCache).forEach(z => {
        // Рисуем полигон
        if (z.polygon && z.pts.length >= 3) {
             L.geoJSON(z.polygon, {
                 style: {color: z.color, weight: 2, fillOpacity: 0.3}
             }).addTo(layers.polygons);
        }
        
        // Рисуем маркер с номером группы (координаты берем готовые из кеша)
        const icon = L.divIcon({ className: 'group-label', html: z.groupId, iconSize:[20,20], iconAnchor:[10,10] });
        
        // Используем z.centerLat и z.centerLng
        const labelMarker = L.marker([z.centerLat, z.centerLng], {icon}).addTo(layers.labels);
        
        labelMarker.bindTooltip(
            `<b>Група ${z.groupId}</b> (Хаб: ${z.hubId})<br>` +
            `Точок: <b>${z.count}</b><br>` +
            `Вага: <b>${z.load.toFixed(0)}</b><br>` +
            `Площа: <b>${z.areaStr} км²</b><br>` +
            `<hr style="margin:5px 0; border-color:#555">` +
            `Орієнт. час: <b>${z.timeStr}</b>`
        );

        labelMarker.on('contextmenu', function(e) {
            L.DomEvent.stopPropagation(e); 
            openContextMenu(e, z.hubId, z.groupId);
        });
    });
}



function redrawMap() { 
    calculateZoneMetrics(); // Спочатку рахуємо математику (1 раз)
    drawPoints();           // Малюємо точки
    drawBoundaries();       // Малюємо зони (використовуючи пораховане)
}

// --- UNDO/REDO & ACTIONS ---
function saveState() {
    const snapshot = JSON.parse(JSON.stringify(pointsData));
    historyStack.push(snapshot);
    if (historyStack.length > MAX_HISTORY) historyStack.shift();
    updateUndoUI();
}
window.undoLastAction = function() {
    if (historyStack.length === 0) return;
    pointsData = historyStack.pop();
    clearSelection(); redrawMap(); updateUndoUI();
};
function updateUndoUI() {
    const btn = document.getElementById('undoBtn');
    btn.disabled = historyStack.length === 0;
    btn.style.opacity = historyStack.length === 0 ? '0.5' : '1';
    btn.innerText = `↩ Скасувати дію` + (historyStack.length ? ` (${historyStack.length})` : '');
}

window.movePt = function(id) {
    const val = parseInt(document.getElementById('m-'+id).value);
    const p = pointsData.find(x => x.id === id);
    
    if(p && val && p.groupIndex !== val) { 
        saveState(); 
        const newColor = getColor(p.assignedHub, val);
        p.groupIndex = val; 
        p.color = newColor; 
        map.closePopup(); 
        redrawMap(); 
    }
};

window.changeGroupColor = function(id) {
    const p = pointsData.find(x => x.id === id);
    const newColor = document.getElementById('clr-' + id).value;
    if(p && newColor) { 
        saveState(); 
        const targetHub = p.assignedHub;
        const targetGroup = p.groupIndex;
        pointsData.forEach(pt => {
            if (pt.assignedHub === targetHub && pt.groupIndex === targetGroup) {
                pt.color = newColor; 
            }
        });
        map.closePopup(); 
        redrawMap(); 
    }
};

window.mergeGr = function(id) {
    const pSrc = pointsData.find(x => x.id === id);
    const tIdx = parseInt(document.getElementById('mg-'+id).value);
    if(pSrc && tIdx && pSrc.groupIndex !== tIdx) {
        saveState();
        const tCol = getColor(pSrc.assignedHub, tIdx);
        const sHub = pSrc.assignedHub; const sGrp = pSrc.groupIndex;
        pointsData.forEach(p => { if(p.assignedHub === sHub && p.groupIndex === sGrp) { p.groupIndex = tIdx; p.color = tCol; }});
        map.closePopup(); redrawMap();
    }
};

window.moveSelectedPoints = function() {
    const targetGroup = parseInt(document.getElementById('bulkGroupInput').value);
    if (!targetGroup && targetGroup !== 0) return alert("Вкажіть групу!");
    if (selectedIds.size === 0) return alert("Оберіть точки!");
    
    saveState();
    const colorCache = {};
    
    pointsData.forEach(p => {
        if (!selectedIds.has(p.id)) return;
        const hub = p.assignedHub;
        const key = hub + '_' + targetGroup; 
        if (!colorCache[key]) {
            const ex = pointsData.find(x => x.assignedHub === hub && x.groupIndex === targetGroup && !selectedIds.has(x.id));
            colorCache[key] = ex ? ex.color : getDistinctColor((String(hub).length + targetGroup) * 13);
        }
        p.groupIndex = targetGroup; 
        p.color = colorCache[key];
    });
    
    clearSelection(); 
    document.getElementById('bulkGroupInput').value = ''; 
    redrawMap();
};

// --- UTILS ---
function getColor(hid, gidx) {
    const ex = pointsData.find(p => p.assignedHub === hid && p.groupIndex === gidx);
    return ex ? ex.color : getDistinctColor((hid.length+gidx)*13);
}
function getDistinctColor(i) { return `hsl(${(i * 137.5) % 360}, 75%, 55%)`; }

function toggleSelectionMode() {
    selectionMode = !selectionMode;
    const btn = document.getElementById('btnSelectMode');
    const panel = document.getElementById('bulkActions');
    if (selectionMode) {
        btn.style.background = '#facc15'; btn.style.color = '#000';
        btn.innerText = 'Масове переміщення (ВКЛ)';
        panel.style.display = 'block';
    } else {
        btn.style.background = ''; btn.style.color = '';
        btn.innerText = 'Масове переміщення';
        if(selectedIds.size === 0) panel.style.display = 'none';
    }
}
function togglePointSelection(id) {
    const el = document.getElementById('marker-' + id);
    if (selectedIds.has(id)) { selectedIds.delete(id); if(el) el.classList.remove('selected-marker'); }
    else { selectedIds.add(id); if(el) el.classList.add('selected-marker'); }
    document.getElementById('selCount').innerText = selectedIds.size;
}
function clearSelection() {
    selectedIds.clear(); document.getElementById('selCount').innerText = 0;
    document.querySelectorAll('.selected-marker').forEach(el => el.classList.remove('selected-marker'));
    if(selectionMode) toggleSelectionMode();
    document.getElementById('bulkActions').style.display = 'none';
}

function exportToExcel() {
    if(!pointsData.length) return;
    const wsExport = XLSX.utils.json_to_sheet(pointsData.map(p => ({
        "ID":p.id, "Lat":p.lat, "Lng":p.lng, "Hub":p.assignedHub, "Group":p.groupIndex, "Load": p.load
    })));
    const wsSavedPoints = XLSX.utils.json_to_sheet(pointsData);
    const wsSavedHubs = XLSX.utils.json_to_sheet(hubsData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, wsExport, "Result_Export");
    XLSX.utils.book_append_sheet(wb, wsSavedPoints, "Saved_Points");
    XLSX.utils.book_append_sheet(wb, wsSavedHubs, "Saved_Hubs");
    XLSX.writeFile(wb, `Result.xlsx`);
}

// --- MOUSE WHEEL SUPPORT (IMPROVED) ---
document.querySelectorAll('input[type="number"]').forEach(input => {
    input.addEventListener('wheel', function(e) {
        // Запобігаємо прокрутці сторінки, якщо курсор на інпуті
        e.preventDefault();
        
        // Визначаємо крок (наприклад, 0.5 або 1)
        const step = parseFloat(this.getAttribute('step')) || 1;
        const min = parseFloat(this.getAttribute('min'));
        const max = parseFloat(this.getAttribute('max'));
        
        // Поточне значення
        let val = parseFloat(this.value) || 0;
        
        // Змінюємо значення
        if (e.deltaY < 0) {
            val += step; // Крутимо вгору -> плюс
        } else {
            val -= step; // Крутимо вниз -> мінус
        }

        // Перевірка на min/max
        if (!isNaN(min) && val < min) val = min;
        if (!isNaN(max) && val > max) val = max;

        // Округляємо, щоб не було 3.000000004
        // Якщо крок дробовий, лишаємо 1 знак після коми, якщо цілий - 0
        const decimals = step % 1 !== 0 ? 1 : 0;
        this.value = val.toFixed(decimals);

        // --- ГОЛОВНЕ: Повідомляємо всім, що значення змінилося ---
        // Це змусить спрацювати наш LIVE UPDATE слухач
        this.dispatchEvent(new Event('input')); 
        
    }, { passive: false });
});

function hslToHex(h, s, l) {
    l /= 100;
    const a = s * Math.min(l, 1 - l) / 100;
    const f = n => {
        const k = (n + h / 30) % 12;
        const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
        return Math.round(255 * color).toString(16).padStart(2, '0');
    };
    return `#${f(0)}${f(8)}${f(4)}`;
}

function getCurrentHexColor(colorStr) {
    if (colorStr.startsWith('#')) return colorStr;
    const match = colorStr.match(/hsl\((\d+(\.\d+)?),\s*(\d+)%,\s*(\d+)%\)/);
    if (match) {
        return hslToHex(parseFloat(match[1]), parseInt(match[3]), parseInt(match[4]));
    }
    return "#ffffff";
}

// --- CONTEXT MENU & SPLIT LOGIC ---
let ctxTarget = null; 

function openContextMenu(e, hubId, groupIndex) {
    ctxTarget = { hubId, groupIndex };
    const menu = document.getElementById('ctxMenu');
    menu.style.display = 'block';
    menu.style.left = e.originalEvent.pageX + 'px';
    menu.style.top = e.originalEvent.pageY + 'px';
}

document.addEventListener('click', function(e) {
    const menu = document.getElementById('ctxMenu');
    if (menu.style.display === 'block') {
        menu.style.display = 'none';
    }
});

map.on('move', () => { document.getElementById('ctxMenu').style.display = 'none'; });

function splitZoneAction() {
    if (!ctxTarget) return;
    
    // НОВОЕ: Красивый вызов
    showPrompt("Розбиття зони", `На скільки частин розбити групу ${ctxTarget.groupIndex}?`, "2").then((countStr) => {
        
        if (!countStr) return;
        const parts = parseInt(countStr);

        if (!parts || parts < 2) return; 

        saveState(); 

        const targetPoints = pointsData.filter(p => 
            p.assignedHub === ctxTarget.hubId && p.groupIndex === ctxTarget.groupIndex
        );

        if (targetPoints.length < parts) {
            showAlert("Помилка", "Замало точок для такого розбиття!");
            return;
        }

        const fc = turf.featureCollection(targetPoints.map(p => turf.point([p.lng, p.lat], {oid: p.id})));
        const clustered = turf.clustersKmeans(fc, {numberOfClusters: parts});

        let maxIndex = 0;
        pointsData.forEach(p => {
            if (p.assignedHub === ctxTarget.hubId && p.groupIndex > maxIndex) maxIndex = p.groupIndex;
        });
        
        const clusterToGroupMap = {};
        let addedGroups = 0;

        clustered.features.forEach(f => {
            const cId = f.properties.cluster;
            if (clusterToGroupMap[cId] === undefined) {
                if (cId === 0) {
                    clusterToGroupMap[cId] = ctxTarget.groupIndex; 
                } else {
                    addedGroups++;
                    clusterToGroupMap[cId] = maxIndex + addedGroups; 
                }
            }
            
            const realId = clusterToGroupMap[cId];
            const pt = pointsData.find(p => p.id === f.properties.oid);
            if (pt) {
                pt.groupIndex = realId;
                if (cId !== 0) {
                        pt.color = getDistinctColor((String(pt.assignedHub).length + realId) * 17);
                }
            }
        });

        redrawMap();
    });
}

// --- DRAWING TOOL (LASSO) ---
const drawItems = new L.FeatureGroup();
map.addLayer(drawItems);

const drawControl = new L.Control.Draw({
    draw: {
        polyline: false, circle: false, marker: false, circlemarker: false,
        rectangle: true, polygon: true
    },
    edit: { featureGroup: drawItems, edit: false, remove: false }
});
map.addControl(drawControl);

map.on(L.Draw.Event.CREATED, function (e) {
    const layer = e.layer;
    const shape = layer.toGeoJSON();
    
    // НОВОЕ: Вызов красивого окна
    showPrompt("Створення зони", "Введіть номер групи для цієї зони:", "99").then((groupStr) => {
        
        // Если нажали отмену или ничего не ввели
        if (groupStr === null || groupStr.trim() === "") {
            map.removeLayer(layer); // Удаляем рисунок
            return; 
        }

        const newGroupIndex = parseInt(groupStr);
        if (!newGroupIndex && newGroupIndex !== 0) return; 
        
        saveState(); // Сохраняем историю для Ctrl+Z

        let count = 0;
        pointsData.forEach(p => {
            const pt = turf.point([p.lng, p.lat]);
            if (turf.booleanPointInPolygon(pt, shape)) {
                // Если у точки не было хаба - ищем ближайший
                if (!p.assignedHub) {
                    let nearest = null, min = Infinity;
                    hubsData.forEach(h => {
                        const d = turf.distance(pt, turf.point([h.lng, h.lat]));
                        if(d < min) { min = d; nearest = h.id; }
                    });
                    p.assignedHub = nearest;
                }
                p.groupIndex = newGroupIndex;
                p.isLocked = true; 
                p.color = getDistinctColor((String(p.assignedHub).length + newGroupIndex) * 20);
                count++;
            }
        });

        // Вместо alert используем наше окно (без поля ввода)
        showAlert("Готово", `Згруповано та заблоковано точок: ${count}`);
        redrawMap();
    });
});

// --- ZONE GROUPING (CLUSTERING) ---

// --- ZONE GROUPING & MANUAL LINKING ---

let cachedZones = []; // Тут храним данные о зонах после расчета
let manualMode = false;
let selectedZones = []; // Список ID выбранных зон (в порядке клика)

function getZoneStats() {
    const zones = {};
    
    pointsData.forEach(p => {
        if (p.groupIndex === 0 || !p.assignedHub) return;
        const key = `${p.assignedHub}_${p.groupIndex}`;
        if (!zones[key]) {
            zones[key] = {
                uniqueId: key,
                hubId: p.assignedHub,
                groupId: p.groupIndex,
                points: [],
                load: 0
            };
        }
        zones[key].points.push(turf.point([p.lng, p.lat]));
        zones[key].load += p.load;
    });

    const result = [];
    Object.values(zones).forEach(z => {
        const fc = turf.featureCollection(z.points);
        const center = turf.center(fc); 
        z.centerLat = center.geometry.coordinates[1];
        z.centerLng = center.geometry.coordinates[0];
        result.push(z);
    });

    return result;
}

// Глобальная переменная для хранения отрисованных маркеров, 
// чтобы мы могли менять им классы без перерисовки всей карты
let zoneMarkersMap = {}; 

function groupZones() {
    if (layers.routes) layers.routes.clearLayers();
    else layers.routes = L.layerGroup().addTo(map);
    
    zoneMarkersMap = {}; // Сброс карты маркеров

    const minZ = parseInt(document.getElementById('minZones').value) || 2;
    const maxZ = parseInt(document.getElementById('maxZones').value) || 5;
    
    cachedZones = getZoneStats(); // Сохраняем в глобальную переменную
    if (cachedZones.length === 0) return showAlert("Увага", "Спочатку створіть зони.");

    // Автоматический расчет (тот же, что и раньше)
    const hubsDict = {};
    cachedZones.forEach(z => {
        if (!hubsDict[z.hubId]) hubsDict[z.hubId] = [];
        hubsDict[z.hubId].push(z);
    });

    let totalGroups = 0;

    Object.keys(hubsDict).forEach(hubId => {
        const hubObj = hubsData.find(h => h.id == hubId);
        let pool = hubsDict[hubId];

        if (hubObj) {
            const hubPt = turf.point([hubObj.lng, hubObj.lat]);
            pool.forEach(z => {
                z.distToHub = turf.distance(turf.point([z.centerLng, z.centerLat]), hubPt);
            });
            pool.sort((a, b) => b.distToHub - a.distToHub);
        }

        let hubGroups = []; 
        while (pool.length > 0) {
            let currentGroup = [];
            let currentZone = pool[0];
            pool.splice(0, 1);
            currentGroup.push(currentZone);

            while (currentGroup.length < maxZ && pool.length > 0) {
                let nearestIdx = -1;
                let minDist = Infinity;
                const lastAdded = currentGroup[currentGroup.length - 1];
                const from = turf.point([lastAdded.centerLng, lastAdded.centerLat]);

                pool.forEach((candidate, idx) => {
                    const to = turf.point([candidate.centerLng, candidate.centerLat]);
                    const dist = turf.distance(from, to);
                    if (dist < minDist) { minDist = dist; nearestIdx = idx; }
                });

                if (minDist > 20 && currentGroup.length >= minZ) break; 

                if (nearestIdx !== -1) {
                    currentGroup.push(pool[nearestIdx]);
                    pool.splice(nearestIdx, 1);
                } else break;
            }
            hubGroups.push(currentGroup);
        }

        if (hubGroups.length > 1) {
            let lastGrp = hubGroups[hubGroups.length - 1];
            let prevGrp = hubGroups[hubGroups.length - 2];
            while (lastGrp.length < minZ && prevGrp.length > minZ) {
                const movedZone = prevGrp.pop(); 
                lastGrp.unshift(movedZone); 
            }
        }

        hubGroups.forEach(grp => {
            drawGroupConnection(grp, totalGroups);
            totalGroups++;
        });
    });

    const statusEl = document.getElementById('groupStatus');
    statusEl.innerText = `Сформовано зв'язок: ${totalGroups}`;
    statusEl.style.color = "#facc15";
}

function drawGroupConnection(group, groupIndex) {
    if (group.length < 1) return;
    const latlngs = group.map(z => [z.centerLat, z.centerLng]);
    const color = `hsl(${(groupIndex * 137.5) % 360}, 80%, 50%)`;

    // Линия
    if (group.length > 1) {
        L.polyline(latlngs, {
            color: color, weight: 4, opacity: 0.7, dashArray: '5, 10'
        }).addTo(layers.routes);
    }

    // Маркеры
    group.forEach((z, idx) => {
        const iconHtml = `<div id="zicon-${z.uniqueId}" style="
            background:${color}; color:#fff; border:1px solid #fff; 
            font-size:10px; width:18px; height:18px; border-radius:50%; 
            display:flex; align-items:center; justify-content:center; 
            box-shadow:0 1px 3px rgba(0,0,0,0.5); transition: transform 0.2s;">
            ${idx + 1}
        </div>`;
                          
        const icon = L.divIcon({ className: '', html: iconHtml });
        
        const m = L.marker([z.centerLat, z.centerLng], {icon: icon})
         .addTo(layers.routes)
         .bindTooltip(`Зона ${z.groupId}<br>Вага: ${z.load.toFixed(0)}`, { direction: 'top' });

        // --- КЛИК ПО МАРКЕРУ ЗОНЫ ---
        m.on('click', function(e) {
            if (manualMode) {
                L.DomEvent.stopPropagation(e);
                toggleZoneSelection(z.uniqueId);
            }
        });
        
        zoneMarkersMap[z.uniqueId] = m; // Сохраняем ссылку
    });
}

// --- MANUAL MODE LOGIC ---

function toggleManualMode() {
    manualMode = !manualMode;
    const btn = document.getElementById('btnManualMode');
    const panel = document.getElementById('manualPanel');
    
    if (manualMode) {
        btn.innerText = "ВКЛ";
        btn.style.background = "#facc15";
        btn.style.color = "#000";
        panel.style.display = "block";
        
        // Если еще нет зон, попробуем их найти
        if (cachedZones.length === 0) {
            cachedZones = getZoneStats();
            // Просто отрисуем точки без линий, чтобы было что кликать
            cachedZones.forEach(z => drawGroupConnection([z], 999));
        }
    } else {
        btn.innerText = "ВКЛ";
        btn.style.background = "";
        btn.style.color = "";
        panel.style.display = "none";
        clearManualSelection();
    }
}

function toggleZoneSelection(uid) {
    const divIcon = document.getElementById('zicon-' + uid);
    
    if (selectedZones.includes(uid)) {
        // Deselect
        selectedZones = selectedZones.filter(id => id !== uid);
        if(divIcon) divIcon.parentElement.classList.remove('zone-marker-selected');
    } else {
        // Select
        selectedZones.push(uid);
        if(divIcon) divIcon.parentElement.classList.add('zone-marker-selected');
    }
    document.getElementById('manualCount').innerText = selectedZones.length;
}

function clearManualSelection() {
    selectedZones.forEach(uid => {
        const divIcon = document.getElementById('zicon-' + uid);
        if(divIcon) divIcon.parentElement.classList.remove('zone-marker-selected');
    });
    selectedZones = [];
    document.getElementById('manualCount').innerText = 0;
}

function linkManualZones() {
    if (selectedZones.length < 2) return alert("Оберіть мінімум 2 зони!");
    
    // Получаем объекты зон по ID
    const zonesToLink = selectedZones.map(uid => cachedZones.find(z => z.uniqueId === uid)).filter(Boolean);
    
    // Рисуем НОВУЮ линию поверх старых
    // Используем уникальный яркий цвет (например, ярко-белый или кислотный)
    const latlngs = zonesToLink.map(z => [z.centerLat, z.centerLng]);
    
    L.polyline(latlngs, {
        color: '#ffffff',
        weight: 6,
        opacity: 0.9,
    }).addTo(layers.routes);
    
    L.polyline(latlngs, {
        color: '#ef4444', // Красная сердцевина
        weight: 3,
        opacity: 1,
    }).addTo(layers.routes);

    // Сбрасываем выбор
    clearManualSelection();
}

// --- UI: Сворачивание блоков ---
function toggleCard(headerElement) {
    // Ищем родительский элемент .card
    const card = headerElement.closest('.card');
    // Переключаем класс collapsed
    card.classList.toggle('collapsed');
}

// --- SCHEDULE & OSRM LOGIC ---

// --- OSRM CACHING LOGIC ---

// 1. Загружаем кэш из памяти браузера при запуске
let osrmCache = {};
try {
    const savedCache = localStorage.getItem('postomater_osrm_cache');
    if (savedCache) {
        osrmCache = JSON.parse(savedCache);
        console.log(`OSRM Cache loaded: ${Object.keys(osrmCache).length} routes`);
    }
} catch (e) {
    console.error("Cache load error", e);
}

// Помощник для создания уникального ключа маршрута
function getRouteKey(lat1, lng1, lat2, lng2) {
    // Гарантируем, что это числа
    const l1 = parseFloat(lat1);
    const g1 = parseFloat(lng1);
    const l2 = parseFloat(lat2);
    const g2 = parseFloat(lng2);

    return `${l1.toFixed(4)},${g1.toFixed(4)}_${l2.toFixed(4)},${g2.toFixed(4)}`;
}

// 2. Обновленная функция с кэшем
async function getOSRMDuration(lat1, lng1, lat2, lng2) {
    const key = getRouteKey(lat1, lng1, lat2, lng2);

    // А. Сначала проверяем кэш
    if (osrmCache[key] !== undefined) {
        console.log(`Route found in cache: ${key}`);
        return osrmCache[key]; // Возвращаем сохраненное значение
    }

    // Б. Если в кэше нет - делаем запрос
    // Формат OSRM: lon,lat;lon,lat
    const url = `https://router.project-osrm.org/route/v1/driving/${lng1},${lat1};${lng2},${lat2}?overview=false`;
    
    try {
        const response = await fetch(url);
        if (!response.ok) return null; 
        const data = await response.json();
        
        if (data.routes && data.routes.length > 0) {
            const seconds = data.routes[0].duration;
            const minutes = seconds / 60;
            const result = Math.ceil(minutes / 5) * 5; // Округляем до 5 мин

            // В. Сохраняем результат в кэш и в LocalStorage
            osrmCache[key] = result;
            localStorage.setItem('postomater_osrm_cache', JSON.stringify(osrmCache));
            
            return result;
        }
        return null;
    } catch (e) {
        console.error("OSRM Error:", e);
        return null;
    }
}

// Функция для очистки кэша (на всякий случай)
function clearOSRMCache() {
    localStorage.removeItem('postomater_osrm_cache');
    osrmCache = {};
    alert("Кеш маршрутів очищено!");
}



// Додавання хвилин до часу "HH:MM"
function addMinutesToTime(timeStr, minutesToAdd) {
    const [h, m] = timeStr.split(':').map(Number);
    const date = new Date();
    date.setHours(h, m, 0, 0);
    date.setMinutes(date.getMinutes() + minutesToAdd);
    
    const newH = String(date.getHours()).padStart(2, '0');
    const newM = String(date.getMinutes()).padStart(2, '0');
    return `${newH}:${newM}`;
}

async function generateSchedules() {
    // 1. Перевірки
    if (wavesConfig.length === 0) return showAlert("Помилка", "Додайте хоча б одну хвилю виїзду!");
    
    const zonesList = Object.values(zonesCache);
    if (zonesList.length === 0) return showAlert("Помилка", "Немає сформованих зон!");

    const btn = document.querySelector('button[onclick="generateSchedules()"]');
    const status = document.getElementById('scheduleStatus');
    
    btn.disabled = true;
    status.innerText = "⏳ Отримання маршрутів (один раз для всіх зон)...";
    
    const tableBody = document.querySelector('#scheduleTable tbody');
    tableBody.innerHTML = "";
    window.scheduleDataExport = [];

    // --- КРОК 1: Кешуємо дистанції (щоб не бомбити OSRM 3 рази для однієї точки) ---
    // Ми спочатку пройдемось по всіх зонах і знайдемо час доїзду.
    const travelTimesMap = {}; // map[zoneUniqueId] = minutes

    for (let i = 0; i < zonesList.length; i++) {
        const z = zonesList[i];
        const hub = hubsData.find(h => h.id == z.hubId);
        if (!hub) continue;

        // Ключ для кешу саме цієї ітерації
        const zKey = z.hubId + '_' + z.groupId;

        // Робимо запит
        await new Promise(r => setTimeout(r, 100)); // Невеличка пауза
        let driveTime = await getOSRMDuration(hub.lat, hub.lng, z.centerLat, z.centerLng);

        // Резервний розрахунок ("повітрям"), якщо OSRM не відповів
        if (!driveTime) {
            const dist = turf.distance(
                turf.point([hub.lng, hub.lat]), 
                turf.point([z.centerLng, z.centerLat])
            );
            driveTime = Math.ceil(((dist * 1.3) / 40 * 60) / 5) * 5;
        }
        travelTimesMap[zKey] = driveTime;
        status.innerText = `Маршрутизація: ${i + 1}/${zonesList.length}`;
    }

    status.innerText = "Генерація таблиці...";

    // --- КРОК 2: Множимо Хвилі на Зони ---
    // Сортуємо хвилі за часом
    wavesConfig.sort();
    
    // Сортуємо зони (за Хабом, потім за номером групи)
    zonesList.sort((a, b) => ('' + a.hubId).localeCompare(b.hubId) || a.groupId - b.groupId);

    // Параметри роботи
    const tPerPoint = parseFloat(document.getElementById('timePerPoint').value) || 3;
    const speedInZone = parseFloat(document.getElementById('travelSpeed').value) || 15;

    // Головний цикл: Хвиля -> Всі Зони
    wavesConfig.forEach((waveTime, waveIdx) => {
        
        zonesList.forEach(z => {
            const zKey = z.hubId + '_' + z.groupId;
            const driveTime = travelTimesMap[zKey] || 0;

            // --- РОЗРАХУНКИ ---
            const departureFromHub = waveTime; // Час цієї хвилі
            
            const arrivalAtZone = addMinutesToTime(departureFromHub, driveTime);
            
            // Час всередині зони (пробіг + сервіс)
            const estDistInternal = 1.3 * Math.sqrt(z.count * parseFloat(z.areaStr));
            const internalTravel = (estDistInternal / speedInZone) * 60;
            const serviceTime = z.count * tPerPoint;
            const totalZoneTime = Math.round((internalTravel + serviceTime) / 5) * 5;
            
            const departureFromZone = addMinutesToTime(arrivalAtZone, totalZoneTime);
            // --- ФОРМАТУВАННЯ (ЧЧ:ММ) ---
            const driveTimeStr = formatDuration(driveTime);      // Було: число хвилин
            const zoneTimeStr = formatDuration(totalZoneTime);   // Було: число хвилин

            // --- ВІДОБРАЖЕННЯ ---
            const tr = document.createElement('tr');
            // Додаємо клас, щоб візуально відділити хвилі (наприклад, жирніша лінія)
            if (zonesList.indexOf(z) === 0 && waveIdx > 0) {
                tr.style.borderTop = "2px solid #64748b"; 
            }

           tr.innerHTML = `
                <td><span class="wave-badge w-idx">${waveIdx + 1}</span></td>
                <td><span style="display:inline-block; width:10px; height:10px; border-radius:50%; background:${z.color}; margin-right:5px;"></span> Група ${z.groupId}</td>
                <td>${z.hubId}</td>
                <td><strong>${departureFromHub}</strong></td>
                <td>${driveTimeStr}</td>      <td>${arrivalAtZone}</td>
                <td>${zoneTimeStr}</td>       <td><strong>${departureFromZone}</strong></td>
            `;
            tableBody.appendChild(tr);

            // Експорт
            window.scheduleDataExport.push({
                "Хвиля": waveIdx + 1,
                "Виїзд (план)": departureFromHub,
                "Зона": `Група ${z.groupId}`,
                "Хаб": z.hubId,
                "Час в дорозі": driveTimeStr,     // Змінено
                "Прибуття в зону": arrivalAtZone,
                "Кількість точок": z.count,
                "Час роботи в зоні": zoneTimeStr, // Змінено
                "Кінець роботи": departureFromZone
            });
        });
    });

    status.innerText = `Готово! Створено ${wavesConfig.length * zonesList.length} графіків.`;
    btn.disabled = false;
    document.getElementById('scheduleContainer').style.display = 'flex';
}

function closeSchedule() {
    document.getElementById('scheduleContainer').style.display = 'none';
}

function exportScheduleToExcel() {
    if (!window.scheduleDataExport || window.scheduleDataExport.length === 0) return;
    
    const ws = XLSX.utils.json_to_sheet(window.scheduleDataExport);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Графіки");
    XLSX.writeFile(wb, "Графіки_Руху.xlsx");
}

// --- LIVE UPDATE LOGIC (ROBUST VERSION) ---
document.addEventListener("DOMContentLoaded", function() {
    const settingInputs = ['timePerPoint', 'travelSpeed'];
    
    settingInputs.forEach(id => {
        const el = document.getElementById(id);
        
        if (el) {
            // Використовуємо 'input', щоб реагувати миттєво під час друку
            el.addEventListener('input', function() {
                console.log(`Налаштування змінено: ${id} = ${this.value}`);
                
                // 1. Перераховуємо математику з новими цифрами
                calculateZoneMetrics(); 
                
                // 2. Оновлюємо тільки шари зон (так швидше, ніж перемальовувати все)
                drawBoundaries(); 
            });
        } else {
            console.warn(`Увага: Елемент з ID "${id}" не знайдено! Перевірте HTML.`);
        }
    });
});

// Перетворює хвилини (число) у формат "ЧЧ:ММ"
function formatDuration(totalMinutes) {
    if (!totalMinutes && totalMinutes !== 0) return "00:00";
    const h = Math.floor(totalMinutes / 60);
    const m = Math.round(totalMinutes % 60); // Округлюємо до цілого
    // padStart(2, '0') додає нуль попереду, якщо число менше 10
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
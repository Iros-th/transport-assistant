import { geocode, fetchRoutes } from './api.js';

let map;
let routeLayers = [];
let mapMarkers = [];

const state = {
    origin: null,
    dest: null,
    priority: 'transit',
    timeIso: new Date().toISOString()
};

let debounceTimer;

document.addEventListener('DOMContentLoaded', () => {
    initMap();
    initUI();
    registerServiceWorker();
    
    // Prefill default example
    state.origin = { name: 'Nørreport St.', lat: 55.6833, lon: 12.5714 };
    state.dest = { name: 'DTU Lyngby', lat: 55.7861, lon: 12.5235 };
    document.getElementById('origin-input').value = state.origin.name;
    document.getElementById('dest-input').value = state.dest.name;
    triggerSearch();
});

function initMap() {
    const isDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    const styleUrl = isDark ? 'https://tiles.openfreemap.org/styles/dark' : 'https://tiles.openfreemap.org/styles/liberty';
    
    map = new maplibregl.Map({
        container: 'map',
        style: styleUrl,
        center: [12.5683, 55.6761], // Copenhagen
        zoom: 12,
        attributionControl: false
    });
}

function initUI() {
    const originInput = document.getElementById('origin-input');
    const destInput = document.getElementById('dest-input');
    const originAuto = document.getElementById('origin-autocomplete');
    const destAuto = document.getElementById('dest-autocomplete');
    
    setupAutocomplete(originInput, originAuto, (place) => { state.origin = place; });
    setupAutocomplete(destInput, destAuto, (place) => { state.dest = place; });
    
    document.getElementById('swap-btn').addEventListener('click', () => {
        const temp = state.origin;
        state.origin = state.dest;
        state.dest = temp;
        
        const tempVal = originInput.value;
        originInput.value = destInput.value;
        destInput.value = tempVal;
    });
    
    const updateSegBtns = (btns, clickedValue) => {
        btns.forEach(btn => btn.setAttribute('aria-pressed', btn.value === clickedValue));
    };

    const prioBtns = document.querySelectorAll('#priority-transit, #priority-driving');
    prioBtns.forEach(btn => {
        btn.addEventListener('click', (e) => {
            state.priority = e.target.value;
            updateSegBtns(prioBtns, state.priority);
            if (state.origin && state.dest) triggerSearch();
        });
    });
    
    const timeBtns = document.querySelectorAll('#time-now, #time-later');
    timeBtns.forEach(btn => {
        btn.addEventListener('click', (e) => {
            updateSegBtns(timeBtns, e.target.value);
            if (e.target.value === 'later') {
                const picker = document.getElementById('time-picker');
                picker.classList.remove('hidden');
                try { picker.showPicker(); } catch(err){}
            } else {
                document.getElementById('time-picker').classList.add('hidden');
                state.timeIso = new Date().toISOString();
                if (state.origin && state.dest) triggerSearch();
            }
        });
    });
    
    document.getElementById('time-picker').addEventListener('change', (e) => {
        if (e.target.value) {
            state.timeIso = new Date(e.target.value).toISOString();
            if (state.origin && state.dest) triggerSearch();
        }
    });
    
    const $ = (s) => document.querySelector(s);
    $("#plan-form").addEventListener("submit", (e) => {
        e.preventDefault();
        triggerSearch();
    });
    
    window.addEventListener('online', () => document.getElementById('offline-banner').classList.add('hidden'));
    window.addEventListener('offline', () => document.getElementById('offline-banner').classList.remove('hidden'));
    
    setupBottomSheet();
}

function setupAutocomplete(inputEl, listEl, onSelect) {
    inputEl.addEventListener('input', (e) => {
        clearTimeout(debounceTimer);
        const query = e.target.value;
        
        if (query.length < 2) {
            listEl.classList.add('hidden');
            return;
        }
        
        debounceTimer = setTimeout(async () => {
            const results = await geocode(query);
            renderAutocomplete(results, listEl, inputEl, onSelect);
        }, 250);
    });
    
    inputEl.addEventListener('keydown', (e) => {
        const items = listEl.querySelectorAll('li');
        if (items.length === 0 || listEl.classList.contains('hidden')) return;
        
        let activeIndex = Array.from(items).findIndex(item => item.classList.contains('active'));
        
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            activeIndex = activeIndex < items.length - 1 ? activeIndex + 1 : 0;
            updateActiveItem(items, activeIndex);
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            activeIndex = activeIndex > 0 ? activeIndex - 1 : items.length - 1;
            updateActiveItem(items, activeIndex);
        } else if (e.key === 'Enter') {
            if (activeIndex >= 0) {
                e.preventDefault();
                items[activeIndex].click();
            }
        } else if (e.key === 'Escape') {
            listEl.classList.add('hidden');
        }
    });
    
    function updateActiveItem(items, index) {
        items.forEach((item, i) => {
            if (i === index) {
                item.classList.add('active');
                item.setAttribute('aria-selected', 'true');
                item.scrollIntoView({ block: 'nearest' });
            } else {
                item.classList.remove('active');
                item.setAttribute('aria-selected', 'false');
            }
        });
    }

    document.addEventListener('click', (e) => {
        if (!inputEl.contains(e.target) && !listEl.contains(e.target)) {
            listEl.classList.add('hidden');
        }
    });
}

function setupBottomSheet() {
    const panel = document.getElementById('panel');
    const handleWrapper = document.querySelector('.panel-handle-wrapper');
    if (!handleWrapper || window.innerWidth >= 768) return;
    
    let startY = 0;
    let currentTranslate = window.innerHeight * 0.4; // half by default? No, let's start at full?
    
    // Actually, prompt says "must leave the map visible". Let's default to half or peek on start if map has route?
    // Let's just implement the drag logic.
    const getSnapPoints = () => [0, window.innerHeight * 0.4, window.innerHeight * 0.7];
    
    handleWrapper.addEventListener('touchstart', (e) => {
        startY = e.touches[0].clientY;
        panel.style.transition = 'none';
    }, {passive: true});
    
    handleWrapper.addEventListener('touchmove', (e) => {
        const delta = e.touches[0].clientY - startY;
        let newTranslate = currentTranslate + delta;
        if (newTranslate < 0) newTranslate = 0;
        panel.style.transform = `translateY(${newTranslate}px)`;
    }, {passive: true});
    
    handleWrapper.addEventListener('touchend', (e) => {
        panel.style.transition = 'transform 0.3s ease';
        const finalTranslate = parseFloat(panel.style.transform.replace('translateY(', '').replace('px)', '')) || 0;
        
        const snaps = getSnapPoints();
        let closest = snaps[0];
        let minDiff = Math.abs(finalTranslate - snaps[0]);
        for(let i = 1; i < snaps.length; i++) {
            const diff = Math.abs(finalTranslate - snaps[i]);
            if (diff < minDiff) {
                minDiff = diff;
                closest = snaps[i];
            }
        }
        
        currentTranslate = closest;
        panel.style.transform = `translateY(${currentTranslate}px)`;
    });
}

function renderAutocomplete(results, listEl, inputEl, onSelect) {
    listEl.innerHTML = '';
    if (results.length === 0) {
        listEl.classList.add('hidden');
        return;
    }
    
    results.forEach((res, i) => {
        const li = document.createElement('li');
        li.role = 'option';
        li.id = `option-${Date.now()}-${i}`;
        li.setAttribute('aria-selected', 'false');
        li.textContent = `${res.name} (${res.context})`;
        li.addEventListener('click', () => {
            inputEl.value = res.name;
            listEl.classList.add('hidden');
            onSelect(res);
        });
        listEl.appendChild(li);
    });
    listEl.classList.remove('hidden');
}

async function triggerSearch() {
    if (!state.origin || !state.dest) return;
    
    showState('loading');
    
    try {
        const routes = await fetchRoutes(state.origin, state.dest, state.timeIso);
        
        if (routes.length === 0) {
            showState('error', 'Ingen ruter fundet.');
            return;
        }
        
        renderRoutes(routes);
        showState('results');
    } catch(e) {
        console.error('route search failed', e);
        showState('error', 'Kunne ikke hente ruter.');
    }
}

function showState(st, msg) {
    document.getElementById('empty-state').classList.add('hidden');
    document.getElementById('loading-state').classList.add('hidden');
    document.getElementById('error-state').classList.add('hidden');
    document.getElementById('routes-content').classList.add('hidden');
    
    if (st === 'loading') document.getElementById('loading-state').classList.remove('hidden');
    if (st === 'error') {
        document.getElementById('error-state').classList.remove('hidden');
        if (msg) document.getElementById('error-msg').textContent = msg;
    }
    if (st === 'results') document.getElementById('routes-content').classList.remove('hidden');
}

function scoreAndRankRoutes(routes) {
    return routes.sort((a, b) => {
        if (state.priority === 'transit') {
            // public transport first, then lowest fillScore (least crowded), tie break duration
            if (a.type === 'transit' && b.type !== 'transit') return -1;
            if (a.type !== 'transit' && b.type === 'transit') return 1;
            if (a.fillScore !== b.fillScore) return a.fillScore - b.fillScore;
            return a.duration - b.duration;
        } else {
            // prioritize driving, then best parking score (which is inverted in fillScore)
            if (a.type === 'driving' && b.type !== 'driving') return -1;
            if (a.type !== 'driving' && b.type === 'driving') return 1;
            if (a.fillScore !== b.fillScore) return a.fillScore - b.fillScore;
            return a.duration - b.duration;
        }
    });
}

function renderRoutes(routes) {
    const ranked = scoreAndRankRoutes(routes);
    const recommended = ranked[0];
    const alternatives = ranked.slice(1, 4);
    
    const recContainer = document.getElementById('recommended-route');
    recContainer.innerHTML = '';
    recContainer.appendChild(createRouteCard(recommended, true));
    
    const altContainer = document.getElementById('alternative-routes');
    altContainer.innerHTML = '';
    alternatives.forEach(alt => {
        altContainer.appendChild(createRouteCard(alt, false));
    });
    
    drawRouteOnMap(recommended);
}

function createRouteCard(route, isRecommended) {
    const tpl = document.getElementById('tpl-route-card');
    const node = tpl.content.cloneNode(true);
    const card = node.querySelector('.route-card');
    
    // Modes
    const modeTranslations = { 'BUS': 'Bus', 'TRAM': 'Letbane', 'RAIL': 'Tog', 'SUBWAY': 'Metro', 'FERRY': 'Færge' };
    const modesContainer = node.querySelector('.route-modes');
    if (route.type === 'driving') {
        modesContainer.innerHTML = `<span class="mode-chip" style="background:#4C8DFF; color: white;">Bil</span>`;
    } else {
        const chipsHTML = route.legs.filter(l => l.mode !== 'WALK').map(l => {
            const text = l.routeShortName || modeTranslations[l.mode] || l.mode;
            const color = l.routeColor ? `#${l.routeColor}` : '#FF3B30';
            return `<span class="mode-chip" style="background:${color}; color: white;">${text}</span>`;
        });
        if (chipsHTML.length === 0) chipsHTML.push(`<span class="mode-chip" style="background:#9CA3AF; color: white;">Gå</span>`);
        modesContainer.innerHTML = chipsHTML.join('');
    }
    
    // Reason
    const reasonEl = node.querySelector('.route-reason');
    if (isRecommended) {
        if (state.priority === 'transit' && route.type === 'transit') {
            const transitModes = route.legs.filter(l => l.mode !== 'WALK').map(l => l.routeShortName || modeTranslations[l.mode] || l.mode).join(' + ');
            reasonEl.textContent = `${transitModes || 'Rute'} er ${route.fillScore}% fyldt - ${route.duration} min, ${route.transfers || 0} skift, ingen parkeringsrisiko`;
        } else if (state.priority === 'driving' && route.type === 'driving') {
            reasonEl.textContent = `Bil er bedst - ${route.duration} min, ${route.parkingAvail}% ledige pladser`;
        } else {
             reasonEl.textContent = `Bedste valg - ${route.duration} min`;
        }
    } else {
        reasonEl.textContent = route.type === 'driving' ? `Parkering: ${route.parkingAvail}% ledigt` : `${route.transfers || 0} skift, ${route.duration} min`;
    }
    
    // Time
    node.querySelector('.time-val').textContent = route.duration;
    
    if (route.startTime) {
        const d = new Date(route.startTime);
        node.querySelector('.route-departure').textContent = `Afgang ${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}`;
    }
    
    // Fill bar
    const bar = node.querySelector('.fill-bar');
    let score = route.fillScore;
    if (route.type === 'driving') score = 100 - route.parkingAvail; // reverse for visual (red = bad)
    
    bar.style.width = `${Math.min(100, Math.max(0, score))}%`;
    if (score < 40) bar.classList.add('fill-green');
    else if (score < 75) bar.classList.add('fill-amber');
    else bar.classList.add('fill-red');
    
    // Expand timeline
    const timeline = node.querySelector('.leg-timeline');
    route.legs.forEach(leg => {
        const lNode = document.getElementById('tpl-leg-step').content.cloneNode(true);
        if (leg.startTime) {
             const d = new Date(leg.startTime);
             lNode.querySelector('.leg-time').textContent = `${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}`;
        }
        const legTitle = leg.routeShortName || { 'BUS': 'Bus', 'TRAM': 'Letbane', 'RAIL': 'Tog', 'SUBWAY': 'Metro', 'FERRY': 'Færge' }[leg.mode] || leg.name;
        lNode.querySelector('.leg-title').textContent = legTitle;
        lNode.querySelector('.leg-desc').textContent = `${leg.duration} min • ${leg.mode === 'WALK' ? 'Gå' : 'Tag'} til ${leg.toName || 'Destination'}`;
        timeline.appendChild(lNode);
    });
    
    card.addEventListener('click', () => {
        timeline.classList.toggle('hidden');
        drawRouteOnMap(route);
    });
    
    return card;
}

function drawRouteOnMap(route) {
    if (!map) return;
    
    // Clear old layers
    routeLayers.forEach(id => {
        if (map.getLayer(id)) map.removeLayer(id);
        if (map.getSource(id)) map.removeSource(id);
    });
    routeLayers = [];
    mapMarkers.forEach(m => m.remove());
    mapMarkers = [];
    
    const bounds = new maplibregl.LngLatBounds();
    
    if (state.origin) {
        const el = document.createElement('div');
        el.className = 'map-marker origin-marker';
        const m = new maplibregl.Marker(el).setLngLat([state.origin.lon, state.origin.lat]).addTo(map);
        mapMarkers.push(m);
        bounds.extend([state.origin.lon, state.origin.lat]);
    }
    if (state.dest) {
        const el = document.createElement('div');
        el.className = 'map-marker dest-marker';
        const m = new maplibregl.Marker(el).setLngLat([state.dest.lon, state.dest.lat]).addTo(map);
        mapMarkers.push(m);
        bounds.extend([state.dest.lon, state.dest.lat]);
    }
    
    route.legs.forEach((leg, i) => {
        if (!leg.geometry || leg.geometry.length === 0) return;
        
        const sourceId = `route-src-${i}`;
        const layerId = `route-layer-${i}`;
        
        // geometry is array of [lng, lat]
        const lineString = {
            type: 'Feature',
            geometry: {
                type: 'LineString',
                coordinates: leg.geometry
            }
        };
        
        leg.geometry.forEach(coord => {
            bounds.extend(coord);
        });
        
        map.addSource(sourceId, {
            type: 'geojson',
            data: lineString
        });
        
        let color = leg.mode === 'WALK' ? '#9CA3AF' : (leg.mode === 'CAR' ? '#4C8DFF' : '#FF3B30');
        
        map.addLayer({
            id: layerId,
            type: 'line',
            source: sourceId,
            layout: {
                'line-join': 'round',
                'line-cap': 'round'
            },
            paint: {
                'line-color': color,
                'line-width': 4,
                'line-dasharray': leg.mode === 'WALK' ? [2, 2] : [1]
            }
        });
        
        routeLayers.push(sourceId, layerId);
    });
    
    if (!bounds.isEmpty()) {
        map.fitBounds(bounds, { padding: 40, animate: true });
    }
}

function registerServiceWorker() {
    if ('serviceWorker' in navigator) {
        window.addEventListener('load', () => {
            navigator.serviceWorker.register('/sw.js').catch(err => {
                console.log('SW registration failed: ', err);
            });
        });
    }
}

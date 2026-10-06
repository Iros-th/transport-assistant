import { geocode, reverseGeocode, fetchPlan } from './api.js';
import {
    formatDist, walkSummary, legMeters, legPlace, sourceLine, isStale, operatorLinks, transitNotice,
    buildLearnSteps, miniMapSvg, scaleTextSize, areaFromProps, placeTown, osmNoteUrl, roundCoord,
    modeLabel, safeColor, readableOn, fmtTime, haversine, isWalkLong
} from './logic.js';

let map = null;
let routeLayers = [];
let routeSources = [];
let mapMarkers = [];

const REDUCED = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
const $ = (s) => document.querySelector(s);

function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* storage may be blocked */ } }

const state = {
    origin: null,
    dest: null,
    priority: 'transit',
    timeIso: new Date().toISOString(),
    timeExplicit: false,
    lowData: lsGet('ta.lowData') === '1',
    currentRoute: null,
    lastMeta: null,
    searchSeq: 0
};

let debounceTimer;

document.addEventListener('DOMContentLoaded', () => {
    initTheme();
    initMap();
    initUI();
    registerServiceWorker();

    // Prefill default example
    state.origin = { name: 'Nørreport St.', town: 'København', area: 'Indre By', lat: 55.6833, lon: 12.5714 };
    state.dest = { name: 'DTU Lyngby', town: 'Kongens Lyngby', area: '', lat: 55.7861, lon: 12.5235 };
    $('#origin-input').value = state.origin.name;
    $('#dest-input').value = state.dest.name;
    syncClearButtons();
    triggerSearch();
});

// ---- theme ---------------------------------------------------------------------------

function effectiveTheme() {
    const t = document.documentElement.getAttribute('data-theme');
    if (t === 'light' || t === 'dark') return t;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function initTheme() {
    updateThemeMeta();
    if (window.matchMedia) {
        const mq = window.matchMedia('(prefers-color-scheme: dark)');
        const onChange = () => { if (!document.documentElement.getAttribute('data-theme')) { updateThemeMeta(); applyMapStyle(); } };
        if (mq.addEventListener) mq.addEventListener('change', onChange);
    }
}

function updateThemeMeta() {
    const m = document.querySelector('meta[name="theme-color"]');
    if (m) m.setAttribute('content', effectiveTheme() === 'dark' ? '#07080A' : '#FFFFFF');
}

function toggleTheme() {
    const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    lsSet('ta.theme', next);
    updateThemeMeta();
    applyMapStyle();
}

// ---- map -----------------------------------------------------------------------------

function styleUrl() {
    return effectiveTheme() === 'dark' ? 'https://tiles.openfreemap.org/styles/dark' : 'https://tiles.openfreemap.org/styles/liberty';
}

function showMapFallback() {
    $('#map-fallback').classList.remove('hidden');
}

function initMap() {
    if (typeof maplibregl === 'undefined') { showMapFallback(); return; }
    try {
        map = new maplibregl.Map({
            container: 'map',
            style: styleUrl(),
            center: [12.5683, 55.6761], // Copenhagen
            zoom: 12,
            attributionControl: false,
            fadeDuration: (REDUCED || state.lowData) ? 0 : 200
        });
    } catch (e) {
        console.warn('Map init failed', e);
        map = null;
        showMapFallback();
        return;
    }
    map.on('style.load', onStyleLoad);
    map.on('moveend', onMoveEnd);
    map.on('error', (e) => { console.warn('Map warning', e && e.error && e.error.message); });
}

function applyMapStyle() {
    if (map) { try { map.setStyle(styleUrl()); } catch (err) { console.warn('Style swap failed', err); } }
}

// Bigger street / stop names: scale every symbol layer's text size up.
function enlargeMapLabels() {
    if (!map) return;
    const style = map.getStyle();
    if (!style || !style.layers) return;
    style.layers.forEach((l) => {
        if (l.type !== 'symbol') return;
        try {
            if (map.getLayoutProperty(l.id, 'text-field') === undefined) return;
            const cur = map.getLayoutProperty(l.id, 'text-size');
            const next = scaleTextSize(cur === undefined ? 16 : cur, 1.25);
            if (next !== null) map.setLayoutProperty(l.id, 'text-size', next);
            map.setPaintProperty(l.id, 'text-halo-width', 1.6);
        } catch (err) { /* layer shapes vary between styles */ }
    });
}

function onStyleLoad() {
    enlargeMapLabels();
    if (state.currentRoute) drawRouteOnMap(state.currentRoute, { fit: !state.fitDone });
}

function onMoveEnd() {
    updateReportLinks();
    scheduleArea();
}

function updateReportLinks() {
    let lat, lon, z;
    if (map) { const c = map.getCenter(); lat = c.lat; lon = c.lng; z = map.getZoom(); }
    else if (state.dest) { lat = state.dest.lat; lon = state.dest.lon; z = 16; }
    else return;
    const url = osmNoteUrl(lat, lon, z);
    $('#report-btn').href = url;
    $('#report-link').href = url;
}

// ---- area / town name ------------------------------------------------------------------

let areaTimer = null;
let areaSeq = 0;
const areaCache = {};

function setAreaLabel(text) { $('#area-label').textContent = text; }

function scheduleArea(force) {
    clearTimeout(areaTimer);
    if (state.lowData && !force) { setAreaLabel('Tryk for at se område'); return; }
    areaTimer = setTimeout(updateArea, force ? 0 : 700);
}

async function updateArea() {
    const seq = ++areaSeq;
    let lat, lon;
    if (map) { const c = map.getCenter(); lat = c.lat; lon = c.lng; }
    else if (state.dest) { lat = state.dest.lat; lon = state.dest.lon; }
    else return;
    // Never send the user's own position to the geocoder: near it, just say so.
    if (state.origin && state.origin.fromGps && haversine([lon, lat], [state.origin.lon, state.origin.lat]) < 3000) {
        setAreaLabel('Din position');
        return;
    }
    if (navigator.onLine === false) { setAreaLabel('Offline'); return; }
    const key = `${roundCoord(lat, 2)},${roundCoord(lon, 2)}`;
    let res = areaCache[key];
    if (!res) {
        res = await reverseGeocode(roundCoord(lat, 3), roundCoord(lon, 3));
        if (res) areaCache[key] = res;
    }
    if (seq !== areaSeq) return;
    const label = res ? areaFromProps({ city: res.town, district: res.area }).label : '';
    setAreaLabel(label || 'Ukendt område');
}

// ---- UI ------------------------------------------------------------------------------

function initUI() {
    const originInput = $('#origin-input');
    const destInput = $('#dest-input');

    setupAutocomplete(originInput, $('#origin-autocomplete'), (place) => { state.origin = place; syncClearButtons(); });
    setupAutocomplete(destInput, $('#dest-autocomplete'), (place) => { state.dest = place; syncClearButtons(); });

    $('#clear-origin').addEventListener('click', () => { originInput.value = ''; state.origin = null; syncClearButtons(); originInput.focus(); });
    $('#clear-dest').addEventListener('click', () => { destInput.value = ''; state.dest = null; syncClearButtons(); destInput.focus(); });
    originInput.addEventListener('input', syncClearButtons);
    destInput.addEventListener('input', syncClearButtons);

    $('#swap-btn').addEventListener('click', () => {
        const temp = state.origin;
        state.origin = state.dest;
        state.dest = temp;
        const tempVal = originInput.value;
        originInput.value = destInput.value;
        destInput.value = tempVal;
        syncClearButtons();
    });

    const updateSegBtns = (btns, clickedValue) => {
        btns.forEach(btn => btn.setAttribute('aria-pressed', btn.value === clickedValue));
    };

    const prioBtns = document.querySelectorAll('#priority-transit, #priority-driving');
    prioBtns.forEach(btn => {
        btn.addEventListener('click', (e) => {
            state.priority = e.currentTarget.value;
            updateSegBtns(prioBtns, state.priority);
            if (state.origin && state.dest) triggerSearch();
        });
    });

    const timeBtns = document.querySelectorAll('#time-now, #time-later');
    timeBtns.forEach(btn => {
        btn.addEventListener('click', (e) => {
            const v = e.currentTarget.value;
            updateSegBtns(timeBtns, v);
            if (v === 'later') {
                const picker = $('#time-picker');
                picker.classList.remove('hidden');
                try { picker.showPicker(); } catch (err) { /* not supported everywhere */ }
            } else {
                $('#time-picker').classList.add('hidden');
                state.timeExplicit = false;
                state.timeIso = new Date().toISOString();
                if (state.origin && state.dest) triggerSearch();
            }
        });
    });

    $('#time-picker').addEventListener('change', (e) => {
        if (e.target.value) {
            state.timeIso = new Date(e.target.value).toISOString();
            state.timeExplicit = true;
            if (state.origin && state.dest) triggerSearch();
        }
    });

    $("#plan-form").addEventListener("submit", (e) => {
        e.preventDefault();
        triggerSearch();
    });

    $('#retry-btn').addEventListener('click', () => triggerSearch());
    $('#notice-retry').addEventListener('click', () => triggerSearch());
    $('#map-retry').addEventListener('click', () => location.reload());
    $('#area-chip').addEventListener('click', () => scheduleArea(true));
    $('#locate-btn').addEventListener('click', locateMe);
    $('#theme-btn').addEventListener('click', toggleTheme);
    $('#reset-btn').addEventListener('click', resetApp);

    const low = $('#lowdata-toggle');
    low.checked = state.lowData;
    low.addEventListener('change', () => {
        state.lowData = low.checked;
        lsSet('ta.lowData', state.lowData ? '1' : '0');
        toast(state.lowData ? 'Lavt dataforbrug: færre forespørgsler og simplere ruter.' : 'Normalt dataforbrug.');
        scheduleArea();
    });

    const setOffline = () => {
        $('#offline-banner').classList.toggle('hidden', navigator.onLine !== false);
    };
    window.addEventListener('online', () => { setOffline(); scheduleArea(); });
    window.addEventListener('offline', setOffline);
    setOffline();

    // Never leave a silent failure: surface unexpected errors as a toast.
    window.addEventListener('unhandledrejection', (e) => { console.warn('Unhandled', e.reason); toast('Noget gik galt. Prøv igen.'); });

    initLearn();
    setupBottomSheet();
    updateReportLinks();
    setAreaLabel(state.lowData ? 'Tryk for at se område' : 'Finder område…');
}

function syncClearButtons() {
    $('#clear-origin').hidden = !$('#origin-input').value;
    $('#clear-dest').hidden = !$('#dest-input').value;
}

let toastTimer;
function toast(msg) {
    let el = $('#toast');
    if (!el) {
        el = document.createElement('div');
        el.id = 'toast';
        el.className = 'toast';
        el.setAttribute('role', 'status');
        document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 4500);
}

// Position: only on an explicit tap, kept in memory for this page view, never stored.
function locateMe() {
    if (!navigator.geolocation) { toast('Din browser kan ikke finde din position.'); return; }
    toast('Finder din position…');
    navigator.geolocation.getCurrentPosition((pos) => {
        state.origin = { name: 'Min position', town: '', area: '', fromGps: true, lat: pos.coords.latitude, lon: pos.coords.longitude };
        $('#origin-input').value = 'Min position';
        syncClearButtons();
        setAreaLabel('Din position');
        if (map) map.easeTo({ center: [pos.coords.longitude, pos.coords.latitude], zoom: 15, animate: !REDUCED });
        if (state.dest) triggerSearch();
    }, (err) => {
        toast(err && err.code === 1 ? 'Positionering er afvist. Skriv din start i stedet.' : 'Kunne ikke finde din position. Skriv din start i stedet.');
    }, { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 });
}

async function resetApp() {
    try {
        if ('serviceWorker' in navigator) {
            const regs = await navigator.serviceWorker.getRegistrations();
            await Promise.all(regs.map(r => r.unregister()));
        }
        if (window.caches) {
            const keys = await caches.keys();
            await Promise.all(keys.map(k => caches.delete(k)));
        }
        ['ta.lowData', 'ta.theme'].forEach(k => { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } });
    } catch (e) { console.warn('Reset failed', e); }
    location.reload();
}

function setupAutocomplete(inputEl, listEl, onSelect) {
    inputEl.addEventListener('input', (e) => {
        clearTimeout(debounceTimer);
        const query = e.target.value;

        if (query.length < (state.lowData ? 3 : 2)) {
            listEl.classList.add('hidden');
            return;
        }

        debounceTimer = setTimeout(async () => {
            const results = await geocode(query);
            if (inputEl.value !== query) return;
            renderAutocomplete(results, listEl, inputEl, onSelect);
        }, state.lowData ? 500 : 250);
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

// ---- bottom sheet (mobile) / side panel (desktop) --------------------------------------

const SHEET_ORDER = ['peek', 'half', 'full'];
const PEEK_PX = 84;

function isMobileLayout() { return window.innerWidth < 900; }

function setSheet(name) {
    const panel = $('#panel');
    panel.dataset.sheet = name;
    $('#panel-handle').setAttribute('aria-expanded', name === 'peek' ? 'false' : 'true');
    $('#panel-content').inert = (name === 'peek');
    $('#app').classList.toggle('panel-collapsed', name === 'peek');
}

function sheetVisiblePx(name) {
    const full = $('#panel').offsetHeight;
    if (name === 'peek') return PEEK_PX;
    if (name === 'half') return Math.min(full, Math.round(window.innerHeight * 0.52));
    return full;
}

function setupBottomSheet() {
    const panel = $('#panel');
    const handle = $('#panel-handle');
    let startY = 0, startVisible = 0, dragging = false, moved = false;

    handle.addEventListener('pointerdown', (e) => {
        if (!isMobileLayout()) return;
        dragging = true; moved = false;
        startY = e.clientY;
        startVisible = sheetVisiblePx(panel.dataset.sheet);
        try { handle.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
        panel.style.transition = 'none';
    });
    handle.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        const dy = e.clientY - startY;
        if (Math.abs(dy) > 6) moved = true;
        const visible = Math.max(PEEK_PX, Math.min(panel.offsetHeight, startVisible - dy));
        panel.style.transform = `translateY(${panel.offsetHeight - visible}px)`;
    });
    const end = (e) => {
        if (!dragging) return;
        dragging = false;
        panel.style.transition = '';
        panel.style.transform = '';
        if (!moved) return;
        const dy = e.clientY - startY;
        const visible = startVisible - dy;
        let best = 'half', bestD = Infinity;
        SHEET_ORDER.forEach(n => { const d = Math.abs(sheetVisiblePx(n) - visible); if (d < bestD) { bestD = d; best = n; } });
        setSheet(best);
        suppressClick = true;
        setTimeout(() => { suppressClick = false; }, 50);
    };
    let suppressClick = false;
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);

    handle.addEventListener('click', () => {
        if (suppressClick) return;
        const cur = panel.dataset.sheet;
        if (!isMobileLayout()) { setSheet(cur === 'peek' ? 'half' : 'peek'); return; }
        setSheet(SHEET_ORDER[(SHEET_ORDER.indexOf(cur) + 1) % SHEET_ORDER.length]);
    });

    setSheet('half');
}

function renderAutocomplete(results, listEl, inputEl, onSelect) {
    listEl.innerHTML = '';
    if (results.length === 0) {
        listEl.classList.add('hidden');
        return;
    }

    results.forEach((res, i) => {
        const li = document.createElement('li');
        li.setAttribute('role', 'option');
        li.id = `option-${Date.now()}-${i}`;
        li.setAttribute('aria-selected', 'false');
        const strong = document.createElement('strong');
        strong.textContent = res.name;
        li.appendChild(strong);
        const sub = [res.context, res.town].filter((v, idx, a) => v && a.indexOf(v) === idx).join(' · ');
        if (sub) {
            const small = document.createElement('span');
            small.className = 'ac-sub';
            small.textContent = sub;
            li.appendChild(small);
        }
        li.addEventListener('click', () => {
            inputEl.value = res.name;
            listEl.classList.add('hidden');
            onSelect(res);
        });
        listEl.appendChild(li);
    });
    listEl.classList.remove('hidden');
}

// ---- searching -------------------------------------------------------------------------

// A typed-but-not-picked text is looked up; the first match wins.
async function resolveInput(inputEl, place) {
    const text = inputEl.value.trim();
    if (!text) return null;
    if (place && place.name === text) return place;
    const found = await geocode(text);
    return found.length ? found[0] : null;
}

function withTimeout(promise, ms) {
    let t;
    const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(new Error('timeout')), ms); });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

async function ensureTown(place) {
    if (!place || place.town || place.fromGps) return;
    const r = await reverseGeocode(roundCoord(place.lat, 4), roundCoord(place.lon, 4));
    if (r) { place.town = r.town; place.area = r.area; }
}

async function triggerSearch() {
    const seq = ++state.searchSeq;
    showState('loading');

    try {
        const o = await resolveInput($('#origin-input'), state.origin);
        const d = await resolveInput($('#dest-input'), state.dest);
        if (!o || !d) {
            showState('error', !$('#origin-input').value.trim() || !$('#dest-input').value.trim()
                ? 'Skriv både start og slut.' : 'Kunne ikke finde stedet. Prøv et andet navn.');
            return;
        }
        state.origin = o; state.dest = d;
        if (!state.timeExplicit) state.timeIso = new Date().toISOString();
        if (navigator.onLine === false) {
            showState('error', 'Du er offline. Forbind til internettet og prøv igen.');
            return;
        }

        const townsDone = withTimeout(Promise.all([ensureTown(o), ensureTown(d)]), 2500).catch(() => {});
        const plan = await withTimeout(fetchPlan(o, d, state.timeIso, { lowData: state.lowData, priority: state.priority, timeExplicit: state.timeExplicit }), 40000);
        if (seq !== state.searchSeq) return; // a newer search replaced this one
        const routes = plan.routes;
        state.lastMeta = plan.meta;

        if (!routes || routes.length === 0) {
            showState('error', transitNotice(plan.meta, navigator.onLine) || 'Ingen ruter fundet. Tjek navnene, eller prøv igen.');
            return;
        }

        await townsDone;
        renderPlaceHeading();
        renderNotice(plan.meta, routes);
        renderRoutes(routes);
        showState('results');
        // On a phone the form fills the half-open sheet: bring the answer into view.
        if (isMobileLayout() && $('#panel').dataset.sheet !== 'peek') {
            const c = $('#panel-content');
            const top = $('#place-heading').getBoundingClientRect().top - c.getBoundingClientRect().top + c.scrollTop - 8;
            c.scrollTo({ top, behavior: REDUCED ? 'auto' : 'smooth' });
        }
    } catch (e) {
        console.warn('route search failed', e);
        if (seq === state.searchSeq) {
            showState('error', e && e.message === 'timeout' ? 'Det tog for lang tid. Prøv igen.' : 'Kunne ikke hente ruter. Prøv igen.');
        }
    }
}

function renderPlaceHeading() {
    const box = $('#place-heading');
    box.innerHTML = '';
    [['Fra', state.origin], ['Til', state.dest]].forEach(([label, p]) => {
        const row = document.createElement('div');
        row.className = 'place-row';
        const l = document.createElement('span');
        l.className = 'place-label';
        l.textContent = label;
        const n = document.createElement('span');
        n.className = 'place-name';
        n.textContent = p.name;
        row.append(l, n);
        const town = placeTown(p);
        if (town && town !== p.name) {
            const t = document.createElement('span');
            t.className = 'place-town';
            t.textContent = town;
            row.appendChild(t);
        }
        box.appendChild(row);
    });
}

function renderNotice(meta, routes) {
    const hasTransit = routes.some(r => r.type === 'transit');
    const msg = hasTransit ? '' : transitNotice(meta, navigator.onLine);
    $('#transit-notice').classList.toggle('hidden', !msg);
    $('#transit-notice-text').textContent = msg;
}

function showState(st, msg) {
    $('#empty-state').classList.add('hidden');
    $('#loading-state').classList.add('hidden');
    $('#error-state').classList.add('hidden');
    $('#routes-content').classList.add('hidden');

    if (st === 'loading') $('#loading-state').classList.remove('hidden');
    if (st === 'error') {
        $('#error-state').classList.remove('hidden');
        if (msg) $('#error-msg').textContent = msg;
        $('#sheet-summary').textContent = 'Fejl – tryk for at åbne';
    }
    if (st === 'results') $('#routes-content').classList.remove('hidden');
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

    const recContainer = $('#recommended-route');
    recContainer.innerHTML = '';
    recContainer.appendChild(createRouteCard(recommended, true));

    const altContainer = $('#alternative-routes');
    altContainer.innerHTML = '';
    alternatives.forEach(alt => {
        altContainer.appendChild(createRouteCard(alt, false));
    });

    $('#sheet-summary').textContent = `${state.origin.name} → ${state.dest.name} · ${recommended.duration} min`;
    state.currentRoute = recommended;
    drawRouteOnMap(recommended, { fit: true });
}

function chip(text, bg) {
    const el = document.createElement('span');
    el.className = 'mode-chip';
    const color = safeColor(bg) || '#C62828';
    el.style.background = color;
    el.style.color = readableOn(color);
    el.textContent = text;
    return el;
}

function legClock(iso) { return fmtTime(iso); }

function createRouteCard(route, isRecommended) {
    const tpl = $('#tpl-route-card');
    const node = tpl.content.cloneNode(true);
    const card = node.querySelector('.route-card');

    // Modes
    const modesContainer = node.querySelector('.route-modes');
    if (route.type === 'driving') {
        modesContainer.appendChild(chip('Bil', '#1A5FCC'));
    } else {
        const chips = route.legs.filter(l => l.mode !== 'WALK').map(l => chip(l.routeShortName || modeLabel(l.mode), l.routeColor));
        if (chips.length === 0) chips.push(chip('Gå', '#5B6472'));
        chips.forEach(c => modesContainer.appendChild(c));
    }

    // Recommendation sentence
    const reasonEl = node.querySelector('.route-reason');
    if (isRecommended) {
        if (state.priority === 'transit' && route.type === 'transit') {
            const transitModes = route.legs.filter(l => l.mode !== 'WALK').map(l => l.routeShortName || modeLabel(l.mode)).join(' + ');
            reasonEl.textContent = `${transitModes || 'Rute'} er ${route.fillScore}% fyldt (simuleret) - ${route.duration} min, ${route.transfers || 0} skift, ingen parkeringsrisiko`;
        } else if (state.priority === 'driving' && route.type === 'driving') {
            reasonEl.textContent = `Bil er bedst - ${route.duration} min, ${route.parkingAvail}% ledige pladser (simuleret)`;
        } else {
            reasonEl.textContent = `Bedste valg - ${route.duration} min`;
        }
    } else {
        reasonEl.textContent = route.type === 'driving' ? `Parkering: ${route.parkingAvail}% ledigt (simuleret)` : `${route.transfers || 0} skift, ${route.duration} min`;
    }

    // Time
    node.querySelector('.time-val').textContent = route.duration;

    if (route.startTime) {
        node.querySelector('.route-departure').textContent = `Afgang ${legClock(route.startTime)}`;
    }

    // Walking distance + warning
    const ws = walkSummary(route);
    const walkLine = node.querySelector('.walk-line');
    if (route.type === 'driving' || ws.count === 0) {
        walkLine.classList.add('hidden');
    } else {
        walkLine.textContent = `Gang i alt ${formatDist(ws.total)}` + (ws.count > 1 ? ` · længste stræk ${formatDist(ws.longest)}` : '');
    }
    const warn = node.querySelector('.walk-warning');
    if (ws.level !== 'ok') {
        warn.textContent = ws.message;
        warn.classList.remove('hidden');
        warn.classList.add(ws.level);
    }

    // Fill bar
    const bar = node.querySelector('.fill-bar');
    let score = route.fillScore;
    if (route.type === 'driving') score = 100 - route.parkingAvail; // reverse for visual (red = bad)

    bar.style.width = `${Math.min(100, Math.max(0, score))}%`;
    if (score < 40) bar.classList.add('fill-green');
    else if (score < 75) bar.classList.add('fill-amber');
    else bar.classList.add('fill-red');

    // Timeline
    const timeline = node.querySelector('.leg-timeline');
    route.legs.forEach(leg => {
        const lNode = $('#tpl-leg-step').content.cloneNode(true);
        if (leg.startTime) lNode.querySelector('.leg-time').textContent = legClock(leg.startTime);
        const legTitle = leg.routeShortName || modeLabel(leg.mode) || leg.name;
        lNode.querySelector('.leg-title').textContent = leg.mode === 'WALK' ? 'Gå' : legTitle + (leg.headsign ? ` mod ${leg.headsign}` : '');
        const to = legPlace(leg.toName, 'to', state.origin, state.dest);
        let desc = `${leg.duration} min`;
        if (leg.mode === 'WALK' || leg.mode === 'CAR') desc += ` · ${formatDist(legMeters(leg))}`;
        desc += ` • ${leg.mode === 'WALK' ? 'Gå' : (leg.mode === 'CAR' ? 'Kør' : 'Tag')} til ${to || 'Destination'}`;
        const descEl = lNode.querySelector('.leg-desc');
        descEl.textContent = desc;
        if (leg.mode === 'WALK' && isWalkLong(legMeters(leg))) {
            lNode.querySelector('.leg-step').classList.add('long-walk');
            descEl.textContent = desc + ' – lang gåtur';
        }
        timeline.appendChild(lNode);
    });

    // Source, freshness and operator links
    const src = node.querySelector('.source-line');
    const srcText = document.createElement('span');
    srcText.textContent = sourceLine(route);
    if (isStale(route)) srcText.className = 'stale';
    src.appendChild(srcText);
    if (route.type !== 'driving' && route.legs.some(l => l.realTime)) {
        const rt = document.createElement('span');
        rt.className = 'rt';
        rt.textContent = ' · realtid på dele af turen';
        src.appendChild(rt);
    } else if (route.type !== 'driving') {
        const rt = document.createElement('span');
        rt.textContent = ' · køreplan';
        src.appendChild(rt);
    }
    operatorLinks(route).forEach(l => {
        const a = document.createElement('a');
        a.href = l.url;
        a.target = '_blank';
        a.rel = 'noopener';
        a.textContent = `Tjek hos ${l.label}`;
        a.addEventListener('click', (e) => e.stopPropagation());
        src.appendChild(document.createTextNode(' · '));
        src.appendChild(a);
    });

    // Actions
    node.querySelector('.learn-btn').addEventListener('click', (e) => { e.stopPropagation(); openLearn(route); });

    const select = () => {
        timeline.classList.toggle('hidden');
        card.setAttribute('aria-expanded', String(!timeline.classList.contains('hidden')));
        state.currentRoute = route;
        drawRouteOnMap(route, { fit: true });
    };
    card.setAttribute('aria-expanded', 'false');
    card.addEventListener('click', select);
    card.addEventListener('keydown', (e) => {
        if (e.target !== card) return;
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(); }
    });

    return card;
}

// ---- Lær ruten -------------------------------------------------------------------------

let learnReturnFocus = null;

function initLearn() {
    const dlg = $('#learn');
    $('#learn-close').addEventListener('click', closeLearn);
    dlg.addEventListener('click', (e) => { if (e.target === dlg) closeLearn(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !dlg.classList.contains('hidden')) closeLearn(); });
}

function openLearn(route) {
    const dlg = $('#learn');
    learnReturnFocus = document.activeElement;
    $('#learn-map').innerHTML = miniMapSvg(route, 320, 190, 18);
    const list = $('#learn-steps');
    list.innerHTML = '';
    buildLearnSteps(route, state.origin, state.dest).forEach(s => {
        const li = document.createElement('li');
        li.className = 'learn-step ' + s.kind;
        const t = document.createElement('div');
        t.className = 'learn-title';
        t.textContent = s.title;
        li.appendChild(t);
        if (s.detail) {
            const d = document.createElement('div');
            d.className = 'learn-detail';
            d.textContent = s.detail;
            li.appendChild(d);
        }
        list.appendChild(li);
    });
    dlg.classList.remove('hidden');
    $('#learn-close').focus();
}

function closeLearn() {
    $('#learn').classList.add('hidden');
    if (learnReturnFocus && learnReturnFocus.focus) learnReturnFocus.focus();
}

// ---- drawing ---------------------------------------------------------------------------

function makeMarker(cls, label) {
    const el = document.createElement('div');
    el.className = 'map-marker ' + cls;
    if (label) {
        const t = document.createElement('span');
        t.className = 'marker-label';
        t.textContent = label;
        el.appendChild(t);
    }
    return el;
}

function mapPadding() {
    if (isMobileLayout()) {
        const sheet = sheetVisiblePx($('#panel').dataset.sheet);
        return { top: 90, bottom: Math.min(sheet, window.innerHeight * 0.6) + 24, left: 30, right: 30 };
    }
    return { top: 90, bottom: 80, left: ($('#panel').dataset.sheet === 'peek' ? 0 : 440) + 50, right: 90 };
}

function clearRouteFromMap() {
    routeLayers.forEach(id => { try { if (map.getLayer(id)) map.removeLayer(id); } catch (e) { /* ignore */ } });
    routeSources.forEach(id => { try { if (map.getSource(id)) map.removeSource(id); } catch (e) { /* ignore */ } });
    routeLayers = [];
    routeSources = [];
    mapMarkers.forEach(m => m.remove());
    mapMarkers = [];
}

function drawRouteOnMap(route, opts) {
    if (!map) return;
    opts = opts || {};
    let styled = false;
    try { styled = !!map.getStyle(); } catch (e) { /* style not ready */ }
    if (!styled) return; // style.load will redraw

    try {
        drawRouteUnsafe(route, opts);
    } catch (e) {
        console.warn('Route draw deferred', e && e.message); // style.load redraws once ready
    }
}

function drawRouteUnsafe(route, opts) {
    clearRouteFromMap();

    const bounds = new maplibregl.LngLatBounds();
    const addMarker = (el, lon, lat, anchor) => {
        const m = new maplibregl.Marker({ element: el, anchor: anchor || 'center' }).setLngLat([lon, lat]).addTo(map);
        mapMarkers.push(m);
        bounds.extend([lon, lat]);
    };

    if (state.origin) addMarker(makeMarker('origin-marker'), state.origin.lon, state.origin.lat);
    if (state.dest) addMarker(makeMarker('dest-marker'), state.dest.lon, state.dest.lat);

    // Board/alight stops with readable names
    const seen = {};
    route.legs.forEach((leg) => {
        if (leg.mode === 'WALK' || leg.mode === 'CAR') return;
        [[leg.fromName, leg.fromLon, leg.fromLat], [leg.toName, leg.toLon, leg.toLat]].forEach(([name, lon, lat]) => {
            if (!name || typeof lon !== 'number' || name === 'START' || name === 'END' || seen[name]) return;
            seen[name] = true;
            addMarker(makeMarker('stop-marker', name), lon, lat, 'left');
        });
    });

    route.legs.forEach((leg, i) => {
        if (!leg.geometry || leg.geometry.length === 0) return;

        const sourceId = `route-src-${i}`;
        const caseId = `route-case-${i}`;
        const layerId = `route-layer-${i}`;

        leg.geometry.forEach(coord => { bounds.extend(coord); });

        map.addSource(sourceId, {
            type: 'geojson',
            data: { type: 'Feature', geometry: { type: 'LineString', coordinates: leg.geometry } }
        });
        routeSources.push(sourceId);

        const dark = effectiveTheme() === 'dark';
        const color = leg.mode === 'WALK' ? (dark ? '#D1D5DB' : '#374151')
            : (leg.mode === 'CAR' ? '#2F7BFF' : (safeColor(leg.routeColor) || '#E5322D'));

        map.addLayer({
            id: caseId, type: 'line', source: sourceId,
            layout: { 'line-join': 'round', 'line-cap': 'round' },
            paint: { 'line-color': dark ? '#000000' : '#FFFFFF', 'line-width': leg.mode === 'WALK' ? 7 : 9 }
        });
        map.addLayer({
            id: layerId, type: 'line', source: sourceId,
            layout: { 'line-join': 'round', 'line-cap': leg.mode === 'WALK' ? 'butt' : 'round' },
            paint: leg.mode === 'WALK'
                ? { 'line-color': color, 'line-width': 4, 'line-dasharray': [1.2, 1.6] }
                : { 'line-color': color, 'line-width': 5.5 }
        });
        routeLayers.push(caseId, layerId);
    });

    if (opts.fit !== false && !bounds.isEmpty()) {
        map.fitBounds(bounds, { padding: mapPadding(), animate: !REDUCED, maxZoom: 16 });
        state.fitDone = true;
    }
}

// ---- service worker ----------------------------------------------------------------------

function registerServiceWorker() {
    if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
        window.addEventListener('load', () => {
            navigator.serviceWorker.register('sw.js').catch(err => {
                console.log('SW registration failed: ', err);
            });
        });
    }
}

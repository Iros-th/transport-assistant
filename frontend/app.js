import { geocode, fetchRoutes, searchLocalPlaces } from './api.js';

let map;
let mapReady = false;
let selectedRoute;
let routeLayers = [];
let mapMarkers = [];
let searchVersion = 0;
let setSheet = () => {};
let sheetPosition = 'half';
const state = { origin: null, dest: null, priority: 'transit', timeIso: new Date().toISOString(), later: false };
const $ = id => document.getElementById(id);
const modeNames = { BUS: 'Bus', TRAM: 'Letbane', RAIL: 'Tog', SUBWAY: 'Metro', FERRY: 'Færge', WALK: 'Gå', CAR: 'Bil' };
const clock = value => new Date(value).toLocaleTimeString('da-DK', { hour: '2-digit', minute: '2-digit' });
const walking = route => route.legs.filter(leg => leg.mode === 'WALK').reduce((sum, leg) => sum + leg.duration, 0);

function formMessage(message = '') {
    $('form-message').textContent = message;
    $('form-message').classList.toggle('hidden', !message);
}

function invalidateResults() {
    ++searchVersion;
    selectedRoute = null;
    showState('empty');
    clearMapRoute();
}

function updateClearButtons() {
    $('clear-origin').hidden = !$('origin-input').value;
    $('clear-dest').hidden = !$('dest-input').value;
}

document.addEventListener('DOMContentLoaded', () => {
    initUI();
    initMap();
    registerServiceWorker();
    state.origin = { name: 'Nørreport St.', lat: 55.6833, lon: 12.5714 };
    state.dest = { name: 'DTU Lyngby', lat: 55.7861, lon: 12.5235 };
    $('origin-input').value = state.origin.name;
    $('dest-input').value = state.dest.name;
    updateClearButtons();
    triggerSearch();
});

function initMap() {
    try {
        if (!window.maplibregl) throw new Error('Map library unavailable');
        const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        map = new maplibregl.Map({
            container: 'map',
            style: `https://tiles.openfreemap.org/styles/${dark ? 'dark' : 'liberty'}`,
            center: [12.5683, 55.6761], zoom: 12
        });
        map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
        map.on('load', () => {
            mapReady = true;
            $('map-status').classList.add('hidden');
            if (selectedRoute) drawRouteOnMap(selectedRoute);
        });
        map.on('error', () => {
            $('map-status').textContent = 'Kortet kunne ikke indlæses helt. Du kan stadig se rejsetrin nedenfor.';
            $('map-status').classList.remove('hidden');
        });
    } catch {
        $('map-status').textContent = 'Kortet er utilgængeligt. Se rejsetrin i rutelisten.';
    }
}

function initUI() {
    setupAutocomplete('origin');
    setupAutocomplete('dest');
    for (const key of ['origin', 'dest']) {
        $(`clear-${key}`).addEventListener('click', () => {
            $(`${key}-input`).value = '';
            $(`${key}-input`).dispatchEvent(new Event('input'));
            $(`${key}-input`).focus();
        });
    }
    $('swap-btn').addEventListener('click', () => {
        [state.origin, state.dest] = [state.dest, state.origin];
        [$('origin-input').value, $('dest-input').value] = [$('dest-input').value, $('origin-input').value];
        for (const key of ['origin', 'dest']) hideAutocomplete(key);
        updateClearButtons();
        if (state.origin && state.dest) triggerSearch();
    });
    $('location-btn').addEventListener('click', () => {
        if (!navigator.geolocation) return formMessage('Din browser understøtter ikke placering. Indtast et startsted.');
        $('location-btn').disabled = true;
        $('location-btn').textContent = 'Finder din placering…';
        navigator.geolocation.getCurrentPosition(position => {
            invalidateResults();
            state.origin = { name: 'Min placering', lat: position.coords.latitude, lon: position.coords.longitude };
            $('origin-input').value = state.origin.name;
            updateClearButtons();
            formMessage();
            finishLocation();
        }, () => {
            formMessage('Kunne ikke hente din placering. Tillad adgang, eller indtast et startsted.');
            finishLocation();
        }, { timeout: 10000, maximumAge: 60000 });
    });
    function finishLocation() {
        $('location-btn').disabled = false;
        $('location-btn').textContent = '↗ Brug min placering';
    }
    for (const value of ['transit', 'driving']) {
        $(`priority-${value}`).addEventListener('click', () => {
            state.priority = value;
            for (const v of ['transit', 'driving']) $(`priority-${v}`).setAttribute('aria-pressed', String(v === value));
            if (state.origin && state.dest) triggerSearch();
        });
    }
    for (const value of ['now', 'later']) {
        $(`time-${value}`).addEventListener('click', () => {
            state.later = value === 'later';
            for (const v of ['now', 'later']) $(`time-${v}`).setAttribute('aria-pressed', String(v === value));
            $('scheduled-time').classList.toggle('hidden', !state.later);
            if (state.later) {
                $('time-picker').focus();
            } else {
                formMessage();
                if (state.origin && state.dest) triggerSearch();
            }
        });
    }
    $('time-picker').addEventListener('change', () => {
        const value = $('time-picker').value;
        if (!value) { $('time-summary').textContent = ''; return; }
        const date = new Date(value);
        if (!Number.isFinite(date.getTime())) return;
        state.timeIso = date.toISOString();
        $('time-summary').textContent = date.toLocaleString('da-DK', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
        if (state.origin && state.dest) triggerSearch();
    });
    $('plan-form').addEventListener('submit', event => { event.preventDefault(); triggerSearch(); });
    $('retry-btn').addEventListener('click', triggerSearch);
    const updateOnline = () => $('offline-banner').classList.toggle('hidden', navigator.onLine);
    window.addEventListener('online', updateOnline);
    window.addEventListener('offline', updateOnline);
    updateOnline();
    setupBottomSheet();
}

function hideAutocomplete(key) {
    $(`${key}-autocomplete`).classList.add('hidden');
    $(`${key}-input`).setAttribute('aria-expanded', 'false');
    $(`${key}-input`).removeAttribute('aria-activedescendant');
}

function setupAutocomplete(key) {
    const input = $(`${key}-input`);
    const list = $(`${key}-autocomplete`);
    let timer;
    let version = 0;
    function renderSuggestions(results, status = '') {
        list.replaceChildren();
        results.forEach((place, index) => {
            const option = document.createElement('li');
            option.setAttribute('role', 'option');
            option.id = `${key}-option-${index}`;
            option.setAttribute('aria-selected', 'false');
            option.textContent = [place.name, place.context].filter(Boolean).join(' · ');
            option.addEventListener('click', () => {
                ++version;
                clearTimeout(timer);
                input.value = place.name;
                state[key] = place;
                hideAutocomplete(key);
                updateClearButtons();
            });
            list.append(option);
        });
        if (status) {
            const message = document.createElement('li');
            message.className = 'autocomplete-status';
            message.setAttribute('role', 'status');
            message.textContent = status;
            list.append(message);
        }
        list.classList.remove('hidden');
        input.setAttribute('aria-expanded', 'true');
        input.removeAttribute('aria-activedescendant');
    }
    function lookup() {
        clearTimeout(timer);
        const request = ++version;
        const query = input.value.trim();
        hideAutocomplete(key);
        if (query.length < 2) return;
        renderSuggestions(searchLocalPlaces(query), 'Søger efter adresser…');
        timer = setTimeout(async () => {
            const results = await geocode(query);
            if (request !== version) return;
            const status = results.lookupUnavailable
                ? 'Adressesøgning er utilgængelig. Prøv en station som København H, Østerport eller Lyngby.'
                : !results.length ? 'Ingen adresser fundet. Prøv et stationsnavn eller en anden adresse.' : '';
            renderSuggestions(results, status);
        }, 250);
    }
    input.addEventListener('input', () => {
        state[key] = null;
        invalidateResults();
        formMessage();
        updateClearButtons();
        lookup();
    });
    input.addEventListener('focus', lookup);
    input.addEventListener('keydown', event => {
        if (event.key === 'Escape') { ++version; hideAutocomplete(key); return; }
        if (list.classList.contains('hidden')) return;
        const items = [...list.querySelectorAll('[role="option"]')];
        if (!items.length) return;
        let index = items.findIndex(item => item.getAttribute('aria-selected') === 'true');
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            index = event.key === 'ArrowDown' ? (index + 1) % items.length : (index <= 0 ? items.length - 1 : index - 1);
            items.forEach((item, i) => { item.classList.toggle('active', i === index); item.setAttribute('aria-selected', String(i === index)); });
            input.setAttribute('aria-activedescendant', items[index].id);
            items[index].scrollIntoView({ block: 'nearest' });
        } else if (event.key === 'Enter' && index >= 0) {
            event.preventDefault();
            items[index].click();
        }
    });
    document.addEventListener('click', event => {
        if (!input.contains(event.target) && !list.contains(event.target)) { ++version; hideAutocomplete(key); }
    });
}

function setupBottomSheet() {
    const panel = $('panel');
    const handle = $('panel-handle');
    const mobile = window.matchMedia('(max-width: 767px)');
    const points = () => ({ expanded: 0, half: Math.max(0, Math.round(panel.offsetHeight - innerHeight * .55)), collapsed: Math.max(0, panel.offsetHeight - 72) });
    setSheet = (position) => {
        sheetPosition = position;
        panel.style.transform = mobile.matches ? `translateY(${points()[position]}px)` : '';
        $('map-toggle').textContent = position === 'collapsed' ? 'Vis ruter' : 'Vis kort';
        handle.setAttribute('aria-expanded', String(position === 'expanded'));
        handle.setAttribute('aria-label', position === 'expanded' ? 'Formindsk rejsepanelet' : 'Udvid rejsepanelet');
        if (selectedRoute) drawRouteOnMap(selectedRoute);
    };
    handle.addEventListener('click', () => setSheet(sheetPosition === 'expanded' ? 'half' : 'expanded'));
    $('map-toggle').addEventListener('click', () => setSheet(sheetPosition === 'collapsed' ? 'half' : 'collapsed'));
    let startY;
    let startTranslate;
    let dragged = false;
    handle.addEventListener('pointerdown', event => {
        if (!mobile.matches) return;
        startY = event.clientY;
        startTranslate = points()[sheetPosition];
        dragged = false;
        handle.setPointerCapture(event.pointerId);
        panel.style.transition = 'none';
    });
    handle.addEventListener('pointermove', event => {
        if (startY === undefined) return;
        const delta = event.clientY - startY;
        dragged ||= Math.abs(delta) > 5;
        panel.style.transform = `translateY(${Math.max(0, Math.min(points().collapsed, startTranslate + delta))}px)`;
    });
    const finish = event => {
        if (startY === undefined) return;
        const value = Math.max(0, Math.min(points().collapsed, startTranslate + event.clientY - startY));
        startY = undefined;
        panel.style.transition = '';
        if (dragged) {
            const closest = Object.entries(points()).sort((a, b) => Math.abs(a[1] - value) - Math.abs(b[1] - value))[0][0];
            setSheet(closest);
        }
    };
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', () => { startY = undefined; panel.style.transition = ''; setSheet(sheetPosition); });
    handle.addEventListener('click', event => { if (dragged) { event.stopImmediatePropagation(); dragged = false; } }, true);
    window.addEventListener('resize', () => { map?.resize(); setSheet(sheetPosition); });
    setSheet('half');
}

async function triggerSearch() {
    const version = ++searchVersion;
    // Invalidate an old request even when the new form is incomplete.
    $('results-container').setAttribute('aria-busy', 'false');
    $('search-btn').disabled = false;
    $('search-btn').textContent = 'Find rejse';
    if (!state.origin || !state.dest) {
        formMessage('Vælg start og destination fra adresseforslagene, før du søger.');
        $(!state.origin ? 'origin-input' : 'dest-input').focus();
        return;
    }
    if (state.later && (!$('time-picker').value || new Date(state.timeIso) < new Date())) {
        formMessage('Vælg en afgangstid i fremtiden.');
        $('time-picker').focus();
        return;
    }
    if (!state.later) state.timeIso = new Date().toISOString();
    formMessage();
    showState('loading');
    setSheet('half');
    try {
        const routes = await fetchRoutes(state.origin, state.dest, state.timeIso);
        if (version !== searchVersion) return;
        if (!routes.length) { showState('error', 'Ingen ruter fundet. Prøv en anden destination eller afgangstid.'); return; }
        renderRoutes(routes);
        showState('results');
        $('results-status').textContent = `${Math.min(routes.length, 4)} rejser fundet. Den anbefalede rejse vises på kortet.`;
    } catch (error) {
        if (version === searchVersion) showState('error', 'Kunne ikke hente ruter. Kontrollér din forbindelse, og prøv igen.');
    }
}

function showState(value, message) {
    for (const id of ['empty-state', 'loading-state', 'error-state', 'routes-content']) $(id).classList.add('hidden');
    const id = { empty: 'empty-state', loading: 'loading-state', error: 'error-state', results: 'routes-content' }[value];
    if (id) $(id).classList.remove('hidden');
    const loading = value === 'loading';
    $('results-container').setAttribute('aria-busy', String(loading));
    $('search-btn').disabled = loading;
    $('search-btn').textContent = loading ? 'Finder rejser…' : 'Find rejse';
    if (message) { $('error-msg').textContent = message; $('results-status').textContent = message; }
    if (loading) $('results-status').textContent = 'Finder rejser…';
}

function renderRoutes(routes) {
    const ranked = [...routes].sort((a, b) => {
        const preferred = state.priority === 'transit' ? 'transit' : 'driving';
        if ((a.type === preferred) !== (b.type === preferred)) return a.type === preferred ? -1 : 1;
        return a.fillScore - b.fillScore || a.duration - b.duration;
    });
    $('recommended-route').replaceChildren(createRouteCard(ranked[0], ranked[0], 0, ranked));
    $('alternative-routes').replaceChildren(...ranked.slice(1, 4).map((route, index) => createRouteCard(route, ranked[0], index + 1)));
    selectRoute(ranked[0], $('recommended-route').firstElementChild);
}

function selectRoute(route, card) {
    selectedRoute = route;
    document.querySelectorAll('.route-card').forEach(item => {
        const selected = item === card;
        item.classList.toggle('selected', selected);
        item.querySelector('.selected-badge').classList.toggle('hidden', !selected);
    });
    drawRouteOnMap(route);
}

function createRouteCard(route, recommended, index, routes = []) {
    const card = $('tpl-route-card').content.firstElementChild.cloneNode(true);
    const isRecommended = index === 0;
    card.classList.toggle('recommended', isRecommended);
    card.querySelector('.recommendation-badge').classList.toggle('hidden', !isRecommended);
    const modes = route.type === 'driving' ? [{ mode: 'CAR' }] : route.legs.filter(leg => leg.mode !== 'WALK');
    if (!modes.length) modes.push({ mode: 'WALK' });
    modes.forEach(leg => {
        const chip = document.createElement('span');
        chip.className = 'mode-chip';
        chip.textContent = leg.routeShortName || modeNames[leg.mode] || leg.name;
        chip.style.background = '#334155';
        card.querySelector('.route-modes').append(chip);
    });
    card.querySelector('.time-val').textContent = route.duration;
    const start = route.startTime || state.timeIso;
    const end = route.endTime || new Date(new Date(start).getTime() + route.duration * 60000);
    card.querySelector('.route-departure').textContent = `Ankomst ${clock(end)}`;
    card.querySelector('.route-summary').textContent = `${clock(start)} → ${clock(end)} · ${walking(route)} min gang · ${route.transfers || 0} skift`;
    const difference = route.duration - recommended.duration;
    const comparison = card.querySelector('.route-comparison');
    if (!isRecommended) {
        const time = difference === 0 ? 'Samme rejsetid' : `${Math.abs(difference)} min ${difference < 0 ? 'hurtigere' : 'længere'}`;
        const transfers = (route.transfers || 0) - (recommended.transfers || 0);
        comparison.textContent = `${time} end anbefalingen${transfers > 0 ? ` · ${transfers} ekstra skift` : ''}`;
        if (route.type === recommended.type && route.type === 'transit') {
            const fill = route.fillScore - recommended.fillScore;
            if (fill) comparison.textContent += ` · ${Math.abs(fill)} procentpoint ${fill > 0 ? 'mere' : 'mindre'} fyldt`;
        }
    } else comparison.classList.add('hidden');
    const reason = card.querySelector('.route-reason');
    if (isRecommended) {
        const preferred = state.priority === 'transit' ? 'transit' : 'driving';
        const fastest = routes.filter(item => item.type === route.type).sort((a, b) => a.duration - b.duration)[0];
        const extra = fastest ? route.duration - fastest.duration : 0;
        if (route.type !== preferred) reason.textContent = 'Bedste tilgængelige rejse. Din foretrukne transportform blev ikke fundet.';
        else if (extra > 0) reason.textContent = `${extra} min længere, men ${route.type === 'driving' ? 'mere ledig parkering' : 'mindre trængsel'}.`;
        else reason.textContent = route.type === 'driving' ? 'Prioriteret for ledig parkering ved destinationen.' : 'Prioriteret for mindre trængsel på rejsen.';
    } else reason.textContent = route.type === 'driving' ? 'Kør til destinationen' : 'Offentlig transport';
    const score = route.type === 'driving' ? 100 - route.parkingAvail : route.fillScore;
    const level = score < 50 ? 'Lav' : score < 75 ? 'Moderat' : score < 90 ? 'Høj' : 'Meget høj';
    card.querySelector('.capacity-label').textContent = route.type === 'driving' ? `Parkering · ${route.parkingAvail}% ledige pladser` : `Trængsel · ${route.fillScore}% fyldt · ${level}`;
    const bar = card.querySelector('.fill-bar');
    bar.style.width = `${Math.min(100, Math.max(0, score))}%`;
    bar.classList.add(score < 50 ? 'fill-green' : score < 75 ? 'fill-amber' : 'fill-red');
    const timeline = card.querySelector('.leg-timeline');
    timeline.id = `timeline-${index}`;
    let elapsed = 0;
    route.legs.forEach(leg => {
        const step = $('tpl-leg-step').content.cloneNode(true);
        step.querySelector('.leg-time').textContent = clock(leg.startTime || new Date(new Date(start).getTime() + elapsed * 60000));
        step.querySelector('.leg-title').textContent = leg.routeShortName || modeNames[leg.mode] || leg.name;
        step.querySelector('.leg-desc').textContent = `${leg.duration} min · ${leg.mode === 'WALK' ? 'Gå' : leg.mode === 'CAR' ? 'Kør' : 'Tag'} til ${leg.toName || state.dest.name}`;
        timeline.append(step);
        elapsed += leg.duration;
    });
    const expand = card.querySelector('.route-expand');
    expand.setAttribute('aria-controls', timeline.id);
    expand.setAttribute('aria-label', `Vis rejsetrin for ${route.duration} minutters rejse`);
    expand.addEventListener('click', () => {
        const open = expand.getAttribute('aria-expanded') !== 'true';
        timeline.classList.toggle('hidden', !open);
        expand.setAttribute('aria-expanded', String(open));
        expand.querySelector('span').textContent = open ? 'Skjul rejsetrin' : 'Vis rejsetrin';
        expand.setAttribute('aria-label', `${open ? 'Skjul' : 'Vis'} rejsetrin for ${route.duration} minutters rejse`);
        selectRoute(route, card);
    });
    card.addEventListener('click', event => { if (!event.target.closest('button')) selectRoute(route, card); });
    return card;
}

function clearMapRoute() {
    if (!map || !mapReady) return;
    routeLayers.forEach(({ layer, source }) => {
        if (map.getLayer(layer)) map.removeLayer(layer);
        if (map.getSource(source)) map.removeSource(source);
    });
    routeLayers = [];
    mapMarkers.forEach(marker => marker.remove());
    mapMarkers = [];
}

function drawRouteOnMap(route) {
    if (!map || !mapReady) return;
    clearMapRoute();
    const bounds = new maplibregl.LngLatBounds();
    for (const key of ['origin', 'dest']) {
        const place = state[key];
        if (!place) continue;
        const element = document.createElement('div');
        element.className = `map-marker ${key}-marker`;
        element.setAttribute('aria-label', place.name);
        const coordinates = [place.lon, place.lat];
        mapMarkers.push(new maplibregl.Marker(element).setLngLat(coordinates).addTo(map));
        bounds.extend(coordinates);
    }
    route.legs.forEach((leg, index) => {
        if (!leg.geometry?.length) return;
        const source = `route-src-${index}`;
        const layer = `route-layer-${index}`;
        leg.geometry.forEach(coordinates => bounds.extend(coordinates));
        map.addSource(source, { type: 'geojson', data: { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: leg.geometry } } });
        const color = leg.mode === 'WALK' ? '#64748B' : leg.mode === 'CAR' ? '#2563EB' : /^([0-9a-f]{6})$/i.test(leg.routeColor || '') ? `#${leg.routeColor}` : '#DC2626';
        map.addLayer({ id: layer, type: 'line', source, layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': color, 'line-width': 5, ...(leg.mode === 'WALK' ? { 'line-dasharray': [2, 2] } : {}) } });
        routeLayers.push({ source, layer });
    });
    if (!bounds.isEmpty()) {
        const mobile = innerWidth < 768;
        const visibleHeight = Math.max(100, $('panel').getBoundingClientRect().top);
        const bottom = mobile ? Math.min(map.getContainer().clientHeight - 100, Math.max(40, innerHeight - visibleHeight + 20)) : 40;
        map.fitBounds(bounds, { padding: { top: 50, left: 40, right: 50, bottom }, maxZoom: 15, duration: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 350 });
    }
}

function registerServiceWorker() {
    if ('serviceWorker' in navigator && location.protocol !== 'file:') {
        navigator.serviceWorker.register('./sw.js').catch(() => {});
    }
}

// Pure helpers (no DOM, no imports) so they can be unit-tested in node: tests/test_logic.js
// loads this file, strips "export " and evaluates it.

export const WALK_WARN_LEG_M = 800;
export const WALK_WARN_TOTAL_M = 1500;
export const WALK_LONG_LEG_M = 1500;
export const WALK_LONG_TOTAL_M = 2500;
export const STALE_AFTER_MIN = 5;

export const REJSEPLANEN_URL = 'https://www.rejseplanen.dk/';
export const DSB_URL = 'https://www.dsb.dk/';

const MODE_LABELS = { BUS: 'Bus', TRAM: 'Letbane', RAIL: 'Tog', SUBWAY: 'Metro', FERRY: 'Færge', SUBURBAN: 'S-tog', REGIONAL_RAIL: 'Regionaltog', LONG_DISTANCE: 'Fjerntog', HIGHSPEED_RAIL: 'Højhastighedstog', CAR: 'Bil', WALK: 'Gå' };

// Only a plain 6-digit hex colour may reach markup or styles ('' otherwise).
export function safeColor(c) {
    const h = String(c == null ? '' : c).replace('#', '');
    return /^[0-9a-fA-F]{6}$/.test(h) ? '#' + h.toUpperCase() : '';
}

// Black or white text, whichever reads better on this background colour.
export function readableOn(hex) {
    const h = safeColor(hex).slice(1);
    if (!h) return '#FFFFFF';
    const v = [0, 2, 4].map(i => parseInt(h.substr(i, 2), 16) / 255).map(c => c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
    const L = 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
    return L > 0.4 ? '#111111' : '#FFFFFF';
}

export function modeLabel(mode) {
    return MODE_LABELS[mode] || mode || '';
}

export function haversine(a, b) {
    const R = 6371000, rad = Math.PI / 180;
    const dLat = (b[1] - a[1]) * rad, dLon = (b[0] - a[0]) * rad;
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

export function pathLength(coords) {
    let m = 0;
    for (let i = 1; i < (coords || []).length; i++) m += haversine(coords[i - 1], coords[i]);
    return m;
}

// Distance of one leg in metres: the reported distance, else the length of its geometry.
export function legMeters(leg) {
    if (leg && typeof leg.distance === 'number' && isFinite(leg.distance)) return leg.distance;
    return Math.round(pathLength(leg && leg.geometry));
}

// "350 m", "1,4 km" (Danish decimal comma).
export function formatDist(m) {
    if (!isFinite(m) || m < 0) return '';
    if (m < 1000) return `${Math.max(10, Math.round(m / 10) * 10)} m`;
    return `${(m / 1000).toFixed(1).replace('.', ',')} km`;
}

// Walking summary + warning level for a route.
export function walkSummary(route) {
    const legs = ((route && route.legs) || []);
    const walks = [];
    legs.forEach((leg, index) => {
        if (leg.mode === 'WALK') walks.push({ index, meters: legMeters(leg), toName: leg.toName });
    });
    const total = walks.reduce((s, w) => s + w.meters, 0);
    const longest = walks.reduce((s, w) => Math.max(s, w.meters), 0);
    let level = 'ok';
    if (longest > WALK_WARN_LEG_M || total > WALK_WARN_TOTAL_M) level = 'warn';
    if (longest > WALK_LONG_LEG_M || total > WALK_LONG_TOTAL_M) level = 'long';
    let message = '';
    if (level !== 'ok') {
        const part = longest > WALK_WARN_LEG_M ? `${formatDist(longest)} i ét stræk` : `${formatDist(total)} i alt`;
        message = (level === 'long' ? 'Meget lang gåtur: ' : 'Lang gåtur: ') + part +
            (longest > WALK_WARN_LEG_M && total > longest ? ` (${formatDist(total)} i alt)` : '') +
            '. Tjek at det passer dig.';
    }
    return { total, longest, count: walks.length, legs: walks, level, message };
}

export function isWalkLong(meters) {
    return meters > WALK_WARN_LEG_M;
}

// ---- places / area names -------------------------------------------------------------

// Photon feature properties -> { town, area, label } ("Indre By, København").
export function areaFromProps(p) {
    p = p || {};
    const town = p.city || p.town || p.village || p.municipality || p.county || '';
    const area = p.district || p.suburb || p.locality || '';
    let label = '';
    if (area && town && area !== town) label = `${area}, ${town}`;
    else label = town || area || '';
    return { town, area, label };
}

// Town label of a stored place ({ town, area }) for the results header.
export function placeTown(place) {
    if (!place) return '';
    return place.town || place.area || '';
}

export function roundCoord(v, digits) {
    const f = Math.pow(10, digits == null ? 3 : digits);
    return Math.round(v * f) / f;
}

// OpenStreetMap "new note" URL pre-positioned at the map location.
export function osmNoteUrl(lat, lon, zoom) {
    const z = Math.max(1, Math.min(19, Math.round(zoom || 17)));
    const la = lat.toFixed(5), lo = lon.toFixed(5);
    return `https://www.openstreetmap.org/note/new?lat=${la}&lon=${lo}#map=${z}/${la}/${lo}`;
}

// ---- data freshness / operator links ---------------------------------------------------

export function fmtTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    try {
        return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Europe/Copenhagen' }).format(d);
    } catch (e) {
        return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    }
}

export function ageMinutes(iso, now) {
    if (!iso) return null;
    const t = new Date(iso).getTime();
    if (isNaN(t)) return null;
    return Math.max(0, Math.round(((now == null ? Date.now() : now) - t) / 60000));
}

// "Kilde: Transitous (Rejseplanen m.fl.) · hentet 14:32" (+ age warning when old).
export function sourceLine(route, now) {
    const src = (route && route.source) || 'ukendt kilde';
    const when = fmtTime(route && route.fetchedAt);
    let s = `Kilde: ${src}`;
    if (when) s += ` · hentet ${when}`;
    const age = ageMinutes(route && route.fetchedAt, now);
    if (age != null && age >= STALE_AFTER_MIN) s += ` · ${age} min gammelt`;
    return s;
}

export function isStale(route, now) {
    const age = ageMinutes(route && route.fetchedAt, now);
    return age != null && age >= STALE_AFTER_MIN;
}

// Links to verify the timetable at the operator. Always Rejseplanen; DSB when a DSB leg is present.
export function operatorLinks(route) {
    const links = [];
    if (route && route.type === 'driving') return links;
    links.push({ label: 'Rejseplanen', url: REJSEPLANEN_URL });
    const legs = (route && route.legs) || [];
    const dsb = legs.some(l => /dsb/i.test(l.agencyName || '') || /dsb\.dk/i.test(l.agencyUrl || ''));
    if (dsb) links.push({ label: 'DSB', url: DSB_URL });
    return links;
}

// Why transit data is missing (or '' when all is well). Danish, user-facing.
export function transitNotice(meta, online) {
    if (!meta || !meta.transitous) return '';
    const t = meta.transitous;
    if (online === false) return 'Du er offline – offentlig transport kan ikke hentes lige nu.';
    if (t.state === 'error') {
        const why = t.status ? ` (svar ${t.status})` : '';
        return `Køreplansdata fra Transitous er midlertidigt utilgængelige${why}. Prøv igen om lidt, eller tjek Rejseplanen.`;
    }
    if (t.state === 'empty') return 'Transitous fandt ingen offentlig transport for denne tid. Prøv en anden tid, eller tjek Rejseplanen.';
    return '';
}

// ---- "Lær ruten" -----------------------------------------------------------------------

export function legPlace(name, role, origin, dest) {
    if (name === 'START' || (role === 'from' && !name)) return (origin && origin.name) || 'Start';
    if (name === 'END' || (role === 'to' && !name)) return (dest && dest.name) || 'Destination';
    return name;
}

// A short list of landmarks / stops / turns to memorise the route.
// -> [{ kind: 'start'|'walk'|'ride'|'transfer'|'car'|'arrive', title, detail }]
export function buildLearnSteps(route, origin, dest) {
    const steps = [];
    const o = (origin && origin.name) || 'Start';
    const d = (dest && dest.name) || 'Destination';
    steps.push({ kind: 'start', title: `Start: ${o}`, detail: placeTown(origin) });
    const legs = (route && route.legs) || [];
    let prevTransit = false;
    legs.forEach(leg => {
        const to = legPlace(leg.toName, 'to', origin, dest);
        const from = legPlace(leg.fromName, 'from', origin, dest);
        if (leg.mode === 'WALK') {
            const m = legMeters(leg);
            if (m < 40 && legs.length > 1) return;
            const via = (leg.streets && leg.streets.length) ? ` via ${leg.streets.slice(0, 2).join(' og ')}` : '';
            steps.push({ kind: 'walk', title: `Gå ${formatDist(m)}${via}`, detail: `til ${to}` + (m > WALK_WARN_LEG_M ? ' – lang gåtur' : '') });
            prevTransit = false;
        } else if (leg.mode === 'CAR') {
            steps.push({ kind: 'car', title: `Kør ${formatDist(legMeters(leg))}`, detail: `${leg.duration} min til ${to}` });
            prevTransit = false;
        } else {
            if (prevTransit) steps.push({ kind: 'transfer', title: `Skift ved ${from}`, detail: '' });
            const line = leg.routeShortName ? `${modeLabel(leg.mode)} ${leg.routeShortName}` : modeLabel(leg.mode);
            const head = leg.headsign ? ` mod ${leg.headsign}` : '';
            const n = (leg.stops || 0) + 1;
            steps.push({ kind: 'ride', title: `${line}${head}`, detail: `fra ${from} til ${to} · ${n} stop · ${leg.duration} min` });
            prevTransit = true;
        }
    });
    steps.push({ kind: 'arrive', title: `Fremme: ${d}`, detail: placeTown(dest) });
    return steps;
}

// Dependency-free SVG overview of the route (no tiles: works offline, costs no data).
export function miniMapSvg(route, w, h, pad) {
    w = w || 320; h = h || 180; pad = pad == null ? 16 : pad;
    const legs = (route && route.legs) || [];
    const pts = [];
    legs.forEach(l => (l.geometry || []).forEach(c => pts.push(c)));
    if (pts.length < 2) return '';
    let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
    pts.forEach(c => { minLon = Math.min(minLon, c[0]); maxLon = Math.max(maxLon, c[0]); minLat = Math.min(minLat, c[1]); maxLat = Math.max(maxLat, c[1]); });
    const k = Math.cos(((minLat + maxLat) / 2) * Math.PI / 180);
    const spanX = Math.max((maxLon - minLon) * k, 1e-6), spanY = Math.max(maxLat - minLat, 1e-6);
    const scale = Math.min((w - 2 * pad) / spanX, (h - 2 * pad) / spanY);
    const offX = (w - spanX * scale) / 2, offY = (h - spanY * scale) / 2;
    const proj = c => [offX + (c[0] - minLon) * k * scale, offY + (maxLat - c[1]) * scale];
    const f = n => n.toFixed(1);
    let paths = '', dots = '';
    legs.forEach(l => {
        const g = l.geometry || [];
        if (g.length < 2) return;
        const d = g.map((c, i) => { const p = proj(c); return (i ? 'L' : 'M') + f(p[0]) + ' ' + f(p[1]); }).join('');
        const walk = l.mode === 'WALK';
        const col = walk ? 'var(--route-walk)' : (l.mode === 'CAR' ? 'var(--route-car)' : (safeColor(l.routeColor) || 'var(--route-transit)'));
        paths += `<path d="${d}" fill="none" stroke="${col}" stroke-width="${walk ? 3 : 5}" stroke-linecap="round" stroke-linejoin="round"${walk ? ' stroke-dasharray="1 7"' : ''}/>`;
    });
    // numbered waypoints at leg boundaries (skip tiny walks)
    let n = 0;
    const first = proj(pts[0]);
    dots += `<circle cx="${f(first[0])}" cy="${f(first[1])}" r="7" fill="var(--text)" stroke="var(--surface)" stroke-width="3"/>`;
    legs.forEach(l => {
        const g = l.geometry || [];
        if (g.length < 2 || l.mode === 'WALK') return;
        [g[0], g[g.length - 1]].forEach(c => {
            const p = proj(c);
            dots += `<circle cx="${f(p[0])}" cy="${f(p[1])}" r="5" fill="var(--surface)" stroke="var(--text)" stroke-width="3"/>`;
            n++;
        });
    });
    const last = proj(pts[pts.length - 1]);
    dots += `<circle cx="${f(last[0])}" cy="${f(last[1])}" r="8" fill="var(--accent)" stroke="var(--surface)" stroke-width="3"/>`;
    return `<svg viewBox="0 0 ${w} ${h}" width="100%" role="img" aria-label="Skitse af ruten" xmlns="http://www.w3.org/2000/svg">${paths}${dots}</svg>`;
}

// ---- map label scaling ---------------------------------------------------------------

function usesZoom(e) {
    return Array.isArray(e) && (e[0] === 'zoom' || e.some(usesZoom));
}

function scaleExpr(e, k) {
    if (typeof e === 'number') return e * k;
    if (!Array.isArray(e)) return null;
    // "zoom" may only be the input of a top-level step/interpolate, so scale the outputs instead.
    if (/^interpolate/.test(String(e[0]))) {
        const out = e.slice(0, 3);
        for (let i = 3; i + 1 < e.length; i += 2) {
            const v = scaleExpr(e[i + 1], k);
            if (v === null) return null;
            out.push(e[i], v);
        }
        return out;
    }
    if (e[0] === 'step') {
        const first = scaleExpr(e[2], k);
        if (first === null) return null;
        const out = [e[0], e[1], first];
        for (let i = 3; i + 1 < e.length; i += 2) {
            const v = scaleExpr(e[i + 1], k);
            if (v === null) return null;
            out.push(e[i], v);
        }
        return out;
    }
    return usesZoom(e) ? null : ['*', k, e];
}

// Scale a MapLibre text-size spec (number, expression or legacy stops) by k; null if unsupported.
export function scaleTextSize(spec, k) {
    if (typeof spec === 'number') return spec * k;
    if (Array.isArray(spec)) return scaleExpr(spec, k);
    if (spec && Array.isArray(spec.stops)) {
        const out = ['interpolate', ['linear'], ['zoom']];
        for (const st of spec.stops) {
            if (typeof st[1] !== 'number') return null;
            out.push(st[0], st[1] * k);
        }
        return out.length > 5 ? out : null;
    }
    return null;
}

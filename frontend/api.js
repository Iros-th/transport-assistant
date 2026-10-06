// Seeded random number generator for deterministic scoring
function xmur3(str) {
    for(var i = 0, h = 1779033703 ^ str.length; i < str.length; i++) {
        h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
        h = h << 13 | h >>> 19;
    } return function() {
        h = Math.imul(h ^ (h >>> 16), 2246822507);
        h = Math.imul(h ^ (h >>> 13), 3266489909);
        return (h ^= h >>> 16) >>> 0;
    }
}
function sfc32(a, b, c, d) {
    return function() {
        a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
        var t = (a + b) | 0;
        a = b ^ b >>> 9;
        b = c + (c << 3) | 0;
        c = (c << 21 | c >>> 11);
        d = d + 1 | 0;
        t = t + d | 0;
        c = c + t | 0;
        return (t >>> 0) / 4294967296;
    }
}
export function getSeededRandom(seedStr) {
    const seed = xmur3(seedStr);
    const rand = sfc32(seed(), seed(), seed(), seed());
    return rand;
}

export function fetchWithTimeout(url, opts, ms) {
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), ms || 12000) : null;
    const o = Object.assign({}, opts || {}, ctrl ? { signal: ctrl.signal } : {});
    return fetch(url, o).finally(() => { if (timer) clearTimeout(timer); });
}

function placeFromFeature(f) {
    const p = f.properties || {};
    const town = p.city || p.town || p.village || p.municipality || p.county || '';
    const area = p.district || p.suburb || p.locality || '';
    return {
        name: p.name || p.street || town || 'Ukendt sted',
        context: [p.street, p.city || p.town || p.village].filter(Boolean).join(', '),
        town,
        area,
        lat: f.geometry.coordinates[1],
        lon: f.geometry.coordinates[0]
    };
}

export async function geocode(query) {
    if (!query || query.length < 2) return [];
    try {
        const res = await fetchWithTimeout(`https://photon.komoot.io/api/?q=${encodeURIComponent(query)}&limit=5&lat=55.68&lon=12.57&lang=default`, {}, 8000);
        if (!res.ok) throw new Error('Photon error');
        const data = await res.json();
        return data.features.map(placeFromFeature);
    } catch (e) {
        console.warn('Geocoding fallback', e);
        // Minimal fallback
        if (query.toLowerCase().includes('nørreport')) {
            return [{ name: 'Nørreport St.', context: 'København', town: 'København', area: 'Indre By', lat: 55.683, lon: 12.571 }];
        }
        if (query.toLowerCase().includes('dtu')) {
            return [{ name: 'DTU', context: 'Lyngby', town: 'Kongens Lyngby', area: '', lat: 55.786, lon: 12.523 }];
        }
        return [];
    }
}

// Photon /reverse: which town/area is at this point? Returns null on any failure.
export async function reverseGeocode(lat, lon) {
    try {
        const res = await fetchWithTimeout(`https://photon.komoot.io/reverse?lat=${lat}&lon=${lon}&lang=default`, {}, 8000);
        if (!res.ok) return null;
        const data = await res.json();
        const f = data.features && data.features[0];
        if (!f) return null;
        const p = placeFromFeature(f);
        return { town: p.town, area: p.area, name: p.name };
    } catch (e) {
        return null;
    }
}

function decodePolyline(str, precision) {
    var index = 0, lat = 0, lng = 0, coordinates = [], shift = 0, result = 0, byte = null, latitude_change, longitude_change, factor = Math.pow(10, Number.isInteger(precision) ? precision : 5);
    while (index < str.length) {
        byte = null; shift = 0; result = 0;
        do { byte = str.charCodeAt(index++) - 63; result |= (byte & 0x1f) << shift; shift += 5; } while (byte >= 0x20);
        latitude_change = ((result & 1) ? ~(result >> 1) : (result >> 1));
        shift = result = 0;
        do { byte = str.charCodeAt(index++) - 63; result |= (byte & 0x1f) << shift; shift += 5; } while (byte >= 0x20);
        longitude_change = ((result & 1) ? ~(result >> 1) : (result >> 1));
        lat += latitude_change; lng += longitude_change;
        coordinates.push([lng / factor, lat / factor]);
    }
    return coordinates;
}

const inFlightRequests = {};

const NON_TRANSIT_MODES = ['WALK', 'BIKE', 'CAR', 'CAR_PARKING', 'CAR_DROPOFF', 'RENTAL', 'FLEX', 'ODM', 'TRANSFER'];

export async function fetchRoutes(from, to, timeIso, opts) {
    const plan = await fetchPlan(from, to, timeIso, opts);
    return plan.routes;
}

// Returns { routes, meta }. meta says what each data source did, so the UI can explain
// a missing transit result instead of silently showing only a car route.
export async function fetchPlan(from, to, timeIso, opts) {
    opts = opts || {};
    const lowData = !!opts.lowData;
    const priority = opts.priority || 'transit';
    const fromStr = `${from.lat},${from.lon}`;
    const toStr = `${to.lat},${to.lon}`;
    const key = `${fromStr}-${toStr}-${timeIso}-${lowData}-${priority}-${!!opts.timeExplicit}`;

    if (inFlightRequests[key]) {
        return inFlightRequests[key];
    }

    const promise = (async () => {
        const routes = [];
        const fetchedAt = new Date().toISOString();
        const meta = { fetchedAt, lowData, transitous: { state: 'pending' }, driving: { state: 'skipped' } };

        // 1. OSRM driving. Low-data mode skips it unless the car is what the user asked for
        // (or transit turns up nothing, see below) and asks for a simplified geometry.
        async function loadDriving() {
            try {
                const overview = lowData ? 'simplified' : 'full';
                const driveRes = await fetchWithTimeout(`https://router.project-osrm.org/route/v1/driving/${from.lon},${from.lat};${to.lon},${to.lat}?overview=${overview}&geometries=geojson`, {}, 12000);
                if (!driveRes.ok) { meta.driving = { state: 'error', status: driveRes.status }; return; }
                const driveData = await driveRes.json();
                if (driveData.routes && driveData.routes.length > 0) {
                    const r = driveData.routes[0];
                    const rand = getSeededRandom(`${toStr}-${timeIso.substring(0,13)}`);
                    const parkingAvail = Math.floor(rand() * 100);
                    const parkingConsistency = Math.floor(rand() * 100);
                    routes.push({
                        id: 'drive-' + Date.now(),
                        type: 'driving',
                        duration: Math.round(r.duration / 60),
                        distance: r.distance,
                        geometry: r.geometry.coordinates,
                        legs: [{
                            mode: 'CAR',
                            duration: Math.round(r.duration / 60),
                            distance: r.distance,
                            name: 'Bil',
                            fromName: from.name,
                            toName: to.name,
                            geometry: r.geometry.coordinates
                        }],
                        parkingAvail,
                        parkingConsistency,
                        fillScore: 100 - parkingAvail,
                        source: 'OSRM / OpenStreetMap',
                        fetchedAt
                    });
                    meta.driving = { state: 'ok' };
                } else {
                    meta.driving = { state: 'empty' };
                }
            } catch (e) {
                console.warn('OSRM error', e);
                meta.driving = { state: 'error', message: String((e && e.message) || e) };
            }
        }

        // 2. Transitous (MOTIS v5). One retry on network error / 5xx.
        async function loadTransit() {
            try {
                const timeParam = opts.timeExplicit ? `&time=${encodeURIComponent(timeIso)}` : '';
                const tUrl = `https://api.transitous.org/api/v5/plan?fromPlace=${fromStr}&toPlace=${toStr}${timeParam}`;
                let tRes = null;
                let netErr = null;
                for (let attempt = 0; attempt < 2; attempt++) {
                    try {
                        tRes = await fetchWithTimeout(tUrl, {}, 15000);
                        netErr = null;
                        if (tRes.ok || tRes.status < 500) break;
                    } catch (e) { netErr = e; tRes = null; }
                }
                if (netErr || !tRes) {
                    meta.transitous = { state: 'error', message: String((netErr && netErr.message) || 'ingen forbindelse') };
                    return;
                }
                if (!tRes.ok) {
                    meta.transitous = { state: 'error', status: tRes.status };
                    return;
                }
                const tData = await tRes.json();
                const itineraries = tData.plan?.itineraries || tData.itineraries || [];
                meta.transitous = { state: itineraries.length ? 'ok' : 'empty' };

                itineraries.forEach((itin, i) => {
                    let totalFill = 0;
                    let transitTime = 0;

                    const legs = itin.legs.map(leg => {
                        const mode = leg.mode;
                        const isTransit = !NON_TRANSIT_MODES.includes(mode);
                        let legScore = 0;

                        if (isTransit) {
                            const seed = `${leg.route}-${leg.from.name}-${timeIso.substring(0,13)}`;
                            const rand = getSeededRandom(seed);
                            legScore = 20 + Math.floor(rand() * 80);
                            totalFill += legScore * (leg.duration / 60);
                            transitTime += (leg.duration / 60);
                        }

                        let coords = [];
                        const lg = leg.legGeometry;
                        if (lg && lg.points) {
                            coords = decodePolyline(lg.points, lg.precision ?? 6);
                        } else if (typeof lg === 'string') {
                            coords = decodePolyline(lg, 6);
                        }

                        const streets = [];
                        (leg.steps || []).forEach(s => {
                            const n = s && s.streetName;
                            if (n && n !== 'path' && n !== 'footpath' && streets.indexOf(n) < 0) streets.push(n);
                        });

                        return {
                            mode,
                            name: leg.route || (mode === 'WALK' ? 'Gå' : mode),
                            routeShortName: leg.routeShortName,
                            routeColor: leg.routeColor,
                            headsign: leg.headsign,
                            agencyName: leg.agencyName,
                            agencyUrl: leg.agencyUrl,
                            realTime: !!leg.realTime,
                            distance: typeof leg.distance === 'number' ? leg.distance : null,
                            stops: Array.isArray(leg.intermediateStops) ? leg.intermediateStops.length : (leg.intermediateStops || 0),
                            streets: streets.slice(0, 3),
                            duration: Math.round(leg.duration / 60),
                            startTime: leg.startTime,
                            endTime: leg.endTime,
                            fromName: leg.from.name,
                            toName: leg.to.name,
                            fromLat: leg.from.lat,
                            fromLon: leg.from.lon,
                            toLat: leg.to.lat,
                            toLon: leg.to.lon,
                            fillScore: legScore,
                            geometry: coords
                        };
                    });

                    const avgFill = transitTime > 0 ? Math.round(totalFill / transitTime) : 0;

                    let allCoords = [];
                    legs.forEach(l => { if(l.geometry) allCoords = allCoords.concat(l.geometry); });

                    routes.push({
                        id: 'transit-' + i,
                        type: 'transit',
                        duration: Math.round(itin.duration / 60),
                        startTime: itin.startTime,
                        endTime: itin.endTime,
                        legs,
                        fillScore: avgFill,
                        transfers: itin.transfers,
                        geometry: allCoords,
                        source: 'Transitous (Rejseplanen m.fl.)',
                        fetchedAt
                    });
                });
            } catch (e) {
                console.warn('Transitous error', e);
                meta.transitous = { state: 'error', message: String((e && e.message) || e) };
            }
        }

        const wantDriving = !lowData || priority === 'driving';
        await Promise.all([loadTransit(), wantDriving ? loadDriving() : Promise.resolve()]);
        if (!wantDriving && !routes.some(r => r.type === 'transit')) await loadDriving();

        // 3. Fallback
        if (routes.length === 0) {
            try {
                const fbRes = await fetchWithTimeout(`/api/plan?from=${fromStr}&to=${toStr}`, {}, 8000);
                if (fbRes.ok) {
                    const fbData = await fbRes.json();
                    meta.fallback = true;
                    return { routes: fbData.routes || [], meta };
                }
            } catch(e) {
                console.error('Backend fallback failed', e);
            }
        }

        return { routes, meta };
    })();

    inFlightRequests[key] = promise;
    try {
        return await promise;
    } finally {
        delete inFlightRequests[key];
    }
}

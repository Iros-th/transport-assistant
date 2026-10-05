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

export async function geocode(query) {
    if (!query || query.length < 2) return [];
    try {
        const res = await fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(query)}&limit=5&lat=55.68&lon=12.57`);
        if (!res.ok) throw new Error('Photon error');
        const data = await res.json();
        return data.features.map(f => ({
            name: f.properties.name,
            context: [f.properties.street, f.properties.city].filter(Boolean).join(', '),
            lat: f.geometry.coordinates[1],
            lon: f.geometry.coordinates[0]
        }));
    } catch (e) {
        console.warn('Geocoding fallback', e);
        // Minimal fallback
        if (query.toLowerCase().includes('nørreport')) {
            return [{ name: 'Nørreport St.', context: 'København', lat: 55.683, lon: 12.571 }];
        }
        if (query.toLowerCase().includes('dtu')) {
            return [{ name: 'DTU', context: 'Lyngby', lat: 55.786, lon: 12.523 }];
        }
        return [];
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

export async function fetchRoutes(from, to, timeIso) {
    const fromStr = `${from.lat},${from.lon}`;
    const toStr = `${to.lat},${to.lon}`;
    const key = `${fromStr}-${toStr}-${timeIso}`;
    
    if (inFlightRequests[key]) {
        return inFlightRequests[key];
    }
    
    const promise = (async () => {
        const routes = [];
        
        // 1. OSRM Driving
        try {
        const driveRes = await fetch(`https://router.project-osrm.org/route/v1/driving/${from.lon},${from.lat};${to.lon},${to.lat}?overview=full&geometries=geojson`);
        if (driveRes.ok) {
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
                        name: 'Bil',
                        geometry: r.geometry.coordinates
                    }],
                    parkingAvail,
                    parkingConsistency,
                    fillScore: 100 - parkingAvail
                });
            }
        }
    } catch (e) {
        console.warn('OSRM error', e);
    }
    
    // 2. Transitous
    try {
        const tUrlAlt = `https://routing.transitous.org/routing/v1/routers/default/plan?fromPlace=${from.lat},${from.lon}&toPlace=${to.lat},${to.lon}`;
        let tRes = await fetch(tUrlAlt, { headers: { 'User-Agent': 'TransportAssistant/1.0' } }).catch(() => null);

        if (!tRes || !tRes.ok) {
            // fallback to MOTIS api
            const tUrl = `https://api.transitous.org/api/v5/plan?fromPlace=${fromStr}&toPlace=${toStr}`;
            tRes = await fetch(tUrl, { headers: { 'User-Agent': 'TransportAssistant/1.0' } }).catch(() => null);
        }

        if (tRes && tRes.ok) {
            const tData = await tRes.json();
            const itineraries = tData.plan?.itineraries || tData.itineraries || [];
            
            itineraries.forEach((itin, i) => {
                let totalFill = 0;
                let transitTime = 0;
                
                const legs = itin.legs.map(leg => {
                    const mode = leg.mode;
                    const isTransit = ['BUS', 'TRAM', 'RAIL', 'SUBWAY', 'FERRY'].includes(mode);
                    let legScore = 0;
                    
                    if (isTransit) {
                        const seed = `${leg.route}-${leg.from.name}-${timeIso.substring(0,13)}`;
                        const rand = getSeededRandom(seed);
                        legScore = 20 + Math.floor(rand() * 80);
                        totalFill += legScore * (leg.duration / 60);
                        transitTime += (leg.duration / 60);
                    }
                    
                    let coords = [];
                    if (leg.legGeometry?.points) {
                        coords = decodePolyline(leg.legGeometry.points, leg.legGeometry.precision ?? 6);
                    }

                    return {
                        mode,
                        name: leg.route || (mode === 'WALK' ? 'Gå' : mode),
                        routeShortName: leg.routeShortName,
                        routeColor: leg.routeColor,
                        duration: Math.round(leg.duration / 60),
                        startTime: leg.startTime,
                        endTime: leg.endTime,
                        fromName: leg.from.name,
                        toName: leg.to.name,
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
                    geometry: allCoords
                });
            });
        }
    } catch (e) {
        console.warn('Transitous error', e);
    }
    
    // 3. Fallback
    if (routes.length === 0) {
        try {
            const fbRes = await fetch(`/api/plan?from=${fromStr}&to=${toStr}`);
            if (fbRes.ok) {
                 const fbData = await fbRes.json();
                 return fbData.routes || [];
            }
        } catch(e) {
            console.error('Backend fallback failed', e);
        }
    }

        return routes;
    })();
    
    inFlightRequests[key] = promise;
    try {
        return await promise;
    } finally {
        delete inFlightRequests[key];
    }
}
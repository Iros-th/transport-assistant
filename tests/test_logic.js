// Unit tests for frontend/logic.js (pure helpers). Run: node tests/test_logic.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'logic.js'), 'utf8');
assert.ok(!/^import /m.test(src), 'logic.js must stay import-free so it can be tested');
const names = [...src.matchAll(/export (?:const|function) (\w+)/g)].map(m => m[1]);
const L = new Function(src.replace(/export /g, '') + `; return { ${names.join(', ')} };`)();

// formatDist: Danish decimal comma, rounding
assert.strictEqual(L.formatDist(136), '140 m');
assert.strictEqual(L.formatDist(5), '10 m');
assert.strictEqual(L.formatDist(1432), '1,4 km');
assert.strictEqual(L.formatDist(NaN), '');

// legMeters: reported distance, else geometry length
assert.strictEqual(L.legMeters({ distance: 210 }), 210);
const geomLeg = { geometry: [[12.5714, 55.6833], [12.5714, 55.6923]] }; // ~1 km north
assert.ok(Math.abs(L.legMeters(geomLeg) - 1000) < 15, 'geometry fallback ~1000 m, got ' + L.legMeters(geomLeg));

// walkSummary levels
const walk = m => ({ mode: 'WALK', distance: m, toName: 'x' });
const ride = { mode: 'BUS', duration: 10 };
let w = L.walkSummary({ legs: [walk(136), ride, walk(131)] });
assert.strictEqual(w.level, 'ok'); assert.strictEqual(w.total, 267); assert.strictEqual(w.message, '');
w = L.walkSummary({ legs: [walk(900), ride, walk(100)] });
assert.strictEqual(w.level, 'warn'); assert.ok(/Lang gåtur/.test(w.message) && /900 m/.test(w.message), w.message);
w = L.walkSummary({ legs: [walk(700), ride, walk(700), ride, walk(300)] });
assert.strictEqual(w.level, 'warn', 'total > 1500 warns even when no single leg is long');
w = L.walkSummary({ legs: [walk(1800), ride] });
assert.strictEqual(w.level, 'long'); assert.ok(/Meget lang/.test(w.message));
assert.strictEqual(L.walkSummary({ legs: [{ mode: 'CAR', distance: 9000 }] }).level, 'ok');

// area / town names
assert.strictEqual(L.areaFromProps({ city: 'København', district: 'Indre By' }).label, 'Indre By, København');
assert.strictEqual(L.areaFromProps({ town: 'Lyngby' }).label, 'Lyngby');
assert.strictEqual(L.areaFromProps({ village: 'Sorø', suburb: 'Sorø' }).label, 'Sorø');
assert.strictEqual(L.areaFromProps({}).label, '');
assert.strictEqual(L.placeTown({ town: 'Kongens Lyngby' }), 'Kongens Lyngby');
assert.strictEqual(L.placeTown(null), '');

// OSM note URL carries the map location
const u = L.osmNoteUrl(55.68331, 12.57141, 17.4);
assert.ok(u.startsWith('https://www.openstreetmap.org/note/new?'), u);
assert.ok(u.includes('lat=55.68331') && u.includes('lon=12.57141') && u.includes('#map=17/55.68331/12.57141'), u);

// freshness / source line (times shown in Europe/Copenhagen)
const now = Date.parse('2026-10-06T10:20:00Z');
const fresh = { source: 'Transitous (Rejseplanen m.fl.)', fetchedAt: '2026-10-06T10:19:00Z' };
assert.ok(/Kilde: Transitous.*hentet 12:19/.test(L.sourceLine(fresh, now)), L.sourceLine(fresh, now));
assert.ok(!/gammelt/.test(L.sourceLine(fresh, now)));
const old = { source: 'X', fetchedAt: '2026-10-06T10:00:00Z' };
assert.ok(/20 min gammelt/.test(L.sourceLine(old, now)));
assert.strictEqual(L.isStale(old, now), true); assert.strictEqual(L.isStale(fresh, now), false);
assert.ok(/ukendt kilde/.test(L.sourceLine({}, now)));

// operator links
assert.deepStrictEqual(L.operatorLinks({ type: 'driving' }), []);
let links = L.operatorLinks({ type: 'transit', legs: [{ mode: 'BUS' }] });
assert.deepStrictEqual(links.map(l => l.label), ['Rejseplanen']);
links = L.operatorLinks({ type: 'transit', legs: [{ mode: 'SUBURBAN', agencyName: 'DSB S-tog' }] });
assert.deepStrictEqual(links.map(l => l.label), ['Rejseplanen', 'DSB']);

// Transitous outage messages
assert.ok(/utilgængelige \(svar 503\)/.test(L.transitNotice({ transitous: { state: 'error', status: 503 } }, true)));
assert.ok(/offline/i.test(L.transitNotice({ transitous: { state: 'error' } }, false)));
assert.ok(/ingen offentlig transport/.test(L.transitNotice({ transitous: { state: 'empty' } }, true)));
assert.strictEqual(L.transitNotice({ transitous: { state: 'ok' } }, true), '');
assert.strictEqual(L.transitNotice(null, true), '');

// Lær ruten steps
const origin = { name: 'Nørreport St.', town: 'København' }, dest = { name: 'DTU Lyngby', town: 'Kongens Lyngby' };
const route = { type: 'transit', legs: [
    { mode: 'WALK', distance: 136, duration: 2, fromName: 'START', toName: 'Nørreport St.', streets: ['Nørre Voldgade'] },
    { mode: 'SUBURBAN', routeShortName: 'E', headsign: 'Holte St.', stops: 7, duration: 18, fromName: 'Nørreport St.', toName: 'Lyngby St.' },
    { mode: 'WALK', distance: 210, duration: 5, fromName: 'Lyngby St.', toName: 'Lyngby St. (Letbane)' },
    { mode: 'TRAM', routeShortName: 'L', headsign: 'Lundtofte St.', stops: 3, duration: 11, fromName: 'Lyngby St. (Letbane)', toName: 'Anker Engelundsvej - DTU (Letbane)' },
    { mode: 'WALK', distance: 131, duration: 5, fromName: 'Anker Engelundsvej - DTU (Letbane)', toName: 'END' }
] };
const steps = L.buildLearnSteps(route, origin, dest);
assert.strictEqual(steps[0].kind, 'start'); assert.ok(steps[0].title.includes('Nørreport St.'));
assert.strictEqual(steps[steps.length - 1].kind, 'arrive'); assert.ok(steps[steps.length - 1].title.includes('DTU Lyngby'));
assert.ok(steps.some(s => s.kind === 'ride' && /S-tog E mod Holte St\./.test(s.title) && /8 stop/.test(s.detail)), JSON.stringify(steps));
assert.ok(steps.some(s => s.kind === 'walk' && /via Nørre Voldgade/.test(s.title)));
assert.ok(steps.some(s => s.kind === 'walk' && s.detail === 'til DTU Lyngby'), 'END must be replaced by the destination name');
assert.ok(!steps.some(s => /START|END/.test(s.title + s.detail)));
assert.ok(steps.length <= route.legs.length + 3, 'a short list, not a wall of text');
const carSteps = L.buildLearnSteps({ type: 'driving', legs: [{ mode: 'CAR', distance: 21000, duration: 28, toName: 'DTU Lyngby' }] }, origin, dest);
assert.deepStrictEqual(carSteps.map(s => s.kind), ['start', 'car', 'arrive']);

// mini map
const svg = L.miniMapSvg({ legs: [
    { mode: 'WALK', geometry: [[12.5714, 55.6833], [12.5718, 55.6834]] },
    { mode: 'BUS', routeColor: 'ff0000', geometry: [[12.5718, 55.6834], [12.5235, 55.7861]] }
] }, 320, 180);
assert.ok(svg.startsWith('<svg') && svg.includes('<path') && svg.includes('#FF0000'), svg.slice(0, 120));
assert.strictEqual(L.miniMapSvg({ legs: [] }), '');
// hostile colour values never reach markup
const evil = L.miniMapSvg({ legs: [{ mode: 'BUS', routeColor: '"><script>', geometry: [[12.5, 55.6], [12.6, 55.7]] }] });
assert.ok(!evil.includes('<script'), 'routeColor must be sanitised');
assert.strictEqual(L.safeColor('fff'), ''); assert.strictEqual(L.safeColor('#00aa11'), '#00AA11');
assert.strictEqual(L.readableOn('#FFFFFF'), '#111111'); assert.strictEqual(L.readableOn('#000080'), '#FFFFFF');

// map label scaling
assert.strictEqual(L.scaleTextSize(12, 1.25), 15);
assert.deepStrictEqual(L.scaleTextSize(['get', 'size'], 2), ['*', 2, ['get', 'size']]);
assert.deepStrictEqual(L.scaleTextSize({ stops: [[10, 10], [14, 16]] }, 1.5), ['interpolate', ['linear'], ['zoom'], 10, 15, 14, 24]);
assert.strictEqual(L.scaleTextSize(undefined, 2), null);
// zoom must stay the input of a top-level interpolate/step: scale the outputs, never wrap
assert.deepStrictEqual(L.scaleTextSize(['interpolate', ['linear'], ['zoom'], 4, 10, 8, 14], 1.5), ['interpolate', ['linear'], ['zoom'], 4, 15, 8, 21]);
assert.deepStrictEqual(L.scaleTextSize(['step', ['zoom'], 10, 6, 12], 2), ['step', ['zoom'], 20, 6, 24]);
assert.strictEqual(L.scaleTextSize(['*', ['zoom'], 2], 2), null);

assert.strictEqual(L.roundCoord(55.683349, 3), 55.683);
assert.strictEqual(L.modeLabel('SUBURBAN'), 'S-tog');

console.log('logic.js tests passed.');

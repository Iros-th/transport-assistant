const assert = require('assert');
const fs = require('fs');
const path = require('path');

// Read the seeded random functions from api.js to test determinism
const apiJsPath = path.join(__dirname, '../frontend/api.js');
const apiJsContent = fs.readFileSync(apiJsPath, 'utf8');

// Extract the functions
const extractFn = (name, content) => {
    const regex = new RegExp(`function ${name}\\(.*?\\) \\{[\\s\\S]*?\\n\\}`);
    const match = content.match(regex);
    return match ? match[0] : '';
};

const xmur3Code = extractFn('xmur3', apiJsContent);
const sfc32Code = extractFn('sfc32', apiJsContent);

eval(xmur3Code);
eval(sfc32Code);

function getSeededRandom(seedStr) {
    const seed = xmur3(seedStr);
    const rand = sfc32(seed(), seed(), seed(), seed());
    return rand;
}

// 1. Test scoring determinism
const rand1 = getSeededRandom('test-seed-1');
const val1 = rand1();
const val2 = rand1();

const rand2 = getSeededRandom('test-seed-1');
const val3 = rand2();

assert.strictEqual(val1, val3, 'Same seed must produce same first value');
assert.notStrictEqual(val1, val2, 'Sequential calls should differ');

// 2. Test ranking
// Test the REAL ranking function from app.js, not a copy.
const appSrc = require('fs').readFileSync(require('path').join(__dirname, '..', 'frontend', 'app.js'), 'utf8');
const fnSrc = appSrc.slice(appSrc.indexOf('function scoreAndRankRoutes'), appSrc.indexOf('function renderRoutes'));
const state = { priority: 'transit' };
const realRank = new Function('state', fnSrc + '; return scoreAndRankRoutes;')(state);
function scoreAndRankRoutes(routes, priority) { state.priority = priority; return realRank(routes); }

const mockRoutes = [
    { id: '1', type: 'transit', fillScore: 50, duration: 30 },
    { id: '2', type: 'transit', fillScore: 40, duration: 45 },
    { id: '3', type: 'driving', fillScore: 20, duration: 25 },
    { id: '4', type: 'transit', fillScore: 40, duration: 35 }
];

// "Mindst fyldt offentlig transport": public transport first (never the car), least crowded, then fastest.
const rankedTransit = scoreAndRankRoutes([...mockRoutes], 'transit');
assert.deepStrictEqual(rankedTransit.map(r => r.id), ['4', '2', '1', '3']);

// For driving priority: driving first, then best fill score (lowest)
// Expected order: 3 (driving), 4 (score 40, dur 35), 2, 1
const rankedDriving = scoreAndRankRoutes([...mockRoutes], 'driving');
assert.strictEqual(rankedDriving[0].id, '3');
assert.strictEqual(rankedDriving[1].id, '4');

// 3. Test api.js syntax
try {
    const apiCode = apiJsContent.replace(/export /g, '');
    eval(apiCode);
} catch (e) {
    assert.fail(`api.js has a syntax error: ${e.message}`);
}

// 4. Test decodePolyline with precision 5 and 6
const decodePolylineCode = extractFn('decodePolyline', apiJsContent);
eval(decodePolylineCode);

const polylinePrecision5 = '_p~iF~ps|U_ulLnnqC_mqNvxq`@';
const decoded5 = decodePolyline(polylinePrecision5, 5);
assert.ok(decoded5.length > 0, 'Should decode precision 5');

const polylinePrecision6 = '_izlhA~rlgdF_{geC~ywl@_kwzG~f`mI';
const decoded6 = decodePolyline(polylinePrecision6, 6);
assert.ok(decoded6.length > 0, 'Should decode precision 6');
// Specifically check precision 6 accuracy (values should be reasonable lat/lons)
assert.ok(Math.abs(decoded6[0][0] + 120.2) < 2, 'Longitude should be correct');

console.log('Frontend scoring and ranking tests passed.');

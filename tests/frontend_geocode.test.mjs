import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { geocode, searchLocalPlaces } from '../frontend/api.js';
const originalFetch = globalThis.fetch;
const originalLocation = globalThis.location;
afterEach(() => { globalThis.fetch = originalFetch; globalThis.location = originalLocation; });

test('stations remain searchable offline, including unaccented names', async () => {
    globalThis.fetch = async () => { throw new Error('offline'); };
    for (const query of ['osterport', 'kobenhavn', 'frederiksberg', 'lyngby']) {
        assert.ok(searchLocalPlaces(query).length > 0);
        const places = await geocode(query);
        assert.ok(places.length > 0);
        assert.equal(places.lookupUnavailable, true);
    }
    assert.equal((await geocode('unknown address')).lookupUnavailable, true);
});

test('arbitrary addresses use same-origin lookup and include house numbers', async () => {
    globalThis.location = { protocol: 'http:' };
    globalThis.fetch = async (url, options) => {
        assert.equal(url, '/api/geocode?q=Testvej%2024');
        assert.ok(options.signal instanceof AbortSignal);
        return new Response(JSON.stringify({ features: [{ properties: { street: 'Testvej', housenumber: '24', city: 'København' }, geometry: { coordinates: [12.5, 55.7] } }] }));
    };
    const places = await geocode('Testvej 24');
    assert.equal(places[0].name, 'Testvej 24');
    assert.equal(places[0].lat, 55.7);
});

test('standalone static previews fall back to direct lookup after a missing API', async () => {
    globalThis.location = { protocol: 'http:' };
    const requests = [];
    globalThis.fetch = async url => {
        requests.push(url);
        return requests.length === 1 ? new Response('', { status: 404 }) : new Response('{"features":[]}');
    };
    await geocode('Østerport');
    assert.equal(requests.length, 2);
    assert.ok(requests[1].startsWith('https://photon.komoot.io/api/'));
});

test('local station results survive malformed upstream data', async () => {
    globalThis.fetch = async () => new Response('not json');
    const places = await geocode('Østerport');
    assert.equal(places[0].name, 'Østerport St.');
    assert.equal(places.lookupUnavailable, true);
});

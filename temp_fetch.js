async function test() {
    const fromStr = '55.683,12.571';
    const toStr = '55.786,12.523';
    const tUrl = `https://api.transitous.org/api/v5/plan?fromPlace=${fromStr}&toPlace=${toStr}`;
    const tRes = await fetch(tUrl, { headers: { 'User-Agent': 'TransportAssistant/1.0' } });
    const tData = await tRes.json();
    console.log(JSON.stringify((tData.plan?.itineraries || tData.itineraries || [])[0].legs.map(l => ({
        mode: l.mode, route: l.route, routeShortName: l.routeShortName, routeColor: l.routeColor
    })), null, 2));
}
test();

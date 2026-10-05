(function () {
  "use strict";

  var SPEED_DRIVE_KMH = 32.0;
  var SPEED_TRANSIT_KMH = 22.0;
  var PARK_SEARCH_MIN = 4.0;
  var PR_DRIVE_FRACTION = 0.55;
  var TRANSIT_ACCESS_WALK_MIN = 6.0;
  var CURBSIDE_WALK_MIN = 1.5;
  var WALK_PENALTY_MAX_MIN = 20.0;

  var W = { time: 0.40, walk: 0.15, crowd: 0.25, park: 0.10, uncertainty: 0.10 };
  var W_TOTAL = W.time + W.walk + W.crowd + W.park + W.uncertainty;

  var CROWD_LOW_MAX = 0.50;
  var CROWD_MOD_MAX = 0.75;
  var CROWD_HIGH_MAX = 0.90;

  var TOTAL_SPACES = 500;

  var TIME_BIAS = {
    OFFPEAK: { label: "Uden for myldretid", crowdCenter: 0.34, parkTaken: 0.42 },
    RUSH: { label: "Myldretid", crowdCenter: 0.84, parkTaken: 0.90 }
  };

  var LINES = [
    { name: "Metro M1", kind: "Metro", capacity: 300 },
    { name: "Metro M2", kind: "Metro", capacity: 300 },
    { name: "Metro M3", kind: "Metro", capacity: 300 },
    { name: "Metro M4", kind: "Metro", capacity: 300 },
    { name: "S-tog linje A", kind: "S-tog", capacity: 500 },
    { name: "S-tog linje B", kind: "S-tog", capacity: 500 },
    { name: "S-tog linje C", kind: "S-tog", capacity: 500 },
    { name: "S-tog linje E", kind: "S-tog", capacity: 500 },
    { name: "S-tog linje H", kind: "S-tog", capacity: 500 },
    { name: "Bus 5C", kind: "Bus", capacity: 90 },
    { name: "Bus 2A", kind: "Bus", capacity: 80 },
    { name: "Bus 350S", kind: "Bus", capacity: 90 },
    { name: "Bus 1A", kind: "Bus", capacity: 80 },
    { name: "Letbane L", kind: "Letbane", capacity: 180 }
  ];

  var LOTS = [
    { id: "p-central", name: "Q-Park Nørreport", walking_minutes: 4.5, distance_to_destination_m: 350.0, offset: 0.0 },
    { id: "p-ostbane", name: "P-hus Israels Plads", walking_minutes: 8.5, distance_to_destination_m: 720.0, offset: -0.45 }
  ];

  var MODES = [
    { label: "Bil", parking: false, transit: false },
    { label: "Bil + parkering", parking: true, transit: false },
    { label: "Parkér og gå", parking: true, transit: false },
    { label: "Parkér & rejs", parking: true, transit: true },
    { label: "Offentlig transport", parking: false, transit: true }
  ];

  function hashSeed(str) {
    var h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (var i = 0; i < str.length; i++) {
      var ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
    h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
    h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return h1 >>> 0;
  }

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function round1(v) { return Math.round(v * 10) / 10; }
  function round4(v) { return Math.round(v * 10000) / 10000; }
  function round(v) { return Math.round(v); }
  function intBetween(rng, lo, hi) { return lo + Math.floor(rng() * (hi - lo + 1)); }

  function crowdLevel(score) {
    if (score < CROWD_LOW_MAX) return "LOW";
    if (score < CROWD_MOD_MAX) return "MODERATE";
    if (score < CROWD_HIGH_MAX) return "HIGH";
    return "VERY_HIGH";
  }

  function crowdWord(score) {
    if (score < 0.5) return "lav til moderat";
    if (score < 0.9) return "høj";
    return "meget høj";
  }

  var FACTOR_LABELS = {
    time: "rejsetid", walk: "gåafstand", crowd: "trængsel",
    park: "parkering", uncertainty: "datausikkerhed"
  };

  function explain(mode, comp) {
    var contrib = {
      time: W.time * comp.time, walk: W.walk * comp.walk, crowd: W.crowd * comp.crowd,
      park: W.park * comp.park, uncertainty: W.uncertainty * comp.uncertainty
    };
    var ranked = Object.keys(contrib).sort(function (a, b) { return contrib[b] - contrib[a]; });
    var dominant = ranked.filter(function (k) { return contrib[k] > 1e-9; }).slice(0, 2);

    var parts = [mode.label + "."];
    if (dominant.length === 1) {
      parts.push("Scoren er primært drevet af " + FACTOR_LABELS[dominant[0]] + ".");
    } else if (dominant.length >= 2) {
      parts.push("Scoren er primært drevet af " + FACTOR_LABELS[dominant[0]] + " og " + FACTOR_LABELS[dominant[1]] + ".");
    } else {
      parts.push("Scorer tæt på ideelt på alle faktorer.");
    }
    if (mode.transit) {
      parts.push("Trængslen er " + crowdWord(comp.crowd) + " på simulerede data.");
    }
    return parts.join(" ");
  }

  function pickLines(rng) {
    var pool = LINES.slice();
    for (var i = pool.length - 1; i > 0; i--) {
      var j = Math.floor(rng() * (i + 1));
      var tmp = pool[i]; pool[i] = pool[j]; pool[j] = tmp;
    }
    return pool.slice(0, 4);
  }

  function buildCrowdingPanel(rng, bias, tripBias, lines) {
    return lines.map(function (line, idx) {
      var ratio = clamp(bias.crowdCenter + tripBias + (rng() - 0.5) * 0.40, 0.05, 1.0);
      var count = round(ratio * line.capacity);
      var occ = count / line.capacity;
      var stale = idx === lines.length - 1;
      return {
        transport_id: line.name,
        route_id: line.kind,
        passenger_count: count,
        estimated_capacity: line.capacity,
        occupancy_ratio: round4(occ),
        crowding_level: crowdLevel(occ),
        source: "DEMO",
        confidence: Math.round((0.90 + rng() * 0.05) * 1000) / 1000,
        freshness: stale ? "STALE" : "SIMULATED",
        age_seconds: stale ? 90.0 : round1(2 + rng() * 18)
      };
    });
  }

  function buildDepartures(rng, startStop, lines) {
    return lines.map(function (line) {
      return {
        line: line.name,
        kind: line.kind,
        stops_away: intBetween(rng, 1, 8),
        start_stop: startStop,
        eta_min: intBetween(rng, 1, 12),
        source: "DEMO",
        freshness: "SIMULATED"
      };
    });
  }

  function buildParkingPanel(rng, bias) {
    return LOTS.map(function (lot) {
      var taken = clamp(bias.parkTaken + lot.offset + (rng() - 0.5) * 0.16, 0.02, 0.995);
      var available = round(TOTAL_SPACES * (1 - taken));
      return {
        parking_id: lot.id,
        name: lot.name,
        available_spaces: available,
        total_spaces: TOTAL_SPACES,
        distance_to_destination_m: lot.distance_to_destination_m,
        walking_minutes: lot.walking_minutes,
        source: "DEMO",
        freshness: "SIMULATED",
        age_seconds: round1(5 + rng() * 20)
      };
    });
  }

  function buildPlan(rng, crowdPanel, parkPanel, lines) {
    var distKm = 2.5 + rng() * 11.0;
    var driveMin = distKm / SPEED_DRIVE_KMH * 60;
    var transitMin = distKm / SPEED_TRANSIT_KMH * 60;
    var parkWalk = round1(3 + rng() * 5);

    var primary = crowdPanel[0];
    var primaryScore = clamp(primary.occupancy_ratio, 0, 1);
    var chosenLot = parkPanel[0];
    var takenChosen = clamp(1 - chosenLot.available_spaces / chosenLot.total_spaces, 0, 1);
    var transitLines = { "Offentlig transport": lines[0].name, "Parkér & rejs": lines[1].name };

    var raw = MODES.map(function (mode) {
      var total, walk;
      if (mode.label === "Bil") { total = driveMin + PARK_SEARCH_MIN; walk = CURBSIDE_WALK_MIN; }
      else if (mode.label === "Bil + parkering") { total = driveMin + PARK_SEARCH_MIN + parkWalk; walk = parkWalk; }
      else if (mode.label === "Parkér og gå") { total = driveMin * 0.9 + parkWalk + 3.0; walk = parkWalk + 3.0; }
      else if (mode.label === "Parkér & rejs") { total = driveMin * PR_DRIVE_FRACTION + transitMin * (1 - PR_DRIVE_FRACTION) + TRANSIT_ACCESS_WALK_MIN; walk = TRANSIT_ACCESS_WALK_MIN; }
      else { total = transitMin + TRANSIT_ACCESS_WALK_MIN; walk = TRANSIT_ACCESS_WALK_MIN; }
      return { mode: mode, total: round1(total), walk: round1(walk) };
    });

    var totals = raw.map(function (r) { return r.total; });
    var tMin = Math.min.apply(null, totals);
    var tMax = Math.max.apply(null, totals);

    var candidates = raw.map(function (r) {
      var mode = r.mode;
      var timeC = tMax > tMin ? (r.total - tMin) / (tMax - tMin) : 0;
      var walkC = Math.min(r.walk / WALK_PENALTY_MAX_MIN, 1);
      var crowdC = mode.transit ? primaryScore : 0;
      var parkC = mode.parking ? takenChosen : 0;
      var conf = primary.confidence;
      var uncertC = mode.transit ? (1 - conf) * 0.30 : 0;

      var comp = { time: timeC, walk: walkC, crowd: crowdC, park: parkC, uncertainty: uncertC };
      var score = (W.time * timeC + W.walk * walkC + W.crowd * crowdC + W.park * parkC + W.uncertainty * uncertC) / W_TOTAL;

      var crowding = mode.transit ? {
        level: primary.crowding_level,
        score: round4(primaryScore),
        confidence: conf,
        source: "DEMO"
      } : null;
      var parking = mode.parking ? { name: chosenLot.name, available_spaces: chosenLot.available_spaces } : null;

      return {
        recommended: false,
        mode: mode.label,
        line: mode.transit ? transitLines[mode.label] : null,
        score: round4(score),
        eta_minutes: r.total,
        walking_minutes: r.walk,
        parking: parking,
        crowding: crowding,
        explanation: explain(mode, comp),
        score_components: {
          time: round4(timeC), walking: round4(walkC), crowding: round4(crowdC),
          parking: round4(parkC), uncertainty: round4(uncertC)
        },
        data_sources: ["Simuleret model"]
      };
    });

    candidates.sort(function (a, b) {
      if (a.score !== b.score) return a.score - b.score;
      return a.mode < b.mode ? -1 : 1;
    });
    if (candidates.length) candidates[0].recommended = true;

    return { demo_mode: true, candidates: candidates };
  }

  function generate(from, to, timeOfDay) {
    var bias = TIME_BIAS[timeOfDay] || TIME_BIAS.OFFPEAK;
    var seed = hashSeed(String(from || "") + "→" + String(to || ""));
    var rng = mulberry32(seed);
    var tripBias = (rng() - 0.5) * 0.36;
    var lines = pickLines(rng);
    var crowdPanel = buildCrowdingPanel(rng, bias, tripBias, lines);
    var departures = buildDepartures(rng, String(from || "startstop"), lines);
    var parkPanel = buildParkingPanel(rng, bias);
    var plan = buildPlan(rng, crowdPanel, parkPanel, lines);
    return { plan: plan, crowding: crowdPanel, parking: parkPanel, departures: departures };
  }

  window.TransitDemoEngine = {
    generate: generate,
    timeOptions: function () {
      return Object.keys(TIME_BIAS).map(function (key) {
        return { key: key, label: TIME_BIAS[key].label };
      });
    }
  };
})();

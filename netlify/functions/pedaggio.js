// Netlify Function: pedaggio esatto via HERE Routing API v8 (chiave lato server)
// Fa DUE percorsi: con pedaggi e senza pedaggi (avoid tollRoad).
// Risposta: { configured, found, toll, currency, hasTolls, distanceKm, durationMin,
//             free: { toll, distanceKm, durationMin, hasTolls }, source:"here" }

exports.handler = async (event) => {
  const headers = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };
  const q = event.queryStringParameters || {};
  const from = (q.from || "").trim();
  const to   = (q.to   || "").trim();
  if (!from || !to) return { statusCode: 400, headers, body: JSON.stringify({ error: "from/to mancanti" }) };

  const KEY = process.env.HERE_API_KEY;
  if (!KEY) return { statusCode: 200, headers, body: JSON.stringify({ configured: false }) };

  const geo = async (place) => {
    const u = "https://geocode.search.hereapi.com/v1/geocode?in=countryCode:ITA&q=" +
              encodeURIComponent(place) + "&apiKey=" + KEY;
    const r = await fetch(u);
    const d = await r.json().catch(() => ({}));
    const it = d.items && d.items[0];
    if (!it || !it.position) throw new Error("luogo non trovato: " + place);
    return it.position.lat + "," + it.position.lng;
  };

  const parseRoute = (data) => {
    const route = data.routes && data.routes[0];
    if (!route) return { found: false, error: data.title || "percorso non trovato" };
    let toll = 0, currency = "EUR", hasTolls = false, meters = 0, seconds = 0;
    for (const s of (route.sections || [])) {
      const sum = s.summary || {};
      meters  += sum.length   || 0;
      seconds += sum.duration || 0;
      const t = sum.tolls && sum.tolls.total;
      if (t && typeof t.value === "number") {
        toll += t.value;
        currency = t.currency || "EUR";
        if (t.value > 0) hasTolls = true;
      }
    }
    return {
      found: true,
      toll: Math.round(toll * 100) / 100,
      currency,
      hasTolls,
      distanceKm: meters ? Math.round(meters / 1000) : null,
      durationMin: seconds ? Math.round(seconds / 60) : null
    };
  };

  const routeCall = async (origin, dest, avoidTolls) => {
    let u = "https://router.hereapi.com/v8/routes?transportMode=car" +
            "&origin=" + origin + "&destination=" + dest +
            "&return=summary,tolls&tolls[summaries]=total&currency=EUR&departureTime=any" +
            "&apiKey=" + KEY;
    if (avoidTolls) u += "&avoid[features]=tollRoad";
    const r = await fetch(u);
    const data = await r.json().catch(() => ({}));
    return parseRoute(data);
  };

  try {
    const origin = await geo(from);
    const dest   = await geo(to);

    const [tollR, freeR] = await Promise.all([
      routeCall(origin, dest, false),
      routeCall(origin, dest, true)
    ]);

    if (!tollR.found) {
      return { statusCode: 200, headers, body: JSON.stringify({ configured: true, found: false, error: tollR.error }) };
    }

    return {
      statusCode: 200, headers,
      body: JSON.stringify({
        configured: true,
        found: true,
        source: "here",
        toll: tollR.toll,
        currency: tollR.currency,
        hasTolls: tollR.hasTolls,
        distanceKm: tollR.distanceKm,
        durationMin: tollR.durationMin,
        free: freeR.found ? {
          toll: freeR.toll,
          distanceKm: freeR.distanceKm,
          durationMin: freeR.durationMin,
          hasTolls: freeR.hasTolls
        } : null
      })
    };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ configured: true, found: false, error: String(e) }) };
  }
};

// Netlify Function: HERE — routing (pedaggio+traffico), autosuggest luoghi, reverse geocode
// mode=suggest&q=...            -> [{label,lat,lng}]
// mode=reverse&at=lat,lng       -> {label,lat,lng}
// (default) from&to             -> percorso con/senza pedaggi + traffico

exports.handler = async (event) => {
  const headers = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };
  const q = event.queryStringParameters || {};
  const KEY = process.env.HERE_API_KEY;
  if (!KEY) return { statusCode: 200, headers, body: JSON.stringify({ configured: false }) };

  // --- suggerimenti luoghi ---
  if (q.mode === "suggest") {
    const text = (q.q || "").trim();
    if (text.length < 2) return { statusCode: 200, headers, body: JSON.stringify([]) };
    const at = (q.at && /^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/.test(q.at)) ? q.at : "41.9,12.5";
    try {
      const u = "https://autosuggest.search.hereapi.com/v1/autosuggest?at=" + at +
                "&in=countryCode:ITA&limit=6&lang=it&q=" + encodeURIComponent(text) + "&apiKey=" + KEY;
      const r = await fetch(u); const d = await r.json().catch(() => ({}));
      const items = (d.items || []).filter(it => it.position).map(it => ({ label: it.title, lat: it.position.lat, lng: it.position.lng }));
      return { statusCode: 200, headers, body: JSON.stringify(items) };
    } catch (e) { return { statusCode: 200, headers, body: JSON.stringify([]) }; }
  }

  // --- reverse geocode (usa la mia posizione) ---
  if (q.mode === "reverse") {
    const at = q.at || "";
    if (!/^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/.test(at)) return { statusCode: 400, headers, body: JSON.stringify({ error: "at non valido" }) };
    try {
      const u = "https://revgeocode.search.hereapi.com/v1/revgeocode?at=" + at + "&lang=it&apiKey=" + KEY;
      const r = await fetch(u); const d = await r.json().catch(() => ({}));
      const it = d.items && d.items[0];
      if (!it) return { statusCode: 200, headers, body: JSON.stringify({ error: "nessun risultato" }) };
      return { statusCode: 200, headers, body: JSON.stringify({ label: it.title, lat: it.position && it.position.lat, lng: it.position && it.position.lng }) };
    } catch (e) { return { statusCode: 500, headers, body: JSON.stringify({ error: String(e) }) }; }
  }

  // --- routing ---
  const from = (q.from || "").trim();
  const to   = (q.to   || "").trim();
  if (!from || !to) return { statusCode: 400, headers, body: JSON.stringify({ error: "from/to mancanti" }) };

  const dep = new Date().toISOString().replace(/\.\d+Z$/, "Z");

  const geo = async (place) => {
    const u = "https://geocode.search.hereapi.com/v1/geocode?in=countryCode:ITA&q=" + encodeURIComponent(place) + "&apiKey=" + KEY;
    const r = await fetch(u); const d = await r.json().catch(() => ({}));
    const it = d.items && d.items[0];
    if (!it || !it.position) throw new Error("luogo non trovato: " + place);
    return { lat: it.position.lat, lng: it.position.lng };
  };
  const parseRoute = (data) => {
    const route = data.routes && data.routes[0];
    if (!route) return { found: false, error: data.title || "percorso non trovato" };
    let toll = 0, currency = "EUR", hasTolls = false, meters = 0, seconds = 0, baseSeconds = 0;
    for (const s of (route.sections || [])) {
      const sum = s.summary || {};
      meters += sum.length || 0; seconds += sum.duration || 0;
      baseSeconds += (sum.baseDuration != null ? sum.baseDuration : sum.duration) || 0;
      const t = sum.tolls && sum.tolls.total;
      if (t && typeof t.value === "number") { toll += t.value; currency = t.currency || "EUR"; if (t.value > 0) hasTolls = true; }
    }
    return { found: true, toll: Math.round(toll * 100) / 100, currency, hasTolls,
      distanceKm: meters ? Math.round(meters / 1000) : null,
      durationMin: seconds ? Math.round(seconds / 60) : null,
      baseMin: baseSeconds ? Math.round(baseSeconds / 60) : null };
  };
  const routeCall = async (o, d, avoidTolls) => {
    let u = "https://router.hereapi.com/v8/routes?transportMode=car&origin=" + o.lat + "," + o.lng +
            "&destination=" + d.lat + "," + d.lng + "&return=summary,tolls&tolls[summaries]=total&currency=EUR" +
            "&departureTime=" + encodeURIComponent(dep) + "&apiKey=" + KEY;
    if (avoidTolls) u += "&avoid[features]=tollRoad";
    const r = await fetch(u); const data = await r.json().catch(() => ({}));
    return parseRoute(data);
  };

  try {
    const o = await geo(from);
    const d = await geo(to);
    const [tollR, freeR] = await Promise.all([routeCall(o, d, false), routeCall(o, d, true)]);
    if (!tollR.found) return { statusCode: 200, headers, body: JSON.stringify({ configured: true, found: false, error: tollR.error }) };
    return { statusCode: 200, headers, body: JSON.stringify({
      configured: true, found: true, source: "here",
      toll: tollR.toll, currency: tollR.currency, hasTolls: tollR.hasTolls,
      distanceKm: tollR.distanceKm, durationMin: tollR.durationMin, baseMin: tollR.baseMin,
      fromLat: o.lat, fromLng: o.lng, toLat: d.lat, toLng: d.lng,
      free: freeR.found ? { toll: freeR.toll, distanceKm: freeR.distanceKm, durationMin: freeR.durationMin, baseMin: freeR.baseMin, hasTolls: freeR.hasTolls } : null
    }) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ configured: true, found: false, error: String(e) }) };
  }
};

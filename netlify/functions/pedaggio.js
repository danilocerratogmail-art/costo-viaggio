// Netlify Function: HERE — routing (pedaggio+traffico+geometria), suggest, reverse, incidenti
// mode=suggest&q=...        -> [{label,lat,lng}]
// mode=reverse&at=lat,lng   -> {label,lat,lng}
// mode=incidents (POST {polys:[...], radius}) -> [{type,crit,closed,text}]
// (default) from&to         -> percorso con/senza pedaggi + traffico + polyline

exports.handler = async (event) => {
  const headers = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };
  const q = event.queryStringParameters || {};
  const KEY = process.env.HERE_API_KEY;
  if (!KEY) return { statusCode: 200, headers, body: JSON.stringify({ configured: false }) };

  if (q.mode === "suggest") {
    const text = (q.q || "").trim();
    if (text.length < 2) return { statusCode: 200, headers, body: JSON.stringify([]) };
    const at = (q.at && /^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/.test(q.at)) ? q.at : "41.9,12.5";
    try {
      const u = "https://autosuggest.search.hereapi.com/v1/autosuggest?at=" + at + "&in=countryCode:ITA&limit=6&lang=it&q=" + encodeURIComponent(text) + "&apiKey=" + KEY;
      const r = await fetch(u); const d = await r.json().catch(() => ({}));
      const items = (d.items || []).filter(it => it.position).map(it => ({ label: it.title, lat: it.position.lat, lng: it.position.lng }));
      return { statusCode: 200, headers, body: JSON.stringify(items) };
    } catch (e) { return { statusCode: 200, headers, body: JSON.stringify([]) }; }
  }

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

  if (q.mode === "incidents") {
    let body = {}; try { body = JSON.parse(event.body || "{}"); } catch (e) {}
    const polys = Array.isArray(body.polys) ? body.polys.slice(0, 8) : [];
    const radius = Math.min(Math.max(parseInt(body.radius, 10) || 250, 50), 1000);
    if (!polys.length) return { statusCode: 200, headers, body: JSON.stringify({ available: true, incidents: [] }) };
    try {
      const lists = await Promise.all(polys.map(async p => {
        try {
          const u = "https://data.traffic.hereapi.com/v7/incidents?in=corridor:" + p + ";r=" + radius + "&locationReferencing=none&apiKey=" + KEY;
          const r = await fetch(u);
          if (r.status === 401 || r.status === 403) return { denied: true, arr: [] };
          const d = await r.json().catch(() => ({}));
          return { denied: false, arr: (d.results || []) };
        } catch (e) { return { denied: false, arr: [] }; }
      }));
      if (lists.some(l => l.denied)) return { statusCode: 200, headers, body: JSON.stringify({ available: false, incidents: [] }) };
      const seen = {}; const out = [];
      lists.forEach(l => l.arr.forEach(it => {
        const det = it.incidentDetails || {};
        const id = det.id || (det.type + "|" + ((det.description && det.description.value) || ""));
        if (seen[id]) return; seen[id] = 1;
        out.push({
          type: det.type || "other",
          crit: det.criticality || "minor",
          closed: !!det.roadClosed,
          text: (det.description && det.description.value) || (det.summary && det.summary.value) || ""
        });
      }));
      const rank = { critical: 0, major: 1, minor: 2, lowImpact: 3 };
      out.sort((a, b) => (b.closed - a.closed) || ((rank[a.crit] ?? 2) - (rank[b.crit] ?? 2)));
      return { statusCode: 200, headers, body: JSON.stringify({ available: true, incidents: out.slice(0, 12) }) };
    } catch (e) { return { statusCode: 200, headers, body: JSON.stringify({ available: false, incidents: [] }) }; }
  }

  // --- routing ---
  const from = (q.from || "").trim();
  const to   = (q.to   || "").trim();
  if (!from || !to) return { statusCode: 400, headers, body: JSON.stringify({ error: "from/to mancanti" }) };
  const dep = new Date().toISOString().replace(/\.\d+Z$/, "Z");

  const geo = async (place) => {
    const m = place.match(/^\s*(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)\s*$/);
    if (m) return { lat: parseFloat(m[1]), lng: parseFloat(m[2]) };
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
    const polys = [];
    for (const s of (route.sections || [])) {
      const sum = s.summary || {};
      meters += sum.length || 0; seconds += sum.duration || 0;
      baseSeconds += (sum.baseDuration != null ? sum.baseDuration : sum.duration) || 0;
      if (s.polyline) polys.push(s.polyline);
      const t = sum.tolls && sum.tolls.total;
      if (t && typeof t.value === "number") { toll += t.value; currency = t.currency || "EUR"; if (t.value > 0) hasTolls = true; }
    }
    return { found: true, toll: Math.round(toll * 100) / 100, currency, hasTolls,
      distanceKm: meters ? Math.round(meters / 1000) : null,
      durationMin: seconds ? Math.round(seconds / 60) : null,
      baseMin: baseSeconds ? Math.round(baseSeconds / 60) : null, polys };
  };
  const routeCall = async (o, d, avoidTolls) => {
    let u = "https://router.hereapi.com/v8/routes?transportMode=car&origin=" + o.lat + "," + o.lng +
            "&destination=" + d.lat + "," + d.lng + "&return=summary,polyline,tolls&tolls[summaries]=total&currency=EUR" +
            "&departureTime=" + encodeURIComponent(dep) + "&apiKey=" + KEY;
    if (avoidTolls) u += "&avoid[features]=tollRoad";
    const r = await fetch(u); const data = await r.json().catch(() => ({}));
    return parseRoute(data);
  };

  try {
    const o = await geo(from); const d = await geo(to);
    const [tollR, freeR] = await Promise.all([routeCall(o, d, false), routeCall(o, d, true)]);
    if (!tollR.found) return { statusCode: 200, headers, body: JSON.stringify({ configured: true, found: false, error: tollR.error }) };
    return { statusCode: 200, headers, body: JSON.stringify({
      configured: true, found: true, source: "here",
      toll: tollR.toll, currency: tollR.currency, hasTolls: tollR.hasTolls,
      distanceKm: tollR.distanceKm, durationMin: tollR.durationMin, baseMin: tollR.baseMin, polys: tollR.polys,
      fromLat: o.lat, fromLng: o.lng, toLat: d.lat, toLng: d.lng,
      free: freeR.found ? { toll: freeR.toll, distanceKm: freeR.distanceKm, durationMin: freeR.durationMin, baseMin: freeR.baseMin, hasTolls: freeR.hasTolls, polys: freeR.polys } : null
    }) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ configured: true, found: false, error: String(e) }) };
  }
};

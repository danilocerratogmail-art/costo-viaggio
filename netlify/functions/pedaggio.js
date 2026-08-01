// Netlify Function: pedaggio esatto via Google Routes API (chiave lato server)
exports.handler = async (event) => {
  const headers = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };
  const q = event.queryStringParameters || {};
  const from = (q.from || "").trim();
  const to   = (q.to   || "").trim();
  if (!from || !to) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Parametri 'from' e 'to' obbligatori" }) };
  }
  const KEY = process.env.GOOGLE_MAPS_KEY;
  if (!KEY) {
    return { statusCode: 200, headers, body: JSON.stringify({ configured: false }) };
  }
  const url = "https://routes.googleapis.com/directions/v2:computeRoutes";
  const body = {
    origin: { address: from },
    destination: { address: to },
    travelMode: "DRIVE",
    routingPreference: "TRAFFIC_UNAWARE",
    extraComputations: ["TOLLS"],
    units: "METRIC",
    languageCode: "it-IT",
    regionCode: "IT"
  };
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": KEY,
        "X-Goog-FieldMask": "routes.distanceMeters,routes.duration,routes.travelAdvisory.tollInfo"
      },
      body: JSON.stringify(body)
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = (data && data.error && data.error.message) || ("HTTP " + r.status);
      return { statusCode: 502, headers, body: JSON.stringify({ configured: true, found: false, error: msg }) };
    }
    const route = data.routes && data.routes[0];
    if (!route) {
      return { statusCode: 200, headers, body: JSON.stringify({ configured: true, found: false }) };
    }
    let toll = 0, currency = "EUR", hasTolls = false;
    const ti = route.travelAdvisory && route.travelAdvisory.tollInfo;
    if (ti && Array.isArray(ti.estimatedPrice) && ti.estimatedPrice.length) {
      const p = ti.estimatedPrice[0];
      toll = Number(p.units || 0) + Number(p.nanos || 0) / 1e9;
      currency = p.currencyCode || "EUR";
      hasTolls = toll > 0;
    }
    const distanceKm = route.distanceMeters ? Math.round(route.distanceMeters / 1000) : null;
    const durationMin = route.duration ? Math.round(parseInt(String(route.duration), 10) / 60) : null;
    return {
      statusCode: 200, headers,
      body: JSON.stringify({ configured: true, found: true, toll: Math.round(toll * 100) / 100, currency, hasTolls, distanceKm, durationMin, source: "google" })
    };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ configured: true, found: false, error: String(e) }) };
  }
};

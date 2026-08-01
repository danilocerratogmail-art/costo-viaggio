// Netlify Function: pedaggio esatto via Google Routes API (con diagnostica)
exports.handler = async (event) => {
  const headers = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };
  const q = event.queryStringParameters || {};
  const from = (q.from || "").trim();
  const to   = (q.to   || "").trim();
  if (!from || !to) return { statusCode: 400, headers, body: JSON.stringify({ error: "from/to mancanti" }) };

  const KEY = process.env.GOOGLE_MAPS_KEY;
  if (!KEY) return { statusCode: 200, headers, body: JSON.stringify({ configured: false }) };

  const body = {
    origin: { address: from },
    destination: { address: to },
    travelMode: "DRIVE",
    routingPreference: "TRAFFIC_AWARE",
    extraComputations: ["TOLLS"],
    routeModifiers: { vehicleInfo: { emissionType: "GASOLINE" } },
    units: "METRIC",
    languageCode: "it-IT",
    regionCode: "IT"
  };

  const extract = (adv) => {
    const ti = adv && adv.tollInfo;
    if (!ti) return { present: false, price: null, currency: null };
    const ep = ti.estimatedPrice;
    if (Array.isArray(ep) && ep.length) {
      const p = ep[0];
      return { present: true, price: Number(p.units || 0) + Number(p.nanos || 0) / 1e9, currency: p.currencyCode || "EUR" };
    }
    return { present: true, price: null, currency: null };
  };

  try {
    const r = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": KEY,
        "X-Goog-FieldMask": "routes.distanceMeters,routes.duration,routes.travelAdvisory.tollInfo,routes.legs.travelAdvisory.tollInfo"
      },
      body: JSON.stringify(body)
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = (data && data.error && data.error.message) || ("HTTP " + r.status);
      return { statusCode: 502, headers, body: JSON.stringify({ configured: true, found: false, error: msg }) };
    }
    const route = data.routes && data.routes[0];
    if (!route) return { statusCode: 200, headers, body: JSON.stringify({ configured: true, found: false }) };

    let info = extract(route.travelAdvisory);
    if (!info.present && Array.isArray(route.legs)) {
      for (const leg of route.legs) { const li = extract(leg.travelAdvisory); if (li.present) { info = li; break; } }
    }
    let tollState, toll = null, currency = "EUR", found = false, hasTolls = false;
    if (!info.present) { tollState = "none"; toll = 0; found = true; }
    else if (info.price != null) { tollState = "priced"; toll = Math.round(info.price * 100) / 100; currency = info.currency || "EUR"; found = true; hasTolls = true; }
    else { tollState = "present_no_price"; hasTolls = true; }

    const distanceKm = route.distanceMeters ? Math.round(route.distanceMeters / 1000) : null;
    const durationMin = route.duration ? Math.round(parseInt(String(route.duration), 10) / 60) : null;

    return { statusCode: 200, headers, body: JSON.stringify({ configured: true, found, toll, currency, hasTolls, tollState, distanceKm, durationMin, source: "google" }) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ configured: true, found: false, error: String(e) }) };
  }
};

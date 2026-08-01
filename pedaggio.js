// Netlify Function: proxy sicuro verso TollGuru (la chiave resta lato server)
// Richiesta:  /.netlify/functions/pedaggio?from=Massa&to=Firenze&vehicle=2AxlesAuto
// Risposta:   { configured:true, found:true, toll:12.3, currency:"EUR", hasTolls:true, distanceKm:..., source:"tollguru" }

exports.handler = async (event) => {
  const headers = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };
  const q = event.queryStringParameters || {};
  const from = (q.from || "").trim();
  const to   = (q.to   || "").trim();
  const vehicle = (q.vehicle || "2AxlesAuto").trim();  // Italia: Classe A (vale anche per le moto)

  if (!from || !to) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Parametri 'from' e 'to' obbligatori" }) };
  }

  const KEY = process.env.TOLLGURU_KEY;
  if (!KEY) {
    // Nessuna chiave impostata: l'app userà la stima
    return { statusCode: 200, headers, body: JSON.stringify({ configured: false }) };
  }

  const BASE = process.env.TOLLGURU_URL || "https://apis.tollguru.com/toll/v2";
  const url  = BASE.replace(/\/+$/,"") + "/origin-destination-waypoints";

  const body = {
    from: { address: from },
    to:   { address: to },
    serviceProvider: "gmaps",
    vehicle: { type: vehicle }
  };

  const pickNum = (...vals) => {
    for (const v of vals) { const n = Number(v); if (Number.isFinite(n) && n >= 0) return n; }
    return null;
  };

  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": KEY },
      body: JSON.stringify(body)
    });
    const data = await r.json().catch(() => ({}));

    if (!r.ok) {
      return { statusCode: 502, headers, body: JSON.stringify({ configured: true, found: false, error: "TollGuru", status: r.status, detail: data }) };
    }

    const route = data.route || (Array.isArray(data.routes) ? data.routes[0] : null);
    if (!route) {
      return { statusCode: 200, headers, body: JSON.stringify({ configured: true, found: false }) };
    }

    const costs = route.costs || {};
    const toll = pickNum(costs.cash, costs.tag, costs.minimumTollCost, costs.licensePlate, costs.prepaidCard);
    const currency = costs.currency || (route.summary && route.summary.currency) || "EUR";

    let distanceKm = null;
    const dist = route.summary && route.summary.distance;
    if (dist) {
      if (Number.isFinite(dist.metric)) distanceKm = Math.round(dist.metric);
      else if (Number.isFinite(dist.value)) distanceKm = Math.round(dist.value > 5000 ? dist.value / 1000 : dist.value);
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        configured: true,
        found: toll !== null,
        toll,
        currency,
        hasTolls: route.hasTolls !== undefined ? route.hasTolls : (toll > 0),
        distanceKm,
        source: "tollguru"
      })
    };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ configured: true, found: false, error: String(e) }) };
  }
};

/**
 * Cloudflare Worker für Trading 212 Radar
 *
 * Features:
 * 1. Intelligentes Edge- & In-Memory-Caching (verhindert Trading 212 HTTP 429 Rate-Limits):
 *    - /api/v0/equity/portfolio hat bei T212 ein Limit von 1 Request / 5 Sekunden.
 *    - /api/v0/equity/metadata/instruments hat ein Limit von 1 Request / 50 Sekunden.
 * 2. Bei HTTP 429 von Trading 212 liefert der Worker automatisch den letzten gültigen
 *    Zwischenstand (Stale-While-Revalidate) oder wartet kurz und versucht es erneut.
 * 3. Reichert jede Position direkt mit Klarnamen (name), shortName, currencyCode und ISIN an.
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-T212-Env',
  'Content-Type': 'application/json;charset=UTF-8',
  'Cache-Control': 'no-store'
};

// In-Memory-Caches innerhalb der Worker-Instanz
const instrumentsCache = new Map(); // env -> { map: Map, ts: number }
const userSnapshotCache = new Map(); // cacheKey -> { payload: object, ts: number }

const PORTFOLIO_TTL_MS = 6000;          // 6 Sekunden Cooldown gegen T212 5s-Limit
const INSTRUMENTS_TTL_MS = 3600 * 1000; // 1 Stunde für Instrumenten-Metadaten

async function sha256Hex(text) {
  const data = new TextEncoder().encode(text);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function getInstrumentsMap(baseHost, envParam, reqHeaders) {
  const now = Date.now();
  const cached = instrumentsCache.get(envParam);
  if (cached && (now - cached.ts) < INSTRUMENTS_TTL_MS && cached.map.size > 0) {
    return cached.map;
  }

  try {
    const res = await fetch(`${baseHost}/api/v0/equity/metadata/instruments`, {
      headers: reqHeaders
    });
    if (res.ok) {
      const list = await res.json();
      const metaMap = new Map();
      if (Array.isArray(list)) {
        for (const inst of list) {
          if (inst && inst.ticker) {
            metaMap.set(inst.ticker, {
              name: inst.name,
              shortName: inst.shortName,
              currencyCode: inst.currencyCode,
              isin: inst.isin,
              type: inst.type
            });
          }
        }
      }
      if (metaMap.size > 0) {
        instrumentsCache.set(envParam, { map: metaMap, ts: now });
        return metaMap;
      }
    }
  } catch (e) {
    // Ignorieren, falls Metadaten-Endpunkt gedrosselt ist
  }

  return cached ? cached.map : new Map();
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (request.method !== 'GET') {
      return new Response(JSON.stringify({ error: 'Method Not Allowed' }), {
        status: 405,
        headers: CORS_HEADERS
      });
    }

    const authHeader = request.headers.get('Authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Missing Authorization header' }), {
        status: 401,
        headers: CORS_HEADERS
      });
    }

    const url = new URL(request.url);
    const envParam = (url.searchParams.get('env') || request.headers.get('X-T212-Env') || 'live').toLowerCase();
    const baseHost = envParam === 'demo'
      ? 'https://demo.trading212.com'
      : 'https://live.trading212.com';

    const authHash = await sha256Hex(`${envParam}:${authHeader}`);
    const now = Date.now();

    // 1. Prüfen, ob innerhalb der letzten 6 Sekunden bereits abgefragt wurde
    const memEntry = userSnapshotCache.get(authHash);
    if (memEntry && (now - memEntry.ts) < PORTFOLIO_TTL_MS) {
      return new Response(
        JSON.stringify({ ...memEntry.payload, cached: true, cacheAgeMs: now - memEntry.ts }),
        { status: 200, headers: CORS_HEADERS }
      );
    }

    // Auch Cloudflare Edge Cache API prüfen (falls Request auf anderem Worker-Isolate landet)
    const edgeCache = caches.default;
    const cacheUrl = new URL(`https://t212-cache.internal/${envParam}/${authHash}`);
    const cacheReq = new Request(cacheUrl.toString(), { method: 'GET' });

    const reqHeaders = {
      'Authorization': authHeader,
      'Accept': 'application/json',
      'User-Agent': 'T212Radar/2.1'
    };

    try {
      // Portfolio + Cash + Dividenden abrufen
      let [portfolioRes, cashRes, divRes] = await Promise.all([
        fetch(`${baseHost}/api/v0/equity/portfolio`, { headers: reqHeaders }),
        fetch(`${baseHost}/api/v0/equity/account/cash`, { headers: reqHeaders }).catch(() => null),
        fetch(`${baseHost}/api/v0/equity/history/dividends?limit=50`, { headers: reqHeaders }).catch(() => null)
      ]);

      // Falls /portfolio wegen kurzem Doppel-Request in 429 läuft:
      // 1) Sofort vorhandenen Cache ausliefern, oder
      // 2) Nach 2.2 Sekunden einmal automatisch wiederholen
      if (portfolioRes.status === 429) {
        if (memEntry && memEntry.payload) {
          return new Response(
            JSON.stringify({
              ...memEntry.payload,
              cached: true,
              rateLimited: true,
              cacheAgeMs: Date.now() - memEntry.ts
            }),
            { status: 200, headers: CORS_HEADERS }
          );
        }

        const edgeCachedRes = await edgeCache.match(cacheReq);
        if (edgeCachedRes) {
          const edgeData = await edgeCachedRes.json();
          return new Response(
            JSON.stringify({ ...edgeData, cached: true, rateLimited: true }),
            { status: 200, headers: CORS_HEADERS }
          );
        }

        // Kein Cache vorhanden -> kurz warten und 1x Retry für /portfolio + /cash
        await sleep(2200);
        [portfolioRes, cashRes] = await Promise.all([
          fetch(`${baseHost}/api/v0/equity/portfolio`, { headers: reqHeaders }),
          fetch(`${baseHost}/api/v0/equity/account/cash`, { headers: reqHeaders }).catch(() => null)
        ]);
      }

      if (!portfolioRes.ok) {
        const errText = await portfolioRes.text();
        return new Response(
          JSON.stringify({
            error: `Trading 212 API HTTP ${portfolioRes.status}`,
            details: errText.slice(0, 300)
          }),
          { status: portfolioRes.status, headers: CORS_HEADERS }
        );
      }

      const rawPortfolio = await portfolioRes.json();
      const summary = (cashRes && cashRes.ok)
        ? await cashRes.json()
        : (memEntry?.payload?.summary || null);
      const divData = (divRes && divRes.ok) ? await divRes.json() : null;
      const dividends = (divData && Array.isArray(divData.items))
        ? divData.items
        : (memEntry?.payload?.dividends || []);

      // Instrumenten-Metadaten aus dem 1h-Cache holen (blockiert oder gefährdet niemals das Portfolio)
      const metaMap = await getInstrumentsMap(baseHost, envParam, reqHeaders);

      const portfolio = (Array.isArray(rawPortfolio) ? rawPortfolio : []).map(pos => {
        const meta = metaMap.get(pos.ticker);
        return meta ? { ...pos, ...meta } : pos;
      });

      const payload = {
        portfolio,
        summary,
        dividends,
        environment: envParam,
        fetchedAt: new Date().toISOString()
      };

      userSnapshotCache.set(authHash, { payload, ts: Date.now() });

      // Für 5 Minuten im Cloudflare Edge-Cache als Fallback bei 429 hinterlegen
      const edgeResponse = new Response(JSON.stringify(payload), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' }
      });
      if (ctx && typeof ctx.waitUntil === 'function') {
        ctx.waitUntil(edgeCache.put(cacheReq, edgeResponse));
      } else {
        await edgeCache.put(cacheReq, edgeResponse).catch(() => {});
      }

      return new Response(JSON.stringify(payload), { status: 200, headers: CORS_HEADERS });
    } catch (err) {
      if (memEntry && memEntry.payload) {
        return new Response(
          JSON.stringify({ ...memEntry.payload, cached: true, warning: err.message }),
          { status: 200, headers: CORS_HEADERS }
        );
      }
      return new Response(
        JSON.stringify({ error: 'Worker Fetch Error', message: err.message }),
        { status: 502, headers: CORS_HEADERS }
      );
    }
  }
};

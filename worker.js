/**
 * Cloudflare Worker für Trading 212 Radar
 *
 * Features:
 * 1. Intelligentes Edge- & In-Memory-Caching (verhindert Trading 212 HTTP 429 Rate-Limits):
 *    - /api/v0/equity/portfolio hat bei T212 ein Limit von 1 Request / 5 Sekunden.
 *    - /api/v0/equity/pies hat ein Limit von 1 Request / 30 Sekunden (wird im Memory + Edge Cache gecacht).
 *    - /api/v0/equity/pies/{id} hat ein Limit von 1 Request / 5 Sekunden (wird 10 Min im Memory + Edge Cache gecacht).
 *    - /api/v0/equity/metadata/instruments hat ein Limit von 1 Request / 50 Sekunden.
 * 2. Vollständige Pie-Auflösung:
 *    - Lädt die Liste aller Pies (/api/v0/equity/pies) sowie die Details jedes einzelnen Pies
 *      (/api/v0/equity/pies/{id}), inklusive Name, Ziel-/Ist-Gewichtung, Pie-Cash,
 *      Dividenden-Einstellungen und enthaltener Positionen.
 *    - Normalisiert Trading 212 `InvestmentResult` (`priceAvgValue`/`value`, `priceAvgInvestedValue`/`investedValue`, `priceAvgResult`/`result`).
 *    - Verknüpft jede Portfolio-Position direkt mit ihren zugehörigen Pies (`pies`-Array).
 * 3. Reichert jede Position mit Klarnamen (name), shortName, currencyCode und ISIN an.
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-T212-Env',
  'Content-Type': 'application/json;charset=UTF-8',
  'Cache-Control': 'no-store'
};

// In-Memory-Caches innerhalb der Worker-Instanz
const instrumentsCache = new Map();  // env -> { map: Map, ts: number }
const userSnapshotCache = new Map(); // authHash -> { payload: object, ts: number }
const piesListCache = new Map();     // authHash -> { list: Array, ts: number }
const pieDetailCache = new Map();    // `${authHash}:${pieId}` -> { detail: object, ts: number }

const PORTFOLIO_TTL_MS = 5500;            // 5.5s Cooldown gegen T212 5s-Limit
const PIES_LIST_TTL_MS = 35 * 1000;       // 35s Cache für /equity/pies (Limit: 1 req / 30s)
const PIE_DETAIL_TTL_MS = 10 * 60 * 1000; // 10 Min Cache für /equity/pies/{id} (Limit: 1 req / 5s)
const INSTRUMENTS_TTL_MS = 3600 * 1000;   // 1h Cache für Instrumenten-Metadaten

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

/**
 * Normalisiert Trading 212 InvestmentResult-Objekte (unterstützt sowohl
 * priceAvgValue/priceAvgInvestedValue/priceAvgResult als auch value/investedValue/result).
 */
function normalizeInvestmentResult(resObj) {
  if (!resObj || typeof resObj !== 'object') return null;
  const investedValue = Number(resObj.priceAvgInvestedValue ?? resObj.investedValue ?? 0);
  const value = Number(resObj.priceAvgValue ?? resObj.value ?? 0);
  const result = Number(resObj.priceAvgResult ?? resObj.result ?? (value - investedValue) ?? 0);
  const resultCoef = Number(resObj.priceAvgResultCoef ?? resObj.resultCoef ?? (investedValue > 0 ? result / investedValue : 0));
  return {
    investedValue,
    value,
    result,
    resultCoef,
    priceAvgInvestedValue: investedValue,
    priceAvgValue: value,
    priceAvgResult: result,
    priceAvgResultCoef: resultCoef
  };
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

/**
 * Ruft die Pies des Nutzers ab und lädt fehlende Pie-Details (/equity/pies/{id})
 * mit zweistufigem Caching (In-Memory + Cloudflare Edge Cache).
 */
async function getEnrichedPies(baseHost, authHash, reqHeaders, edgeCache) {
  const now = Date.now();
  let rawPiesList = null;
  let piesHttpStatus = 200;

  const listCacheUrl = `https://t212-cache.internal/pies-list/${authHash}`;

  // 1. In-Memory prüfen
  const cachedList = piesListCache.get(authHash);
  if (cachedList && (now - cachedList.ts) < PIES_LIST_TTL_MS) {
    rawPiesList = cachedList.list;
  }

  // 2. Edge Cache prüfen (wichtig wegen 1 req / 30s Limit bei Wechsel der Worker-Instanz)
  if (!rawPiesList && edgeCache) {
    try {
      const edgeListRes = await edgeCache.match(new Request(listCacheUrl));
      if (edgeListRes) {
        const parsed = await edgeListRes.json();
        if (Array.isArray(parsed)) {
          rawPiesList = parsed;
          piesListCache.set(authHash, { list: rawPiesList, ts: now });
        }
      }
    } catch (e) {}
  }

  // 3. Live von Trading 212 abrufen
  if (!rawPiesList) {
    try {
      const res = await fetch(`${baseHost}/api/v0/equity/pies`, { headers: reqHeaders });
      piesHttpStatus = res.status;
      if (res.ok) {
        const parsed = await res.json();
        if (Array.isArray(parsed)) {
          rawPiesList = parsed;
          piesListCache.set(authHash, { list: rawPiesList, ts: now });
          if (edgeCache) {
            const edgePutList = new Response(JSON.stringify(rawPiesList), {
              headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=35' }
            });
            await edgeCache.put(new Request(listCacheUrl), edgePutList).catch(() => {});
          }
        }
      }
    } catch (e) {}

    if (!rawPiesList && cachedList) {
      rawPiesList = cachedList.list;
    }
  }

  if (!Array.isArray(rawPiesList) || rawPiesList.length === 0) {
    return { pies: [], piesStatus: piesHttpStatus };
  }

  const enrichedPies = [];
  let liveDetailFetches = 0;

  for (const pieSummary of rawPiesList) {
    const pieId = pieSummary.id;
    if (!pieId) continue;

    const detailKey = `${authHash}:${pieId}`;
    const detailCacheUrl = `https://t212-cache.internal/pie-detail/${authHash}/${pieId}`;
    let detail = null;

    // 1. In-Memory-Cache prüfen
    const memDetail = pieDetailCache.get(detailKey);
    if (memDetail && (now - memDetail.ts) < PIE_DETAIL_TTL_MS) {
      detail = memDetail.detail;
    }

    // 2. Cloudflare Edge Cache prüfen
    if (!detail && edgeCache) {
      try {
        const edgeRes = await edgeCache.match(new Request(detailCacheUrl));
        if (edgeRes) {
          detail = await edgeRes.json();
          pieDetailCache.set(detailKey, { detail, ts: now });
        }
      } catch (e) {}
    }

    // 3. Live von Trading 212 abrufen (/api/v0/equity/pies/{id})
    if (!detail && liveDetailFetches < 4) {
      try {
        if (liveDetailFetches > 0) {
          await sleep(5050);
        }
        liveDetailFetches++;
        let dRes = await fetch(`${baseHost}/api/v0/equity/pies/${pieId}`, { headers: reqHeaders });
        if (dRes.status === 429) {
          await sleep(5100);
          dRes = await fetch(`${baseHost}/api/v0/equity/pies/${pieId}`, { headers: reqHeaders });
        }
        if (dRes.ok) {
          detail = await dRes.json();
          pieDetailCache.set(detailKey, { detail, ts: Date.now() });
          if (edgeCache) {
            const edgePutRes = new Response(JSON.stringify(detail), {
              headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=600' }
            });
            await edgeCache.put(new Request(detailCacheUrl), edgePutRes).catch(() => {});
          }
        }
      } catch (e) {}
    }

    if (!detail && memDetail) {
      detail = memDetail.detail;
    }

    const settings = (detail && detail.settings) ? detail.settings : {};
    const instruments = (detail && Array.isArray(detail.instruments)) ? detail.instruments : [];

    enrichedPies.push({
      id: pieId,
      name: settings.name || `Pie #${pieId}`,
      icon: settings.icon || null,
      goal: settings.goal ?? null,
      dividendCashAction: settings.dividendCashAction || null,
      cash: Number(pieSummary.cash || 0),
      progress: pieSummary.progress ?? null,
      status: pieSummary.status || null,
      dividendDetails: pieSummary.dividendDetails || null,
      result: normalizeInvestmentResult(pieSummary.result),
      detailsLoaded: !!detail,
      instruments: instruments.map(inst => ({
        ticker: inst.ticker,
        currentShare: Number(inst.currentShare || 0),
        expectedShare: Number(inst.expectedShare || 0),
        ownedQuantity: Number(inst.ownedQuantity || 0),
        result: normalizeInvestmentResult(inst.result)
      }))
    });
  }

  return { pies: enrichedPies, piesStatus: piesHttpStatus };
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

    // Geo-Beschränkung: nur Deutschland (DE)
    const cf = request.cf;
    if (cf && cf.country && cf.country.toUpperCase() !== 'DE') {
      return new Response(JSON.stringify({
        error: 'Access restricted to Germany (DE)',
        detectedCountry: cf.country
      }), {
        status: 403,
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

    // 1. Prüfen, ob innerhalb der letzten 5.5 Sekunden bereits abgefragt wurde
    const memEntry = userSnapshotCache.get(authHash);
    if (memEntry && (now - memEntry.ts) < PORTFOLIO_TTL_MS && (memEntry.payload?.pies?.length > 0)) {
      return new Response(
        JSON.stringify({ ...memEntry.payload, cached: true, cacheAgeMs: now - memEntry.ts }),
        { status: 200, headers: CORS_HEADERS }
      );
    }

    const edgeCache = caches.default;
    const cacheUrl = new URL(`https://t212-cache.internal/snapshot/${envParam}/${authHash}`);
    const cacheReq = new Request(cacheUrl.toString(), { method: 'GET' });

    const reqHeaders = {
      'Authorization': authHeader,
      'Accept': 'application/json',
      'User-Agent': 'T212Radar/2.4'
    };

    try {
      // Portfolio + Cash + Dividenden parallel abrufen
      let [portfolioRes, cashRes, divRes] = await Promise.all([
        fetch(`${baseHost}/api/v0/equity/portfolio`, { headers: reqHeaders }),
        fetch(`${baseHost}/api/v0/equity/account/cash`, { headers: reqHeaders }).catch(() => null),
        fetch(`${baseHost}/api/v0/equity/history/dividends?limit=50`, { headers: reqHeaders }).catch(() => null)
      ]);

      // Falls /portfolio wegen kurzem Doppel-Request in 429 läuft:
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

      // Pies & Instrumenten-Metadaten parallel laden
      const [piesResult, metaMap] = await Promise.all([
        getEnrichedPies(baseHost, authHash, reqHeaders, edgeCache),
        getInstrumentsMap(baseHost, envParam, reqHeaders)
      ]);

      const pies = (piesResult.pies && piesResult.pies.length > 0)
        ? piesResult.pies
        : (memEntry?.payload?.pies || []);
      const piesStatus = piesResult.piesStatus || 200;

      // Zuordnungs-Map: Ticker -> Liste der Pies, in denen diese Position liegt
      const tickerToPiesMap = new Map();
      for (const pie of pies) {
        if (Array.isArray(pie.instruments)) {
          for (const inst of pie.instruments) {
            if (!inst.ticker) continue;
            const list = tickerToPiesMap.get(inst.ticker) || [];
            list.push({
              id: pie.id,
              name: pie.name,
              ownedQuantity: inst.ownedQuantity,
              currentShare: inst.currentShare,
              expectedShare: inst.expectedShare,
              value: inst.result?.value ?? inst.result?.priceAvgValue ?? null,
              investedValue: inst.result?.investedValue ?? inst.result?.priceAvgInvestedValue ?? null,
              result: inst.result?.result ?? inst.result?.priceAvgResult ?? null
            });
            tickerToPiesMap.set(inst.ticker, list);
          }
        }
      }

      const portfolio = (Array.isArray(rawPortfolio) ? rawPortfolio : []).map(pos => {
        const meta = metaMap.get(pos.ticker);
        const posPies = tickerToPiesMap.get(pos.ticker) || [];
        return {
          ...pos,
          ...(meta || {}),
          pies: posPies
        };
      });

      const payload = {
        portfolio,
        summary,
        pies,
        piesStatus,
        dividends,
        environment: envParam,
        fetchedAt: new Date().toISOString()
      };

      userSnapshotCache.set(authHash, { payload, ts: Date.now() });

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

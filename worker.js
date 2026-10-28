/**
 * Cloudflare Worker für Trading 212 Radar
 *
 * Ruft parallel die offenen Positionen (/api/v0/equity/portfolio),
 * den Kontostand (/api/v0/equity/account/cash), die letzten Dividenden
 * (/api/v0/equity/history/dividends) sowie die Instrumenten-Metadaten
 * (/api/v0/equity/metadata/instruments) von Trading 212 ab und reichert
 * jede Position direkt mit Klarnamen (name), shortName, currencyCode und ISIN an.
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-T212-Env',
  'Content-Type': 'application/json;charset=UTF-8',
  'Cache-Control': 'no-store'
};

export default {
  async fetch(request) {
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

    const reqHeaders = {
      'Authorization': authHeader,
      'Accept': 'application/json',
      'User-Agent': 'T212Radar/2.0'
    };

    try {
      const [portfolioRes, cashRes, divRes, metaRes] = await Promise.all([
        fetch(`${baseHost}/api/v0/equity/portfolio`, { headers: reqHeaders }),
        fetch(`${baseHost}/api/v0/equity/account/cash`, { headers: reqHeaders }).catch(() => null),
        fetch(`${baseHost}/api/v0/equity/history/dividends?limit=50`, { headers: reqHeaders }).catch(() => null),
        fetch(`${baseHost}/api/v0/equity/metadata/instruments`, {
          headers: reqHeaders,
          cf: { cacheTtl: 3600, cacheEverything: true }
        }).catch(() => null)
      ]);

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
      const summary = cashRes && cashRes.ok ? await cashRes.json() : null;
      const divData = divRes && divRes.ok ? await divRes.json() : null;
      const dividends = divData && Array.isArray(divData.items) ? divData.items : [];
      const instruments = metaRes && metaRes.ok ? await metaRes.json() : [];

      const metaMap = new Map();
      if (Array.isArray(instruments)) {
        for (const inst of instruments) {
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

      const portfolio = (Array.isArray(rawPortfolio) ? rawPortfolio : []).map(pos => {
        const meta = metaMap.get(pos.ticker);
        return meta ? { ...pos, ...meta } : pos;
      });

      return new Response(
        JSON.stringify({
          portfolio,
          summary,
          dividends,
          environment: envParam,
          fetchedAt: new Date().toISOString()
        }),
        { status: 200, headers: CORS_HEADERS }
      );
    } catch (err) {
      return new Response(
        JSON.stringify({ error: 'Worker Fetch Error', message: err.message }),
        { status: 502, headers: CORS_HEADERS }
      );
    }
  }
};

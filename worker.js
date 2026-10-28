/**
 * Cloudflare Worker für Trading 212 Radar
 *
 * Ruft parallel die offenen Positionen (/api/v0/equity/portfolio),
 * den Kontostand (/api/v0/equity/account/cash) und optional die letzten
 * Dividenden (/api/v0/equity/history/dividends) von Trading 212 ab
 * und liefert alles gebündelt mit aktivierten CORS-Headern zurück.
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
      'Accept': 'application/json'
    };

    try {
      const [portfolioRes, cashRes, divRes] = await Promise.all([
        fetch(`${baseHost}/api/v0/equity/portfolio`, { headers: reqHeaders }),
        fetch(`${baseHost}/api/v0/equity/account/cash`, { headers: reqHeaders }).catch(() => null),
        fetch(`${baseHost}/api/v0/equity/history/dividends?limit=50`, { headers: reqHeaders }).catch(() => null)
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

      const portfolio = await portfolioRes.json();
      const summary = cashRes && cashRes.ok ? await cashRes.json() : null;
      const divData = divRes && divRes.ok ? await divRes.json() : null;
      const dividends = divData && Array.isArray(divData.items) ? divData.items : [];

      return new Response(
        JSON.stringify({
          portfolio: Array.isArray(portfolio) ? portfolio : [],
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

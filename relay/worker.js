// Election Tracker relay — Cloudflare Worker
// Passes read-only GET requests through to Kalshi's public market-data API
// and adds the headers a web page needs to read the response.
// Responses are cached at the edge for 15 seconds so many refreshes
// don't hammer Kalshi's rate limits.

const KALSHI = "https://api.elections.kalshi.com/trade-api/v2";
const CACHE_SECONDS = 15;

// Only these read-only Kalshi paths are allowed through.
const ALLOWED = [/^\/exchange\/status$/, /^\/series(\/[^/]+)?$/, /^\/events(\/[^/]+)?$/,
  /^\/markets(\/[^/]+)?$/, /^\/markets\/[^/]+\/orderbook$/,
  /^\/series\/[^/]+\/markets\/[^/]+\/candlesticks$/];

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "accept",
};

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    if (request.method !== "GET") return new Response("Read-only relay", { status: 405, headers: CORS });

    const url = new URL(request.url);
    if (!ALLOWED.some((re) => re.test(url.pathname))) {
      return new Response("Not an allowed Kalshi path", { status: 404, headers: CORS });
    }

    const cache = caches.default;
    const cacheKey = new Request(url.toString(), { method: "GET" });
    const hit = await cache.match(cacheKey);
    if (hit) return hit;

    const upstream = await fetch(KALSHI + url.pathname + url.search, {
      headers: { accept: "application/json" },
    });
    const body = await upstream.text();
    const response = new Response(body, {
      status: upstream.status,
      headers: {
        ...CORS,
        "Content-Type": "application/json",
        "Cache-Control": `public, max-age=${CACHE_SECONDS}`,
      },
    });
    if (upstream.ok) ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  },
};

// Election Tracker relay — Cloudflare Worker
// Passes read-only GET requests through to Kalshi's public market-data API
// and adds the headers a web page needs to read the response.
// - Prices are cached at the edge for 15 seconds so many refreshes don't hammer Kalshi.
// - Slow-changing lists (series, events) are cached for 10 minutes.
// - When Kalshi answers "429 too many requests", the relay waits and retries.

const KALSHI = "https://api.elections.kalshi.com/trade-api/v2";
const PRICE_CACHE_SECONDS = 15;
const LIST_CACHE_SECONDS = 600;
const RETRIES = 4;

// Only these read-only Kalshi paths are allowed through.
const ALLOWED = [/^\/exchange\/status$/, /^\/series(\/[^/]+)?$/, /^\/events(\/[^/]+)?$/,
  /^\/markets(\/[^/]+)?$/, /^\/markets\/[^/]+\/orderbook$/,
  /^\/series\/[^/]+\/markets\/[^/]+\/candlesticks$/];

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "accept",
  "Access-Control-Expose-Headers": "x-relay-attempts, x-relay-cache",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cacheSecondsFor(url) {
  // Series lists and event lists without nested prices change slowly.
  if (url.pathname.startsWith("/series") && !url.pathname.includes("candlesticks")) return LIST_CACHE_SECONDS;
  if (url.pathname.startsWith("/events") && url.searchParams.get("with_nested_markets") !== "true") return LIST_CACHE_SECONDS;
  return PRICE_CACHE_SECONDS;
}

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
    if (hit) {
      const h = new Response(hit.body, hit);
      h.headers.set("x-relay-cache", "hit");
      return h;
    }

    let upstream, attempts = 0;
    for (;;) {
      attempts++;
      try {
        upstream = await fetch(KALSHI + url.pathname + url.search, {
          headers: { accept: "application/json", "user-agent": "election-tracker-relay/1.0" },
        });
      } catch (e) {
        upstream = new Response(JSON.stringify({ error: "relay could not reach Kalshi" }), { status: 502 });
      }
      if ((upstream.status !== 429 && upstream.status < 500) || attempts >= RETRIES) break;
      const retryAfter = Number(upstream.headers.get("retry-after"));
      await sleep(retryAfter > 0 ? Math.min(retryAfter * 1000, 4000) : 400 * 2 ** (attempts - 1) + Math.random() * 300);
    }

    const body = await upstream.text();
    const seconds = cacheSecondsFor(url);
    const response = new Response(body, {
      status: upstream.status,
      headers: {
        ...CORS,
        "Content-Type": "application/json",
        "Cache-Control": `public, max-age=${seconds}`,
        "x-relay-attempts": String(attempts),
        "x-relay-cache": "miss",
      },
    });
    if (upstream.ok) ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  },
};

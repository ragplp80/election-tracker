// Election Tracker relay — Vercel serverless function.
// GET /api/kalshi?path=/events?series_ticker=SENATETX&with_nested_markets=true
// Passes read-only requests to Kalshi's public market-data API.
// Vercel's edge caches each answer briefly so constant refreshing stays light.

const KALSHI = "https://api.elections.kalshi.com/trade-api/v2";
const ALLOWED = [/^\/exchange\/status$/, /^\/series(\/[^/]+)?$/, /^\/events(\/[^/]+)?$/,
  /^\/markets(\/[^/]+)?$/, /^\/markets\/[^/]+\/orderbook$/,
  /^\/series\/[^/]+\/markets\/[^/]+\/candlesticks$/];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Expose-Headers", "x-relay-attempts");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).send("Read-only relay");

  const raw = String(req.query.path || "");
  const pathname = raw.split("?")[0];
  if (!raw.startsWith("/") || !ALLOWED.some((re) => re.test(pathname))) {
    return res.status(404).send("Not an allowed Kalshi path");
  }

  const slow = (pathname.startsWith("/series") && !pathname.includes("candlesticks")) ||
    (pathname.startsWith("/events") && !raw.includes("with_nested_markets=true"));

  let upstream, attempts = 0;
  for (;;) {
    attempts++;
    try {
      upstream = await fetch(KALSHI + raw, { headers: { accept: "application/json" } });
    } catch (e) {
      upstream = null;
    }
    if ((upstream && upstream.status !== 429 && upstream.status < 500) || attempts >= 4) break;
    await sleep(400 * 2 ** (attempts - 1) + Math.random() * 300);
  }
  if (!upstream) return res.status(502).json({ error: "relay could not reach Kalshi" });

  const body = await upstream.text();
  res.setHeader("Content-Type", "application/json");
  res.setHeader("x-relay-attempts", String(attempts));
  const history = pathname.includes("candlesticks");
  if (upstream.ok) {
    res.setHeader("Cache-Control", slow
      ? "public, s-maxage=600, stale-while-revalidate=600"
      : history
        ? "public, s-maxage=60, stale-while-revalidate=60"   // past prices don't change; share across viewers
        : "public, s-maxage=15, stale-while-revalidate=15");
  } else {
    res.setHeader("Cache-Control", "no-store");
  }
  return res.status(upstream.status).send(body);
};

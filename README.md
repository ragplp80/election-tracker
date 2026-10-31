# Live Odds Tracker

Live prediction-market odds for the 2026 Senate, governor and House races.

- `index.html` — the page. `core.js` — race rules shared by the page and the server.
- `api/snapshot.js` — every race with current prices in one response, shared for 15 seconds.
- `api/catalog.js` — the list of 2026 races, rebuilt about hourly in the background.
- `api/kalshi.js` — read-only relay used for price history and as a fallback.

## Tests

```
cd tests && npm install && npm test
```

Tests run the real page and server code against a fake Kalshi. They also run on GitHub on every push.

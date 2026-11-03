// Shared trend history, built from the server's own price checks. Every time the snapshot is
// rebuilt (every 15 seconds while anyone is watching, and every few minutes from the keep-warm
// job), each race's current value is recorded, at most once a minute. Pages load this in one
// request instead of looking up hundreds of price histories themselves.
//
// Stored compactly: the times the server checked (samples), and for each race only the moments
// its value changed. Every check from the last 3 hours is kept, one per hour back to 72 hours.
const Core = require("../core.js");
const { runtimeCache } = require("./_lib.js");

const KEY = "trends-v1", FULL_MS = 3 * 3600e3, KEEP_MS = 72 * 3600e3;
let mem = null, saving = Promise.resolve();

async function load() {
  if (mem) return mem;
  try { mem = (await runtimeCache()?.get(KEY)) || null; } catch (e) {}
  return (mem = mem || { samples: [], series: {} });
}
const valueOf = (ev) => { const o = Core.raceOdds(ev); return o ? (o.d ?? o.outs[0].p) : null; };

function trim(store, now) {
  const keep = [], hours = new Set();
  for (const t of store.samples) {
    if (t < now - KEEP_MS) continue;
    if (t >= now - FULL_MS) { keep.push(t); continue; }
    const h = Math.floor(t / 3600e3);
    if (!hours.has(h)) { hours.add(h); keep.push(t); }
  }
  store.samples = keep;
  const from = keep[0] ?? now;
  for (const [id, pts] of Object.entries(store.series)) {
    // Keep the last change before the oldest sample, so the value then is still known
    let i = 0;
    while (i + 1 < pts.length && pts[i + 1][0] <= from) i++;
    store.series[id] = pts.slice(i);
  }
}

// races: [{ev}] from a fresh snapshot
async function record(races, now = Date.now()) {
  const store = await load();
  const t = Math.floor(now / 60e3) * 60e3;
  if (store.samples.length && store.samples[store.samples.length - 1] >= t) return false;   // already have this minute
  store.samples.push(t);
  for (const { ev } of races) {
    const v = valueOf(ev);
    if (v == null) continue;
    const v4 = Math.round(v * 1e4), pts = (store.series[ev.event_ticker] = store.series[ev.event_ticker] || []);
    if (!pts.length || pts[pts.length - 1][1] !== v4) pts.push([t, v4]);
  }
  trim(store, now);
  // Save before returning: the page reads it from a different function, through the shared cache
  saving = saving.then(() => runtimeCache()?.set(KEY, store, { ttl: 7 * 86400, name: "trends" })).catch(() => {});
  await saving;
  return true;
}
// The reader runs in another function, so fetch the shared copy rather than trusting memory
async function read() {
  try { const v = await runtimeCache()?.get(KEY); if (v) mem = v; } catch (e) {}
  return load();
}
function reset() { mem = null; }

module.exports = { record, read, reset };

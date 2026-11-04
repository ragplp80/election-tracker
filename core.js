// Shared by the page (window.Core) and the server functions (require("../core.js")).
// How Kalshi market series map to races, and which events belong to the 2026 election.
(function (root) {
  "use strict";

  const STATES = {AL:"Alabama",AK:"Alaska",AZ:"Arizona",AR:"Arkansas",CA:"California",CO:"Colorado",CT:"Connecticut",DE:"Delaware",FL:"Florida",GA:"Georgia",HI:"Hawaii",ID:"Idaho",IL:"Illinois",IN:"Indiana",IA:"Iowa",KS:"Kansas",KY:"Kentucky",LA:"Louisiana",ME:"Maine",MD:"Maryland",MA:"Massachusetts",MI:"Michigan",MN:"Minnesota",MS:"Mississippi",MO:"Missouri",MT:"Montana",NE:"Nebraska",NV:"Nevada",NH:"New Hampshire",NJ:"New Jersey",NM:"New Mexico",NY:"New York",NC:"North Carolina",ND:"North Dakota",OH:"Ohio",OK:"Oklahoma",OR:"Oregon",PA:"Pennsylvania",RI:"Rhode Island",SC:"South Carolina",SD:"South Dakota",TN:"Tennessee",TX:"Texas",UT:"Utah",VT:"Vermont",VA:"Virginia",WA:"Washington",WV:"West Virginia",WI:"Wisconsin",WY:"Wyoming"};

  // Every seat on the ballot in 2026. Markets are matched to these; a market that doesn't match a
  // seat (a 2028 race, a district number that doesn't exist) is ignored, and seats with no market
  // are simply left out of refreshes.
  const SEATS2026 = {
    senate: ["AL","AK","AR","CO","DE","FL","GA","ID","IL","IA","KS","KY","LA","ME","MA","MI","MN","MS","MT","NE","NH","NJ","NM","NC","OH","OK","OR","RI","SC","SD","TN","TX","VA","WV","WY"],
    gov: ["AL","AK","AZ","AR","CA","CO","CT","FL","GA","HI","ID","IL","IA","KS","ME","MD","MA","MI","MN","NE","NV","NH","NM","NY","OH","OK","OR","PA","RI","SC","SD","TN","TX","VT","WI","WY"],
    // House seats per state (2020 apportionment); one-seat states are district 0 ("at large")
    house: {AL:7,AK:1,AZ:9,AR:4,CA:52,CO:8,CT:5,DE:1,FL:28,GA:14,HI:2,ID:2,IL:17,IN:9,IA:4,KS:4,KY:6,LA:6,ME:2,MD:8,MA:9,MI:13,MN:8,MS:4,MO:8,MT:2,NE:3,NV:4,NH:2,NJ:12,NM:3,NY:26,NC:14,ND:1,OH:15,OK:5,OR:6,PA:17,RI:2,SC:7,SD:1,TN:9,TX:38,UT:4,VT:1,VA:11,WA:10,WV:2,WI:8,WY:1},
  };

  // Kalshi series naming: SENATETX, KXSENATETX, GOVPARTYAZ, HOUSEPA7, HOUSEAKAL, KXHOUSENC11, CONTROLS/CONTROLH.
  // pref: when a race has two series, the higher one wins (party-style series beat person-style ones).
  function classify(t) {
    let m;
    if (t === "CONTROLS") return { type: "ctlS" };
    if (t === "CONTROLH") return { type: "ctlH" };
    if (t === "KXDHOUSESEATS") return { type: "seats" };
    // One series holding many districts (events KXHOUSERACE-NC03-26, -KS03-26, ...): see eventMeta
    if (t === "KXHOUSERACE") return { type: "houseMulti", pref: 1.5 };
    if ((m = t.match(/^SENATE([A-Z]{2})(S?)$/)) && STATES[m[1]]) return { type: "senate", st: m[1], special: !!m[2], pref: 2 };
    if ((m = t.match(/^KXSENATE([A-Z]{2})$/)) && STATES[m[1]]) return { type: "senate", st: m[1], special: false, pref: 1 };
    if ((m = t.match(/^GOVPARTY-?([A-Z]{2})$/)) && STATES[m[1]]) return { type: "gov", st: m[1], pref: 2 };
    if ((m = t.match(/^KXGOVPARTY([A-Z]{2})$/)) && STATES[m[1]]) return { type: "gov", st: m[1], pref: 1 };
    if ((m = t.match(/^HOUSE([A-Z]{2})(\d{1,2})(S?)$/)) && STATES[m[1]]) return { type: "house", st: m[1], dist: +m[2], special: !!m[3], pref: 2 };
    if ((m = t.match(/^HOUSE([A-Z]{2})AL$/)) && STATES[m[1]]) return { type: "house", st: m[1], dist: 0, pref: 2 };
    if ((m = t.match(/^HOUSEPARTY-([A-Z]{2})(\d{1,2})$/)) && STATES[m[1]]) return { type: "house", st: m[1], dist: +m[2], pref: 2 };
    if ((m = t.match(/^KXHOUSE([A-Z]{2})(\d{1,2})$/)) && STATES[m[1]]) return { type: "house", st: m[1], dist: +m[2], pref: 1 };
    // "Person" markets name candidates rather than parties. Backups only (pref 0): used when a race
    // has no open party market, e.g. a California top-two race between two members of one party.
    if ((m = t.match(/^KX([A-Z]{2})SENATE(?:PERSON)?$/)) && STATES[m[1]]) return { type: "senate", st: m[1], special: false, pref: 0 };
    if ((m = t.match(/^KXGOV([A-Z]{2})$/)) && STATES[m[1]]) return { type: "gov", st: m[1], pref: 0 };
    if ((m = t.match(/^KX([A-Z]{2})(\d{1,2})PERSON$/)) && STATES[m[1]]) return { type: "house", st: m[1], dist: +m[2], pref: 0 };
    if (t === "KXALASKAHOUSE") return { type: "house", st: "AK", dist: 0, pref: 0 };
    return null;
  }

  // The race an event belongs to. Usually the series says it; for a multi-district series the
  // district comes from the event ticker (KXHOUSERACE-NC03-26 -> NC-3). Null if it can't be read.
  function eventMeta(meta, ev) {
    if (meta.type !== "houseMulti") return meta;
    const m = String(ev.event_ticker || "").match(/-([A-Z]{2})(\d{1,2}|AL)-26$/);
    if (!m || !STATES[m[1]]) return null;
    return { series: meta.series, type: "house", st: m[1], dist: m[2] === "AL" ? 0 : +m[2], special: false, pref: meta.pref, multi: true };
  }

  // The seat a market is for: senate-TX, gov-AZ, house-PA-7, house-AK-0, or ctlS / ctlH / seats.
  // (No state has two Senate seats up in 2026, so Ohio's and Florida's specials are just senate-OH/FL.)
  function seatKey(c) {
    if (c.type === "ctlS" || c.type === "ctlH" || c.type === "seats" || c.type === "houseMulti") return c.type;
    if (c.type === "house") return `house-${c.st}-${c.dist || 0}`;
    return `${c.type}-${c.st}`;
  }
  const seriesKey = seatKey;   // older name, same thing
  function isSeat(c) {
    if (c.type === "ctlS" || c.type === "ctlH" || c.type === "seats" || c.type === "houseMulti") return true;
    if (c.type === "senate") return SEATS2026.senate.includes(c.st);
    if (c.type === "gov") return SEATS2026.gov.includes(c.st);
    if (c.type === "house") { const n = SEATS2026.house[c.st]; return n === 1 ? (c.dist || 0) === 0 : c.dist >= 1 && c.dist <= n; }
    return false;
  }
  // Total contracts traded on an event, used to pick the busiest market when several match a seat
  function eventVolume(ev) {
    return (ev.markets || []).reduce((s, m) => s + (parseFloat(m.volume_fp) || parseFloat(m.volume_24h_fp) || 0), 0);
  }

  // Only this year's races. Kalshi names 2026 state races like SENATETX-26, control markets like
  // CONTROLS-2026, and the House seat count after the 120th Congress (KXDHOUSESEATS-27).
  // Off-year races (e.g. Kentucky governor, 2027) are also listed, so they are filtered out here.
  const GOV_YEAR = { KS: "27", NH: "28" };
  function is2026(meta, ev) {
    const t = ev.event_ticker || "";
    if (meta.type === "ctlS" || meta.type === "ctlH") return /-2026\b/.test(t);
    if (meta.type === "seats") return /-27$/.test(t);
    // A few 2026 governor races are named for another year: Kansas by inauguration (GOVPARTYKS-27)
    // and New Hampshire by the end of the two-year term (GOVPARTYNH-28). Kentucky's -27 really is 2027.
    if (meta.type === "gov" && GOV_YEAR[meta.st] && new RegExp(`-${GOV_YEAR[meta.st]}\\b`).test(t)) return true;
    return /-26(\b|[A-Z])/.test(t);
  }

  // Only the market fields the page uses, to keep responses and saved copies small.
  const MARKET_FIELDS = ["ticker", "event_ticker", "yes_sub_title", "subtitle", "status", "result", "yes_bid_dollars", "yes_ask_dollars",
    "last_price_dollars", "previous_price_dollars", "volume_24h_fp", "volume_fp", "floor_strike", "cap_strike"];
  function slimMarket(m) {
    const o = {};
    for (const k of MARKET_FIELDS) if (m[k] != null && m[k] !== "") o[k] = m[k];
    return o;
  }
  function slimEvent(ev) {
    return { event_ticker: ev.event_ticker, markets: (ev.markets || []).map(slimMarket) };
  }

  // Series that mention a Senate, House or governor race but aren't recognized above. Side bets
  // (nominees, margins, combos, turnout...) and foreign or state-legislature races are left out.
  // Used by the coverage check, so a new market format gets noticed instead of silently missed.
  const SIDE_BET = /nomin|primary|margin|\bmov\b|combo|turnout|exit poll|seats|leader|speaker|redistrict|recount|endorse|run\b|closest|closer|within|sweep|state senate|state house|delegates|council|lieutenant|outright|advance|round|place|matchup|count|lose|losing|majority|control|popular|vote|caucus|minority|chair|referendum|ap call|drop out|ballot|outperform|exact outcome|split|opposite|reddest|independent|seek re-election|special election/i;
  const FOREIGN = /japan|brazil|chile|argentin|australia|philippine|nigeria|kenya|ital|czech|thailand|nepal|jamaica|colombia|bolivia|paraguay|dominican|peru|hondura|guatemala|zealand|mexic|spain|quebec|são paulo|santa catarina|governorship|state governor/i;
  function untrackedRace(ticker, title) {
    if (classify(ticker)) return false;
    const text = `${ticker} ${title || ""}`;
    if (!/senate|house|governor|\bgov/i.test(text)) return false;
    if (/^SENATEPARTY/.test(ticker)) return false;   // the 2024 cycle's series
    if (/^[A-Z]{3,4}$/.test(title || "") || title === ticker) return false;   // primary series titled "ILD", "MNR"...
    return !SIDE_BET.test(title || "") && !FOREIGN.test(title || "");
  }

  // ---------- Odds from an event's markets (shared by the main page and How We Looking) ----------
  const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
  // Kalshi tags parties several ways: SENATETX-26-D, KXHOUSENC11-26-DEM / -GOP, or only in the label.
  function partyOf(m) {
    const suf = (m.ticker || "").split("-").pop().toUpperCase();
    const lab = `${m.yes_sub_title || ""} ${m.subtitle || ""}`;
    if (["D", "DEM", "DEMS"].includes(suf) || /democrat/i.test(lab)) return "D";
    if (["R", "REP", "GOP"].includes(suf) || /republican/i.test(lab)) return "R";
    if (["I", "IND"].includes(suf) || /independent/i.test(lab)) return "I";
    return "X";
  }
  // Midpoint when the spread is tight, otherwise the last trade. prev: yesterday's price.
  function priceOf(m, prev) {
    if (prev) return num(m.previous_price_dollars);
    if (m.result === "yes") return 1;
    if (m.result === "no") return 0;
    const bid = num(m.yes_bid_dollars), ask = num(m.yes_ask_dollars), last = num(m.last_price_dollars);
    if (bid && ask && ask - bid <= 0.1) return (bid + ask) / 2;
    return last ?? bid ?? ask;
  }
  function dProbOf(outs, key) {
    const d = outs.find((o) => o.party === "D"), r = outs.find((o) => o.party === "R");
    const pd = d?.[key], pr = r?.[key];
    if (pd != null && pr != null && pd + pr > 0) return pd / (pd + pr);
    if (pd != null) return pd; if (pr != null) return 1 - pr;
    return null;
  }
  // Outcomes sorted by chance, whether it's a three-way race, and the tracked number d: the
  // Democrat's chance, or in a three-way race (a strong independent, 5%+, e.g. Dan Osborn in
  // Nebraska) the chance the Republican loses, out of all candidates.
  function raceOdds(ev) {
    // Called races stay: a settled or decided market counts as 100% (won) or 0% (lost)
    const outs = (ev.markets || []).map((m) => ({
      ticker: m.ticker, party: partyOf(m),
      name: (m.yes_sub_title || m.subtitle || m.ticker).replace(/ Party$/, ""),
      p: priceOf(m), p24: priceOf(m, true), vol24: num(m.volume_24h_fp) ?? 0, vol: num(m.volume_fp) ?? 0,
    })).filter((o) => o.p != null);
    if (!outs.length) return null;
    outs.sort((a, b) => b.p - a.p);
    const multi = outs.some((o) => (o.party === "I" || o.party === "X") && o.p >= 0.05) && outs.some((o) => o.party === "R");
    const notR = (key) => { const tot = outs.reduce((s, o) => s + (o[key] ?? 0), 0), r = outs.find((o) => o.party === "R")?.[key]; return tot > 0 && r != null ? 1 - r / tot : null; };
    return { outs, multi, d: multi ? notR("p") : dProbOf(outs, "p"), d24: multi ? notR("p24") : dProbOf(outs, "p24") };
  }

  // Who held each seat before this election
  const HELD_SEN = {AL:"R",AK:"R",AR:"R",CO:"D",DE:"D",FL:"R",GA:"D",ID:"R",IL:"D",IA:"R",KS:"R",KY:"R",LA:"R",ME:"R",MA:"D",MI:"D",MN:"D",MS:"R",MT:"R",NE:"R",NH:"D",NJ:"D",NM:"D",NC:"R",OH:"R",OK:"R",OR:"D",RI:"D",SC:"R",SD:"R",TN:"R",TX:"R",VA:"D",WV:"R",WY:"R"};
  const HELD_GOV = {AL:"R",AK:"R",AZ:"D",AR:"R",CA:"D",CO:"D",CT:"D",FL:"R",GA:"R",HI:"D",ID:"R",IL:"D",IA:"R",KS:"D",ME:"D",MD:"D",MA:"D",MI:"D",MN:"D",NE:"R",NV:"R",NH:"R",NM:"D",NY:"D",OH:"R",OK:"R",OR:"D",PA:"D",RI:"D",SC:"R",SD:"R",TN:"R",TX:"R",VT:"R",WI:"D",WY:"R"};

  // House seat-count market (KXDHOUSESEATS): buckets like "238-241" with their chances
  function parseSeatMarket(j) {
    const ev = (j.events || []).find((e) => /-27$/.test(e.event_ticker)) || (j.events || [])[0];
    if (!ev) return null;
    const buckets = [];
    for (const m of ev.markets || []) {
      const lab = m.yes_sub_title || m.subtitle || "";
      let lo = null, hi = null, x;
      if ((x = lab.match(/(\d{3})\s*[-–]\s*(\d{3})/))) { lo = +x[1]; hi = +x[2]; }
      else if ((x = lab.match(/(below|under|fewer than|less than)\s*(\d{3})/i))) { hi = +x[2] - 1; lo = hi - 3; }
      else if ((x = lab.match(/(above|over|more than)\s*(\d{3})/i))) { lo = +x[2] + 1; hi = lo + 3; }
      else if ((x = lab.match(/(\d{3})\s*\+|(\d{3}) or more/i))) { lo = +(x[1] || x[2]); hi = lo + 3; }
      else if (num(m.floor_strike) != null || num(m.cap_strike) != null) { lo = num(m.floor_strike) ?? num(m.cap_strike) - 3; hi = num(m.cap_strike) ?? lo + 3; }
      const p = priceOf(m);
      if (lo == null || p == null) continue;
      buckets.push({ lo, hi, mid: (lo + hi) / 2, p, label: lab, ticker: m.ticker });
    }
    if (buckets.length < 3) return null;
    buckets.sort((a, b) => a.mid - b.mid);
    return { buckets, id: ev.event_ticker };
  }
  // Expected seats, the middle, the 10th-90th percentile range, and the chance of a majority (218+)
  function seatStats(hs) {
    const tot = hs.buckets.reduce((s, b) => s + b.p, 0); if (!tot) return null;
    const ps = hs.buckets.map((b) => ({ ...b, q: b.p / tot }));
    const mean = ps.reduce((s, b) => s + b.mid * b.q, 0);
    const pct = (t) => { let c = 0; for (const b of ps) { if (c + b.q >= t) { const f = (t - c) / b.q; return b.lo + f * (b.hi - b.lo + 1); } c += b.q; } return ps[ps.length - 1].hi; };
    const pMaj = ps.reduce((s, b) => s + (b.mid >= 218 ? b.q : 0), 0);
    return { mean, median: pct(0.5), p10: pct(0.1), p90: pct(0.9), pMaj };
  }

  const Core = { STATES, SEATS2026, classify, eventMeta, seatKey, seriesKey, isSeat, eventVolume, is2026, slimMarket, slimEvent, untrackedRace,
    partyOf, priceOf, dProbOf, raceOdds, parseSeatMarket, seatStats, HELD_SEN, HELD_GOV };
  if (typeof module === "object" && module.exports) module.exports = Core;
  else root.Core = Core;
})(typeof window !== "undefined" ? window : globalThis);

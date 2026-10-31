// Shared by the page (window.Core) and the server functions (require("../core.js")).
// How Kalshi market series map to races, and which events belong to the 2026 election.
(function (root) {
  "use strict";

  const STATES = {AL:"Alabama",AK:"Alaska",AZ:"Arizona",AR:"Arkansas",CA:"California",CO:"Colorado",CT:"Connecticut",DE:"Delaware",FL:"Florida",GA:"Georgia",HI:"Hawaii",ID:"Idaho",IL:"Illinois",IN:"Indiana",IA:"Iowa",KS:"Kansas",KY:"Kentucky",LA:"Louisiana",ME:"Maine",MD:"Maryland",MA:"Massachusetts",MI:"Michigan",MN:"Minnesota",MS:"Mississippi",MO:"Missouri",MT:"Montana",NE:"Nebraska",NV:"Nevada",NH:"New Hampshire",NJ:"New Jersey",NM:"New Mexico",NY:"New York",NC:"North Carolina",ND:"North Dakota",OH:"Ohio",OK:"Oklahoma",OR:"Oregon",PA:"Pennsylvania",RI:"Rhode Island",SC:"South Carolina",SD:"South Dakota",TN:"Tennessee",TX:"Texas",UT:"Utah",VT:"Vermont",VA:"Virginia",WA:"Washington",WV:"West Virginia",WI:"Wisconsin",WY:"Wyoming"};

  // Kalshi series naming: SENATETX, KXSENATETX, GOVPARTYAZ, HOUSEPA7, HOUSEAKAL, KXHOUSENC11, CONTROLS/CONTROLH.
  // pref: when a race has two series, the higher one wins (party-style series beat person-style ones).
  function classify(t) {
    let m;
    if (t === "CONTROLS") return { type: "ctlS" };
    if (t === "CONTROLH") return { type: "ctlH" };
    if (t === "KXDHOUSESEATS") return { type: "seats" };
    if ((m = t.match(/^SENATE([A-Z]{2})(S?)$/)) && STATES[m[1]]) return { type: "senate", st: m[1], special: !!m[2], pref: 2 };
    if ((m = t.match(/^KXSENATE([A-Z]{2})$/)) && STATES[m[1]]) return { type: "senate", st: m[1], special: false, pref: 1 };
    if ((m = t.match(/^GOVPARTY-?([A-Z]{2})$/)) && STATES[m[1]]) return { type: "gov", st: m[1], pref: 2 };
    if ((m = t.match(/^KXGOVPARTY([A-Z]{2})$/)) && STATES[m[1]]) return { type: "gov", st: m[1], pref: 1 };
    if ((m = t.match(/^HOUSE([A-Z]{2})(\d{1,2})(S?)$/)) && STATES[m[1]]) return { type: "house", st: m[1], dist: +m[2], special: !!m[3], pref: 2 };
    if ((m = t.match(/^HOUSE([A-Z]{2})AL$/)) && STATES[m[1]]) return { type: "house", st: m[1], dist: 0, pref: 2 };
    if ((m = t.match(/^HOUSEPARTY-([A-Z]{2})(\d{1,2})$/)) && STATES[m[1]]) return { type: "house", st: m[1], dist: +m[2], pref: 2 };
    if ((m = t.match(/^KXHOUSE([A-Z]{2})(\d{1,2})$/)) && STATES[m[1]]) return { type: "house", st: m[1], dist: +m[2], pref: 1 };
    return null;
  }

  // One key per race, used to pick a single series when Kalshi lists several for the same race.
  function seriesKey(c) {
    if (c.type === "ctlS" || c.type === "ctlH" || c.type === "seats") return c.type;
    return `${c.type}-${c.st}-${c.dist ?? ""}-${c.special ? "s" : ""}`;
  }

  // Only this year's races. Kalshi names 2026 state races like SENATETX-26, control markets like
  // CONTROLS-2026, and the House seat count after the 120th Congress (KXDHOUSESEATS-27).
  // Off-year races (e.g. Kentucky governor, 2027) are also listed, so they are filtered out here.
  function is2026(meta, ev) {
    const t = ev.event_ticker || "";
    if (meta.type === "ctlS" || meta.type === "ctlH") return /-2026\b/.test(t);
    if (meta.type === "seats") return /-27$/.test(t);
    return /-26(\b|[A-Z])/.test(t);
  }

  // Only the market fields the page uses, to keep responses and saved copies small.
  const MARKET_FIELDS = ["ticker", "event_ticker", "yes_sub_title", "subtitle", "status", "yes_bid_dollars", "yes_ask_dollars",
    "last_price_dollars", "previous_price_dollars", "volume_24h_fp", "volume_fp", "floor_strike", "cap_strike"];
  function slimMarket(m) {
    const o = {};
    for (const k of MARKET_FIELDS) if (m[k] != null && m[k] !== "") o[k] = m[k];
    return o;
  }
  function slimEvent(ev) {
    return { event_ticker: ev.event_ticker, markets: (ev.markets || []).map(slimMarket) };
  }

  const Core = { STATES, classify, seriesKey, is2026, slimMarket, slimEvent };
  if (typeof module === "object" && module.exports) module.exports = Core;
  else root.Core = Core;
})(typeof window !== "undefined" ? window : globalThis);

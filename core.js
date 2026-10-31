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

  const Core = { STATES, classify, eventMeta, seriesKey, is2026, slimMarket, slimEvent, untrackedRace };
  if (typeof module === "object" && module.exports) module.exports = Core;
  else root.Core = Core;
})(typeof window !== "undefined" ? window : globalThis);

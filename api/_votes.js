// Vote counts for the last uncalled races, read from each state's own published results, and a
// running record of every "vote drop" (each time a race's totals change). For the races where the
// states publish it, also an estimate of the ballots still to count and what they'd do to the margin.
//
// Each state publishes differently, so each has a small reader that turns its file into the same
// shape: { cands: [{ name, party, votes }], total, reporting, asOf, url }.
const { runtimeCache } = require("./_lib.js");

const ELECTION = { nc: "20261103", wa: "20261103" };

// The races to follow. src: which state reader; null = no free feed the server can read (yet).
const RACES = [
  { key: "house-NC-3", label: "NC-3", state: "NC", src: "nc", contest: /^US HOUSE OF REPRESENTATIVES DISTRICT 03\b/i,
    site: "https://er.ncsbe.gov/?election_dt=11/03/2026",
    // State Board county numbers (alphabetical) of the counties the district touches
    counties: { 31: "Duplin", 40: "Greene", 52: "Jones", 54: "Lenoir", 67: "Onslow", 74: "Pitt", 82: "Sampson", 96: "Wayne", 98: "Wilson" } },
  { key: "house-CA-23", label: "CA-23", state: "CA", src: "ca", path: "us-rep/district/23",
    site: "https://electionresults.sos.ca.gov/returns/us-rep/district/23",
    // The county that publishes its uncounted ballots, and the district's other counties (SoS slugs)
    leftCounty: { slug: "san-bernardino", name: "San Bernardino", page: "https://elections.sbcounty.gov/elections/2026/1103/" },
    otherCounties: { riverside: "Riverside", "los-angeles": "Los Angeles", kern: "Kern" } },
  { key: "house-WA-5", label: "WA-5", state: "WA", src: "wa", contest: /^Congressional District 5 - /i,
    site: "https://results.votewa.gov/results/public/washington" },
  { key: "house-AZ-2", label: "AZ-2", state: "AZ", src: null, why: "Arizona's results site blocks automated readers",
    site: "https://results.arizona.vote/" },
  { key: "house-AZ-5", label: "AZ-5", state: "AZ", src: null, why: "Arizona's results site blocks automated readers",
    site: "https://results.arizona.vote/" },
  { key: "house-AZ-8", label: "AZ-8", state: "AZ", src: null, why: "Arizona's results site blocks automated readers",
    site: "https://results.arizona.vote/" },
  { key: "house-AK-0", label: "AK-AL", state: "AK", src: null, why: "Alaska posts results as PDFs; ranked-choice count starts Nov. 18",
    site: "https://www.elections.alaska.gov/election-results/" },
  { key: "senate-AK", label: "Alaska Senate", state: "AK", src: null, why: "Alaska posts results as PDFs; ranked-choice count starts Nov. 18",
    site: "https://www.elections.alaska.gov/election-results/" },
];

const num = (v) => { const n = parseFloat(String(v ?? "").replace(/,/g, "")); return Number.isFinite(n) ? n : 0; };
const partyOf = (s) => { const t = String(s || "").toUpperCase(); return /DEM/.test(t) ? "D" : /REP/.test(t) ? "R" : t ? "O" : ""; };
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
async function getText(url) {
  const r = await fetch(url, { headers: { "user-agent": UA, accept: "*/*" } });
  if (!r.ok) throw new Error(`${new URL(url).hostname} answered ${r.status}`);
  return r.text();
}
async function getBytes(url) {
  const r = await fetch(url, { headers: { "user-agent": UA, accept: "*/*" } });
  if (!r.ok) throw new Error(`${new URL(url).hostname} answered ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}
// The text of a PDF (replaced in tests)
async function pdfText(buf) {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const { text } = await extractText(await getDocumentProxy(new Uint8Array(buf)), { mergePages: true });
  return text;
}

// North Carolina: one file with every contest, one line per candidate (cnm contest, bnm name,
// pty party, vct votes, prt/ptl precincts reporting/total)
const ncFile = (county) => `https://er.ncsbe.gov/enr/${ELECTION.nc}/data/results_${county}.txt`;
async function readNC(races) {
  const url = ncFile(0);
  const rows = JSON.parse(await getText(url));
  const out = {};
  for (const race of races) {
    const mine = rows.filter((r) => race.contest.test(r.cnm || ""));
    if (!mine.length) { out[race.key] = { error: "contest not found in the state's file" }; continue; }
    out[race.key] = {
      cands: mine.map((r) => ({ name: r.bnm, party: partyOf(r.pty), votes: num(r.vct) })),
      reporting: mine[0].ptl ? `${num(mine[0].prt)} of ${num(mine[0].ptl)} precincts` : "", asOf: null, url,
    };
  }
  return out;
}
// California: one small JSON per contest
async function readCA(races) {
  const out = {};
  await Promise.all(races.map(async (race) => {
    const url = `https://api.sos.ca.gov/returns/${race.path}`;
    try {
      const j = JSON.parse(await getText(url));
      out[race.key] = { cands: (j.candidates || []).map((c) => ({ name: c.Name, party: partyOf(c.Party), votes: num(c.Votes) })),
        reporting: String(j.Reporting || "").replace(/ precincts reporting$/i, " precincts"), asOf: j.ReportingTime || null, url };
    } catch (e) { out[race.key] = { error: String(e.message || e) }; }
  }));
  return out;
}
// Washington: every contest in one JSON (ballot items with ballot options and vote counts)
const WA_API = `https://results.votewa.gov/results/public/api/elections/washington/${ELECTION.wa}`;
const waName = (x) => (x && x[0] && x[0].text) || "";
async function readWA(races) {
  const url = `${WA_API}/ballot-items`;
  const items = JSON.parse(await getText(url)).data || [];
  const out = {};
  for (const race of races) {
    const it = items.find((x) => race.contest.test(waName(x.name)));
    if (!it) { out[race.key] = { error: "contest not found in the state's file" }; continue; }
    const rs = it.reportingStatus || {};
    out[race.key] = {
      cands: (it.summaryResults?.ballotOptions || []).filter((o) => !o.isWriteIn).map((o) => ({ name: waName(o.name), party: partyOf(o.party?.abbreviation), votes: num(o.voteCount) })),
      reporting: rs.totalUnits ? `${rs.reportingUnits} of ${rs.totalUnits} counties` : "", asOf: rs.asOf || null, url, itemId: it.id,
    };
  }
  return out;
}
const READERS = { nc: readNC, ca: readCA, wa: readWA };

// Each candidate's share of a county's votes: [[name, votes], ...] -> { name: share }
function splitOf(pairs) {
  const t = pairs.reduce((s, [, v]) => s + v, 0);
  return t > 0 ? Object.fromEntries(pairs.map(([k, v]) => [k, v / t])) : null;
}

// ---------- Ballots left to count ----------
// None of the states publish this by district, so each estimate takes the ballots left in each
// county the district touches and keeps the district's share of them: the district's votes in that
// county divided by all ballots counted there so far. Each returns
// { est, kind, parts: [{ name, left, share, est, asOf }], asOf, source, note }.

// Washington: the results file for one contest has, for every county, the ballots counted so far,
// the county's own estimate of ballots left, and the contest's votes there.
async function leftWA(race, cur) {
  if (!cur.itemId) throw new Error("no contest id");
  const source = `${WA_API}/data/ballot-item/${cur.itemId}`;
  const j = JSON.parse(await getText(source));
  const id = (s) => String(s || "").toLowerCase();
  const counted = Object.fromEntries((j.localityElections || []).map((l) => [id(l.jurisdictionId), num(l.ballotsCast)]));
  const stat = (j.statistics || []).find((s) => /left to count/i.test(waName(s.name)));
  const left = {};
  for (const g of stat?.groups || []) for (const c of g.children || []) left[id(c.id)] = { n: num(c.value), at: c.lastUpdated || null };
  const parts = (j.ballotItemWithBreakdown?.breakdownResults || []).map((b) => {
    const k = id(b.locality?.id), cast = counted[k], l = left[k];
    const share = cast > 0 ? Math.min(1, num(b.voteTotal) / cast) : 0;
    const split = splitOf((b.ballotOptions || []).filter((o) => !o.isWriteIn).map((o) => [waName(o.name), num(o.voteCount)]));
    return { name: waName(b.locality?.name).replace(/ County$/, ""), left: l ? l.n : null, share, est: l ? l.n * share : 0, asOf: l?.at || null, split };
  });
  if (!parts.length) throw new Error("no county breakdown");
  const known = parts.filter((p) => p.left != null);
  return { est: known.reduce((s, p) => s + p.est, 0), kind: "uncounted", parts,
    asOf: known.map((p) => p.asOf).filter(Boolean).sort().pop() || null, source,
    note: parts.length > known.length ? (parts.length - known.length === 1 ? "1 county hasn't posted an estimate" : `${parts.length - known.length} counties haven't posted an estimate`) : null };
}

// California: San Bernardino County (nearly all of CA-23) posts an unprocessed-ballots table on its
// election page. The district's other counties are estimated at San Bernardino's rate.
function parseSBTable(html) {
  const cell = (label) => {
    const m = html.match(new RegExp(label + "[^<]*</td>\\s*<td[^>]*>([^<]*)</td>", "i"));
    return m ? num(m[1]) : null;
  };
  const at = html.match(/unprocessed ballot reporting as of ([^<]+?)\s*</i);
  return { processed: cell("Cumulative total number of processed ballots"), left: cell("TOTAL ESTIMATED NUMBER OF UNPROCESSED BALLOTS"),
    cure: cell("Ballots left to cure"), asOf: at ? at[1].trim() : null };
}
async function leftCA(race) {
  const lc = race.leftCounty;
  const t = parseSBTable(await getText(lc.page));
  if (t.left == null || !t.processed) throw new Error(`couldn't read ${lc.name} County's table`);
  const countyVotes = async (slug) => {
    const j = JSON.parse(await getText(`https://api.sos.ca.gov/returns/${race.path}/county/${slug}`));
    const first = Array.isArray(j) ? j[0] : j;
    const pairs = (first?.candidates || []).map((c) => [c.Name, num(c.Votes)]);
    return { total: pairs.reduce((s, [, v]) => s + v, 0), split: splitOf(pairs) };
  };
  const main = await countyVotes(lc.slug);
  const share = Math.min(1, main.total / t.processed);
  const rate = t.left / t.processed;   // ballots left per ballot counted in San Bernardino
  const parts = [{ name: lc.name, left: t.left, share, est: t.left * share, asOf: t.asOf, split: main.split }];
  for (const [slug, name] of Object.entries(race.otherCounties || {})) {
    try { const v = await countyVotes(slug); parts.push({ name, left: null, share: null, est: v.total * rate, asOf: null, assumed: true, split: v.split }); }
    catch (e) { /* a county we can't read just isn't added */ }
  }
  return { est: parts.reduce((s, p) => s + p.est, 0), kind: "uncounted", parts, asOf: t.asOf, source: lc.page,
    cure: t.cure != null ? t.cure * share : null,
    note: `Other counties estimated at ${lc.name}'s rate` };
}

// North Carolina: every precinct is in and mail ballots were due on Election Day, so what's left is
// mostly provisional ballots. The State Board posts how many were cast in each county (a PDF); each
// county's share comes from its own results file (the district's votes there vs. the U.S. Senate race,
// which every voter in the county had on the ballot).
const NC_PROVISIONALS = "https://s3.amazonaws.com/dl.ncsbe.gov/Legal/Provisionals%20Cast%20Reports/2026_November_Provisionals_Cast_By_Voting_Method.pdf";
function parseNCProvisionals(text) {
  const out = {};
  // "PITT 1,002 114 0 0 1,116": county, then four counts and the total
  for (const m of String(text).matchAll(/([A-Z][A-Z .']*?)\s+([\d,]+)\s+([\d,]+)\s+([\d,]+)\s+([\d,]+)\s+([\d,]+)(?=\s|$)/g)) {
    out[m[1].trim().toUpperCase()] = num(m[6]);
  }
  return out;
}
async function leftNC(race) {
  const prov = parseNCProvisionals(await exportsRef.pdfText(await getBytes(NC_PROVISIONALS)));
  if (!Object.keys(prov).length) throw new Error("couldn't read the provisional ballot report");
  const parts = await Promise.all(Object.entries(race.counties).map(async ([id, name]) => {
    const left = prov[name.toUpperCase()];
    try {
      const rows = JSON.parse(await getText(ncFile(id)));
      const sum = (re) => rows.filter((r) => re.test(r.cnm || "")).reduce((s, r) => s + num(r.vct), 0);
      const district = sum(race.contest), county = sum(/^US SENATE\b/i);
      const split = splitOf(rows.filter((r) => race.contest.test(r.cnm || "")).map((r) => [r.bnm, num(r.vct)]));
      const share = county > 0 ? Math.min(1, district / county) : 0;
      return { name, left: left ?? null, share, est: (left || 0) * share, asOf: null, split };
    } catch (e) { return { name, left: left ?? null, share: null, est: 0, asOf: null, error: String(e.message || e) }; }
  }));
  const missed = parts.filter((p) => p.error).length;
  return { est: parts.reduce((s, p) => s + p.est, 0), kind: "provisional", parts, asOf: null, source: NC_PROVISIONALS,
    note: "Provisional ballots; each county decides at its canvass which ones count, and many won't"
      + (missed ? `. Couldn't read ${missed} of the ${parts.length} counties, so they're left out` : "") };
}
const LEFT = { nc: leftNC, ca: leftCA, wa: leftWA };

// The estimates change slowly (counties update them a few times a day), so they're kept for 5 minutes.
const LEFT_KEY = "votes-left-v2", LEFT_TTL = 5 * 60e3;
let leftMem = null;
async function ballotsLeft(results, now) {
  if (!leftMem) { try { leftMem = (await runtimeCache()?.get(LEFT_KEY)) || null; } catch (e) {} }
  const kept = (leftMem && leftMem.byKey) || {};
  const fresh = leftMem && now - leftMem.t < LEFT_TTL;
  if (fresh) return kept;
  const byKey = {};
  await Promise.all(RACES.filter((r) => r.src && LEFT[r.src]).map(async (r) => {
    const cur = results[r.key];
    if (!cur || cur.error) { if (kept[r.key]) byKey[r.key] = kept[r.key]; return; }
    try { byKey[r.key] = await LEFT[r.src](r, cur); }
    catch (e) { byKey[r.key] = kept[r.key] && !kept[r.key].error ? { ...kept[r.key], stale: true } : { error: String(e.message || e) }; }
  }));
  leftMem = { t: now, byKey };
  try { await runtimeCache()?.set(LEFT_KEY, leftMem, { ttl: 3600, name: "ballots left" }); } catch (e) {}
  return byKey;
}

// ---------- Projection ----------
// How the ballots left might split. Where we know each county's votes so far, each county's ballots
// split like that county has voted (where the ballots are matters more than anything else); the
// rest split like the district's votes so far.
function project(cands, left) {
  if (!cands || cands.length < 2 || !left || !(left.est > 0)) return null;
  const total = cands.reduce((s, c) => s + c.votes, 0);
  if (!total) return null;
  const whole = Object.fromEntries(cands.map((c) => [c.name, c.votes / total]));
  const final = Object.fromEntries(cands.map((c) => [c.name, c.votes]));
  let byCounty = 0;
  const parts = (left.parts || []).filter((p) => p.est > 0);
  const counted = parts.reduce((s, p) => s + p.est, 0);
  for (const p of parts) {
    const sp = p.split && cands.every((c) => p.split[c.name] != null) ? p.split : null;
    if (sp) byCounty += p.est;
    for (const c of cands) final[c.name] += p.est * (sp ? sp[c.name] : whole[c.name]);
  }
  for (const c of cands) final[c.name] += Math.max(0, left.est - counted) * whole[c.name];   // anything not in a county line
  const order = Object.keys(final).sort((a, b) => final[b] - final[a]);
  // What the candidate who is behind now needs from the ballots left (of the votes for the top two)
  const [a, b] = cands, margin = a.votes - b.votes;
  const pool = left.est * (a.votes + b.votes) / total;
  const needs = pool > 0 ? (pool + margin) / (2 * pool) : null;
  return { basis: byCounty >= left.est * 0.5 ? "county" : "so far", final, leader: order[0], runnerUp: order[1],
    margin: final[order[0]] - final[order[1]], trailer: b.name, needs };
}

// ---------- The record of drops ----------
const KEY = "votes-v1", KEEP = 300;
let mem = null;
async function load() {
  try { const v = await runtimeCache()?.get(KEY); if (v) mem = v; } catch (e) {}
  return (mem = mem || {});
}
async function save(store) {
  mem = store;
  try { await runtimeCache()?.set(KEY, store, { ttl: 30 * 86400, name: "vote drops" }); } catch (e) {}
}

// Read every state, compare with the last saved count for each race, and save a new entry
// whenever the totals changed. Returns the races with their current counts and drop history.
async function check(now = Date.now()) {
  const bySrc = {};
  for (const r of RACES) if (r.src) (bySrc[r.src] = bySrc[r.src] || []).push(r);
  const results = {};
  await Promise.all(Object.entries(bySrc).map(async ([src, races]) => {
    try { Object.assign(results, await READERS[src](races)); }
    catch (e) { for (const r of races) results[r.key] = { error: String(e.message || e) }; }
  }));
  const store = await load();
  let changed = false;
  for (const r of RACES) {
    const cur = results[r.key];
    if (!cur || cur.error || !cur.cands?.length) continue;
    const votes = Object.fromEntries(cur.cands.map((c) => [c.name, c.votes]));
    const list = (store[r.key] = store[r.key] || []);
    const last = list[list.length - 1];
    if (!last || cur.cands.some((c) => last.votes[c.name] !== c.votes)) {
      list.push({ t: now, asOf: cur.asOf || null, votes });
      if (list.length > KEEP) list.splice(0, list.length - KEEP);
      changed = true;
    }
  }
  if (changed) await save(store);
  const lefts = await ballotsLeft(results, now);
  return RACES.map((r) => {
    const cur = results[r.key] || null;
    const cands = cur?.cands ? [...cur.cands].sort((a, b) => b.votes - a.votes) : null;
    const history = store[r.key] || [];
    const left = lefts[r.key] || null;
    return { key: r.key, label: r.label, state: r.state, site: r.site, supported: !!r.src, why: r.why || null,
      error: cur?.error || null, cands, total: cands ? cands.reduce((s, c) => s + c.votes, 0) : null,
      reporting: cur?.reporting || null, asOf: cur?.asOf || null, source: cur?.url || null,
      parties: cands ? Object.fromEntries(cands.map((c) => [c.name, c.party])) : null,
      left, projection: left && !left.error ? project(cands, left) : null,
      history };
  });
}
function reset() { mem = null; leftMem = null; }

const exportsRef = module.exports = { RACES, check, reset, pdfText, project, parseNCProvisionals };

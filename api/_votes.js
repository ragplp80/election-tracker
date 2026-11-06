// Vote counts for the last uncalled races, read from each state's own published results, and a
// running record of every "vote drop" (each time a race's totals change).
//
// Each state publishes differently, so each has a small reader that turns its file into the same
// shape: { cands: [{ name, party, votes }], total, reporting, asOf, url }.
const { runtimeCache } = require("./_lib.js");

const ELECTION = { nc: "20261103", wa: "20261103" };

// The races to follow. src: which state reader; null = no free feed the server can read (yet).
const RACES = [
  { key: "house-NC-3", label: "NC-3", state: "NC", src: "nc", contest: /^US HOUSE OF REPRESENTATIVES DISTRICT 03\b/i,
    site: "https://er.ncsbe.gov/?election_dt=11/03/2026" },
  { key: "house-CA-23", label: "CA-23", state: "CA", src: "ca", path: "us-rep/district/23",
    site: "https://electionresults.sos.ca.gov/returns/us-rep/district/23" },
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
async function getText(url) {
  const r = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (vote-drop tracker)", accept: "*/*" } });
  if (!r.ok) throw new Error(`${new URL(url).hostname} answered ${r.status}`);
  return r.text();
}

// North Carolina: one file with every contest, one line per candidate (cnm contest, bnm name,
// pty party, vct votes, prt/ptl precincts reporting/total)
async function readNC(races) {
  const url = `https://er.ncsbe.gov/enr/${ELECTION.nc}/data/results_0.txt`;
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
async function readWA(races) {
  const url = `https://results.votewa.gov/results/public/api/elections/washington/${ELECTION.wa}/ballot-items`;
  const items = JSON.parse(await getText(url)).data || [];
  const name = (x) => (x && x[0] && x[0].text) || "";
  const out = {};
  for (const race of races) {
    const it = items.find((x) => race.contest.test(name(x.name)));
    if (!it) { out[race.key] = { error: "contest not found in the state's file" }; continue; }
    const rs = it.reportingStatus || {};
    out[race.key] = {
      cands: (it.summaryResults?.ballotOptions || []).filter((o) => !o.isWriteIn).map((o) => ({ name: name(o.name), party: partyOf(o.party?.abbreviation), votes: num(o.voteCount) })),
      reporting: rs.totalUnits ? `${rs.reportingUnits} of ${rs.totalUnits} counties` : "", asOf: rs.asOf || null, url,
    };
  }
  return out;
}
const READERS = { nc: readNC, ca: readCA, wa: readWA };

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
  return RACES.map((r) => {
    const cur = results[r.key] || null;
    const cands = cur?.cands ? [...cur.cands].sort((a, b) => b.votes - a.votes) : null;
    return { key: r.key, label: r.label, state: r.state, site: r.site, supported: !!r.src, why: r.why || null,
      error: cur?.error || null, cands, total: cands ? cands.reduce((s, c) => s + c.votes, 0) : null,
      reporting: cur?.reporting || null, asOf: cur?.asOf || null, source: cur?.url || null,
      parties: cands ? Object.fromEntries(cands.map((c) => [c.name, c.party])) : null,
      history: store[r.key] || [] };
  });
}
function reset() { mem = null; }

module.exports = { RACES, check, reset, readNC, readCA, readWA };

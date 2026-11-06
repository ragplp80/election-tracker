// Vote drops: counts read from the states' own results feeds, and a record of every change
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadPage, defaultBoard, twoParty, waitFor, useFakeKalshi, callHandler } = require("./helpers.js");

function states() {
  return {
    nc: [
      { cnm: "US HOUSE OF REPRESENTATIVES DISTRICT 03", bnm: "Ann Lee", pty: "DEM", vct: "1000", prt: "180", ptl: "200" },
      { cnm: "US HOUSE OF REPRESENTATIVES DISTRICT 03", bnm: "Bob Ray", pty: "REP", vct: "1100", prt: "180", ptl: "200" },
      { cnm: "US HOUSE OF REPRESENTATIVES DISTRICT 13", bnm: "Someone Else", pty: "REP", vct: "9999", prt: "1", ptl: "1" },
    ],
    ca: { "us-rep/district/23": { candidates: [
      { Name: "Jay Obernolte", Party: "Rep", Votes: "78,084" }, { Name: "Pat Hodge", Party: "Dem", Votes: "74,188" }],
      Reporting: "500 of 520 precincts reporting", ReportingTime: "November 5, 2026, 4:10 p.m." } },
    wa: [{ name: [{ text: "Congressional District 5 - U.S. Representative" }],
      summaryResults: { ballotOptions: [
        { name: [{ text: "Michael Baumgartner" }], party: { abbreviation: "REP" }, voteCount: 115993 },
        { name: [{ text: "Carmela Conroy" }], party: { abbreviation: "DEM" }, voteCount: 111167 },
        { name: [{ text: "WRITE-IN" }], isWriteIn: true, voteCount: 50 }] },
      reportingStatus: { reportingUnits: 5, totalUnits: 7, asOf: "2026-11-05T23:00:00Z" } }],
  };
}
const byKey = (races) => Object.fromEntries(races.map((r) => [r.key, r]));

test("votes: each state's feed is read into the same shape, and a drop is saved only when totals change", async (t) => {
  const board = defaultBoard(); board.states = states();
  const restore = useFakeKalshi(board, []);
  t.after(restore);
  const votes = require("../api/_votes.js");

  let r = byKey(await votes.check(1000));
  assert.deepEqual(r["house-NC-3"].cands.map((c) => [c.name, c.party, c.votes]), [["Bob Ray", "R", 1100], ["Ann Lee", "D", 1000]], "only district 3, leader first");
  assert.equal(r["house-NC-3"].reporting, "180 of 200 precincts");
  assert.equal(r["house-CA-23"].cands[0].votes, 78084, "commas in California's counts");
  assert.equal(r["house-CA-23"].reporting, "500 of 520 precincts");
  assert.deepEqual(r["house-WA-5"].cands.map((c) => c.name), ["Michael Baumgartner", "Carmela Conroy"], "write-ins left out");
  assert.equal(r["house-WA-5"].total, 227160);
  assert.equal(r["house-WA-5"].reporting, "5 of 7 counties");
  assert.equal(r["house-AZ-2"].supported, false);
  assert.match(r["house-AZ-2"].why, /blocks automated readers/);
  for (const k of ["house-NC-3", "house-CA-23", "house-WA-5"]) assert.equal(r[k].history.length, 1, k + " starts its record");

  r = byKey(await votes.check(2000));
  assert.equal(r["house-CA-23"].history.length, 1, "no change, no new entry");

  board.states.ca["us-rep/district/23"].candidates[0].Votes = "80,084";
  r = byKey(await votes.check(3000));
  assert.equal(r["house-CA-23"].history.length, 2, "California posted new votes");
  assert.equal(r["house-CA-23"].history[1].t, 3000);
  assert.equal(r["house-CA-23"].history[1].votes["Jay Obernolte"], 80084);
  assert.equal(r["house-WA-5"].history.length, 1);

  delete board.states.nc;
  r = byKey(await votes.check(4000));
  assert.match(r["house-NC-3"].error, /answered 404/, "a feed that's down is reported, not fatal");
  assert.equal(r["house-NC-3"].history.length, 1, "...and its record is kept");
  assert.ok(r["house-WA-5"].cands, "other states still read");

  const res = await callHandler(require("../api/votes.js"));
  assert.equal(res.statusCode, 200);
  assert.match(res.headers["cache-control"], /s-maxage=60/);
  assert.equal(res.body.races.length, votes.RACES.length);
});

test("Vote Drops page: shows each race's margin, and after new votes, the drop and who it helped", async (t) => {
  const board = defaultBoard();
  board.events.HOUSECA23 = [twoParty("HOUSECA23-26", "D", "Jay Obernolte", 0.34)];
  board.states = states();
  const pg = loadPage({ file: "votes.html", board });
  t.after(() => pg.close());
  const card = (k) => pg.d.querySelector(`.race[data-key="${k}"]`);
  await waitFor(() => card("house-CA-23") && /Checked the states/.test(pg.text("#status")), { what: "first load", timeout: 15000 });

  const ca = () => card("house-CA-23").textContent.replace(/\s+/g, " ");
  assert.match(ca(), /Obernolte \+3,896/);
  assert.match(ca(), /152,272 votes counted/);
  assert.match(ca(), /Market: Jay Obernolte 66%/);
  assert.equal(card("house-CA-23").querySelector(".mkt a").getAttribute("href"), "https://kalshi.com/markets/houseca23/m/houseca23-26");
  assert.match(ca(), /No new votes since/);
  assert.match(card("house-AZ-2").textContent, /blocks automated readers/);
  assert.equal(card("house-AZ-2").querySelector("a.btn").getAttribute("href"), "https://results.arizona.vote/");
  assert.ok(pg.d.getElementById("newstrip").hidden, "nothing new yet");

  board.states.ca["us-rep/district/23"].candidates[0].Votes = "80,084";   // +2,000 Obernolte
  board.states.ca["us-rep/district/23"].candidates[1].Votes = "75,188";   // +1,000 Hodge
  board.states.nc[0].vct = "1300"; board.states.nc[1].vct = "1150";         // Lee takes the lead
  pg.d.getElementById("refresh").click();
  await waitFor(() => !pg.d.getElementById("newstrip").hidden, { what: "new drops", timeout: 15000 });

  assert.match(ca(), /\+3,000 votes · Obernolte netted 1,000 \(Obernolte won 67% of it\) · margin Obernolte \+4,896/);
  assert.match(card("house-CA-23").className, /fresh/);
  const nc = card("house-NC-3").textContent.replace(/\s+/g, " ");
  assert.match(nc, /Lee netted 250/);
  assert.match(nc, /LEAD CHANGE/);
  assert.match(pg.text("#newList"), /CA-23 .* \+3,000 · Obernolte \+1,000/);
  assert.match(pg.text("#newList"), /NC-3 .* \+350 · Lee \+250/);
  assert.deepEqual(pg.errors, []);
});

// ---------- Ballots left to count ----------
function full() {
  const s = states();
  s.wa[0].id = "item5";
  s.waItem = {
    localityElections: [{ jurisdictionId: "A", ballotsCast: 10000 }, { jurisdictionId: "B", ballotsCast: 50000 }, { jurisdictionId: "C", ballotsCast: 4000 }],
    statistics: [{ name: [{ text: "Estimated Ballots Left to Count - by county" }], groups: [{ children: [
      { id: "a", name: [{ text: "Adams County" }], value: 1000, lastUpdated: "2026-11-06T16:00:00Z" },
      { id: "b", name: [{ text: "Spokane County" }], value: 6000, lastUpdated: "2026-11-06T18:00:00Z" }] }] }],
    ballotItemWithBreakdown: { breakdownResults: [
      { locality: { id: "A", name: [{ text: "Adams County" }] }, voteTotal: 9500 },
      { locality: { id: "B", name: [{ text: "Spokane County" }] }, voteTotal: 20000 },
      { locality: { id: "C", name: [{ text: "Ferry County" }] }, voteTotal: 3800 }] },
  };
  s.sb = `<p><strong>Estimated unprocessed ballot reporting as of November 5, 2026, at 5:45 p.m.</strong></p><table><tbody>
    <tr><td width="700">1. Cumulative total number of processed ballots (includes ballots tabulated on election night)</td><td style="text-align: right">400,000</td></tr>
    <tr><td>7. Provisional ballots</td><td>4,600</td></tr>
    <tr><td width="650">10. TOTAL ESTIMATED NUMBER OF UNPROCESSED BALLOTS (total includes #3-9)</td><td style="text-align: right" width="90">160,000</td></tr>
    <tr><td width="650">11. Ballots left to cure (noncomparable signatures)</td><td style="text-align: right" width="90">2,000</td></tr></tbody></table>`;
  s.ca["us-rep/district/23/county/san-bernardino"] = [{ candidates: [{ Name: "Pat Hodge", Votes: "66,000" }, { Name: "Jay Obernolte", Votes: "70,000" }] }, {}];
  s.ca["us-rep/district/23/county/riverside"] = [{ candidates: [{ Name: "Pat Hodge", Votes: "3,000" }, { Name: "Jay Obernolte", Votes: "5,000" }] }, {}];
  const house = (n, a, b) => [{ cnm: "US HOUSE OF REPRESENTATIVES DISTRICT 03 (VOTE FOR 1)", bnm: "Ann Lee", vct: String(a) }, { cnm: "US HOUSE OF REPRESENTATIVES DISTRICT 03 (VOTE FOR 1)", bnm: "Bob Ray", vct: String(b) }];
  const senate = (n) => [{ cnm: "US SENATE (VOTE FOR 1)", bnm: "X", vct: String(n / 2) }, { cnm: "US SENATE (VOTE FOR 1)", bnm: "Y", vct: String(n / 2) }];
  s.ncCounties = { 31: [...house(31, 1500, 1500), ...senate(3000)], 74: [...house(74, 30000, 30000), ...senate(100000)] };
  s.ncProv = "Provisional Ballots Cast by Voting Method, County\nCounty Total\nDUPLIN 125 32 0 0 157\nNEW HANOVER 858 178 0 0 1,036\nPITT 1,002 114 0 0 1,116\nStatewide 30,745 6,043 0 0 36,788";
  return s;
}
function withPdfStub(t) {
  const votes = require("../api/_votes.js"), real = votes.pdfText;
  votes.pdfText = async (buf) => Buffer.from(buf).toString("utf8");
  t.after(() => { votes.pdfText = real; });
  return votes;
}

test("votes left: each state's county estimates, times the district's share of each county", async (t) => {
  const board = defaultBoard(); board.states = full();
  t.after(useFakeKalshi(board, []));
  const votes = withPdfStub(t);
  const r = byKey(await votes.check(1000));

  const wa = r["house-WA-5"].left;
  assert.equal(Math.round(wa.est), 3350, "1,000 × 95% (Adams) + 6,000 × 40% (Spokane)");
  assert.deepEqual(wa.parts.map((p) => [p.name, p.left, +p.share.toFixed(2)]), [["Adams", 1000, 0.95], ["Spokane", 6000, 0.4], ["Ferry", null, 0.95]]);
  assert.equal(wa.asOf, "2026-11-06T18:00:00Z", "the newest county estimate");
  assert.match(wa.note, /1 county hasn't posted/);

  const ca = r["house-CA-23"].left;
  assert.equal(Math.round(ca.est), 57600, "160,000 × 34% in San Bernardino, plus Riverside's 8,000 votes × 0.4");
  assert.equal(ca.asOf, "November 5, 2026, at 5:45 p.m.");
  assert.equal(Math.round(ca.cure), 680);
  assert.deepEqual(ca.parts.map((p) => p.name), ["San Bernardino", "Riverside"], "counties without a county file are left out");

  const nc = r["house-NC-3"].left;
  assert.equal(nc.kind, "provisional");
  assert.equal(Math.round(nc.est), 827, "Duplin 157 × 100% + Pitt 1,116 × 60%");
  assert.match(nc.note, /Couldn't read 7 of the 9 counties/);
  assert.equal(votes.parseNCProvisionals(board.states.ncProv)["NEW HANOVER"], 1036);
  assert.equal(votes.parseNCProvisionals(board.states.ncProv).STATEWIDE, undefined);

  // What the trailing candidate needs, and the margin if the rest split like the votes so far
  const p = r["house-CA-23"].projection;
  assert.equal(p.basis, "county");
  assert.equal(p.trailer, "Pat Hodge");
  assert.equal(+(p.needs * 100).toFixed(1), 53.4, "(57,600 + 3,896) / (2 × 57,600)");
  assert.equal(p.leader, "Jay Obernolte");
  // San Bernardino 54,400 at 70/136 Obernolte; Riverside 3,200 at 5/8
  assert.equal(Math.round(p.margin), Math.round(3896 + 54400 * (4000 / 136000) + 3200 * (2000 / 8000)));

  // A source that's down shows as an error for that race only
  delete board.states.sb;
  votes.reset();
  const r2 = byKey(await votes.check(2000));
  assert.match(r2["house-CA-23"].left.error, /answered 404/);
  assert.equal(r2["house-CA-23"].projection, null);
  assert.ok(r2["house-WA-5"].left.est > 0);
});

test("votes left: each county's ballots split like that county has voted so far", () => {
  const votes = require("../api/_votes.js");
  const cands = [{ name: "A", votes: 6000 }, { name: "B", votes: 5000 }];
  // 1,000 left in a county voting 80% B, 1,000 in one voting 50/50, 500 with no county split
  const left = { est: 2500, parts: [{ est: 1000, split: { A: 0.2, B: 0.8 } }, { est: 1000, split: { A: 0.5, B: 0.5 } }, { est: 500 }] };
  const p = votes.project(cands, [], left);
  assert.equal(p.basis, "county");
  assert.equal(Math.round(p.final.A), 6000 + 200 + 500 + 273, "the last 500 split like the race so far (6/11)");
  assert.equal(p.leader, "A");
  assert.equal(Math.round(p.margin), 445, "6,972.7 vs 6,527.3");
  assert.equal(+(p.needs * 100).toFixed(1), 70, "B needs (2,500 + 1,000) / 5,000 of the two-way votes left");
  assert.ok(votes.project(cands, [], { est: 100 }).needs > 1, "B can't make up 1,000 votes out of 100");
});

test("Vote Drops page: each card shows the votes left, what the trailing candidate needs, and the projected margin", async (t) => {
  const board = defaultBoard(); board.states = full();
  const pg = loadPage({ file: "votes.html", board });
  t.after(() => pg.close());
  withPdfStub(t);
  const card = (k) => pg.d.querySelector(`.race[data-key="${k}"]`);
  await waitFor(() => card("house-CA-23")?.querySelector(".left"), { what: "estimates", timeout: 15000 });
  const ca = card("house-CA-23").querySelector(".left").textContent.replace(/\s+/g, " ");
  assert.match(ca, /Votes left to count \(est\.\)\s*~57,600/);
  assert.match(ca, /Hodge needs\s*53\.4% of them/);
  assert.match(ca, /If each county's split like its votes so far\s*Obernolte \+6,300/);
  assert.match(ca, /San Bernardino\s*160,000\s*34%\s*54,400/);
  assert.match(ca, /About 680 more are waiting on voters to fix a signature/);
  const nc = card("house-NC-3").querySelector(".left").textContent.replace(/\s+/g, " ");
  assert.match(nc, /Provisional ballots left \(est\.\)\s*~830/);
  assert.match(nc, /and all count/);
  assert.match(card("house-WA-5").querySelector(".left").textContent, /Conroy can.t catch up\s*would need more than all of them/, "4,826 behind with ~3,350 left");
  assert.ok(!card("house-AZ-2").querySelector(".left"), "no estimate where there's no feed");
  assert.deepEqual(pg.errors, []);
});

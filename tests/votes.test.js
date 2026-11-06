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

// Election night and storage: run the page with the clock set to Nov 3-4, 2026.
const test = require("node:test");
const assert = require("node:assert/strict");
const { defaultBoard, twoParty, loadPage, waitFor, loaded } = require("./helpers.js");

const ET_830PM_NOV3 = Date.UTC(2026, 10, 4, 1, 30);   // 8:30pm EST (clocks fall back Nov 1)
const ET_6PM_NOV3 = Date.UTC(2026, 10, 3, 23, 0);

function page(t, opts) { const pg = loadPage(opts); t.after(() => pg.close()); return pg; }
const noErrors = (pg) => assert.deepEqual(pg.errors, [], "no script errors");

// Minute-by-minute history for the last 6 hours (plus hourly before), from a value function.
function seed(now, fns) {
  const hist = {};
  for (const [id, f] of Object.entries(fns)) {
    const pts = [];
    for (let t = now - 30 * 3600e3; t < now - 6 * 3600e3; t += 3600e3) pts.push([t, f(t)]);
    for (let t = Math.ceil((now - 6 * 3600e3) / 60e3) * 60e3; t <= now - 60e3; t += 60e3) pts.push([t, f(t)]);
    hist[id] = pts;
  }
  return hist;
}

test("election night: baseline is 6pm, feed is live, next poll closing is shown", async (t) => {
  const now = ET_830PM_NOV3;
  const board = defaultBoard();
  board.events.SENATEGA = [twoParty("SENATEGA-26", "Jon Ossoff", "Mike Collins", 0.845)];
  const hist = seed(now, {
    // Maine: 30% in the afternoon, 45% at 6pm, 55% since 6:45pm
    "SENATEME-26": (x) => (x < now - 3.5 * 3600e3 ? 0.3 : x < ET_6PM_NOV3 + 45 * 60e3 ? 0.45 : 0.55),
    // Georgia: a 4.5-point jump ten minutes ago (live rule: 4+ in 15 min; the daytime rule would miss it)
    "SENATEGA-26": (x) => (x < now - 10 * 60e3 ? 0.8 : 0.845),
  });
  const pg = page(t, { board, now, storage: { "et.history": hist } });
  await loaded(pg);
  assert.match(pg.text("#baseline"), /since 6pm ET/);
  assert.equal(pg.row("SENATEME-26").querySelectorAll(".c")[2].textContent.trim(), "D +10", "Today compares with 6pm, not midnight");
  assert.match(pg.text("#feedSub"), /^Live/);
  await waitFor(() => /Georgia Sen: moved \d pts toward Jon Ossoff/.test(pg.text("#feedList")), { what: "live feed move" });
  assert.match(pg.text("#nextClose"), /Next polls close: 9pm ET · AZ, NE/);
  noErrors(pg);
});

test("the morning after: still compared with 6pm until 8am, then back to midnight", async (t) => {
  const pg = page(t, { now: Date.UTC(2026, 10, 4, 12, 0) });   // 7am EST Nov 4
  await loaded(pg);
  assert.match(pg.text("#baseline"), /since 6pm ET/);
  assert.equal(pg.w.eval("baseAt()"), ET_6PM_NOV3);
  const later = page(t, { now: Date.UTC(2026, 10, 4, 14, 0) }); // 9am EST
  await loaded(later);
  assert.match(later.text("#baseline"), /since 12am ET/);
});

test("midnight is right on both sides of the Nov 1 clock change", async (t) => {
  const pg = page(t, { now: Date.UTC(2026, 9, 31, 16, 0) });
  await loaded(pg);
  assert.equal(pg.w.eval('etTs("2026-10-31",0)'), Date.UTC(2026, 9, 31, 4), "EDT: midnight is 04:00 UTC");
  assert.equal(pg.w.eval('etTs("2026-11-02",0)'), Date.UTC(2026, 10, 2, 5), "EST: midnight is 05:00 UTC");
  assert.equal(pg.w.eval('etTs("2026-11-03",18)'), ET_6PM_NOV3);
});

test("saved history stays small: 150 races of full detail fit easily", async (t) => {
  const pg = page(t);
  await loaded(pg);
  const size = pg.w.eval(`(()=>{
    const now=clockNow();
    for(let i=0;i<150;i++){const pts=[];for(let x=now-72*3600e3;x<=now;x+=60e3)pts.push([x,0.5+0.1*Math.sin(x/1e6+i)]);history["X"+i]=compactHistory(pts,now)}
    saveHistory();return localStorage.getItem("et.history").length})()`);
  assert.ok(size < 1.5e6, `saved history is ${Math.round(size / 1024)} KB`);
  const back = pg.w.eval(`loadHistory()["X7"].length`);
  assert.ok(back > 400, "reloads with full detail");
});

test("a full browser store keeps a shorter history instead of failing", async (t) => {
  const pg = page(t);
  await loaded(pg);
  const kept = pg.w.eval(`(()=>{
    const now=clockNow();
    for(let i=0;i<40;i++){const pts=[];for(let x=now-72*3600e3;x<=now;x+=60e3)pts.push([x,0.5]);history["Y"+i]=compactHistory(pts,now)}
    saveHistory();const full=localStorage.getItem("et.history").length;      // what a full save needs
    const real=Storage.prototype.setItem;
    Storage.prototype.setItem=function(k,v){if(k==="et.history"&&v.length>full*0.9)throw new Error("QuotaExceededError");return real.call(this,k,v)};
    const ok=saveHistory();Storage.prototype.setItem=real;
    const saved=JSON.parse(localStorage.getItem("et.history"));
    const oldest=Math.min(...Object.values(saved.d).map(p=>p[0][0]))*60e3;
    return {ok,hoursKept:(now-oldest)/3600e3};
  })()`);
  assert.equal(kept.ok, true);
  assert.ok(kept.hoursKept <= 26.1, "trimmed to about a day");
  noErrors(pg);
});

test("merging history is fast enough for the iPad", async (t) => {
  const pg = page(t);
  await loaded(pg);
  const ms = pg.w.eval(`(()=>{
    const now=clockNow(),t0=performance.now();
    for(let i=0;i<150;i++){const have=[],add=[];for(let x=now-6*3600e3;x<=now;x+=60e3){have.push([x,0.5]);add.push([x+20e3,0.6])}history["Z"+i]=have;mergePoints("Z"+i,add,now)}
    return performance.now()-t0})()`);
  assert.ok(ms < 1500, `merging 150 races took ${Math.round(ms)} ms`);
});

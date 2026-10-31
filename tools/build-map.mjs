// Run from tools/: npm i us-atlas@3.0.1 topojson-client@3.1.0 topojson-server@3.0.1 topojson-simplify@3.0.3 d3-geo@3.1.1 @mapbox/geojson-rewind@0.5.2
// then: CDS_DIR=<unitedstates districts cds/2022> TX_FILE=<tx_cd120_2026.geojson> node build-map.mjs
// Builds map2026.json for the Live Odds Tracker: state outlines and House district shapes,
// projected once to Albers USA (975x610, the same projection as us-atlas's states-albers file),
// simplified, with bounds and label points. The page draws these as SVG with no map library.
import fs from "node:fs";
import path from "node:path";
import * as topojson from "topojson-client";
import { topology } from "topojson-server";
import { presimplify, simplify, sphericalTriangleArea } from "topojson-simplify";
import { geoPath, geoAlbersUsa } from "d3-geo";
import rewind from "@mapbox/geojson-rewind";

const FIPS = {"01":"AL","02":"AK","04":"AZ","05":"AR","06":"CA","08":"CO","09":"CT","10":"DE","11":"DC","12":"FL","13":"GA","15":"HI","16":"ID","17":"IL","18":"IN","19":"IA","20":"KS","21":"KY","22":"LA","23":"ME","24":"MD","25":"MA","26":"MI","27":"MN","28":"MS","29":"MO","30":"MT","31":"NE","32":"NV","33":"NH","34":"NJ","35":"NM","36":"NY","37":"NC","38":"ND","39":"OH","40":"OK","41":"OR","42":"PA","44":"RI","45":"SC","46":"SD","47":"TN","48":"TX","49":"UT","50":"VT","51":"VA","53":"WA","54":"WV","55":"WI","56":"WY","72":"PR"};
const REDRAWN_NO_SHAPES = { CA: 52, NC: 14, OH: 15, UT: 4, FL: 28, TN: 9, LA: 6, AL: 7 };   // new 2026 lines, no shapes available
const AT_LARGE = ["AK", "DE", "ND", "SD", "VT", "WY"];
const APPROX = ["GA", "NY"];   // shapes are the 2022 lines; both states adjusted lines for 2024

const MIN_KM = +(process.env.MIN_KM || 0.7);
// Drop consecutive repeated points (common after rounding to 0.1 px) and degenerate rings,
// and write points relative to the previous one, which is shorter.
function tidy(d) {
  let out = "";
  for (const ring of d.split("M").filter(Boolean)) {
    const pts = [];
    for (const pair of ring.replace(/Z$/, "").split("L")) {
      const [x, y] = pair.split(",").map(Number);
      const last = pts[pts.length - 1];
      if (!last || last[0] !== x || last[1] !== y) pts.push([x, y]);
    }
    if (pts.length < 3) continue;
    out += "M" + pts[0][0] + "," + pts[0][1];
    for (let i = 1; i < pts.length; i++) {
      const dx = Math.round((pts[i][0] - pts[i - 1][0]) * 10) / 10, dy = Math.round((pts[i][1] - pts[i - 1][1]) * 10) / 10;
      out += "l" + dx + "," + dy;
    }
    out += "Z";
  }
  return out.replace(/,-/g, "-").replace(/l(-?)0\./g, "l$1.").replace(/([,l-])0\./g, "$1.");
}
const round = (n, k) => Math.round(n * 10 ** k) / 10 ** k;

// ----- States (already projected)
const us = JSON.parse(fs.readFileSync("node_modules/us-atlas/states-albers-10m.json", "utf8"));
const statePath = geoPath().digits(1);
const states = {};
for (const f of topojson.feature(us, us.objects.states).features) {
  const st = FIPS[f.id];
  if (!st || st === "PR") continue;
  const b = statePath.bounds(f).map((p) => p.map((x) => round(x, 1)));
  states[st] = { n: f.properties.name, d: tidy(statePath(f)), b: [b[0][0], b[0][1], b[1][0], b[1][1]] };
}

// ----- Districts (lon/lat): 2022 lines for states whose maps didn't change for 2026, plus Texas 2026
const feats = {};
const dir = process.env.CDS_DIR || "../../data/districts/cds/2022";
for (const name of fs.readdirSync(dir)) {
  const st = name.split("-")[0];
  if (REDRAWN_NO_SHAPES[st] || st === "TX" || !states[st]) continue;
  const g = JSON.parse(fs.readFileSync(path.join(dir, name, "shape.geojson"), "utf8"));
  const f = g.type === "FeatureCollection" ? g.features[0] : g;
  feats[`${st}-${+name.split("-")[1]}`] = rewind({ type: "Feature", geometry: f.geometry, properties: {} }, true);   // d3 wants clockwise rings
}
const tx = JSON.parse(fs.readFileSync(process.env.TX_FILE || "../../data/tx-districts/data/tx_cd120_2026.geojson", "utf8"));
for (const f of tx.features) feats[`TX-${+f.properties.CD120}`] = rewind({ type: "Feature", geometry: f.geometry, properties: {} }, true);

// Simplify all districts together so shared borders stay aligned
let topo = topology(feats);
topo = presimplify(topo, sphericalTriangleArea);
// Keep detail down to about MIN_KM across (triangle area in steradians): finer than a pixel even
// when zoomed into a single state.
const before = topo.arcs.reduce((n, a) => n + a.length, 0);
const R_KM = 6371, minArea = (MIN_KM * MIN_KM) / (R_KM * R_KM);
topo = simplify(topo, minArea);
console.log("arc points", before, "->", topo.arcs.reduce((n, a) => n + a.length, 0));
const proj = geoAlbersUsa().scale(1300).translate([487.5, 305]).precision(0);   // no resampling: keep the simplified points
const dPath = geoPath(proj).digits(1);
const districts = {};
for (const key of Object.keys(feats)) {
  const f = topojson.feature(topo, topo.objects[key]);
  const d = tidy(dPath(f) || "");
  if (!d) { console.warn("no path", key); continue; }
  const c = dPath.centroid(f).map((x) => round(x, 1));
  districts[key] = { d, c };
}
for (const st of AT_LARGE) districts[`${st}-0`] = { d: states[st].d, c: geoPath().centroid(topojson.feature(us, us.objects.states).features.find((f) => FIPS[f.id] === st)).map((x) => round(x, 1)) };

const out = { w: 975, h: 610, states, districts, tiles: REDRAWN_NO_SHAPES, approx: APPROX,
  sources: {
    states: "us-atlas 3.0.1 (US Census Bureau cartographic boundaries), Albers USA",
    districts: "unitedstates/districts via github.com/nickoneill/districts, 2022 lines (118th Congress)",
    tx: "github.com/jessestrait/tx-districts, Texas 2025-enacted map (120th Congress numbering)",
  } };
const json = JSON.stringify(out);
fs.writeFileSync("../map2026.json", json);
console.log("states", Object.keys(states).length, "districts", Object.keys(districts).length, "size KB", Math.round(json.length / 1024));

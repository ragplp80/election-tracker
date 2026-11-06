// Temporary: which counties hold a NC contest, from the per-county results files
module.exports = async (req, res) => {
  const re = new RegExp(req.query.c || "^US HOUSE OF REPRESENTATIVES DISTRICT 03\\b", "i");
  const out = {}, errs = {};
  await Promise.all(Array.from({ length: 100 }, (_, i) => i + 1).map(async (n) => {
    try {
      const r = await fetch(`https://er.ncsbe.gov/enr/20261103/data/results_${n}.txt`);
      if (!r.ok) { errs[n] = r.status; return; }
      const rows = JSON.parse(await r.text());
      const mine = rows.filter((x) => re.test(x.cnm || ""));
      if (mine.length) out[n] = { cid: mine[0].cid, votes: Object.fromEntries(mine.map((x) => [x.bnm, +x.vct])), sample: Object.keys(mine[0]) };
    } catch (e) { errs[n] = String(e.message || e); }
  }));
  res.status(200).json({ out, errs });
};

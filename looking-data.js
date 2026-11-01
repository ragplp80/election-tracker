// "How We Looking" scenario chart, typed in from the "early tells" graphic (DDHQ tiers,
// Chuck Todd, Karl Rove, WSJ, Cook, 270toWin). Edit here if the source changes.
// House: which districts decide each tier, by poll-closing time (Eastern). Riptide districts are
// Democratic seats the GOP would take; every other tier lists seats Democrats need to win.
// Senate: the final margin each scenario implies, per race (from the chart's columns).
window.LOOKING = {
  tiers: [
    { id: "riptide", name: "Red Riptide", house: "GOP holds or gains", senate: "GOP +3 to even" },
    { id: "tide", name: "Blue Tide", house: "Dems win 218–229", senate: "D +1 to +3" },
    { id: "wave", name: "Blue Wave", house: "Dems win 230–239", senate: "D +4 to +6" },
    { id: "tsunami", name: "Blue Tsunami", house: "Dems win 240+", senate: "D +7 or more" },
  ],
  // House seat ranges for the seat-count market cross-check
  houseSeats: { tide: 218, wave: 230, tsunami: 240 },
  // Senate: net seats Democrats gain (an Osborn win in Nebraska counts with them)
  senateNet: { tide: 1, wave: 4, tsunami: 7 },

  house: [
    { at: 18, states: "KY (east) · IN",
      riptide: [], tide: [],
      wave: [["KY-6", "Open seat"], ["IN-5", "Spartz"]], tsunami: [] },
    { at: 19, states: "FL · GA · SC · VA · IN · KY",
      riptide: [["VA-7", "Vindman"], ["IN-1", "Mrvan"], ["GA-2", "Bishop"]],
      tide: [["FL-14", "Castor", 1], ["FL-22", "Open seat", 1], ["FL-25", "Moskowitz", 1], ["VA-2", "Kiggans"], ["SC-1", "Open seat"]],
      wave: [["FL-9", "Soto", 1], ["FL-7", "Open seat"], ["VA-1", "Wittman"]],
      tsunami: [["VA-5", "McGuire"], ["FL-27", "Salazar"], ["GA-1", "Open seat"], ["SC-2", "Wilson"]] },
    { at: 19.5, states: "NC · OH",
      riptide: [["OH-1", "Landsman", 1], ["OH-13", "Sykes", 1]],
      tide: [["NC-1", "Davis", 1], ["NC-11", "Open seat"], ["OH-7", "Miller"], ["OH-9", "Kaptur", 1]],
      wave: [["OH-10", "Turner"]],
      tsunami: [["NC-9", "Hudson"], ["NC-5", "Foxx"]] },
    { at: 20, states: "PA · MI · NJ · TX · ME",
      riptide: [],
      tide: [["PA-8", "Bresnahan"], ["MI-4", "Huizenga"], ["MI-7", "Barrett"], ["MI-10", "Open seat"], ["NJ-7", "Kean"], ["PA-1", "Fitzpatrick"]],
      wave: [["ME-2", "Open seat"], ["TX-15", "De La Cruz", 1]],
      tsunami: [["NJ-2", "Van Drew"]] },
    { at: 21, states: "NY · AZ · CO · WI · NE · IA",
      riptide: [],
      tide: [["NY-17", "Lawler"], ["AZ-1", "Open seat"], ["AZ-6", "Ciscomani"], ["CO-8", "Evans"], ["WI-3", "Van Orden"],
        ["NE-2", "Open seat"], ["IA-1", "Miller-Meeks"], ["IA-2", "Open seat"], ["IA-3", "Nunn"], ["CO-5", "Crank"]],
      wave: [], tsunami: [] },
    { at: 22, states: "MT", riptide: [], tide: [["MT-1", "Open seat"]], wave: [], tsunami: [] },
    { at: 23, states: "CA", riptide: [], tide: [["CA-22", "Valadao", 1], ["CA-48", "Open seat", 1]], wave: [], tsunami: [] },
  ],
  // Dashed boxes: bars the GOP clears for a red signal. need = how many of the districts the GOP
  // must be favored in. byPts is the margin the chart asks for (not tracked; win odds shown).
  gopTests: [
    { at: 18, label: "KY-6: GOP by 10+", seats: ["KY-6"], need: 1, byPts: 10 },
    { at: 18, label: "IN-5: GOP by 15+", seats: ["IN-5"], need: 1, byPts: 15 },
    { at: 19, label: "Florida redraw: GOP 4 for 4", seats: ["FL-9", "FL-14", "FL-22", "FL-25"], need: 4 },
    { at: 20, label: "Texas redraw: GOP 4+ of 5", seats: ["TX-9", "TX-28", "TX-32", "TX-34", "TX-35"], need: 4 },
    { at: 20, label: "PA-7 and PA-10: GOP 2 for 2", seats: ["PA-7", "PA-10"], need: 2 },
  ],

  // r: the Republican's name as the margin markets spell it; rcp: Oct. 30 RCP average (D+ positive).
  // Ranges are each scenario's final margin. "I" means the independent (Osborn).
  senate: [
    { st: "FL", at: 19, r: "Moody", d: "Nixon", rcp: -6.1, ranges: ["R10+", "R4-9", "R3-Even", "Any D win"] },
    { st: "GA", at: 19, r: "Collins", d: "Ossoff", rcp: 8.2, ranges: ["R win or D <5", "D5-10", "D11-14", "D15+"] },
    { st: "SC", at: 19, r: "Graham", d: "Andrews", rcp: -2.7, ranges: ["R9+", "R8-Even", "D1-4", "D5+"] },
    { st: "NC", at: 19.5, r: "Whatley", d: "Cooper", rcp: 10.7, ranges: ["R win or D <6", "D6-12", "D13-16", "D17+"] },
    { st: "OH", at: 19.5, r: "Husted", d: "Brown", rcp: 2.6, ranges: ["R2+", "R1-D6", "D7-10", "D11+"] },
    { st: "ME", at: 20, r: "Collins", d: "Jackson", rcp: 1.2, ranges: ["R1+", "Even-D4", "D5-8", "D9+"] },
    { st: "NH", at: 20, r: "Sununu", d: "Pappas", rcp: 6.2, ranges: ["R win or D <4", "D4-11", "D12-15", "D16+"] },
    { st: "TX", at: 20, r: "Paxton", d: "Talarico", rcp: 1.8, ranges: ["R5+", "R4-D4", "D5-8", "D9+"] },
    { st: "MI", at: 20, r: "Rogers", d: "El-Sayed", rcp: 3.5, ranges: ["Any R win", "D0-7", "D8-11", "D12+"] },
    { st: "KS", at: 20, r: "Marshall", d: "Hamilton", rcp: 2.4, ranges: ["R7+", "R6-D3", "D4-7", "D8+"] },
    { st: "MS", at: 20, r: "Hyde-Smith", d: "Colom", rcp: null, ranges: ["R14+", "R3-13", "R2-Even", "D1+"] },
    { st: "IA", at: 21, r: "Hinson", d: "Turek", rcp: -0.5, ranges: ["R5+", "R4-D2", "D3-6", "D7+"] },
    { st: "NE", at: 21, r: "Ricketts", d: "Osborn", ind: true, rcp: -1.4, ranges: ["R5+", "R4-Even", "I1-4", "I5+"] },
    { st: "MN", at: 21, r: "Tafoya", d: "Flanagan", rcp: 5.1, ranges: ["R win or D <1", "D1-12", "D13-16", "D17+"] },
  ],

  // Governor races the keys refer to: the Republican's name as the margin markets spell it
  govR: { TX: "Abbott", FL: "Donalds", GA: "Jackson" },

  // Keys to watch. side: which party a "yes" is good news for. check: how the page decides it from the odds (see looking.html); none means it
  // needs vote counts the markets don't carry, so it is listed as something to watch for.
  keys: [
    { at: 19.5, text: "NC called for Cooper at close", means: "the baseline wave is real", check: "ncCooper", side: "D" },
    { at: 20, until: 21, text: "Big D. Graham win in South Carolina", means: "Republicans came home; polls missed", check: "scGrahamBig", side: "R" },
    { at: 20, until: 21, text: "Brown 4+ points ahead of his 2024 race", means: "Ohio likely flips", check: "ohBrownAhead", side: "D" },
    { at: 20, until: 22, text: "Paxton trails Abbott", means: "voters splitting tickets; Texas at risk", check: "txPaxtonTrails", side: "D" },
    { at: 20, until: 22, text: "El-Sayed lags Harris '24 in Detroit", means: "Democratic trouble", side: "R" },
    { at: 21, text: "Florida Senate still uncalled", means: "good Democratic night", check: "flSenUncalled", side: "D" },
    { at: 21, text: "Talarico tops Harris '24 in South Texas", means: "Texas in play", side: "D" },
    { at: 21, until: 22, text: "Florida governor still uncalled", means: "very good Democratic night", check: "flGovUncalled", side: "D" },
    { at: 21, until: 22, text: "Hamilton wins Johnson County by 20+", means: "Kansas in play", side: "D" },
    { at: 22, text: "Iowa farm-county GOP turnout below 2022", means: "farmers fleeing the GOP", side: "D" },
    { at: 19, until: 23, text: "GA governor called for Jackson (R) before Atlanta reports", means: "no wave", check: "gaGovEarly", side: "R" },
    { at: 23, text: "Abbott uncalled, lead shrinking", means: "GOP trouble", check: "txAbbottUncalled", side: "D" },
    { at: 23, text: "Polls close in Alaska", means: "" },
    { at: 27, text: "Senate control still unresolved", means: "GOP beat the polls, or Alaska/Maine pending", check: "senUnresolved", side: "R" },
  ],
  notes: "Maine's ranked-choice count could take days; Alaska's ranked-choice tabulation doesn't start until Nov. 18.",
};

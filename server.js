const express = require("express");
const axios   = require("axios");
const cron    = require("node-cron");
const cors    = require("cors");
const https   = require("https");

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ── API Keys ───────────────────────────────────────────────────────────────
const ODDS_KEY = process.env.ODDS_KEY || "d798eaddfb18067ac60181fee84d9f9a";

// ── In-memory cache ────────────────────────────────────────────────────────
let cache = {
  basketball : [],
  football   : [],
  baseball   : [],
  hockey     : [],
  all        : [],
  lastUpdated: null
};

// Separate store for odds data (refreshed every 5 min)
let oddsStore = {
  basketball: [], football: [], baseball: [], hockey: []
};

// ══════════════════════════════════════════════════════════════════
//  ESPN PUBLIC APIs  (no key needed, clean JSON, refreshes every 60s)
// ══════════════════════════════════════════════════════════════════

const ESPN_ENDPOINTS = {
  basketball: [
    { url: "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard",   league: "NBA" },
    { url: "https://site.api.espn.com/apis/site/v2/sports/basketball/wnba/scoreboard",  league: "WNBA" },
    { url: "https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/scoreboard", league: "NCAA" }
  ],
  football: [
    { url: "https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/scoreboard",                league: "Premier League" },
    { url: "https://site.api.espn.com/apis/site/v2/sports/soccer/esp.1/scoreboard",                league: "La Liga" },
    { url: "https://site.api.espn.com/apis/site/v2/sports/soccer/ger.1/scoreboard",                league: "Bundesliga" },
    { url: "https://site.api.espn.com/apis/site/v2/sports/soccer/ita.1/scoreboard",                league: "Serie A" },
    { url: "https://site.api.espn.com/apis/site/v2/sports/soccer/fra.1/scoreboard",                league: "Ligue 1" },
    { url: "https://site.api.espn.com/apis/site/v2/sports/soccer/UEFA.Champions_League/scoreboard", league: "Champions League" }
  ],
  baseball: [
    { url: "https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard", league: "MLB" }
  ],
  hockey: [
    { url: "https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/scoreboard", league: "NHL" }
  ]
};

const ESPN_HEADERS = {
  "User-Agent": "Mozilla/5.0 (compatible; BallIQ/1.0)",
  "Accept"    : "application/json"
};

async function fetchESPNSport(sport) {
  const endpoints = ESPN_ENDPOINTS[sport] || [];
  let allMatches  = [];

  for (const ep of endpoints) {
    try {
      const resp = await axios.get(ep.url, {
        headers: ESPN_HEADERS,
        timeout: 10000
      });
      const matches = parseESPNScoreboard(resp.data, sport, ep.league);
      allMatches    = allMatches.concat(matches);
      console.log(`ESPN ${ep.league}: ${matches.length} matches`);
    } catch (err) {
      console.log(`ESPN failed for ${ep.league}: ${err.message}`);
    }
  }
  return allMatches;
}

function parseESPNScoreboard(data, sport, league) {
  const matches = [];
  const events  = data?.events || [];

  for (const ev of events) {
    try {
      const comp        = ev.competitions?.[0];
      if (!comp) continue;

      const competitors = comp.competitors || [];
      if (competitors.length < 2) continue;

      // ESPN always puts home team first when homeAway = "home"
      const homeComp = competitors.find(c => c.homeAway === "home") || competitors[0];
      const awayComp = competitors.find(c => c.homeAway === "away") || competitors[1];

      const homeTeam  = homeComp.team?.displayName || homeComp.team?.name || "Home";
      const awayTeam  = awayComp.team?.displayName || awayComp.team?.name || "Away";
      const homeScore = parseInt(homeComp.score || "0");
      const awayScore = parseInt(awayComp.score || "0");

      // Status
      const status    = ev.status || {};
      const stateType = status.type?.state || "pre";   // pre, in, post
      const isLive    = stateType === "in";
      const isFinished = stateType === "post";

      // Skip finished games
      if (isFinished) continue;

      // Period / quarter info
      const period    = status.period || 1;
      const clockStr  = status.displayClock || "0:00";
      const quarter   = espnPeriodToQuarter(sport, period, stateType);
      const minute    = parseClockToElapsed(clockStr, sport);

      // Odds from ESPN (sometimes included)
      let homeOdds = 1.91, awayOdds = 1.91;
      const odds = comp.odds?.[0];
      if (odds) {
        // ESPN provides spread, convert to approximate moneyline
        const spread = parseFloat(odds.spread || "0");
        if (!isNaN(spread) && spread !== 0) {
          // Rough conversion: spread to implied win probability
          homeOdds = spreadToDecimalOdds(spread);
          awayOdds = spreadToDecimalOdds(-spread);
        }
      }

      matches.push({
        id             : ev.id || `espn_${sport}_${matches.length}`,
        homeTeam,
        awayTeam,
        homeScore,
        awayScore,
        quarter,
        minuteInQuarter: minute,
        homeOdds,
        awayOdds,
        totalLine      : 0,
        overOdds       : 1.91,
        underOdds      : 1.91,
        league,
        sport,
        isLive,
        source         : "ESPN"
      });
    } catch (e) {
      // skip bad event
    }
  }
  return matches;
}

function espnPeriodToQuarter(sport, period, state) {
  if (state === "pre") return "—";
  if (sport === "football") {
    // Soccer uses minutes
    return state === "in" ? "LIVE" : "FT";
  }
  if (sport === "baseball") {
    return `Inn ${period}`;
  }
  // Basketball and hockey use periods/quarters
  const map = { 1: "Q1", 2: "Q2", 3: "Q3", 4: "Q4" };
  return map[period] || (period > 4 ? "OT" : "Q" + period);
}

function parseClockToElapsed(clockStr, sport) {
  // clockStr is time remaining e.g. "7:34"
  try {
    const parts = clockStr.split(":");
    const minRemaining = parseInt(parts[0]);
    return Math.max(0, 12 - minRemaining); // convert remaining to elapsed
  } catch (e) { return 6; }
}

function spreadToDecimalOdds(spread) {
  // Approximate: every 3 points of spread ≈ 10% win probability shift from 50%
  const prob = Math.min(0.90, Math.max(0.10, 0.5 + (spread * -1) * 0.033));
  return parseFloat((1 / prob).toFixed(2));
}

// ══════════════════════════════════════════════════════════════════
//  THE ODDS API  (new key, refreshes every 5 minutes)
// ══════════════════════════════════════════════════════════════════

const ODDS_SPORTS = {
  basketball : ["basketball_nba", "basketball_euroleague"],
  football   : [
    "soccer_epl",
    "soccer_spain_la_liga",
    "soccer_italy_serie_a",
    "soccer_germany_bundesliga",
    "soccer_france_ligue_one"
  ],
  baseball   : ["baseball_mlb"],
  hockey     : ["icehockey_nhl"]
};

async function fetchOddsForSport(sport) {
  const sportKeys = ODDS_SPORTS[sport] || [];
  let allMatches  = [];

  for (const key of sportKeys) {
    try {
      await sleep(1200); // avoid burst rate limit

      const [oddsResp, scoresResp] = await Promise.all([
        axios.get(`https://api.the-odds-api.com/v4/sports/${key}/odds/`, {
          params : { apiKey: ODDS_KEY, regions: "eu", markets: "h2h,totals", oddsFormat: "decimal" },
          timeout: 12000
        }),
        axios.get(`https://api.the-odds-api.com/v4/sports/${key}/scores/`, {
          params : { apiKey: ODDS_KEY, daysFrom: 1 },
          timeout: 12000
        }).catch(() => ({ data: [] }))
      ]);

      const remaining = oddsResp.headers["x-requests-remaining"];
      console.log(`Odds API ${key}: ${oddsResp.data.length} matches | Quota left: ${remaining}`);

      const scoreMap = buildScoreMap(scoresResp.data);
      const matches  = parseOddsResponse(oddsResp.data, key, sport, scoreMap);
      allMatches     = allMatches.concat(matches);

    } catch (err) {
      if (err.response?.status === 429) {
        console.log(`429 on ${key} — stopping to protect quota`);
        break;
      }
      console.log(`Odds API error for ${key}: ${err.message}`);
    }
  }
  return allMatches;
}

function buildScoreMap(scoresArr) {
  const map = {};
  if (!Array.isArray(scoresArr)) return map;

  for (const g of scoresArr) {
    const home  = g.home_team || "";
    const away  = g.away_team || "";
    const key   = norm(home) + "|" + norm(away);
    const scArr = g.scores || [];
    let hs = 0, as = 0;

    for (const s of scArr) {
      const sc = parseInt(s.score || "0");
      if (s.name === home) hs = sc;
      else as = sc;
    }

    map[key] = {
      homeScore : hs,
      awayScore : as,
      isLive    : !g.completed,
      quarter   : estimateQuarter(hs + as)
    };
  }
  return map;
}

function parseOddsResponse(arr, leagueKey, sport, scoreMap) {
  if (!Array.isArray(arr)) return [];
  const matches = [];

  for (const g of arr) {
    try {
      const home = g.home_team || "";
      const away = g.away_team || "";
      const si   = scoreMap[norm(home) + "|" + norm(away)]
                || fuzzyScore(home, away, scoreMap)
                || { homeScore: 0, awayScore: 0, isLive: false, quarter: "—" };

      const m = {
        id             : g.id || Math.random().toString(36).slice(2),
        homeTeam       : home,
        awayTeam       : away,
        homeScore      : si.homeScore,
        awayScore      : si.awayScore,
        quarter        : si.quarter,
        minuteInQuarter: 6,
        homeOdds       : 1.91,
        awayOdds       : 1.91,
        totalLine      : 0,
        overOdds       : 1.91,
        underOdds      : 1.91,
        league         : leagueToName(leagueKey),
        sport,
        isLive         : si.isLive,
        source         : "TheOddsAPI",
        commenceTime   : g.commence_time || ""
      };

      for (const book of (g.bookmakers || [])) {
        for (const mkt of (book.markets || [])) {
          if (mkt.key === "h2h") {
            for (const o of (mkt.outcomes || [])) {
              if (o.name === home)      m.homeOdds = o.price;
              else if (o.name === away) m.awayOdds = o.price;
            }
          } else if (mkt.key === "totals") {
            for (const o of (mkt.outcomes || [])) {
              if (o.name === "Over")  { m.overOdds = o.price; m.totalLine = o.point || m.totalLine; }
              if (o.name === "Under") { m.underOdds = o.price; if (!m.totalLine) m.totalLine = o.point; }
            }
          }
        }
        break; // first bookmaker only
      }

      if (m.homeOdds > 1.0 && m.awayOdds > 1.0) matches.push(m);
    } catch (e) { /* skip */ }
  }
  return matches;
}

// ══════════════════════════════════════════════════════════════════
//  MERGE  (ESPN scores + Odds API odds → one rich match object)
// ══════════════════════════════════════════════════════════════════

function mergeESPNWithOdds(espnMatches, oddsMatches) {
  const result = [...espnMatches];

  for (const espn of result) {
    // Find matching odds entry by team name fuzzy match
    const oddsMatch = oddsMatches.find(o =>
      norm(o.homeTeam).includes(lastWord(espn.homeTeam)) &&
      norm(o.awayTeam).includes(lastWord(espn.awayTeam))
    );
    if (oddsMatch) {
      // Enrich ESPN entry with real odds
      espn.homeOdds  = oddsMatch.homeOdds;
      espn.awayOdds  = oddsMatch.awayOdds;
      espn.totalLine = oddsMatch.totalLine;
      espn.overOdds  = oddsMatch.overOdds;
      espn.underOdds = oddsMatch.underOdds;
    }
  }

  // Add odds-only matches (upcoming games not on ESPN scoreboard yet)
  for (const odds of oddsMatches) {
    const alreadyIn = result.find(e =>
      norm(e.homeTeam).includes(lastWord(odds.homeTeam)) &&
      norm(e.awayTeam).includes(lastWord(odds.awayTeam))
    );
    if (!alreadyIn) result.push(odds);
  }

  return result;
}

// ══════════════════════════════════════════════════════════════════
//  REFRESH FUNCTIONS
// ══════════════════════════════════════════════════════════════════

async function refreshESPN() {
  console.log(`[${new Date().toISOString()}] Refreshing ESPN scores…`);
  const sports = ["basketball", "football", "baseball", "hockey"];

  await Promise.all(sports.map(async (sport) => {
    try {
      const espnMatches = await fetchESPNSport(sport);
      cache[sport]      = mergeESPNWithOdds(espnMatches, oddsStore[sport]);
    } catch (err) {
      console.error(`ESPN refresh error for ${sport}: ${err.message}`);
    }
  }));

  rebuildAll();
}

async function refreshOdds() {
  console.log(`[${new Date().toISOString()}] Refreshing Odds API…`);
  const sports = ["basketball", "football", "baseball", "hockey"];

  for (const sport of sports) {
    try {
      const matches     = await fetchOddsForSport(sport);
      oddsStore[sport]  = matches;
      // Re-merge with latest ESPN data
      const espnMatches = cache[sport].filter(m => m.source === "ESPN");
      cache[sport]      = mergeESPNWithOdds(espnMatches, matches);
    } catch (err) {
      console.error(`Odds refresh error for ${sport}: ${err.message}`);
    }
    await sleep(2000);
  }

  rebuildAll();
}

function rebuildAll() {
  cache.all = [
    ...cache.basketball,
    ...cache.football,
    ...cache.baseball,
    ...cache.hockey
  ];
  cache.lastUpdated = new Date().toISOString();
  console.log(`✅ Cache updated. Total: ${cache.all.length} matches`);
}

// ══════════════════════════════════════════════════════════════════
//  API ROUTES
// ══════════════════════════════════════════════════════════════════

app.get("/api/health", (req, res) => {
  res.json({
    status     : "ok",
    lastUpdated: cache.lastUpdated,
    counts     : {
      all        : cache.all.length,
      basketball : cache.basketball.length,
      football   : cache.football.length,
      baseball   : cache.baseball.length,
      hockey     : cache.hockey.length
    }
  });
});

app.get("/api/matches", (req, res) => {
  const sport = req.query.sport || "all";
  const data  = cache[sport] || cache.all;
  res.json({ sport, count: data.length, lastUpdated: cache.lastUpdated, matches: data });
});

app.get("/api/matches/all", (req, res) => {
  res.json({ count: cache.all.length, lastUpdated: cache.lastUpdated, matches: cache.all });
});

app.post("/api/refresh", async (req, res) => {
  await Promise.all([refreshESPN(), refreshOdds()]);
  res.json({ status: "refreshed", count: cache.all.length });
});

// ══════════════════════════════════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════════════════════════════════

function estimateQuarter(totalPts) {
  if (totalPts < 55)  return "Q1";
  if (totalPts < 115) return "Q2";
  if (totalPts < 170) return "Q3";
  return "Q4";
}

function norm(s)     { return (s || "").toLowerCase().trim(); }

function lastWord(s) {
  if (!s) return "";
  return s.trim().split(/\s+/).pop().toLowerCase();
}

function fuzzyScore(home, away, map) {
  const hW = lastWord(home), aW = lastWord(away);
  for (const [k, v] of Object.entries(map)) {
    if (k.includes(hW) && k.includes(aW)) return v;
  }
  return null;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function leagueToName(key) {
  const map = {
    basketball_nba            : "NBA",
    basketball_euroleague     : "EuroLeague",
    soccer_epl                : "Premier League",
    soccer_spain_la_liga      : "La Liga",
    soccer_italy_serie_a      : "Serie A",
    soccer_germany_bundesliga : "Bundesliga",
    soccer_france_ligue_one   : "Ligue 1",
    baseball_mlb              : "MLB",
    icehockey_nhl             : "NHL"
  };
  return map[key] || key;
}

// ══════════════════════════════════════════════════════════════════
//  KEEP-ALIVE
// ══════════════════════════════════════════════════════════════════

setInterval(() => {
  const url = process.env.RENDER_EXTERNAL_URL;
  if (url) {
    https.get(url + "/api/health", (res) => {
      console.log(`Keep-alive: ${res.statusCode}`);
    }).on("error", () => {});
  }
}, 14 * 60 * 1000);

// ══════════════════════════════════════════════════════════════════
//  CRON SCHEDULES
// ══════════════════════════════════════════════════════════════════

// ESPN live scores — every 60 seconds, completely free
cron.schedule("* * * * *", refreshESPN);

// Odds API — every 5 minutes to protect quota
cron.schedule("*/5 * * * *", refreshOdds);

// ══════════════════════════════════════════════════════════════════
//  STARTUP
// ══════════════════════════════════════════════════════════════════

(async () => {
  await refreshOdds();  // odds first
  await refreshESPN();  // then live scores
})();

app.listen(PORT, () => {
  console.log(`BallIQ backend running on port ${PORT}`);
});

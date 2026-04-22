const express = require("express");
const axios   = require("axios");
const cheerio = require("cheerio");
const cron    = require("node-cron");
const cors    = require("cors");
const https   = require("https");

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ── API Keys ───────────────────────────────────────────────────────────────
const ODDS_KEY = process.env.ODDS_KEY || "07dd34f3881dacd8b47b80bd58051a24";

// ── In-memory cache ────────────────────────────────────────────────────────
let cache = {
  basketball : [],
  football   : [],
  tennis     : [],
  baseball   : [],
  hockey     : [],
  all        : [],
  lastUpdated: null
};

// ══════════════════════════════════════════════════════════════════
//  AISCORE SCRAPER
// ══════════════════════════════════════════════════════════════════

const AI_HEADERS = {
  "User-Agent"      : "Mozilla/5.0 (Linux; Android 12; Mobile) AppleWebKit/537.36 Chrome/112.0 Mobile Safari/537.36",
  "Accept"          : "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language" : "en-US,en;q=0.5",
  "Referer"         : "https://m.aiscore.com/"
};

const AI_API = "https://api.aiscore.com";

async function fetchAiScoreSport(sport) {
  const sportMap = { football: 1, basketball: 2, tennis: 13, baseball: 16, hockey: 17 };
  const code = sportMap[sport] || 2;

  try {
    const resp = await axios.get(`${AI_API}/api/v1/competition/live`, {
      params  : { sport: code, lang: "en" },
      headers : AI_HEADERS,
      timeout : 12000
    });
    return parseAiScoreResponse(resp.data, sport);
  } catch (err) {
    console.log(`AiScore API failed for ${sport}: ${err.message} — trying HTML scrape`);
    return scrapeAiScorePage(sport);
  }
}

function parseAiScoreResponse(data, sport) {
  const matches = [];
  if (!data || !data.data) return matches;

  const comps = data.data.competitions || data.data || [];
  for (const comp of comps) {
    const events = comp.events || comp.matches || [];
    for (const ev of events) {
      try {
        const m = {
          id             : String(ev.id || ev.event_id || Math.random()),
          homeTeam       : ev.home_name || ev.home?.name || "Home",
          awayTeam       : ev.away_name || ev.away?.name || "Away",
          homeScore      : parseInt(ev.home_score || ev.score?.home || 0),
          awayScore      : parseInt(ev.away_score || ev.score?.away || 0),
          quarter        : parseStatus(ev.status_name || ev.time_str || ev.status || ""),
          minuteInQuarter: 6,
          homeOdds       : 1.91,
          awayOdds       : 1.91,
          totalLine      : sport === "basketball" ? 220.5 : 0,
          overOdds       : 1.91,
          underOdds      : 1.91,
          league         : comp.competition_name || comp.league || "League",
          sport          : sport,
          isLive         : true,
          source         : "AiScore"
        };
        if (m.homeTeam !== "Home" && m.awayTeam !== "Away") {
          matches.push(m);
        }
      } catch (e) { /* skip bad event */ }
    }
  }
  return matches;
}

async function scrapeAiScorePage(sport) {
  const sportPath = {
    football   : "football",
    basketball : "basketball",
    tennis     : "tennis",
    baseball   : "baseball",
    hockey     : "ice-hockey"
  }[sport] || "basketball";

  try {
    const resp = await axios.get(`https://m.aiscore.com/${sportPath}`, {
      headers: AI_HEADERS,
      timeout: 12000
    });
    const $       = cheerio.load(resp.data);
    const matches = [];
    let idCount   = 0;

    $("li, div").each((_, el) => {
      const elClass = $(el).attr("class") || "";
      if (!elClass.includes("match") && !elClass.includes("event")) return;

      const teams  = $(el).find("[class*=team],[class*=name]");
      const scores = $(el).find("[class*=score],[class*=result]");

      if (teams.length >= 2) {
        const m = {
          id             : `ai_${sport}_${idCount++}`,
          homeTeam       : teams.eq(0).text().trim(),
          awayTeam       : teams.eq(1).text().trim(),
          homeScore      : parseScore(scores.eq(0).text()),
          awayScore      : parseScore(scores.eq(1).text()),
          quarter        : "LIVE",
          minuteInQuarter: 6,
          homeOdds       : 1.91,
          awayOdds       : 1.91,
          totalLine      : 0,
          overOdds       : 1.91,
          underOdds      : 1.91,
          league         : "Live",
          sport          : sport,
          isLive         : true,
          source         : "AiScore-HTML"
        };
        if (m.homeTeam.length > 1 && m.awayTeam.length > 1) {
          matches.push(m);
        }
      }
    });
    return matches;
  } catch (err) {
    console.log(`AiScore HTML scrape failed for ${sport}: ${err.message}`);
    return [];
  }
}

// ══════════════════════════════════════════════════════════════════
//  THE ODDS API
// ══════════════════════════════════════════════════════════════════

const ODDS_SPORTS = {
  basketball : ["basketball_nba", "basketball_euroleague", "basketball_ncaab"],
  football   : [
    "soccer_epl", "soccer_spain_la_liga", "soccer_italy_serie_a",
    "soccer_germany_bundesliga", "soccer_france_ligue_one",
    "soccer_uefa_champs_league"
  ],
  tennis     : ["tennis_atp", "tennis_wta"],
  baseball   : ["baseball_mlb"],
  hockey     : ["icehockey_nhl"]
};

async function fetchOddsForSport(sport) {
  const sportKeys = ODDS_SPORTS[sport] || [];
  let allMatches  = [];

  for (const key of sportKeys) {
    try {
      const [oddsResp, scoresResp] = await Promise.all([
        axios.get(`https://api.the-odds-api.com/v4/sports/${key}/odds/`, {
          params : {
            apiKey     : ODDS_KEY,
            regions    : "eu",
            markets    : "h2h,totals",
            oddsFormat : "decimal"
          },
          timeout: 10000
        }),
        axios.get(`https://api.the-odds-api.com/v4/sports/${key}/scores/`, {
          params : { apiKey: ODDS_KEY, daysFrom: 1 },
          timeout: 10000
        }).catch(() => ({ data: [] }))
      ]);

      const scoreMap = buildScoreMap(scoresResp.data);
      const matches  = parseOddsResponse(oddsResp.data, key, sport, scoreMap);
      allMatches     = allMatches.concat(matches);
    } catch (err) {
      console.log(`Odds API failed for ${key}: ${err.message}`);
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
      completed : g.completed,
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
                || { homeScore: 0, awayScore: 0, isLive: true, quarter: "—" };

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
        sport          : sport,
        isLive         : si.isLive,
        source         : "TheOddsAPI",
        commenceTime   : g.commence_time || ""
      };

      // Parse bookmaker odds — use first available bookmaker
      const books = g.bookmakers || [];
      for (const book of books) {
        for (const mkt of (book.markets || [])) {
          if (mkt.key === "h2h") {
            for (const o of (mkt.outcomes || [])) {
              if (o.name === home)      m.homeOdds = o.price;
              else if (o.name === away) m.awayOdds = o.price;
            }
          } else if (mkt.key === "totals") {
            for (const o of (mkt.outcomes || [])) {
              if (o.name === "Over") {
                m.overOdds  = o.price;
                m.totalLine = o.point || m.totalLine;
              }
              if (o.name === "Under") {
                m.underOdds = o.price;
                if (!m.totalLine) m.totalLine = o.point;
              }
            }
          }
        }
        break; // first bookmaker is enough
      }

      if (m.homeOdds > 1.0 && m.awayOdds > 1.0) {
        matches.push(m);
      }
    } catch (e) { /* skip bad game */ }
  }
  return matches;
}

// ══════════════════════════════════════════════════════════════════
//  MAIN REFRESH
// ══════════════════════════════════════════════════════════════════

async function refreshAll() {
  console.log(`[${new Date().toISOString()}] Refreshing all sports…`);
  const sports = ["basketball", "football", "tennis", "baseball", "hockey"];

  await Promise.all(sports.map(async (sport) => {
    try {
      const [aiMatches, oddsMatches] = await Promise.all([
        fetchAiScoreSport(sport),
        fetchOddsForSport(sport)
      ]);

      const merged  = mergeMatches(oddsMatches, aiMatches);
      cache[sport]  = merged.length > 0 ? merged : aiMatches;
    } catch (err) {
      console.error(`Refresh error for ${sport}: ${err.message}`);
    }
  }));

  cache.all = [
    ...cache.basketball,
    ...cache.football,
    ...cache.tennis,
    ...cache.baseball,
    ...cache.hockey
  ];
  cache.lastUpdated = new Date().toISOString();
  console.log(`✅ Done. Total matches cached: ${cache.all.length}`);
}

function mergeMatches(primary, secondary) {
  const result = [...primary];

  for (const s of secondary) {
    const exists = primary.find(p =>
      norm(p.homeTeam).includes(lastWord(s.homeTeam)) &&
      norm(p.awayTeam).includes(lastWord(s.awayTeam))
    );
    if (!exists) {
      result.push(s);
    } else if (s.homeScore > 0 && exists.homeScore === 0) {
      // Enrich primary with live score from AiScore
      exists.homeScore = s.homeScore;
      exists.awayScore = s.awayScore;
      exists.quarter   = s.quarter;
      exists.isLive    = true;
    }
  }
  return result;
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
      tennis     : cache.tennis.length,
      baseball   : cache.baseball.length,
      hockey     : cache.hockey.length
    }
  });
});

app.get("/api/matches", (req, res) => {
  const sport = req.query.sport || "all";
  const data  = cache[sport] || cache.all;
  res.json({
    sport      : sport,
    count      : data.length,
    lastUpdated: cache.lastUpdated,
    matches    : data
  });
});

app.get("/api/matches/all", (req, res) => {
  res.json({
    count      : cache.all.length,
    lastUpdated: cache.lastUpdated,
    matches    : cache.all
  });
});

app.post("/api/refresh", async (req, res) => {
  await refreshAll();
  res.json({ status: "refreshed", count: cache.all.length });
});

// ══════════════════════════════════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════════════════════════════════

function parseStatus(s) {
  if (!s) return "—";
  s = s.toUpperCase();
  if (s.includes("1ST") || s.includes("Q1") || s === "1") return "Q1";
  if (s.includes("2ND") || s.includes("Q2") || s === "2") return "Q2";
  if (s.includes("HT")  || s.includes("HALF"))             return "HT";
  if (s.includes("3RD") || s.includes("Q3") || s === "3") return "Q3";
  if (s.includes("4TH") || s.includes("Q4") || s === "4") return "Q4";
  if (s.includes("OT")  || s.includes("OVER"))             return "OT";
  if (s.includes("LIVE"))                                   return "LIVE";
  if (s.match(/^\d+[']/))                                   return s.slice(0, 6);
  return s.slice(0, 6);
}

function estimateQuarter(totalPts) {
  if (totalPts < 55)  return "Q1";
  if (totalPts < 115) return "Q2";
  if (totalPts < 170) return "Q3";
  return "Q4";
}

function parseScore(s) {
  const n = parseInt((s || "").replace(/[^0-9]/g, ""));
  return isNaN(n) ? 0 : n;
}

function norm(s) {
  return (s || "").toLowerCase().trim();
}

function lastWord(s) {
  if (!s) return "";
  const parts = s.trim().split(/\s+/);
  return parts[parts.length - 1].toLowerCase();
}

function fuzzyScore(home, away, map) {
  const hW = lastWord(home);
  const aW = lastWord(away);
  for (const [k, v] of Object.entries(map)) {
    if (k.includes(hW) && k.includes(aW)) return v;
  }
  return null;
}

function leagueToName(key) {
  const map = {
    basketball_nba            : "NBA",
    basketball_euroleague     : "EuroLeague",
    basketball_ncaab          : "NCAAB",
    soccer_epl                : "Premier League",
    soccer_spain_la_liga      : "La Liga",
    soccer_italy_serie_a      : "Serie A",
    soccer_germany_bundesliga : "Bundesliga",
    soccer_france_ligue_one   : "Ligue 1",
    soccer_uefa_champs_league : "Champions League",
    tennis_atp                : "ATP Tennis",
    tennis_wta                : "WTA Tennis",
    baseball_mlb              : "MLB",
    icehockey_nhl             : "NHL"
  };
  return map[key] || key;
}

// ══════════════════════════════════════════════════════════════════
//  KEEP-ALIVE (prevents Render free tier from sleeping)
// ══════════════════════════════════════════════════════════════════

setInterval(() => {
  const url = process.env.RENDER_EXTERNAL_URL;
  if (url) {
    https.get(url + "/api/health", (res) => {
      console.log(`Keep-alive ping: ${res.statusCode}`);
    }).on("error", (err) => {
      console.log(`Keep-alive failed: ${err.message}`);
    });
  }
}, 14 * 60 * 1000); // every 14 minutes

// ══════════════════════════════════════════════════════════════════
//  STARTUP
// ══════════════════════════════════════════════════════════════════

cron.schedule("* * * * *", refreshAll);

refreshAll();

app.listen(PORT, () => {
  console.log(`BallIQ backend running on port ${PORT}`);
});
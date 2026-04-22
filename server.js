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
//  AISCORE HTML SCRAPER  (runs every 60s — no rate limit)
// ══════════════════════════════════════════════════════════════════

const AI_HEADERS = {
  "User-Agent"      : "Mozilla/5.0 (Linux; Android 12; Mobile) AppleWebKit/537.36 Chrome/112.0 Mobile Safari/537.36",
  "Accept"          : "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language" : "en-US,en;q=0.5",
  "Referer"         : "https://m.aiscore.com/"
};

const AI_SPORT_PATHS = {
  basketball : "basketball",
  football   : "football",
  tennis     : "tennis",
  baseball   : "baseball",
  hockey     : "ice-hockey"
};

async function scrapeAiScorePage(sport) {
  const path = AI_SPORT_PATHS[sport] || "basketball";
  try {
    const resp = await axios.get(`https://m.aiscore.com/${path}`, {
      headers: AI_HEADERS,
      timeout: 15000
    });
    const $       = cheerio.load(resp.data);
    const matches = [];
    let   idCount = 0;

    // AiScore mobile wraps each match in a specific list item
    // Try multiple selector patterns to be resilient to DOM changes
    const selectors = [
      ".match-list-item",
      ".event-item",
      ".live-match",
      "li[class*='match']",
      "div[class*='match-item']",
      "div[class*='event-row']"
    ];

    let found = false;
    for (const sel of selectors) {
      const els = $(sel);
      if (els.length > 0) {
        els.each((_, el) => {
          const m = extractMatchFromEl($, el, sport, idCount++);
          if (m) matches.push(m);
        });
        found = true;
        break;
      }
    }

    // Generic fallback: scan all elements with score-like content
    if (!found || matches.length === 0) {
      $("*").each((_, el) => {
        const cls = ($(el).attr("class") || "").toLowerCase();
        if ((cls.includes("match") || cls.includes("event")) &&
             !cls.includes("container") && !cls.includes("list") &&
             !cls.includes("wrapper") && !cls.includes("header")) {
          const m = extractMatchFromEl($, el, sport, idCount++);
          if (m) matches.push(m);
        }
      });
    }

    console.log(`AiScore ${sport}: scraped ${matches.length} matches`);
    return matches;
  } catch (err) {
    console.log(`AiScore scrape failed for ${sport}: ${err.message}`);
    return [];
  }
}

function extractMatchFromEl($, el, sport, id) {
  try {
    // Team names
    const teamEls = $(el).find("[class*='team'],[class*='name'],[class*='club']");
    if (teamEls.length < 2) return null;

    const homeTeam = teamEls.eq(0).text().trim();
    const awayTeam = teamEls.eq(1).text().trim();
    if (!homeTeam || !awayTeam || homeTeam.length < 2 || awayTeam.length < 2) return null;
    if (homeTeam === awayTeam) return null;

    // Scores
    const scoreEls = $(el).find("[class*='score'],[class*='result'],[class*='goal']");
    let homeScore = 0, awayScore = 0;
    if (scoreEls.length >= 2) {
      homeScore = parseScore(scoreEls.eq(0).text());
      awayScore = parseScore(scoreEls.eq(1).text());
    } else if (scoreEls.length === 1) {
      const raw = scoreEls.eq(0).text().replace(/\s/g, "");
      const sep = raw.includes("-") ? "-" : raw.includes(":") ? ":" : null;
      if (sep) {
        const parts = raw.split(sep);
        homeScore = parseScore(parts[0]);
        awayScore = parseScore(parts[1] || "0");
      }
    }

    // Status / period
    const statusEl = $(el).find("[class*='status'],[class*='time'],[class*='period'],[class*='min']");
    const quarter  = statusEl.length > 0 ? parseStatus(statusEl.first().text()) : "LIVE";

    // League name
    const leagueEl = $(el).find("[class*='league'],[class*='competition'],[class*='tour']");
    const league   = leagueEl.length > 0 ? leagueEl.first().text().trim() : sportToLeague(sport);

    return {
      id             : `ai_${sport}_${id}`,
      homeTeam,
      awayTeam,
      homeScore,
      awayScore,
      quarter,
      minuteInQuarter: 6,
      homeOdds       : 1.91,
      awayOdds       : 1.91,
      totalLine      : sport === "basketball" ? 220.5 : 0,
      overOdds       : 1.91,
      underOdds      : 1.91,
      league         : league || sportToLeague(sport),
      sport,
      isLive         : true,
      source         : "AiScore"
    };
  } catch (e) {
    return null;
  }
}

// ══════════════════════════════════════════════════════════════════
//  THE ODDS API  (runs every 5 minutes — respects rate limit)
//  Only valid free-tier sport keys used
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
  hockey     : ["icehockey_nhl"],
  tennis     : []  // tennis keys on free tier are event-specific, skip
};

async function fetchOddsForSport(sport) {
  const sportKeys = ODDS_SPORTS[sport] || [];
  let allMatches  = [];

  for (const key of sportKeys) {
    try {
      // Add a small delay between calls to avoid burst rate limiting
      await sleep(1500);

      const [oddsResp, scoresResp] = await Promise.all([
        axios.get(`https://api.the-odds-api.com/v4/sports/${key}/odds/`, {
          params : {
            apiKey     : ODDS_KEY,
            regions    : "eu",
            markets    : "h2h,totals",
            oddsFormat : "decimal"
          },
          timeout: 12000
        }),
        axios.get(`https://api.the-odds-api.com/v4/sports/${key}/scores/`, {
          params : { apiKey: ODDS_KEY, daysFrom: 1 },
          timeout: 12000
        }).catch(() => ({ data: [] }))
      ]);

      // Log remaining API quota
      const remaining = oddsResp.headers["x-requests-remaining"];
      if (remaining) console.log(`Odds API quota remaining: ${remaining}`);

      const scoreMap = buildScoreMap(scoresResp.data);
      const matches  = parseOddsResponse(oddsResp.data, key, sport, scoreMap);
      allMatches     = allMatches.concat(matches);
      console.log(`Odds API ${key}: got ${matches.length} matches`);
    } catch (err) {
      if (err.response?.status === 429) {
        console.log(`429 rate limit hit for ${key} — skipping remaining keys for ${sport}`);
        break; // Stop hitting more endpoints for this sport
      }
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
        sport,
        isLive         : si.isLive,
        source         : "TheOddsAPI",
        commenceTime   : g.commence_time || ""
      };

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
              if (o.name === "Over")  { m.overOdds = o.price; m.totalLine = o.point || m.totalLine; }
              if (o.name === "Under") { m.underOdds = o.price; if (!m.totalLine) m.totalLine = o.point; }
            }
          }
        }
        break;
      }

      if (m.homeOdds > 1.0 && m.awayOdds > 1.0) matches.push(m);
    } catch (e) { /* skip */ }
  }
  return matches;
}

// ══════════════════════════════════════════════════════════════════
//  REFRESH STRATEGIES
//  - AiScore: every 60 seconds (free scraping, live scores)
//  - Odds API: every 5 minutes (rate-limited API)
// ══════════════════════════════════════════════════════════════════

let oddsCache = {
  basketball: [], football: [], baseball: [], hockey: [], tennis: []
};

async function refreshAiScore() {
  console.log(`[${new Date().toISOString()}] Refreshing AiScore…`);
  const sports = ["basketball", "football", "tennis", "baseball", "hockey"];

  await Promise.all(sports.map(async (sport) => {
    const aiMatches = await scrapeAiScorePage(sport);
    if (aiMatches.length > 0) {
      // Merge AiScore live scores into existing odds data
      const merged = mergeMatches(oddsCache[sport], aiMatches);
      cache[sport] = merged.length > 0 ? merged : aiMatches;
    } else if (oddsCache[sport].length > 0) {
      cache[sport] = oddsCache[sport]; // keep odds data even if AiScore fails
    }
  }));

  rebuildAll();
}

async function refreshOdds() {
  console.log(`[${new Date().toISOString()}] Refreshing Odds API…`);
  const sports = ["basketball", "football", "baseball", "hockey"];

  for (const sport of sports) {
    const matches = await fetchOddsForSport(sport);
    if (matches.length > 0) {
      oddsCache[sport] = matches;
      // Merge with current AiScore data
      cache[sport] = mergeMatches(matches, cache[sport]);
    }
    await sleep(2000); // 2s gap between sports
  }

  rebuildAll();
}

function rebuildAll() {
  cache.all = [
    ...cache.basketball,
    ...cache.football,
    ...cache.tennis,
    ...cache.baseball,
    ...cache.hockey
  ];
  cache.lastUpdated = new Date().toISOString();
  console.log(`✅ Cache updated. Total: ${cache.all.length} matches`);
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
    sport,
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
  await Promise.all([refreshAiScore(), refreshOdds()]);
  res.json({ status: "refreshed", count: cache.all.length });
});

// ══════════════════════════════════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════════════════════════════════

function parseStatus(s) {
  if (!s) return "LIVE";
  s = s.toUpperCase().trim();
  if (s.includes("1ST") || s.includes("Q1") || s === "1") return "Q1";
  if (s.includes("2ND") || s.includes("Q2") || s === "2") return "Q2";
  if (s.includes("HT")  || s.includes("HALF"))             return "HT";
  if (s.includes("3RD") || s.includes("Q3") || s === "3") return "Q3";
  if (s.includes("4TH") || s.includes("Q4") || s === "4") return "Q4";
  if (s.includes("OT")  || s.includes("OVER"))             return "OT";
  if (s.match(/^\d+['′]/))                                  return s.slice(0, 5);
  if (s.includes("LIVE") || s.includes("PROGRESS"))        return "LIVE";
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

function sportToLeague(sport) {
  const m = { basketball:"NBA", football:"Football", tennis:"Tennis",
               baseball:"MLB", hockey:"NHL" };
  return m[sport] || sport;
}

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
//  KEEP-ALIVE  (prevents Render free tier sleep)
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

// AiScore every 60 seconds
cron.schedule("* * * * *", refreshAiScore);

// Odds API every 5 minutes (saves your monthly quota)
cron.schedule("*/5 * * * *", refreshOdds);

// ══════════════════════════════════════════════════════════════════
//  STARTUP
// ══════════════════════════════════════════════════════════════════

(async () => {
  await refreshOdds();   // Odds first (provides base data with odds)
  await refreshAiScore(); // AiScore second (enriches with live scores)
})();

app.listen(PORT, () => {
  console.log(`BallIQ backend running on port ${PORT}`);
});    

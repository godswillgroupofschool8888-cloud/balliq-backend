const express = require("express");
const axios   = require("axios");
const cron    = require("node-cron");
const cors    = require("cors");
const https   = require("https");

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "10mb" }));

// ── Keys ───────────────────────────────────────────────────────────────────
const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY || "";

// ── Cache ──────────────────────────────────────────────────────────────────
let cache = {
  basketball: [], football: [], baseball: [],
  hockey: [], tennis: [], all: [], lastUpdated: null
};

// ══════════════════════════════════════════════════════════════════
//  ESPN  (primary — clean JSON, no key)
// ══════════════════════════════════════════════════════════════════

const ESPN_ENDPOINTS = {
  basketball: [
    { url: "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard",  league: "NBA" },
    { url: "https://site.api.espn.com/apis/site/v2/sports/basketball/wnba/scoreboard", league: "WNBA" },
    { url: "https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/scoreboard", league: "NCAA" }
  ],
  football: [
    { url: "https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/scoreboard",                 league: "Premier League" },
    { url: "https://site.api.espn.com/apis/site/v2/sports/soccer/esp.1/scoreboard",                 league: "La Liga" },
    { url: "https://site.api.espn.com/apis/site/v2/sports/soccer/ger.1/scoreboard",                 league: "Bundesliga" },
    { url: "https://site.api.espn.com/apis/site/v2/sports/soccer/ita.1/scoreboard",                 league: "Serie A" },
    { url: "https://site.api.espn.com/apis/site/v2/sports/soccer/fra.1/scoreboard",                 league: "Ligue 1" },
    { url: "https://site.api.espn.com/apis/site/v2/sports/soccer/UEFA.Champions_League/scoreboard", league: "Champions League" }
  ],
  baseball: [
    { url: "https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard", league: "MLB" }
  ],
  hockey: [
    { url: "https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/scoreboard", league: "NHL" }
  ],
  tennis: [
    { url: "https://site.api.espn.com/apis/site/v2/sports/tennis/scoreboard", league: "ATP/WTA" }
  ]
};

const ESPN_HEADERS = {
  "User-Agent": "Mozilla/5.0 (compatible; BallIQ/2.0)",
  "Accept"    : "application/json"
};

async function fetchESPNSport(sport) {
  const endpoints = ESPN_ENDPOINTS[sport] || [];
  let all = [];
  for (const ep of endpoints) {
    try {
      const resp    = await axios.get(ep.url, { headers: ESPN_HEADERS, timeout: 10000 });
      const matches = parseESPN(resp.data, sport, ep.league);
      all           = all.concat(matches);
      console.log(`ESPN ${ep.league}: ${matches.length} matches`);
    } catch (err) {
      console.log(`ESPN ${ep.league} failed: ${err.message}`);
    }
  }
  return all;
}

function parseESPN(data, sport, league) {
  const matches = [];
  const events  = data?.events || [];

  for (const ev of events) {
    try {
      const comp        = ev.competitions?.[0];
      if (!comp) continue;
      const competitors = comp.competitors || [];
      if (competitors.length < 2) continue;

      const homeC = competitors.find(c => c.homeAway === "home") || competitors[0];
      const awayC = competitors.find(c => c.homeAway === "away") || competitors[1];

      const status    = ev.status || {};
      const stateType = status.type?.state || "pre";
      if (stateType === "post") continue; // skip finished

      // Quarter-by-quarter scores
      const homeQScores = (homeC.linescores || []).map(s => parseInt(s.value || 0));
      const awayQScores = (awayC.linescores || []).map(s => parseInt(s.value || 0));

      // Team stats if available
      const homeStats = extractESPNStats(homeC);
      const awayStats = extractESPNStats(awayC);

      // Injuries
      const injuries = extractInjuries(comp);

      matches.push({
        id              : ev.id || `espn_${matches.length}`,
        homeTeam        : homeC.team?.displayName || "Home",
        awayTeam        : awayC.team?.displayName || "Away",
        homeScore       : parseInt(homeC.score || "0"),
        awayScore       : parseInt(awayC.score || "0"),
        homeQScores,
        awayQScores,
        quarter         : espnPeriod(sport, status.period || 1, stateType, status.displayClock),
        minuteInQuarter : parseClockElapsed(status.displayClock || "12:00"),
        homeOdds        : 1.91,
        awayOdds        : 1.91,
        totalLine       : 0,
        overOdds        : 1.91,
        underOdds       : 1.91,
        league,
        sport,
        isLive          : stateType === "in",
        source          : "ESPN",
        homeStats,
        awayStats,
        injuries,
        commenceTime    : ev.date || ""
      });
    } catch (e) { /* skip */ }
  }
  return matches;
}

function extractESPNStats(competitor) {
  const stats = {};
  const raw   = competitor.statistics || [];
  for (const s of raw) {
    stats[s.name] = s.displayValue || s.value;
  }
  return stats;
}

function extractInjuries(comp) {
  const list = [];
  const geo  = comp.geoBroadcasts || [];
  // ESPN sometimes includes injuries in notes
  const notes = comp.notes || [];
  for (const n of notes) {
    if (n.text && n.text.toLowerCase().includes("out")) {
      list.push(n.text);
    }
  }
  return list;
}

function espnPeriod(sport, period, state, clock) {
  if (state === "pre") return "PRE";
  if (sport === "football") return state === "in" ? (clock || "LIVE") : "FT";
  if (sport === "baseball") return `Inn ${period}`;
  if (sport === "tennis")   return `Set ${period}`;
  const map = { 1:"Q1", 2:"Q2", 3:"Q3", 4:"Q4" };
  return map[period] || (period > 4 ? "OT" : `Q${period}`);
}

function parseClockElapsed(clockStr) {
  try {
    const parts = (clockStr || "12:00").split(":");
    return Math.max(0, 12 - parseInt(parts[0]));
  } catch (e) { return 6; }
}

// ══════════════════════════════════════════════════════════════════
//  SOFASCORE  (secondary — enriches stats, no key)
// ══════════════════════════════════════════════════════════════════

const SOFA_SPORTS = {
  basketball: "basketball",
  football  : "football",
  baseball  : "baseball",
  hockey    : "ice-hockey",
  tennis    : "tennis"
};

const SOFA_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Linux; Android 12; Mobile) AppleWebKit/537.36",
  "Accept"    : "application/json",
  "Referer"   : "https://www.sofascore.com/"
};

async function fetchSofaLive(sport) {
  const sportName = SOFA_SPORTS[sport] || "basketball";
  try {
    const resp = await axios.get(
      `https://api.sofascore.com/api/v1/sport/${sportName}/events/live`,
      { headers: SOFA_HEADERS, timeout: 10000 }
    );
    return parseSofaScore(resp.data, sport);
  } catch (err) {
    console.log(`SofaScore ${sport} failed: ${err.message}`);
    return [];
  }
}

function parseSofaScore(data, sport) {
  const matches = [];
  const events  = data?.events || [];

  for (const ev of events) {
    try {
      const hs = ev.homeScore || {};
      const as = ev.awayScore || {};
      const st = ev.status   || {};

      const homeQScores = [hs.period1||0, hs.period2||0, hs.period3||0, hs.period4||0].filter((v,i) => i < (st.currentPeriodStartTimestamp ? 4 : 2));
      const awayQScores = [as.period1||0, as.period2||0, as.period3||0, as.period4||0].filter((v,i) => i < homeQScores.length);

      matches.push({
        id             : `sofa_${ev.id || matches.length}`,
        homeTeam       : ev.homeTeam?.name || "",
        awayTeam       : ev.awayTeam?.name || "",
        homeScore      : hs.current || 0,
        awayScore      : as.current || 0,
        homeQScores,
        awayQScores,
        quarter        : sofaStatus(sport, st),
        minuteInQuarter: 6,
        homeOdds       : 1.91,
        awayOdds       : 1.91,
        totalLine      : 0,
        overOdds       : 1.91,
        underOdds      : 1.91,
        league         : ev.tournament?.name || sport,
        sport,
        isLive         : st.type === "inprogress",
        source         : "SofaScore",
        homeStats      : {},
        awayStats      : {},
        injuries       : []
      });
    } catch (e) { /* skip */ }
  }
  return matches;
}

function sofaStatus(sport, st) {
  const desc = (st.description || "").toLowerCase();
  if (desc.includes("1st") || desc.includes("q1")) return "Q1";
  if (desc.includes("2nd") || desc.includes("q2")) return "Q2";
  if (desc.includes("half"))                        return "HT";
  if (desc.includes("3rd") || desc.includes("q3")) return "Q3";
  if (desc.includes("4th") || desc.includes("q4")) return "Q4";
  if (desc.includes("overtime"))                    return "OT";
  if (st.type === "inprogress")                     return "LIVE";
  return "—";
}

// ══════════════════════════════════════════════════════════════════
//  CLAUDE VISION — extract odds from screenshot
// ══════════════════════════════════════════════════════════════════

app.post("/api/analyze-screenshot", async (req, res) => {
  const { imageBase64, mediaType, sport, feedStage } = req.body;

  if (!imageBase64) {
    return res.status(400).json({ error: "No image provided" });
  }

  if (!ANTHROPIC_KEY) {
    return res.status(500).json({ error: "ANTHROPIC_KEY not configured on server" });
  }

  try {
    const response = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model     : "claude-sonnet-4-20250514",
        max_tokens: 512,
        messages  : [{
          role   : "user",
          content: [
            {
              type  : "image",
              source: { type: "base64", media_type: mediaType || "image/jpeg", data: imageBase64 }
            },
            {
              type: "text",
              text: `You are a sports betting odds extractor. Look at this screenshot and extract all betting odds visible.
Return ONLY a valid JSON object with these fields (use null if not visible):
{
  "homeOdds": number,
  "awayOdds": number,
  "drawOdds": number,
  "totalLine": number,
  "overOdds": number,
  "underOdds": number,
  "homeSpread": number,
  "awaySpread": number,
  "homeSpreadOdds": number,
  "awaySpreadOdds": number,
  "htHomeOdds": number,
  "htAwayOdds": number,
  "htDrawOdds": number,
  "bookmaker": string
}
All odds should be decimal format. No explanation, only JSON.`
            }
          ]
        }]
      },
      {
        headers: {
          "x-api-key"        : ANTHROPIC_KEY,
          "anthropic-version": "2023-06-01",
          "Content-Type"     : "application/json"
        },
        timeout: 20000
      }
    );

    const text  = response.data.content?.[0]?.text || "{}";
    const clean = text.replace(/```json|```/g, "").trim();
    const odds  = JSON.parse(clean);

    res.json({ success: true, odds, feedStage: feedStage || "LIVE" });
  } catch (err) {
    console.error("Claude Vision error:", err.message);
    res.status(500).json({ error: "Failed to analyze screenshot: " + err.message });
  }
});

// ══════════════════════════════════════════════════════════════════
//  MERGE  (ESPN primary + SofaScore enrichment)
// ══════════════════════════════════════════════════════════════════

function mergeData(espnMatches, sofaMatches) {
  const result = [...espnMatches];

  for (const sofa of sofaMatches) {
    const exists = result.find(e =>
      norm(e.homeTeam).includes(lastWord(sofa.homeTeam)) &&
      norm(e.awayTeam).includes(lastWord(sofa.awayTeam))
    );
    if (exists) {
      // Enrich ESPN entry with SofaScore quarter scores if richer
      if (sofa.homeQScores.length > (exists.homeQScores || []).length) {
        exists.homeQScores = sofa.homeQScores;
        exists.awayQScores = sofa.awayQScores;
      }
      if (sofa.homeScore > 0 && exists.homeScore === 0) {
        exists.homeScore = sofa.homeScore;
        exists.awayScore = sofa.awayScore;
      }
    } else {
      result.push(sofa);
    }
  }
  return result;
}

// ══════════════════════════════════════════════════════════════════
//  REFRESH
// ══════════════════════════════════════════════════════════════════

async function refreshAll() {
  console.log(`[${new Date().toISOString()}] Refreshing…`);
  const sports = ["basketball","football","baseball","hockey","tennis"];

  await Promise.all(sports.map(async (sport) => {
    try {
      const [espn, sofa] = await Promise.all([
        fetchESPNSport(sport),
        fetchSofaLive(sport)
      ]);
      cache[sport] = mergeData(espn, sofa);
    } catch (err) {
      console.error(`Refresh error ${sport}: ${err.message}`);
    }
  }));

  cache.all = [
    ...cache.basketball, ...cache.football, ...cache.baseball,
    ...cache.hockey,     ...cache.tennis
  ];
  cache.lastUpdated = new Date().toISOString();
  console.log(`✅ Total cached: ${cache.all.length}`);
}

// ══════════════════════════════════════════════════════════════════
//  ROUTES
// ══════════════════════════════════════════════════════════════════

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok", lastUpdated: cache.lastUpdated,
    counts: {
      all: cache.all.length, basketball: cache.basketball.length,
      football: cache.football.length, baseball: cache.baseball.length,
      hockey: cache.hockey.length, tennis: cache.tennis.length
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
  await refreshAll();
  res.json({ status: "refreshed", count: cache.all.length });
});

// ══════════════════════════════════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════════════════════════════════

function norm(s)     { return (s||"").toLowerCase().trim(); }
function lastWord(s) { return (s||"").trim().split(/\s+/).pop().toLowerCase(); }

// ══════════════════════════════════════════════════════════════════
//  KEEP-ALIVE
// ══════════════════════════════════════════════════════════════════

setInterval(() => {
  const url = process.env.RENDER_EXTERNAL_URL;
  if (url) https.get(url + "/api/health", () => {}).on("error", () => {});
}, 14 * 60 * 1000);

// ══════════════════════════════════════════════════════════════════
//  STARTUP
// ══════════════════════════════════════════════════════════════════

cron.schedule("* * * * *", refreshAll);

refreshAll();

app.listen(PORT, () => console.log(`BallIQ v2 backend on port ${PORT}`));

import { Router, type IRouter } from "express";
import { GetNflScheduleResponse } from "@workspace/api-zod";

type CsvRow = Record<string, string>;

const router: IRouter = Router();
const cache = new Map<number, { expiresAt: number; data: unknown }>();
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

const teams = [
  ["ARI", "Arizona Cardinals", "Cardinals", "Arizona", "NFC", "NFC West", "#97233F", "#000000"],
  ["ATL", "Atlanta Falcons", "Falcons", "Atlanta", "NFC", "NFC South", "#A71930", "#000000"],
  ["BAL", "Baltimore Ravens", "Ravens", "Baltimore", "AFC", "AFC North", "#241773", "#9E7C0C"],
  ["BUF", "Buffalo Bills", "Bills", "Buffalo", "AFC", "AFC East", "#00338D", "#C60C30"],
  ["CAR", "Carolina Panthers", "Panthers", "Carolina", "NFC", "NFC South", "#0085CA", "#101820"],
  ["CHI", "Chicago Bears", "Bears", "Chicago", "NFC", "NFC North", "#0B162A", "#C83803"],
  ["CIN", "Cincinnati Bengals", "Bengals", "Cincinnati", "AFC", "AFC North", "#FB4F14", "#000000"],
  ["CLE", "Cleveland Browns", "Browns", "Cleveland", "AFC", "AFC North", "#311D00", "#FF3C00"],
  ["DAL", "Dallas Cowboys", "Cowboys", "Dallas", "NFC", "NFC East", "#041E42", "#869397"],
  ["DEN", "Denver Broncos", "Broncos", "Denver", "AFC", "AFC West", "#FB4F14", "#002244"],
  ["DET", "Detroit Lions", "Lions", "Detroit", "NFC", "NFC North", "#0076B6", "#B0B7BC"],
  ["GB", "Green Bay Packers", "Packers", "Green Bay", "NFC", "NFC North", "#203731", "#FFB612"],
  ["HOU", "Houston Texans", "Texans", "Houston", "AFC", "AFC South", "#03202F", "#A71930"],
  ["IND", "Indianapolis Colts", "Colts", "Indianapolis", "AFC", "AFC South", "#002C5F", "#A2AAAD"],
  ["JAX", "Jacksonville Jaguars", "Jaguars", "Jacksonville", "AFC", "AFC South", "#006778", "#D7A22A"],
  ["KC", "Kansas City Chiefs", "Chiefs", "Kansas City", "AFC", "AFC West", "#E31837", "#FFB81C"],
  ["LV", "Las Vegas Raiders", "Raiders", "Las Vegas", "AFC", "AFC West", "#000000", "#A5ACAF"],
  ["LAC", "Los Angeles Chargers", "Chargers", "Los Angeles", "AFC", "AFC West", "#0080C6", "#FFC20E"],
  ["LAR", "Los Angeles Rams", "Rams", "Los Angeles", "NFC", "NFC West", "#003594", "#FFA300"],
  ["MIA", "Miami Dolphins", "Dolphins", "Miami", "AFC", "AFC East", "#008E97", "#FC4C02"],
  ["MIN", "Minnesota Vikings", "Vikings", "Minnesota", "NFC", "NFC North", "#4F2683", "#FFC62F"],
  ["NE", "New England Patriots", "Patriots", "New England", "AFC", "AFC East", "#002244", "#C60C30"],
  ["NO", "New Orleans Saints", "Saints", "New Orleans", "NFC", "NFC South", "#D3BC8D", "#101820"],
  ["NYG", "New York Giants", "Giants", "New York", "NFC", "NFC East", "#0B2265", "#A71930"],
  ["NYJ", "New York Jets", "Jets", "New York", "AFC", "AFC East", "#125740", "#000000"],
  ["PHI", "Philadelphia Eagles", "Eagles", "Philadelphia", "NFC", "NFC East", "#004C54", "#A5ACAF"],
  ["PIT", "Pittsburgh Steelers", "Steelers", "Pittsburgh", "AFC", "AFC North", "#FFB612", "#101820"],
  ["SEA", "Seattle Seahawks", "Seahawks", "Seattle", "NFC", "NFC West", "#002244", "#69BE28"],
  ["SF", "San Francisco 49ers", "49ers", "San Francisco", "NFC", "NFC West", "#AA0000", "#B3995D"],
  ["TB", "Tampa Bay Buccaneers", "Buccaneers", "Tampa Bay", "NFC", "NFC South", "#D50A0A", "#FF7900"],
  ["TEN", "Tennessee Titans", "Titans", "Tennessee", "AFC", "AFC South", "#0C2340", "#4B92DB"],
  ["WAS", "Washington Commanders", "Commanders", "Washington", "NFC", "NFC East", "#5A1414", "#FFB81C"],
].map(([code, name, shortName, city, conference, division, primaryColor, secondaryColor]) => ({
  code,
  name,
  shortName,
  city,
  conference,
  division,
  primaryColor,
  secondaryColor,
  logo: `https://a.espncdn.com/i/teamlogos/nfl/500/${code.toLowerCase()}.png`,
}));

function parseCsv(text: string): CsvRow[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];
    if (char === '"' && quoted && next === '"') {
      field += '"';
      i += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      row.push(field);
      field = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") i += 1;
      row.push(field);
      if (row.some((value) => value.length > 0)) rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  const headers = rows.shift()?.map((header) => header.trim()) ?? [];
  return rows.map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])));
}

function numberOrNull(value: string | undefined): number | null {
  if (!value || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeTeamCode(value: string | undefined): string {
  const aliases: Record<string, string> = {
    LA: "LAR",
    STL: "LAR",
    OAK: "LV",
    SD: "LAC",
    JAC: "JAX",
    WSH: "WAS",
  };
  return aliases[value ?? ""] ?? value ?? "";
}

function classifyHoliday(date: string | null | undefined): string | null {
  if (!date) return null;
  const [, month, day] = date.split("-").map(Number);
  if (month === 11 && day >= 22 && day <= 28) return "THANKSGIVING";
  if (month === 12 && day === 25) return "CHRISTMAS";
  if (month === 12 && day === 24) return "CHRISTMAS EVE";
  return null;
}

function normalizeRow(row: CsvRow, season: number, index: number) {
  const date = row.gameday || null;
  const gametime = row.gametime || null;
  const weekday = row.weekday || null;
  const location = row.location || null;
  const neutralSite = location?.toLowerCase() === "neutral";
  const international = neutralSite || /london|munich|são paulo|sao paulo|melbourne|mexico/i.test(`${location} ${row.stadium}`);
  const primetime = Boolean(gametime && Number(gametime.split(":")[0]) >= 19) || /thursday|monday|saturday/i.test(weekday ?? "");
  const awayTeam = normalizeTeamCode(row.away_team);
  const homeTeam = normalizeTeamCode(row.home_team);
  const homeInfo = teams.find((team) => team.code === homeTeam);
  const awayInfo = teams.find((team) => team.code === awayTeam);
  return {
    id: row.game_id || row.old_game_id || `${season}-${row.week}-${awayTeam}-${homeTeam}-${index}`,
    season,
    week: Number(row.week),
    date,
    day: weekday,
    time: gametime,
    awayTeam,
    homeTeam,
    awayScore: numberOrNull(row.away_score),
    homeScore: numberOrNull(row.home_score),
    status: numberOrNull(row.away_score) !== null && numberOrNull(row.home_score) !== null ? "FINAL" : "SCHEDULED",
    network: row.network || null,
    stadium: row.stadium || row.stadium_id || null,
    location: international ? (location && location !== "Neutral" ? location : `${homeInfo?.city ?? awayInfo?.city ?? ""}`) || null : location === "Home" ? homeInfo?.city ?? null : location,
    international,
    neutralSite,
    primetime,
    divisionGame: row.div_game === "TRUE" || row.div_game === "1",
    holiday: classifyHoliday(date),
  };
}

router.get("/nfl/schedule/:season", async (req, res) => {
  const season = Number(req.params.season);
  if (!Number.isInteger(season) || season < 2026 || season > 2100) {
    res.status(400).json({ error: "Invalid NFL season." });
    return;
  }
  const cached = cache.get(season);
  if (cached && cached.expiresAt > Date.now()) {
    res.json(cached.data);
    return;
  }
  try {
    const response = await fetch("https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv");
    if (!response.ok) throw new Error(`nflverse returned ${response.status}`);
    const rows = parseCsv(await response.text()).filter((row) => row.season === String(season) && row.game_type === "REG");
    const data = GetNflScheduleResponse.parse({
      season,
      source: "nflverse",
      fetchedAt: new Date().toISOString(),
      teams,
      games: rows.map((row, index) => normalizeRow(row, season, index)),
    });
    cache.set(season, { expiresAt: Date.now() + CACHE_TTL_MS, data });
    res.json(data);
  } catch (error) {
    req.log.error({ err: error, season }, "Unable to load NFL schedule");
    res.status(502).json({ error: "Unable to load the NFL schedule right now." });
  }
});

export default router;
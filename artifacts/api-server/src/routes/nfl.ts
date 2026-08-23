import { Router, type IRouter } from "express";
import { GetNflScheduleResponse } from "@workspace/api-zod";

type CsvRow = Record<string, string>;

const router: IRouter = Router();

/** The nflverse slate barely moves; ESPN's live layer (status, scores, TV) moves constantly. Cache them apart. */
const scheduleCache = new Map<number, { expiresAt: number; rows: CsvRow[] }>();
const espnCache = new Map<number, { expiresAt: number; fullRefreshAt: number; games: Map<string, EspnGame> }>();
const SCHEDULE_TTL_MS = 6 * 60 * 60 * 1000;
const ESPN_FULL_TTL_MS = 6 * 60 * 60 * 1000;
/** While a game is in progress the score is the point of the page, so refresh it aggressively. */
const ESPN_LIVE_TTL_MS = 30 * 1000;
const ESPN_IDLE_TTL_MS = 15 * 60 * 1000;
const ALL_WEEKS = Array.from({ length: 18 }, (_, index) => index + 1);

type EspnGame = {
  network: string | null;
  state: "pre" | "in" | "post";
  completed: boolean;
  detail: string | null;
  awayScore: number | null;
  homeScore: number | null;
};

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

/** Thanksgiving is the fourth Thursday in November, so it moves between the 22nd and the 28th. */
function thanksgiving(year: number): number {
  const firstOfNovember = new Date(Date.UTC(year, 10, 1)).getUTCDay();
  return 22 + ((4 - firstOfNovember + 7) % 7);
}

function classifyHoliday(date: string | null | undefined): string | null {
  if (!date) return null;
  const [year, month, day] = date.split("-").map(Number);
  // Match the day itself, not the holiday week: a Sunday slate three days earlier is not a holiday game.
  if (month === 11 && day === thanksgiving(year)) return "THANKSGIVING";
  if (month === 12 && day === 25) return "CHRISTMAS";
  if (month === 12 && day === 24) return "CHRISTMAS EVE";
  return null;
}

type EspnEvent = {
  id?: string;
  status?: { type?: { state?: string; completed?: boolean; shortDetail?: string; detail?: string } };
  competitions?: Array<{
    broadcasts?: Array<{ names?: string[]; media?: { shortName?: string } }>;
    competitors?: Array<{ homeAway?: string; score?: string }>;
  }>;
};

function readEvent(event: EspnEvent): EspnGame | null {
  if (!event.id) return null;
  const competition = event.competitions?.[0];
  const names = (competition?.broadcasts ?? []).flatMap(
    (broadcast) => broadcast.names ?? (broadcast.media?.shortName ? [broadcast.media.shortName] : []),
  );
  const score = (side: string) => {
    const raw = competition?.competitors?.find((competitor) => competitor.homeAway === side)?.score;
    const parsed = Number(raw);
    return raw !== undefined && raw !== "" && Number.isFinite(parsed) ? parsed : null;
  };
  const state = event.status?.type?.state;
  return {
    network: names.length ? [...new Set(names)].join(" / ") : null,
    state: state === "in" || state === "post" ? state : "pre",
    completed: event.status?.type?.completed === true,
    detail: event.status?.type?.shortDetail ?? event.status?.type?.detail ?? null,
    awayScore: score("away"),
    homeScore: score("home"),
  };
}

/** Weeks holding a game today or yesterday (Eastern) — the only ones whose score can still change. */
function activeWeeks(rows: CsvRow[]): number[] {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const weeks = new Set<number>();
  for (const row of rows) {
    if (row.gameday === today || row.gameday === yesterday) weeks.add(Number(row.week));
  }
  return [...weeks].filter(Number.isFinite);
}

async function fetchEspnWeeks(season: number, weeks: number[], into: Map<string, EspnGame>): Promise<void> {
  await Promise.all(
    weeks.map(async (week) => {
      try {
        const response = await fetch(
          `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=${season}&seasontype=2&week=${week}`,
        );
        if (!response.ok) return;
        const payload = (await response.json()) as { events?: EspnEvent[] };
        for (const event of payload.events ?? []) {
          const parsed = readEvent(event);
          if (parsed && event.id) into.set(event.id, parsed);
        }
      } catch {
        // ESPN is best-effort: games fall back to the nflverse slate with no TV info and no live state.
      }
    }),
  );
}

async function loadEspn(season: number, rows: CsvRow[]): Promise<Map<string, EspnGame>> {
  const now = Date.now();
  const cached = espnCache.get(season);
  if (cached && cached.expiresAt > now) return cached.games;
  const games = cached?.games ?? new Map<string, EspnGame>();
  // Sweep all 18 weeks on the first load and every few hours (flexed kickoffs, late TV assignments);
  // in between only re-poll the weeks that can actually be in progress.
  const fullRefresh = !cached || now - cached.fullRefreshAt > ESPN_FULL_TTL_MS;
  const weeks = fullRefresh ? ALL_WEEKS : activeWeeks(rows);
  if (weeks.length) await fetchEspnWeeks(season, weeks, games);
  const live = [...games.values()].some((game) => game.state === "in");
  espnCache.set(season, {
    games,
    expiresAt: now + (live ? ESPN_LIVE_TTL_MS : ESPN_IDLE_TTL_MS),
    fullRefreshAt: fullRefresh ? now : (cached?.fullRefreshAt ?? now),
  });
  return games;
}

/** nflverse only marks international games "Home"/"Neutral", so map the venue to its real city. */
const VENUE_CITIES: Record<string, string> = {
  "Melbourne Cricket Ground": "Melbourne, Australia",
  "Maracana Stadium": "Rio de Janeiro, Brazil",
  "Bernabeu": "Madrid, Spain",
  "Stade de France": "Paris, France",
  "FC Bayern Munich Stadium": "Munich, Germany",
  "Tottenham Hotspur Stadium": "London, UK",
  "Wembley Stadium": "London, UK",
  "Estadio Banorte": "Mexico City, Mexico",
};

function venueCity(stadium: string | undefined): string | null {
  return (stadium && VENUE_CITIES[stadium]) ?? null;
}

function normalizeRow(row: CsvRow, season: number, index: number, espnGames: Map<string, EspnGame>) {
  const date = row.gameday || null;
  const gametime = row.gametime || null;
  const weekday = row.weekday || null;
  const location = row.location || null;
  const neutralSite = location?.toLowerCase() === "neutral";
  const international = neutralSite || /london|munich|são paulo|sao paulo|melbourne|mexico|tottenham|wembley/i.test(`${location} ${row.stadium}`);
  const awayTeam = normalizeTeamCode(row.away_team);
  const homeTeam = normalizeTeamCode(row.home_team);
  const homeInfo = teams.find((team) => team.code === homeTeam);
  const awayInfo = teams.find((team) => team.code === awayTeam);
  // ESPN is the live authority; nflverse only publishes a final score hours after the whistle.
  const espn = espnGames.get(row.espn);
  const csvAway = numberOrNull(row.away_score);
  const csvHome = numberOrNull(row.home_score);
  const isFinal = espn ? espn.completed || (espn.state === "post" && espn.awayScore !== null) : csvAway !== null && csvHome !== null;
  const status = espn?.state === "in" ? "LIVE" : isFinal ? "FINAL" : "SCHEDULED";
  const useEspnScore = espn !== undefined && status !== "SCHEDULED";
  const awayScore = useEspnScore ? espn.awayScore ?? csvAway : csvAway;
  const homeScore = useEspnScore ? espn.homeScore ?? csvHome : csvHome;
  return {
    id: row.game_id || row.old_game_id || `${season}-${row.week}-${awayTeam}-${homeTeam}-${index}`,
    season,
    week: Number(row.week),
    date,
    day: weekday,
    time: gametime,
    awayTeam,
    homeTeam,
    awayScore: awayScore,
    homeScore: homeScore,
    status,
    statusDetail: status === "SCHEDULED" ? null : espn?.detail ?? null,
    network: espn?.network ?? null,
    stadium: (row.stadium || row.stadium_id || null)?.replace("Tottenham Hotspur Stadium", "Tottenham Hotspur") ?? null,
    location: international
      ? (location && location !== "Neutral" && location !== "Home" ? location : venueCity(row.stadium) ?? homeInfo?.city ?? awayInfo?.city ?? null)
      : location === "Home"
        ? homeInfo?.city ?? null
        : location,
    international,
    neutralSite,
    divisionGame: row.div_game === "TRUE" || row.div_game === "1",
    holiday: classifyHoliday(date),
    spreadLine: numberOrNull(row.spread_line),
    totalLine: numberOrNull(row.total_line),
  };
}

router.get("/nfl/schedule/:season", async (req, res) => {
  const season = Number(req.params.season);
  if (!Number.isInteger(season) || season < 2026 || season > 2100) {
    res.status(400).json({ error: "Invalid NFL season." });
    return;
  }
  try {
    const cachedSchedule = scheduleCache.get(season);
    let rows = cachedSchedule && cachedSchedule.expiresAt > Date.now() ? cachedSchedule.rows : null;
    if (!rows) {
      const response = await fetch("https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv");
      if (!response.ok) throw new Error(`nflverse returned ${response.status}`);
      rows = parseCsv(await response.text()).filter((row) => row.season === String(season) && row.game_type === "REG");
      scheduleCache.set(season, { expiresAt: Date.now() + SCHEDULE_TTL_MS, rows });
    }
    const espnGames = await loadEspn(season, rows);
    // Assembled per request rather than cached whole: the two halves expire on very different clocks.
    res.json(
      GetNflScheduleResponse.parse({
        season,
        source: "nflverse + espn",
        fetchedAt: new Date().toISOString(),
        teams,
        games: rows.map((row, index) => normalizeRow(row, season, index, espnGames)),
      }),
    );
  } catch (error) {
    req.log.error({ err: error, season }, "Unable to load NFL schedule");
    res.status(502).json({ error: "Unable to load the NFL schedule right now." });
  }
});

export default router;

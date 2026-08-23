import type { NflGame, NflTeam } from '@workspace/api-client-react';

export type ExportFormat = 'csv' | 'ics';

type ExportState = { view: 'week' | 'team' | 'matrix'; week: number; team: string; gameType: string };

function matchesGameType(game: NflGame, gameType: string) {
  if (gameType === 'division') return game.divisionGame;
  if (gameType === 'international') return game.international;
  return true;
}

/** Mirror the current view: week board exports the filtered week, team lens the team's season, matrix the full slate. */
function selectGames(games: NflGame[], state: ExportState): { games: NflGame[]; label: string } {
  if (state.view === 'team' && state.team) {
    return {
      games: games.filter((game) => game.awayTeam === state.team || game.homeTeam === state.team).sort((a, b) => a.week - b.week),
      label: state.team.toLowerCase(),
    };
  }
  if (state.view === 'week') {
    return {
      games: games.filter((game) => game.week === state.week && matchesGameType(game, state.gameType)).sort((a, b) => (a.date || '').localeCompare(b.date || '')),
      label: `week-${state.week}${state.gameType !== 'all' ? `-${state.gameType}` : ''}`,
    };
  }
  return {
    games: [...games].sort((a, b) => a.week - b.week || (a.date || '').localeCompare(b.date || '')),
    label: 'season',
  };
}

function csvField(value: string | number | null): string {
  const text = value === null ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function buildCsv(games: NflGame[], teams: NflTeam[]): string {
  const name = (code: string) => teams.find((team) => team.code === code)?.name || code;
  const header = ['Week', 'Date', 'Day', 'Time (ET)', 'Away', 'Home', 'Away Score', 'Home Score', 'Status', 'Network', 'Venue', 'Location', 'Division', 'International', 'Holiday'];
  const rows = games.map((game) => [
    game.week, game.date, game.day, game.time,
    name(game.awayTeam), name(game.homeTeam),
    game.awayScore, game.homeScore, game.status, game.network,
    game.stadium, game.location,
    game.divisionGame ? 'YES' : '', game.international ? 'YES' : '', game.holiday,
  ]);
  return [header, ...rows].map((row) => row.map(csvField).join(',')).join('\r\n');
}

function icsEscape(text: string): string {
  return text.replaceAll('\\', '\\\\').replaceAll(';', '\\;').replaceAll(',', '\\,').replaceAll('\n', '\\n');
}

/** RFC 5545 line folding: continuation lines start with a space. */
function fold(line: string): string {
  const parts: string[] = [];
  let rest = line;
  parts.push(rest.slice(0, 74));
  rest = rest.slice(74);
  while (rest.length) {
    parts.push(` ${rest.slice(0, 73)}`);
    rest = rest.slice(73);
  }
  return parts.join('\r\n');
}

// nflverse kickoff times are US Eastern; ship the standard America/New_York definition so calendars shift correctly.
const VTIMEZONE = [
  'BEGIN:VTIMEZONE', 'TZID:America/New_York',
  'BEGIN:DAYLIGHT', 'TZOFFSETFROM:-0500', 'TZOFFSETTO:-0400', 'TZNAME:EDT', 'DTSTART:19700308T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU', 'END:DAYLIGHT',
  'BEGIN:STANDARD', 'TZOFFSETFROM:-0400', 'TZOFFSETTO:-0500', 'TZNAME:EST', 'DTSTART:19701101T020000', 'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU', 'END:STANDARD',
  'END:VTIMEZONE',
];

function buildIcs(games: NflGame[], teams: NflTeam[]): string {
  const name = (code: string) => teams.find((team) => team.code === code)?.name || code;
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//StatChasers//NFL Schedule//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', ...VTIMEZONE];
  for (const game of games) {
    if (!game.date) continue; // flex games without a date can't be placed on a calendar
    const day = game.date.replaceAll('-', '');
    const time = game.time?.match(/^(\d{1,2}):(\d{2})/);
    const details = [
      game.network ? `TV: ${game.network}` : null,
      game.divisionGame ? 'Division game' : null,
      game.international ? 'International game' : null,
      game.holiday,
    ].filter(Boolean).join(' · ');
    lines.push(
      'BEGIN:VEVENT',
      `UID:${game.id}@statchasers`,
      `DTSTAMP:${stamp}`,
      time
        ? `DTSTART;TZID=America/New_York:${day}T${time[1].padStart(2, '0')}${time[2]}00`
        : `DTSTART;VALUE=DATE:${day}`, // kickoff TBD: all-day entry rather than an invented time
      ...(time ? ['DURATION:PT3H15M'] : []),
      fold(`SUMMARY:${icsEscape(`${name(game.awayTeam)} @ ${name(game.homeTeam)} (NFL Week ${game.week})`)}`),
      ...(details ? [fold(`DESCRIPTION:${icsEscape(details)}`)] : []),
      ...(game.stadium || game.location ? [fold(`LOCATION:${icsEscape(game.stadium || game.location || '')}`)] : []),
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}

function download(filename: string, mime: string, content: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

/** Returns false when there is nothing to export (feed not loaded or filter matched nothing). */
export function exportSchedule(format: ExportFormat, games: NflGame[], teams: NflTeam[], state: ExportState, season: number): boolean {
  const selection = selectGames(games, state);
  if (!selection.games.length) return false;
  const filename = `statchasers-${season}-${selection.label}.${format}`;
  if (format === 'csv') download(filename, 'text/csv;charset=utf-8', buildCsv(selection.games, teams));
  else download(filename, 'text/calendar;charset=utf-8', buildIcs(selection.games, teams));
  return true;
}

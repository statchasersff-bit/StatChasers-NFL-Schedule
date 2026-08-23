import { type ReactNode, type CSSProperties, useCallback, useEffect, useMemo, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  ArrowLeft,
  ArrowRight,
  CalendarDays,
  ChevronDown,
  CircleAlert,
  Command,
  Download,
  Grid2X2,
  List,
  MapPin,
  RefreshCw,
  Shield,
  Sparkles,
  Users,
} from 'lucide-react';
import {
  getGetNflScheduleQueryKey,
  useGetNflSchedule,
  type NflGame,
  type NflTeam,
} from '@workspace/api-client-react';
import { ErrorBoundary } from '@/components/error-boundary';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { exportSchedule, type ExportFormat } from '@/lib/export';
import { getConfig, routerBase } from '@/config';
import { toast } from '@/hooks/use-toast';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import { Route, Switch, useLocation, Router as WouterRouter } from 'wouter';

const queryClient = new QueryClient();
const SEASON = getConfig().season;
type ViewMode = 'week' | 'team' | 'matrix';

function readState(): { view: ViewMode; week: number; team: string; filter: string; gameType: string } {
  const params = new URLSearchParams(window.location.search);
  const rawView = params.get('scheduleView') || params.get('view');
  const view: ViewMode = rawView === 'team' || rawView === 'matrix' ? rawView : 'week';
  const week = Math.min(18, Math.max(1, Number(params.get('week')) || 1));
  return { view, week, team: params.get('team') || '', filter: params.get('filter') || '', gameType: params.get('gameType') || 'all' };
}

function updateState(next: Partial<ReturnType<typeof readState>>) {
  const current = readState();
  const merged = { ...current, ...next };
  const params = new URLSearchParams();
  if (merged.view !== 'week') params.set('scheduleView', merged.view);
  if (merged.week !== 1) params.set('week', String(merged.week));
  if (merged.team) params.set('team', merged.team);
  if (merged.filter) params.set('filter', merged.filter);
  if (merged.gameType && merged.gameType !== 'all') params.set('gameType', merged.gameType);
  const query = params.toString();
  // Never hard-code "/": on WordPress the app lives at /nfl/nfl-schedule/ and rewriting to the
  // origin root would throw the visitor off the page.
  const { basePath } = getConfig();
  window.history.pushState({}, '', query ? `${basePath}?${query}` : basePath);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

function useUrlState() {
  const [state, setState] = useState(readState);
  useEffect(() => {
    const onPop = () => setState(readState());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  return [state, updateState] as const;
}

function formatDate(date: string | null, day: string | null) {
  if (!date) return day || 'Date TBD';
  const parsed = new Date(`${date}T12:00:00`);
  if (Number.isNaN(parsed.getTime())) return day || date;
  return `${parsed.toLocaleDateString('en-US', { weekday: 'short' })}, ${parsed.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
}

/** ESPN's detail is already display-ready ("Q3 5:23", "Final/OT"); uppercase it to match the board. */
function statusText(game: NflGame) {
  if (game.status === 'LIVE') return game.statusDetail?.toUpperCase() || 'LIVE';
  if (game.status === 'FINAL') return game.statusDetail?.toUpperCase() || 'FINAL';
  return formatTime(game.time);
}

function LiveDot() {
  return <span className="live-dot mr-1 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-accent align-middle" aria-hidden="true" />;
}

/** nflverse kickoffs are US Eastern, so label the zone rather than implying the viewer's local time. */
function formatTime(time: string | null) {
  if (!time) return 'Time TBD';
  const match = time.match(/^(\d{1,2}):(\d{2})/);
  if (!match) return time;
  const hour = Number(match[1]);
  return `${hour % 12 === 0 ? 12 : hour % 12}:${match[2]} ${hour >= 12 ? 'PM' : 'AM'} ET`;
}

function TeamLogo({ team, size = 'md', plain = false }: { team?: NflTeam; size?: 'xxs' | 'xs' | 'sm' | 'md' | 'lg'; plain?: boolean }) {
  const dimensions = size === 'lg' ? 'h-14 w-14' : size === 'sm' ? 'h-8 w-8' : size === 'xs' ? 'h-6 w-6' : size === 'xxs' ? 'h-[22px] w-[22px]' : 'h-10 w-10';
  if (!team) return <div className={`${dimensions} rounded-full bg-secondary`} />;
  if (plain && team.logo) {
    return <img className={`${dimensions} shrink-0 object-contain`} src={team.logo} alt={`${team.name} logo`} title={team.name} data-testid={`team-logo-${team.code}`} />;
  }
  return (
    <div
      className={`${dimensions} team-mark flex shrink-0 items-center justify-center rounded-full bg-white shadow-sm`}
      style={{ border: `2px solid ${team.primaryColor || '#17243e'}` } as CSSProperties}
      data-testid={`team-logo-${team.code}`}
      title={team.name}
    >
      {team.logo ? (
        <img className="h-[72%] w-[72%] object-contain" src={team.logo} alt={`${team.name} logo`} />
      ) : (
        <span className="font-display text-[11px] font-bold tracking-tight text-primary">{team.code}</span>
      )}
    </div>
  );
}

function Header({ state, setState, onExport }: { state: ReturnType<typeof readState>; setState: typeof updateState; onExport: (format: ExportFormat) => void }) {
  const [location] = useLocation();
  const setView = (view: ViewMode) => setState({ view });
  return (
    <header className="border-b border-border bg-card">
      <div className="mx-auto flex max-w-[1480px] items-center justify-between gap-4 px-[2px] py-4">
        <nav className="app-nav flex min-w-0 items-center gap-1" aria-label="Primary navigation">
          {(['week', 'team', 'matrix'] as ViewMode[]).map((item) => (
            <button
              key={item}
              onClick={() => setView(item)}
              className={`app-nav-tab flex items-center whitespace-nowrap border-b-2 font-bold uppercase tracking-[0.12em] ${state.view === item ? 'border-accent text-primary' : 'border-transparent text-muted-foreground hover:text-primary'}`}
              data-testid={`button-view-${item}`}
            >
              {item === 'week' ? <List size={15} /> : item === 'team' ? <Shield size={15} /> : <Grid2X2 size={15} />}
              <span className="app-nav-label-full">{item === 'week' ? 'Weekly board' : item === 'team' ? 'Team lens' : 'Season matrix'}</span>
              <span className="app-nav-label-short">{item === 'week' ? 'Weekly' : item === 'team' ? 'Team' : 'Matrix'}</span>
            </button>
          ))}
        </nav>
        <div className="flex items-center gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                className="hidden items-center gap-2 border border-border px-3 py-2 text-[11px] font-bold uppercase tracking-[0.12em] text-muted-foreground hover:border-primary hover:text-primary min-[580px]:flex"
                data-testid="button-export-schedule"
              >
                <Download size={14} /> Export
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => onExport('csv')} data-testid="button-export-csv">Download CSV</DropdownMenuItem>
              <DropdownMenuItem onClick={() => onExport('ics')} data-testid="button-export-ics">Calendar file (.ics)</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      {location !== '/' && null}
    </header>
  );
}

function WeekRail({ week, setState }: { week: number; setState: typeof updateState }) {
  return (
    <div className="mobile-scroll -mx-1 flex gap-1 overflow-x-auto px-1 pb-1">
      {Array.from({ length: 18 }, (_, index) => index + 1).map((item) => (
        <button key={item} onClick={() => setState({ week: item, view: 'week' })} className={`week-button min-w-[26px] flex-1 border px-1 py-1.5 text-center ${week === item ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-card text-muted-foreground'}`} data-testid={`button-week-${item}`}>
          <span className="font-display text-sm font-bold leading-none">{item}</span>
        </button>
      ))}
    </div>
  );
}

function GameRow({ game, teams }: { game: NflGame; teams: NflTeam[] }) {
  const away = teams.find((team) => team.code === game.awayTeam);
  const home = teams.find((team) => team.code === game.homeTeam);
  const isLive = game.status === 'LIVE';
  const hasScore = game.awayScore !== null && game.homeScore !== null;
  return (
    <article className="schedule-row grid grid-cols-[4.5em_minmax(0,1fr)_5.375em] items-center gap-3 border-b border-border px-4 py-1.5 sm:grid-cols-[96px_minmax(0,1fr)_118px] sm:px-5 xl:grid-cols-[112px_minmax(0,1fr)_145px]" data-testid={`row-game-${game.id}`}>
      <div>
        <div className="text-[0.6875em] font-bold text-primary">{formatDate(game.date, game.day)}</div>
        <div className={`mt-0.5 text-[0.625em] ${isLive ? 'font-bold text-accent' : 'text-muted-foreground'}`} data-testid={`text-status-${game.id}`}>{isLive && <LiveDot />}{statusText(game)}</div>
      </div>
      <div className="flex min-w-0 items-center justify-center gap-3 xl:gap-7">
        <div className="flex min-w-0 flex-1 items-center justify-end gap-2 text-right">
          <div className="min-w-0"><div className="flex items-center justify-end gap-2"><div className="week-team-name truncate font-display text-[0.8125em] font-bold text-primary">{away?.shortName || game.awayTeam}</div>{hasScore && <strong className={`font-display text-[1em] tabular-nums ${isLive ? 'text-accent' : 'text-primary'}`}>{game.awayScore}</strong>}</div><div className="week-team-code text-[0.625em] uppercase tracking-[0.08em] text-muted-foreground">{game.awayTeam}</div></div>
          <TeamLogo team={away} size="sm" plain />
        </div>
        <div className="flex shrink-0 flex-col items-center">
          <span className="text-[0.5625em] font-bold uppercase tracking-[0.14em] text-muted-foreground">at</span>
          <span className="my-0.5 h-px w-5 bg-accent" />
        </div>
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <TeamLogo team={home} size="sm" plain />
          <div className="min-w-0"><div className="flex items-center gap-2">{hasScore && <strong className={`font-display text-[1em] tabular-nums ${isLive ? 'text-accent' : 'text-primary'}`}>{game.homeScore}</strong>}<div className="week-team-name truncate font-display text-[0.8125em] font-bold text-primary">{home?.shortName || game.homeTeam}</div></div><div className="week-team-code text-[0.625em] uppercase tracking-[0.08em] text-muted-foreground">{game.homeTeam}</div></div>
        </div>
      </div>
      <div className="text-right">
        <div className="flex items-center justify-end gap-1.5">{game.divisionGame && <span className="shrink-0 border border-border px-1.5 py-0.5 text-[0.5625em] font-bold uppercase tracking-[0.08em] text-muted-foreground">Div</span>}<span className="font-display text-[0.75em] font-bold text-primary">{game.holiday || game.network || '—'}</span></div>
        <div className="mt-0.5 flex items-center justify-end gap-1.5 text-[0.625em] text-muted-foreground"><MapPin size={11} className="shrink-0" /><span className="min-w-0 truncate" title={game.stadium || game.location || undefined}>{game.stadium || game.location || 'Venue TBD'}</span></div>
      </div>
    </article>
  );
}

const INTL_VENUES: Record<string, { flag: string; city: string }> = {
  'Melbourne Cricket Ground': { flag: '\u{1F1E6}\u{1F1FA}', city: 'Melbourne, Australia' },
  'Maracana Stadium': { flag: '\u{1F1E7}\u{1F1F7}', city: 'Rio de Janeiro, Brazil' },
  'Bernabeu': { flag: '\u{1F1EA}\u{1F1F8}', city: 'Madrid, Spain' },
  'Stade de France': { flag: '\u{1F1EB}\u{1F1F7}', city: 'Paris, France' },
  'FC Bayern Munich Stadium': { flag: '\u{1F1E9}\u{1F1EA}', city: 'Munich, Germany' },
  'Tottenham Hotspur': { flag: '\u{1F1EC}\u{1F1E7}', city: 'London, UK' },
  'Wembley Stadium': { flag: '\u{1F1EC}\u{1F1E7}', city: 'London, UK' },
  'Estadio Banorte': { flag: '\u{1F1F2}\u{1F1FD}', city: 'Mexico City, Mexico' },
};

function venueMeta(stadium: string | null) {
  return (stadium && INTL_VENUES[stadium]) || { flag: '\u{1F30D}', city: stadium || 'International' };
}

function MatchupTeams({ game, teams, compact = false }: { game: NflGame; teams: NflTeam[]; compact?: boolean }) {
  const away = teams.find((team) => team.code === game.awayTeam);
  const home = teams.find((team) => team.code === game.homeTeam);
  const nameClass = 'text-primary';
  const codeClass = 'text-muted-foreground';
  const side = (team: NflTeam | undefined, fallback: string, align: 'right' | 'left') => (
    <div className={`flex min-w-0 flex-1 items-center gap-1.5 ${align === 'right' ? 'flex-row-reverse' : ''}`}>
      <TeamLogo team={team} size="xs" plain />
      <div className={`min-w-0 ${align === 'right' ? 'text-right' : 'text-left'}`}>
        {!compact && <div className={`truncate font-display text-[12px] font-bold leading-tight ${nameClass}`}>{team?.shortName || fallback}</div>}
        <div className={`font-display text-[10px] font-bold uppercase leading-tight tracking-[0.08em] ${compact ? nameClass : codeClass}`}>{fallback}</div>
      </div>
    </div>
  );
  return (
    <div className="flex items-center gap-1.5">
      {side(away, game.awayTeam, 'right')}
      <div className="flex shrink-0 flex-col items-center">
        <span className={`text-[9px] font-bold uppercase leading-none tracking-[0.14em] ${codeClass}`}>at</span>
        <span className="mt-0.5 h-px w-3 bg-accent" />
      </div>
      {side(home, game.homeTeam, 'left')}
    </div>
  );
}

function spreadLabel(game: NflGame) {
  if (game.spreadLine === null || game.spreadLine === 0) return 'PK';
  const favored = game.spreadLine > 0 ? game.homeTeam : game.awayTeam;
  return `${favored} -${Math.abs(game.spreadLine)}`;
}

function SnapshotCard({ label, children, testId }: { label: string; children: ReactNode; testId: string }) {
  return (
    <section className="border border-border bg-card px-4 py-3 text-center" data-testid={testId}>
      <div className="text-[10px] font-bold uppercase tracking-[0.15em] text-muted-foreground">{label}</div>
      {children}
    </section>
  );
}

/** The market has to cover most of the slate before a "highest/lowest" claim means anything. */
const LINE_COVERAGE_FLOOR = 0.5;

function totalLabel(game: NflGame) {
  return `O/U ${game.totalLine}`;
}

function FantasySnapshot({ games, teams, week }: { games: NflGame[]; teams: NflTeam[]; week: number }) {
  const weekGames = games.filter((game) => game.week === week);
  const withLines = weekGames.filter((game) => game.totalLine !== null);
  const withSpreads = weekGames.filter((game) => game.spreadLine !== null).sort((a, b) => Math.abs(a.spreadLine ?? 99) - Math.abs(b.spreadLine ?? 99));
  const covered = weekGames.length > 0 && withLines.length / weekGames.length >= LINE_COVERAGE_FLOOR;
  if (!covered) {
    return (
      <SnapshotCard label={`Week ${week} market`} testId="panel-fantasy-snapshot">
        <div className="mt-1 text-[12px] leading-5 text-muted-foreground">
          {withLines.length === 0
            ? `Betting lines for week ${week} haven't posted yet. Snapshot fills in as the market opens.`
            : `Only ${withLines.length} of ${weekGames.length} week ${week} games have posted lines — too few to rank the slate.`}
        </div>
      </SnapshotCard>
    );
  }
  const sortedTotals = [...withLines].sort((a, b) => (b.totalLine ?? 0) - (a.totalLine ?? 0));
  const best = sortedTotals[0];
  const toughest = sortedTotals.length > 1 ? sortedTotals[sortedTotals.length - 1] : null;
  const closest = withSpreads[0] || null;
  const biggest = withSpreads.length > 1 ? withSpreads[withSpreads.length - 1] : null;
  const coverage = withLines.length === weekGames.length ? null : `${withLines.length} of ${weekGames.length} games priced`;
  return (
    <>
      <SnapshotCard label="Highest total" testId="panel-best-matchup">
        <div className="mt-1.5"><MatchupTeams game={best} teams={teams} compact /></div>
        <div className="mt-1.5 font-display text-[13px] font-bold text-primary">{totalLabel(best)}</div>
        <div className="mt-1 text-[11px] text-muted-foreground">Highest posted over/under this week</div>
        {coverage && <div className="mt-0.5 text-[10px] text-muted-foreground/75">{coverage}</div>}
      </SnapshotCard>
      {toughest && (
        <SnapshotCard label="Lowest total" testId="panel-toughest-matchup">
          <div className="mt-1.5"><MatchupTeams game={toughest} teams={teams} compact /></div>
          <div className="mt-1.5 font-display text-[13px] font-bold text-primary">{totalLabel(toughest)}</div>
          <div className="mt-1 text-[11px] text-muted-foreground">Lowest posted over/under this week</div>
        </SnapshotCard>
      )}
      {closest && (
        <SnapshotCard label="Closest spread" testId="panel-closest-spread">
          <div className="mt-1.5"><MatchupTeams game={closest} teams={teams} compact /></div>
          <div className="mt-1.5 font-display text-[13px] font-bold text-primary">{spreadLabel(closest)}</div>
        </SnapshotCard>
      )}
      {biggest && (
        <SnapshotCard label="Biggest spread" testId="panel-biggest-spread">
          <div className="mt-1.5"><MatchupTeams game={biggest} teams={teams} compact /></div>
          <div className="mt-1.5 font-display text-[13px] font-bold text-primary">{spreadLabel(biggest)}</div>
        </SnapshotCard>
      )}
    </>
  );
}

function ByeCard({ teams, games, week, setState }: { teams: NflTeam[]; games: NflGame[]; week: number; setState: typeof updateState }) {
  const byes = teams.filter((team) => !games.some((game) => game.week === week && (game.awayTeam === team.code || game.homeTeam === team.code)));
  return (
    <section className="border border-border bg-card px-4 py-3 text-center" data-testid="panel-bye-weeks">
      <div className="text-[10px] font-bold uppercase tracking-[0.15em] text-muted-foreground">Bye week</div>
      {byes.length > 0 ? (
        <div className="mt-1.5 flex flex-wrap justify-center gap-1.5">{byes.map((team) => <button key={team.code} onClick={() => setState({ team: team.code, view: 'team' })} className="flex items-center gap-1.5 border border-border py-0.5 pl-1 pr-1.5 hover:border-primary" title={team.name} data-testid={`button-bye-team-${team.code}`}><TeamLogo team={team} size="xs" plain /><span className="flex flex-col items-start leading-tight"><span className="font-display text-[11px] font-bold text-primary">{team.shortName || team.code}</span><span className="font-display text-[9px] font-bold uppercase tracking-[0.08em] text-muted-foreground">{team.code}</span></span></button>)}</div>
      ) : <div className="mt-1 text-[12px] text-muted-foreground">No teams on bye</div>}
    </section>
  );
}

function TravelCard({ games, teams, week }: { games: NflGame[]; teams: NflTeam[]; week: number }) {
  const intl = games.filter((game) => game.week === week && game.international);
  return (
    <section className="border border-border bg-card px-4 py-3 text-center" data-testid="panel-travel-alert">
      <div className="text-[10px] font-bold uppercase tracking-[0.15em] text-muted-foreground">Travel alert</div>
      {intl.length > 0 ? (
        <div className="mt-1.5 space-y-2">
          {intl.map((game) => (
            <div key={game.id}>
              <MatchupTeams game={game} teams={teams} compact />
              <div className="text-[11px] text-muted-foreground">{venueMeta(game.stadium).city}</div>
            </div>
          ))}
        </div>
      ) : <div className="mt-1 text-[12px] text-muted-foreground">No international travel this week</div>}
    </section>
  );
}

function DivisionCard({ games, teams, week }: { games: NflGame[]; teams: NflTeam[]; week: number }) {
  const divisional = games.filter((game) => game.week === week && game.divisionGame);
  return (
    <section className="border border-border bg-card px-4 py-3 text-center" data-testid="panel-division-games">
      <div className="text-[10px] font-bold uppercase tracking-[0.15em] text-muted-foreground">Divisional games</div>
      {divisional.length > 0 ? (
        <div className="mt-1.5">
          <div className="font-display text-[13px] font-bold text-primary">{divisional.length} {divisional.length === 1 ? 'matchup' : 'matchups'}</div>
          <div className="mt-1.5 space-y-1.5">{divisional.map((game) => <MatchupTeams key={game.id} game={game} teams={teams} compact />)}</div>
        </div>
      ) : <div className="mt-1 text-[12px] text-muted-foreground">No divisional games this week</div>}
    </section>
  );
}

function WeeklyView({ games, teams, week, gameType, setState }: { games: NflGame[]; teams: NflTeam[]; week: number; gameType: string; setState: typeof updateState }) {
  const weekGames = games.filter((game) => {
    if (game.week !== week) return false;
    if (gameType === 'division') return game.divisionGame;
    if (gameType === 'international') return game.international;
    return true;
  }).sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  return (
    <>
      <div className="mb-5 flex items-center justify-between gap-4">
        <h2 className="font-display text-lg font-bold tracking-[-0.04em] text-primary">Week {week}<span className="ml-2 text-sm font-medium text-muted-foreground">/ 18</span></h2>
        <label className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.12em] text-muted-foreground">
          Filter
          <select value={gameType} onChange={(event) => setState({ gameType: event.target.value })} className="h-9 border border-border bg-card px-2 text-[11px] font-semibold normal-case tracking-normal text-primary outline-none focus:border-primary" aria-label="Filter games">
            <option value="all">All games</option>
            <option value="division">Division</option>
            <option value="international">International</option>
          </select>
        </label>
      </div>
      <div className="mt-4">
        <WeekRail week={week} setState={setState} />
      </div>
      <div className="week-board mt-5 overflow-hidden border border-border bg-card">
        <div className="schedule-head grid grid-cols-[4.5em_minmax(0,1fr)_5.375em] gap-3 border-b border-border bg-secondary/50 px-4 py-1.5 font-bold uppercase text-muted-foreground sm:grid-cols-[96px_minmax(0,1fr)_118px] sm:px-5 xl:grid-cols-[112px_minmax(0,1fr)_145px]"><span className="text-[0.5625em] tracking-[0.14em]">When</span><span className="text-center text-[0.5625em] tracking-[0.14em]">Matchup</span><span className="text-right text-[0.5625em] tracking-[0.14em]">Details</span></div>
        {weekGames.length > 0 ? weekGames.map((game) => <GameRow key={game.id} game={game} teams={teams} />) : <EmptyState title={`Week ${week} is still open`} body="No normalized matchups were returned for this week." />}
      </div>
    </>
  );
}

function formatShortDate(date: string | null, day: string | null) {
  if (!date) return day || 'TBD';
  const parsed = new Date(`${date}T12:00:00`);
  if (Number.isNaN(parsed.getTime())) return day || date;
  return parsed.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

type WeekMark = { week: number; kind: 'home' | 'away' | 'bye'; game: NflGame | null };

function useTeamSeason(teamGames: NflGame[], code: string) {
  return useMemo(() => {
    const byWeek = new Map(teamGames.map((game) => [game.week, game]));
    const marks: WeekMark[] = Array.from({ length: 18 }, (_, index) => {
      const game = byWeek.get(index + 1) || null;
      return { week: index + 1, kind: !game ? 'bye' : game.homeTeam === code ? 'home' : 'away', game };
    });
    const scheduled = marks.filter((mark) => mark.kind !== 'bye');
    return {
      marks,
      scheduled,
      total: teamGames.length,
      home: marks.filter((mark) => mark.kind === 'home').length,
      away: marks.filter((mark) => mark.kind === 'away').length,
      division: teamGames.filter((game) => game.divisionGame).length,
      bye: marks.find((mark) => mark.kind === 'bye')?.week ?? null,
    };
  }, [teamGames, code]);
}

function TeamGameRow({ game, teams, code }: { game: NflGame; teams: NflTeam[]; code: string }) {
  const away = teams.find((team) => team.code === game.awayTeam);
  const home = teams.find((team) => team.code === game.homeTeam);
  const isLive = game.status === 'LIVE';
  const hasScore = game.awayScore !== null && game.homeScore !== null;
  const side = (team: NflTeam | undefined, fallback: string, score: number | null, align: 'right' | 'left') => (
    <div className={`flex min-w-0 items-center gap-1.5 ${align === 'right' ? 'flex-row-reverse text-right' : 'text-left'}`}>
      <TeamLogo team={team} size="xs" plain />
      <span className={`min-w-0 truncate text-[12px] leading-tight ${team?.code === code ? 'font-bold text-primary' : 'font-medium text-muted-foreground'}`}>
        <span className="team-name-full">{team?.name || fallback}</span>
        <span className="team-name-short">{team?.shortName || fallback}</span>
        <span className="team-name-code">{team?.code || fallback}</span>
      </span>
      {hasScore && <strong className={`font-display text-[12px] tabular-nums ${isLive ? 'text-accent' : 'text-primary'}`}>{score}</strong>}
    </div>
  );
  return (
    <article className="team-row grid grid-cols-[2.4rem_minmax(0,1fr)_9rem] items-center gap-3 border-b border-border px-4 py-1 last:border-b-0" data-testid={`row-team-game-${game.id}`}>
      <div className="font-display text-[11px] font-bold leading-none text-muted-foreground">
        W{game.week}
        {game.divisionGame && <span className="ml-0.5 text-accent" title="Division game">•</span>}
      </div>
      <div className="team-row-matchup grid min-w-0 grid-cols-[minmax(0,1fr)_1.1rem_minmax(0,1fr)] items-center gap-1.5">
        {side(away, game.awayTeam, game.awayScore, 'right')}
        <span className="flex flex-col items-center">
          <span className="text-[9px] font-bold uppercase leading-none tracking-[0.08em] text-muted-foreground/70">at</span>
          <span className="mt-0.5 h-px w-3 bg-accent" />
        </span>
        {side(home, game.homeTeam, game.homeScore, 'left')}
      </div>
      <div className="team-row-meta flex items-center justify-end gap-2 text-right">
        <span className="w-[3.4rem] text-[11px] font-semibold leading-tight text-primary">{formatShortDate(game.date, game.day)}</span>
        <span className={`w-[4.2rem] text-[10px] leading-tight tabular-nums ${isLive ? 'font-bold text-accent' : 'text-muted-foreground'}`}>{isLive && <LiveDot />}{statusText(game)}</span>
      </div>
    </article>
  );
}

const COLLAPSED_ROWS = 8;

function TeamScheduleList({ teamGames, teams, code }: { teamGames: NflGame[]; teams: NflTeam[]; code: string }) {
  const [expanded, setExpanded] = useState(true);
  const visible = expanded ? teamGames : teamGames.slice(0, COLLAPSED_ROWS);
  return (
    <div className="team-schedule border border-border bg-card">
      <div className="flex items-center justify-between border-b border-border px-3 py-2 sm:px-4">
        <div className="text-[10px] font-bold uppercase tracking-[0.15em] text-muted-foreground">Full schedule</div>
        <span className="text-[11px] text-muted-foreground">{teamGames.length} {teamGames.length === 1 ? 'game' : 'games'}</span>
      </div>
      {visible.length ? visible.map((game) => <TeamGameRow key={game.id} game={game} teams={teams} code={code} />) : <EmptyState title="No schedule found" body="Choose another team or refresh the schedule feed." />}
      {teamGames.length > COLLAPSED_ROWS && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="w-full border-t border-border py-2 text-[10px] font-bold uppercase tracking-[0.12em] text-muted-foreground hover:bg-secondary hover:text-primary"
          data-testid="button-toggle-team-schedule"
        >
          {expanded ? 'Show less' : `Show all ${teamGames.length} games`}
        </button>
      )}
    </div>
  );
}

function StatBar({ label, value, max, tone }: { label: string; value: number; max: number; tone: 'light' | 'dark' }) {
  return (
    <div className="flex items-center gap-2">
      <span className={`w-9 shrink-0 text-[9px] font-bold uppercase tracking-[0.12em] ${tone === 'dark' ? 'text-primary-foreground/55' : 'text-muted-foreground'}`}>{label}</span>
      <div className={`h-2 flex-1 ${tone === 'dark' ? 'bg-primary-foreground/15' : 'bg-secondary'}`}>
        <div className="h-full bg-accent" style={{ width: `${max > 0 ? (value / max) * 100 : 0}%` }} />
      </div>
      <span className={`w-4 shrink-0 text-right font-display text-[12px] font-bold tabular-nums ${tone === 'dark' ? 'text-primary-foreground' : 'text-primary'}`}>{value}</span>
    </div>
  );
}

function SeasonSnapshotCard({ season, stats }: { season: number; stats: ReturnType<typeof useTeamSeason> }) {
  const tiles = [
    { value: stats.total, label: 'Games' },
    { value: stats.home, label: 'Home' },
    { value: stats.away, label: 'Away' },
    { value: stats.division, label: 'Division' },
    { value: stats.bye ? `W${stats.bye}` : '—', label: 'Bye week' },
  ];
  return (
    <section className="border border-primary bg-primary p-4 text-primary-foreground" data-testid="panel-season-snapshot">
      <div className="mb-3 flex items-center justify-between">
        <div className="text-[10px] font-bold uppercase tracking-[0.16em] text-accent">{season} season snapshot</div>
        <Sparkles size={15} className="text-accent" />
      </div>
      <div className="grid grid-cols-3 gap-y-3">
        {tiles.map((tile) => (
          <div key={tile.label}>
            <div className="font-display text-[20px] font-bold leading-none tabular-nums">{tile.value}</div>
            <div className="mt-1 text-[9px] font-bold uppercase tracking-[0.1em] text-primary-foreground/55">{tile.label}</div>
          </div>
        ))}
      </div>
      <div className="mt-4 space-y-1.5 border-t border-primary-foreground/15 pt-3">
        <StatBar label="Home" value={stats.home} max={Math.max(stats.home, stats.away, 1)} tone="dark" />
        <StatBar label="Away" value={stats.away} max={Math.max(stats.home, stats.away, 1)} tone="dark" />
      </div>
    </section>
  );
}

const PATH_SEGMENTS: Array<[number, number]> = [[1, 6], [7, 12], [13, 18]];

function SeasonPathCard({ stats, city }: { stats: ReturnType<typeof useTeamSeason>; city: string }) {
  const segments = PATH_SEGMENTS.map(([from, to]) => {
    const slice = stats.marks.filter((mark) => mark.week >= from && mark.week <= to);
    return {
      label: `Weeks ${from}–${to}`,
      home: slice.filter((mark) => mark.kind === 'home').length,
      away: slice.filter((mark) => mark.kind === 'away').length,
      bye: slice.filter((mark) => mark.kind === 'bye').length,
    };
  });
  const last6 = stats.scheduled.slice(-6);
  const first6 = stats.scheduled.slice(0, 6);
  const homeLast = last6.filter((mark) => mark.kind === 'home').length;
  const homeFirst = first6.filter((mark) => mark.kind === 'home').length;
  const takeaway =
    last6.length === 0
      ? { title: 'Path pending', body: 'No games are scheduled for this team yet.' }
      : homeLast >= 4
        ? { title: 'Late-season home edge', body: `${homeLast} of ${city}'s final ${last6.length} scheduled games are at home.` }
        : homeLast <= 2
          ? { title: 'Late-season road grind', body: `${last6.length - homeLast} of ${city}'s final ${last6.length} scheduled games are on the road.` }
          : homeFirst <= 2
            ? { title: 'Early road gauntlet', body: `${first6.length - homeFirst} of the opening ${first6.length} games are away from home.` }
            : { title: 'Balanced draw', body: 'Home and road games stay evenly spread from September through January.' };
  return (
    <section className="border border-border bg-card px-4 py-3" data-testid="panel-season-path">
      <div className="text-[10px] font-bold uppercase tracking-[0.15em] text-muted-foreground">Season path</div>
      <div className="mt-2.5 flex gap-[3px]">
        {stats.marks.map((mark) => (
          <div
            key={mark.week}
            title={`Week ${mark.week} — ${mark.kind === 'bye' ? 'Bye' : mark.kind === 'home' ? `vs ${mark.game?.awayTeam}` : `at ${mark.game?.homeTeam}`}`}
            className={`h-5 flex-1 border ${mark.kind === 'home' ? 'border-primary bg-primary' : mark.kind === 'away' ? 'border-border bg-transparent' : 'border-dashed border-border bg-muted'}`}
            data-testid={`path-week-${mark.week}`}
          />
        ))}
      </div>
      <div className="mt-1.5 flex items-center gap-3 text-[9px] font-bold uppercase tracking-[0.08em] text-muted-foreground">
        <span className="flex items-center gap-1"><span className="h-2 w-2 border border-primary bg-primary" />Home</span>
        <span className="flex items-center gap-1"><span className="h-2 w-2 border border-border" />Away</span>
        <span className="flex items-center gap-1"><span className="h-2 w-2 border border-dashed border-border bg-muted" />Bye</span>
      </div>
      <div className="mt-3 space-y-2 border-t border-border pt-3">
        {segments.map((segment) => (
          <div key={segment.label} className="flex items-baseline justify-between gap-2">
            <span className="font-display text-[12px] font-bold text-primary">{segment.label}</span>
            <span className="text-[11px] text-muted-foreground">
              {[segment.home ? `${segment.home} home` : '', segment.away ? `${segment.away} road` : '', segment.bye ? `${segment.bye} bye` : ''].filter(Boolean).join(' · ') || 'No games'}
            </span>
          </div>
        ))}
      </div>
      <div className="mt-3 border-t border-border pt-3">
        <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-accent">{takeaway.title}</div>
        <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">{takeaway.body}</p>
      </div>
    </section>
  );
}

function DivisionSlateCard({ teamGames, teams, team }: { teamGames: NflGame[]; teams: NflTeam[]; team: NflTeam }) {
  const slate = teamGames.filter((game) => game.divisionGame);
  const home = slate.filter((game) => game.homeTeam === team.code).length;
  return (
    <section className="border border-border bg-card px-4 py-3" data-testid="panel-division-slate">
      <div className="text-[10px] font-bold uppercase tracking-[0.15em] text-muted-foreground">{team.division} schedule</div>
      {slate.length ? (
        <>
          <div className="mt-2 space-y-1">
            {slate.map((game) => {
              const atHome = game.homeTeam === team.code;
              const opponent = teams.find((entry) => entry.code === (atHome ? game.awayTeam : game.homeTeam));
              return (
                <div key={game.id} className="flex items-center gap-2" data-testid={`division-game-${game.id}`}>
                  <span className="w-7 shrink-0 font-display text-[11px] font-bold text-muted-foreground">W{game.week}</span>
                  <TeamLogo team={opponent} size="xs" plain />
                  <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-primary">{atHome ? '' : '@ '}{opponent?.shortName || game.homeTeam}</span>
                  <span className="shrink-0 text-[12px]" title={atHome ? 'Home game' : 'Road game'}>{atHome ? '\u{1F3E0}' : '\u{2708}\u{FE0F}'}</span>
                </div>
              );
            })}
          </div>
          <div className="mt-2.5 border-t border-border pt-2 text-[11px] font-semibold text-muted-foreground">
            <span className="text-primary">{home} home</span> · <span className="text-primary">{slate.length - home} away</span>
          </div>
        </>
      ) : <div className="mt-1 text-[12px] text-muted-foreground">No division games scheduled</div>}
    </section>
  );
}

function OpponentBreakdownCard({ teamGames, teams, team }: { teamGames: NflGame[]; teams: NflTeam[]; team: NflTeam }) {
  const opponents = teamGames.map((game) => teams.find((entry) => entry.code === (game.homeTeam === team.code ? game.awayTeam : game.homeTeam))).filter(Boolean) as NflTeam[];
  const byDivision = new Map<string, number>();
  const byConference = new Map<string, number>();
  opponents.forEach((opponent) => {
    byDivision.set(opponent.division, (byDivision.get(opponent.division) || 0) + 1);
    byConference.set(opponent.conference, (byConference.get(opponent.conference) || 0) + 1);
  });
  const divisions = [...byDivision.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const max = divisions[0]?.[1] || 1;
  const unique = [...new Map(opponents.map((opponent) => [opponent.code, opponent])).values()].sort((a, b) => a.code.localeCompare(b.code));
  return (
    <section className="border border-border bg-card px-4 py-3" data-testid="panel-opponent-breakdown">
      <div className="text-[10px] font-bold uppercase tracking-[0.15em] text-muted-foreground">Who {team.city} plays</div>
      {divisions.length ? (
        <>
          <div className="mt-2 space-y-1.5">
            {divisions.map(([division, count]) => (
              <div key={division} className="flex items-center gap-2" data-testid={`opponent-division-${division.replace(/\s+/g, '-')}`}>
                <span className="w-[4.6rem] shrink-0 text-[11px] font-semibold text-primary">{division}</span>
                <div className="h-1.5 flex-1 bg-secondary"><div className="h-full bg-accent" style={{ width: `${(count / max) * 100}%` }} /></div>
                <span className="w-3 shrink-0 text-right font-display text-[11px] font-bold tabular-nums text-primary">{count}</span>
              </div>
            ))}
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2 border-t border-border pt-2.5">
            {['NFC', 'AFC'].map((conference) => (
              <div key={conference}>
                <div className="text-[9px] font-bold uppercase tracking-[0.12em] text-muted-foreground">{conference}</div>
                <div className="font-display text-[15px] font-bold tabular-nums text-primary">{byConference.get(conference) || 0} <span className="text-[10px] font-medium text-muted-foreground">games</span></div>
              </div>
            ))}
          </div>
          <div className="mt-3 flex flex-wrap gap-1.5 border-t border-border pt-2.5">
            {unique.map((opponent) => <TeamLogo key={opponent.code} team={opponent} size="xs" plain />)}
          </div>
        </>
      ) : <div className="mt-1 text-[12px] text-muted-foreground">No opponents scheduled</div>}
    </section>
  );
}

function TeamView({ games, teams, state, setState }: { games: NflGame[]; teams: NflTeam[]; state: ReturnType<typeof readState>; setState: typeof updateState }) {
  const selected = teams.find((team) => team.code === state.team) || teams[0];
  const code = selected?.code || '';
  const teamGames = useMemo(
    () => (code ? games.filter((game) => game.awayTeam === code || game.homeTeam === code).sort((a, b) => a.week - b.week) : []),
    [games, code],
  );
  const stats = useTeamSeason(teamGames, code);
  return (
    <div className="dashboard-grid team-lens-grid">
      <div className="min-w-0">
        <div className="mb-5 flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
          <Select value={selected?.code || ''} onValueChange={(nextCode) => setState({ team: nextCode, view: 'team' })}>
            <SelectTrigger
              className="team-lens-head group h-auto w-auto min-w-0 justify-start gap-4 rounded-none border-0 bg-transparent p-0 text-left shadow-none focus:ring-0 focus:ring-offset-0 [&>svg]:hidden"
              aria-label={selected ? `Change team — currently ${selected.name}` : 'Choose a team'}
              data-testid="select-team-view"
            >
              {selected && <TeamLogo team={selected} size="lg" />}
              <div className="min-w-0">
                <div className="text-[10px] font-bold uppercase tracking-[0.16em] text-muted-foreground">Team lens</div>
                <div role="heading" aria-level={2} className="team-lens-name mt-1 flex items-center gap-2 font-display text-3xl font-bold tracking-[-0.05em] text-primary group-hover:text-accent">
                  <span className="min-w-0 truncate">{selected?.city || 'Select a'} <span className="text-muted-foreground/65 group-hover:text-accent/70">{selected?.shortName || 'team'}</span></span>
                  <ChevronDown size={20} className="shrink-0 text-muted-foreground transition-transform group-hover:text-accent group-data-[state=open]:rotate-180" />
                </div>
                <p className="mt-1 text-[12px] text-muted-foreground">{selected?.division}</p>
              </div>
            </SelectTrigger>
            <SelectContent className="max-h-[320px]">
              {teams.map((team) => (
                <SelectItem key={team.code} value={team.code} data-testid={`option-team-${team.code}`}>
                  <span className="flex items-center gap-2"><TeamLogo team={team} size="sm" plain /><span>{team.name}</span></span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <TeamScheduleList teamGames={teamGames} teams={teams} code={code} />
      </div>
      {selected && (
        <div className="fade-in-delay space-y-3">
          <SeasonSnapshotCard season={SEASON} stats={stats} />
          <SeasonPathCard stats={stats} city={selected.city} />
          <DivisionSlateCard teamGames={teamGames} teams={teams} team={selected} />
          <OpponentBreakdownCard teamGames={teamGames} teams={teams} team={selected} />
        </div>
      )}
    </div>
  );
}

function MatrixView({ games, teams, setState }: { games: NflGame[]; teams: NflTeam[]; setState: typeof updateState }) {
  const cells = useMemo(() => {
    const map = new Map<string, NflGame>();
    games.forEach((game) => { map.set(`${game.awayTeam}-${game.week}`, game); map.set(`${game.homeTeam}-${game.week}`, game); });
    return map;
  }, [games]);
  return (
    <div>
      <div className="mb-5 flex flex-col justify-between gap-2 sm:flex-row sm:items-end"><div><div className="text-[10px] font-bold uppercase tracking-[0.16em] text-muted-foreground">Full-season matrix</div><h2 className="mt-1 font-display text-2xl font-bold tracking-[-0.04em] text-primary">Every team. Every week.</h2></div><p className="text-[11px] text-muted-foreground">Select a cell to jump into the weekly board.</p></div>
      <div className="scrollbar-thin overflow-x-auto border border-border bg-card">
        <div className="min-w-[700px]">
          <div className="grid grid-cols-[68px_repeat(18,minmax(36px,1fr))] lg:grid-cols-[118px_repeat(18,minmax(36px,1fr))] border-b border-border bg-secondary/50 text-[9px] font-bold uppercase tracking-[0.12em] text-muted-foreground"><div className="px-1.5 py-1.5">Team</div>{Array.from({ length: 18 }, (_, i) => <div key={i + 1} className="matrix-cell px-0.5 py-1.5 text-center">W{i + 1}</div>)}</div>
          {teams.map((team) => <div key={team.code} className="grid grid-cols-[68px_repeat(18,minmax(36px,1fr))] lg:grid-cols-[118px_repeat(18,minmax(36px,1fr))] border-b border-border last:border-b-0"><button onClick={() => setState({ team: team.code, view: 'team' })} className="flex items-center gap-1.5 px-1.5 text-left hover:bg-secondary" data-testid={`button-matrix-team-${team.code}`}><TeamLogo team={team} size="xxs" plain /><span className="min-w-0"><span className="hidden truncate font-display text-[11px] font-bold leading-tight text-primary lg:block">{team.shortName || team.code}</span><span className="block font-display text-[11px] font-bold uppercase leading-tight tracking-[0.04em] text-primary lg:text-[9px] lg:tracking-[0.08em] lg:text-muted-foreground">{team.code}</span></span></button>{Array.from({ length: 18 }, (_, i) => { const game = cells.get(`${team.code}-${i + 1}`); if (!game) return <div key={i + 1} className="matrix-cell flex items-center justify-center border-l border-border bg-muted/35 text-[9px] text-muted-foreground">BYE</div>; const opponent = game.awayTeam === team.code ? game.homeTeam : game.awayTeam; const home = game.homeTeam === team.code; return <button key={i + 1} onClick={() => setState({ week: i + 1, view: 'week' })} className="matrix-cell border-l border-border px-0.5 py-0.5 text-center hover:bg-accent/15" data-testid={`button-matrix-cell-${team.code}-${i + 1}`}><div className="font-display text-[10px] leading-tight text-primary">{home ? opponent : `@${opponent}`}</div></button>; })}</div>)}
        </div>
      </div>
    </div>
  );
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return <div className="flex min-h-[180px] flex-col items-center justify-center px-6 text-center"><div className="mb-3 flex h-9 w-9 items-center justify-center border border-border text-muted-foreground"><CalendarDays size={17} /></div><h3 className="font-display text-base font-bold text-primary">{title}</h3><p className="mt-1 max-w-[280px] text-[12px] leading-5 text-muted-foreground">{body}</p></div>;
}

function LoadingState() {
  return <div className="space-y-4" aria-label="Loading schedule" data-testid="loading-schedule"><div className="h-20 animate-pulse border border-border bg-secondary/60" /><div className="h-12 animate-pulse border border-border bg-secondary/60" /><div className="h-[390px] animate-pulse border border-border bg-secondary/60" /></div>;
}

function ErrorState({ retry }: { retry: () => void }) {
  return <div className="flex min-h-[370px] flex-col items-center justify-center border border-destructive/35 bg-card px-6 text-center" data-testid="error-schedule"><CircleAlert className="mb-4 text-destructive" size={25} /><h2 className="font-display text-xl font-bold text-primary">Schedule feed unavailable</h2><p className="mt-2 max-w-[360px] text-[12px] leading-5 text-muted-foreground">We could not load the normalized 2026 schedule. Try the feed again in a moment.</p><button onClick={retry} className="mt-5 flex items-center gap-2 border border-primary bg-primary px-4 py-2 text-[11px] font-bold uppercase tracking-[0.1em] text-primary-foreground hover:bg-primary/90" data-testid="button-retry-schedule"><RefreshCw size={14} /> Retry feed</button></div>;
}

function SchedulePage() {
  const [state, setState] = useUrlState();
  const { data, isLoading, isError, refetch } = useGetNflSchedule(SEASON, {
    query: {
      queryKey: getGetNflScheduleQueryKey(SEASON),
      staleTime: 1000 * 60 * 5,
      // Poll only while a game is in progress; the rest of the season is static for hours at a time.
      refetchInterval: (query) => (query.state.data?.games.some((game) => game.status === 'LIVE') ? 1000 * 30 : false),
    },
  });
  const teams = data?.teams || [];
  const games = data?.games || [];
  const resolvedState = state.team && teams.some((team) => team.code === state.team) ? state : { ...state, team: teams[0]?.code || '' };
  const handleExport = useCallback(
    (format: ExportFormat) => {
      if (!exportSchedule(format, games, teams, resolvedState, SEASON)) {
        toast({ description: 'No games to export yet — load the schedule or loosen the filter first.' });
      }
    },
    [games, teams, resolvedState],
  );
  const content = isLoading ? <LoadingState /> : isError ? <ErrorState retry={() => void refetch()} /> : !data || !teams.length ? <EmptyState title="No schedule data" body="The feed returned no teams for the 2026 season." /> : resolvedState.view === 'team' ? <TeamView games={games} teams={teams} state={resolvedState} setState={setState} /> : resolvedState.view === 'matrix' ? <MatrixView games={games} teams={teams} setState={setState} /> : <WeeklyView games={games} teams={teams} week={resolvedState.week} gameType={resolvedState.gameType} setState={setState} />;
  useEffect(() => {
    // The WordPress embed keeps its server-rendered table on screen until this fires, so the
    // visitor never sees the schedule replaced by a loading skeleton.
    if (data && teams.length > 0) document.documentElement.classList.add('sc-nfl-ready');
  }, [data, teams.length]);
  return (
    <div className="app-shell">
      <Header state={state} setState={setState} onExport={handleExport} />
      <main className="mx-auto max-w-[1480px] px-[2px] pb-12 pt-6">
        <div className={`${state.view === 'week' ? 'dashboard-grid' : ''} fade-in`}>
          <section className="min-w-0">{content}</section>
          {!isLoading && !isError && data && teams.length > 0 && state.view === 'week' && <div className="fade-in-delay space-y-3"><FantasySnapshot games={games} teams={teams} week={resolvedState.week} /><ByeCard teams={teams} games={games} week={resolvedState.week} setState={setState} /><TravelCard games={games} teams={teams} week={resolvedState.week} /><DivisionCard games={games} teams={teams} week={resolvedState.week} /></div>}
        </div>
      </main>
    </div>
  );
}

function Router() {
  return <RoutedErrorBoundary><Switch><Route path="/" component={SchedulePage} /><Route component={NotFound} /></Switch></RoutedErrorBoundary>;
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function App() {
  return <QueryClientProvider client={queryClient}><TooltipProvider><WouterRouter base={routerBase()}><Router /></WouterRouter><Toaster /></TooltipProvider></QueryClientProvider>;
}

export default App;
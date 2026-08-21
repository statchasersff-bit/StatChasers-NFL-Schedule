import { type ReactNode, type CSSProperties, useCallback, useEffect, useMemo, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  ArrowLeft,
  ArrowRight,
  CalendarDays,
  ChevronDown,
  CircleAlert,
  Clock3,
  Command,
  Download,
  Filter,
  Grid2X2,
  List,
  MapPin,
  RefreshCw,
  Search,
  Shield,
  SlidersHorizontal,
  Sparkles,
  SunMedium,
  Trophy,
  Users,
  X,
} from 'lucide-react';
import {
  getGetNflScheduleQueryKey,
  useGetNflSchedule,
  type NflGame,
  type NflTeam,
} from '@workspace/api-client-react';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import { Route, Switch, useLocation, Router as WouterRouter } from 'wouter';

const queryClient = new QueryClient();
const SEASON = 2026;
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
  window.history.pushState({}, '', query ? `/?${query}` : '/');
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

function formatTime(time: string | null) {
  if (!time) return 'Time TBD';
  const match = time.match(/^(\d{1,2}):(\d{2})/);
  if (!match) return time;
  const hour = Number(match[1]);
  return `${hour > 12 ? hour - 12 : hour}:${match[2]} ${hour >= 12 ? 'PM' : 'AM'}`;
}

function TeamLogo({ team, size = 'md' }: { team?: NflTeam; size?: 'sm' | 'md' | 'lg' }) {
  const dimensions = size === 'lg' ? 'h-14 w-14' : size === 'sm' ? 'h-8 w-8' : 'h-10 w-10';
  if (!team) return <div className={`${dimensions} rounded-full bg-secondary`} />;
  return (
    <div
      className={`${dimensions} team-mark flex shrink-0 items-center justify-center rounded-full border border-white/80 shadow-sm`}
      style={{ background: team.primaryColor || '#17243e' } as CSSProperties}
      data-testid={`team-logo-${team.code}`}
      title={team.name}
    >
      {team.logo ? (
        <img className="h-[72%] w-[72%] object-contain" src={team.logo} alt={`${team.name} logo`} />
      ) : (
        <span className="font-display text-[11px] font-bold tracking-tight text-white">{team.code}</span>
      )}
    </div>
  );
}

function Header({ state, setState, teams }: { state: ReturnType<typeof readState>; setState: typeof updateState; teams: NflTeam[] }) {
  const [location] = useLocation();
  const [mobileSearch, setMobileSearch] = useState(false);
  const setView = (view: ViewMode) => setState({ view });
  return (
    <header className="border-b border-border bg-card">
      <div className="top-rule" />
      <div className="mx-auto flex max-w-[1480px] items-center justify-between gap-4 px-5 py-4 lg:px-8">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center bg-primary text-accent">
            <Trophy size={18} strokeWidth={2.4} />
          </div>
          <div>
            <div className="font-display text-[17px] font-bold leading-none tracking-[-0.03em]">StatChasers</div>
            <div className="mt-1 text-[10px] font-bold uppercase tracking-[0.22em] text-muted-foreground">NFL schedule lab</div>
          </div>
        </div>
        <nav className="hidden items-center gap-1 md:flex" aria-label="Primary navigation">
          {(['week', 'team', 'matrix'] as ViewMode[]).map((item) => (
            <button
              key={item}
              onClick={() => setView(item)}
              className={`flex items-center gap-2 border-b-2 px-4 py-3 text-[12px] font-bold uppercase tracking-[0.12em] ${state.view === item ? 'border-accent text-primary' : 'border-transparent text-muted-foreground hover:text-primary'}`}
              data-testid={`button-view-${item}`}
            >
              {item === 'week' ? <List size={15} /> : item === 'team' ? <Shield size={15} /> : <Grid2X2 size={15} />}
              {item === 'week' ? 'Weekly board' : item === 'team' ? 'Team lens' : 'Season matrix'}
            </button>
          ))}
        </nav>
        <div className="flex items-center gap-2">
          <button
            className="hidden items-center gap-2 border border-border px-3 py-2 text-[11px] font-bold uppercase tracking-[0.12em] text-muted-foreground hover:border-primary hover:text-primary sm:flex"
            onClick={() => window.alert('Schedule export is ready to connect to your preferred format.')}
            data-testid="button-export-schedule"
          >
            <Download size={14} /> Export
          </button>
          <button className="flex h-9 w-9 items-center justify-center border border-border text-muted-foreground hover:border-primary hover:text-primary sm:hidden" onClick={() => setMobileSearch(!mobileSearch)} data-testid="button-toggle-search">
            {mobileSearch ? <X size={17} /> : <Search size={17} />}
          </button>
          <span className="hidden items-center gap-2 text-[11px] font-semibold text-muted-foreground lg:flex"><span className="h-2 w-2 rounded-full bg-[#3d9b70]" /> Data current</span>
        </div>
      </div>
      {mobileSearch && (
        <div className="border-t border-border px-5 py-3 sm:hidden">
          <TeamSearch state={state} setState={setState} teams={teams} fullWidth />
        </div>
      )}
      {location !== '/' && null}
    </header>
  );
}

function TeamSearch({ state, setState, teams, fullWidth = false }: { state: ReturnType<typeof readState>; setState: typeof updateState; teams: NflTeam[]; fullWidth?: boolean }) {
  return (
    <div className={`relative ${fullWidth ? 'w-full' : 'w-full max-w-[290px]'}`}>
      <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" size={16} />
      <input
        type="search"
        value={state.filter}
        onChange={(event) => setState({ filter: event.target.value })}
        placeholder="Find a team or city..."
        className="h-10 w-full border border-border bg-background pl-9 pr-9 text-[13px] outline-none transition-colors placeholder:text-muted-foreground/70 focus:border-primary focus:ring-2 focus:ring-accent/30"
        data-testid="input-team-search"
      />
      {state.filter && <button onClick={() => setState({ filter: '' })} className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-muted-foreground hover:text-primary" data-testid="button-clear-team-search"><X size={14} /></button>}
      {state.filter && teams.length > 0 && teams.filter((team) => `${team.name} ${team.city} ${team.code}`.toLowerCase().includes(state.filter.toLowerCase())).length > 0 && (
        <div className="absolute left-0 right-0 top-12 z-20 border border-border bg-card p-1 shadow-lg">
          {teams.filter((team) => `${team.name} ${team.city} ${team.code}`.toLowerCase().includes(state.filter.toLowerCase())).slice(0, 5).map((team) => (
            <button key={team.code} onClick={() => { setState({ team: team.code, view: 'team', filter: '' }); }} className="flex w-full items-center gap-2 px-2 py-2 text-left hover:bg-secondary" data-testid={`button-search-team-${team.code}`}>
              <TeamLogo team={team} size="sm" /><span className="text-[12px] font-semibold">{team.city} <span className="font-normal text-muted-foreground">{team.name}</span></span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ViewTabs({ state, setState }: { state: ReturnType<typeof readState>; setState: typeof updateState }) {
  return (
    <div className="flex border-b border-border md:hidden">
      {(['week', 'team', 'matrix'] as ViewMode[]).map((item) => (
        <button key={item} onClick={() => setState({ view: item })} className={`flex-1 border-b-2 py-3 text-[10px] font-bold uppercase tracking-[0.1em] ${state.view === item ? 'border-accent text-primary' : 'border-transparent text-muted-foreground'}`} data-testid={`button-mobile-view-${item}`}>
          {item === 'week' ? 'Weekly' : item === 'team' ? 'Team' : 'Matrix'}
        </button>
      ))}
    </div>
  );
}

function WeekRail({ week, setState }: { week: number; setState: typeof updateState }) {
  return (
    <div className="mobile-scroll -mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
      {Array.from({ length: 18 }, (_, index) => index + 1).map((item) => (
        <button key={item} onClick={() => setState({ week: item, view: 'week' })} className={`week-button min-w-[53px] border px-3 py-2 text-left ${week === item ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-card text-muted-foreground'}`} data-testid={`button-week-${item}`}>
          <span className="block text-[9px] font-bold uppercase tracking-[0.12em] opacity-70">Wk</span>
          <span className="font-display text-lg font-bold leading-none">{String(item).padStart(2, '0')}</span>
        </button>
      ))}
    </div>
  );
}

function PageIntro({ state, setState, teams }: { state: ReturnType<typeof readState>; setState: typeof updateState; teams: NflTeam[] }) {
  return (
    <section className="mb-7 flex flex-col justify-between gap-5 border-b border-border pb-6 lg:flex-row lg:items-end">
      <div>
        <div className="mb-3 flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.18em] text-accent-foreground">
          <span className="h-2 w-2 bg-accent" /> 2026 regular season
        </div>
        <h1 className="font-display text-4xl font-bold tracking-[-0.055em] text-primary sm:text-5xl">Find the edge<br /><span className="text-muted-foreground/75">before kickoff.</span></h1>
        <p className="mt-3 max-w-[550px] text-[13px] leading-6 text-muted-foreground">A faster read on every matchup, bye, and fantasy-friendly stretch in the 2026 NFL season.</p>
      </div>
      <div className="hidden flex-col items-end gap-2 lg:flex">
        <span className="text-[10px] font-bold uppercase tracking-[0.16em] text-muted-foreground">Team lookup</span>
        <TeamSearch state={state} setState={setState} teams={teams} />
      </div>
    </section>
  );
}

function StatStrip({ games, teams, week }: { games: NflGame[]; teams: NflTeam[]; week: number }) {
  const selectedGames = games.filter((game) => game.week === week);
  const prime = selectedGames.filter((game) => game.primetime).length;
  const byes = teams.filter((team) => !selectedGames.some((game) => game.awayTeam === team.code || game.homeTeam === team.code)).length;
  const stats = [
    { label: 'Week matchups', value: selectedGames.length, icon: CalendarDays },
    { label: 'Prime-time windows', value: prime, icon: Clock3 },
    { label: 'Teams on bye', value: byes, icon: SunMedium },
  ];
  return (
    <div className="mb-6 grid grid-cols-1 border border-border bg-card sm:grid-cols-3">
      {stats.map(({ label, value, icon: Icon }, index) => (
        <div key={label} className={`flex items-center gap-3 px-4 py-3 ${index > 0 ? 'border-t border-border sm:border-l sm:border-t-0' : ''}`} data-testid={`stat-${label.toLowerCase().replaceAll(' ', '-')}`}>
          <Icon size={16} className={index === 2 ? 'text-accent-foreground' : 'text-muted-foreground'} />
          <div><div className="font-display text-xl font-bold tabular-nums text-primary">{value}</div><div className="text-[10px] font-bold uppercase tracking-[0.1em] text-muted-foreground">{label}</div></div>
        </div>
      ))}
    </div>
  );
}

function GameRow({ game, teams }: { game: NflGame; teams: NflTeam[] }) {
  const away = teams.find((team) => team.code === game.awayTeam);
  const home = teams.find((team) => team.code === game.homeTeam);
  const isFinal = game.status === 'FINAL' || (game.awayScore !== null && game.homeScore !== null);
  return (
    <article className="schedule-row grid grid-cols-[72px_minmax(0,1fr)_86px] items-center gap-3 border-b border-border px-4 py-4 sm:grid-cols-[112px_minmax(0,1fr)_145px] sm:px-5" data-testid={`row-game-${game.id}`}>
      <div className="self-start pt-1">
        <div className="text-[11px] font-bold text-primary">{formatDate(game.date, game.day)}</div>
        <div className="mt-1 text-[10px] text-muted-foreground">{game.holiday || game.network || '—'}</div>
      </div>
      <div className="flex min-w-0 items-center justify-center gap-3 sm:gap-7">
        <div className="flex min-w-0 flex-1 items-center justify-end gap-2 text-right">
          <div className="min-w-0"><div className="flex items-center justify-end gap-2"><div className="truncate font-display text-[13px] font-bold text-primary">{away?.shortName || game.awayTeam}</div>{isFinal && <strong className="font-display text-base tabular-nums text-primary">{game.awayScore}</strong>}</div><div className="text-[10px] uppercase tracking-[0.08em] text-muted-foreground">{game.awayTeam}</div></div>
          <TeamLogo team={away} size="sm" />
        </div>
        <div className="flex shrink-0 flex-col items-center">
          <span className="text-[9px] font-bold uppercase tracking-[0.14em] text-muted-foreground">at</span>
          <span className="my-1 h-px w-5 bg-accent" />
        </div>
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <TeamLogo team={home} size="sm" />
          <div className="min-w-0"><div className="flex items-center gap-2">{isFinal && <strong className="font-display text-base tabular-nums text-primary">{game.homeScore}</strong>}<div className="truncate font-display text-[13px] font-bold text-primary">{home?.shortName || game.homeTeam}</div></div><div className="text-[10px] uppercase tracking-[0.08em] text-muted-foreground">{game.homeTeam}</div></div>
        </div>
      </div>
      <div className="text-right">
        <div className="font-display text-[12px] font-bold text-primary">{isFinal ? 'FINAL' : game.status === 'LIVE' ? 'LIVE' : formatTime(game.time)}</div>
        <div className="mt-1 flex items-center justify-end gap-1 text-[10px] text-muted-foreground"><MapPin size={11} /> {game.international ? 'International' : game.stadium || game.location || 'Venue TBD'}</div>
        <div className="mt-1 flex justify-end gap-1">{game.primetime && <span className="border border-accent bg-accent/15 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.08em] text-accent-foreground">Prime</span>}{game.divisionGame && <span className="hidden border border-border px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.08em] text-muted-foreground sm:inline-block">Div</span>}</div>
      </div>
    </article>
  );
}

function ByePanel({ teams, games, week, setState }: { teams: NflTeam[]; games: NflGame[]; week: number; setState: typeof updateState }) {
  const byes = teams.filter((team) => !games.some((game) => game.week === week && (game.awayTeam === team.code || game.homeTeam === team.code)));
  return (
    <section className="border border-border bg-card p-5" data-testid="panel-bye-weeks">
      <div className="mb-4 flex items-start justify-between"><div><div className="mb-1 text-[10px] font-bold uppercase tracking-[0.15em] text-muted-foreground">Bye week utility</div><h2 className="font-display text-lg font-bold tracking-[-0.03em] text-primary">{byes.length} teams reset in week {week}</h2></div><SunMedium className="text-accent-foreground" size={18} /></div>
      {byes.length > 0 ? (
        <div className="flex flex-wrap gap-2">{byes.map((team) => <button key={team.code} onClick={() => setState({ team: team.code, view: 'team' })} className="flex items-center gap-2 border border-border px-2 py-1.5 text-left hover:border-primary" data-testid={`button-bye-team-${team.code}`}><TeamLogo team={team} size="sm" /><span className="text-[11px] font-bold">{team.code}</span></button>)}</div>
      ) : <p className="text-[12px] leading-5 text-muted-foreground">No teams are currently marked on bye for this week.</p>}
    </section>
  );
}

function InsightsPanel({ games, teams, week }: { games: NflGame[]; teams: NflTeam[]; week: number }) {
  const teamGames = new Map<string, NflGame[]>();
  games.forEach((game) => { [game.awayTeam, game.homeTeam].forEach((code) => teamGames.set(code, [...(teamGames.get(code) || []), game])); });
  const mostPrime = [...teamGames.entries()].map(([code, items]) => ({ code, count: items.filter((game) => game.primetime).length })).sort((a, b) => b.count - a.count)[0];
  const weekGames = games.filter((game) => game.week === week);
  const divisionalRate = weekGames.length ? Math.round((weekGames.filter((game) => game.divisionGame).length / weekGames.length) * 100) : 0;
  return (
    <aside className="space-y-4">
      <section className="border border-primary bg-primary p-5 text-primary-foreground" data-testid="panel-fantasy-insights">
        <div className="mb-5 flex items-center justify-between"><div className="text-[10px] font-bold uppercase tracking-[0.16em] text-accent">Fantasy read</div><Sparkles size={17} className="text-accent" /></div>
        <h2 className="font-display text-2xl font-bold leading-tight tracking-[-0.04em]">The schedule<br />is the matchup.</h2>
        <p className="mt-3 text-[12px] leading-5 text-primary-foreground/65">Use the board to spot dense travel weeks, divisional pressure, and prime-time volume before the waiver wire moves.</p>
        <div className="mt-6 border-t border-primary-foreground/15 pt-4"><div className="text-[10px] font-bold uppercase tracking-[0.12em] text-primary-foreground/55">Week {week} signal</div><div className="mt-2 font-display text-3xl font-bold text-accent">{divisionalRate}%</div><div className="text-[11px] text-primary-foreground/65">of matchups are divisional</div></div>
      </section>
      <section className="border border-border bg-card p-5" data-testid="panel-schedule-notes">
        <div className="mb-4 flex items-center justify-between"><div className="text-[10px] font-bold uppercase tracking-[0.15em] text-muted-foreground">Schedule notes</div><SlidersHorizontal size={16} className="text-muted-foreground" /></div>
        <div className="space-y-4">
          <div><div className="text-[11px] font-bold text-primary">Prime-time leader</div><div className="mt-1 text-[12px] text-muted-foreground">{mostPrime ? `${mostPrime.code} carries ${mostPrime.count} prime-time windows` : 'No prime-time data yet'}</div></div>
          <div className="border-t border-border pt-4"><div className="text-[11px] font-bold text-primary">International slate</div><div className="mt-1 text-[12px] text-muted-foreground">{games.filter((game) => game.international).length} games outside the U.S. this season</div></div>
          <div className="border-t border-border pt-4"><div className="text-[11px] font-bold text-primary">Source freshness</div><div className="mt-1 flex items-center gap-1.5 text-[12px] text-muted-foreground"><span className="h-1.5 w-1.5 rounded-full bg-[#3d9b70]" /> Normalized schedule feed</div></div>
        </div>
      </section>
    </aside>
  );
}

function WeeklyView({ games, teams, week, gameType, setState }: { games: NflGame[]; teams: NflTeam[]; week: number; gameType: string; setState: typeof updateState }) {
  const weekGames = games.filter((game) => {
    if (game.week !== week) return false;
    if (gameType === 'primetime') return game.primetime;
    if (gameType === 'division') return game.divisionGame;
    if (gameType === 'international') return game.international;
    if (gameType === 'holiday') return Boolean(game.holiday);
    return true;
  }).sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  return (
    <>
      <div className="mb-5 flex items-end justify-between gap-4"><div><div className="text-[10px] font-bold uppercase tracking-[0.16em] text-muted-foreground">Schedule explorer</div><h2 className="mt-1 font-display text-2xl font-bold tracking-[-0.04em] text-primary">Week {week}<span className="ml-2 text-base font-medium text-muted-foreground">/ 18</span></h2></div><div className="hidden items-center gap-2 text-[11px] text-muted-foreground sm:flex"><Filter size={14} /> Showing all matchups</div></div>
       <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
         <WeekRail week={week} setState={setState} />
         <label className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.12em] text-muted-foreground">
           Filter
           <select value={gameType} onChange={(event) => setState({ gameType: event.target.value })} className="h-9 border border-border bg-card px-2 text-[11px] font-semibold normal-case tracking-normal text-primary outline-none focus:border-primary" aria-label="Filter games">
             <option value="all">All games</option>
             <option value="primetime">Primetime</option>
             <option value="division">Division</option>
             <option value="international">International</option>
             <option value="holiday">Holiday</option>
           </select>
         </label>
       </div>
      <div className="mt-5 overflow-hidden border border-border bg-card">
        <div className="grid grid-cols-[72px_minmax(0,1fr)_86px] gap-3 border-b border-border bg-secondary/50 px-4 py-2.5 text-[9px] font-bold uppercase tracking-[0.14em] text-muted-foreground sm:grid-cols-[112px_minmax(0,1fr)_145px] sm:px-5"><span>When</span><span className="text-center">Matchup</span><span className="text-right">Details</span></div>
        {weekGames.length > 0 ? weekGames.map((game) => <GameRow key={game.id} game={game} teams={teams} />) : <EmptyState title={`Week ${week} is still open`} body="No normalized matchups were returned for this week." />}
      </div>
    </>
  );
}

function TeamView({ games, teams, state, setState }: { games: NflGame[]; teams: NflTeam[]; state: ReturnType<typeof readState>; setState: typeof updateState }) {
  const selected = teams.find((team) => team.code === state.team) || teams[0];
  const teamGames = selected ? games.filter((game) => game.awayTeam === selected.code || game.homeTeam === selected.code).sort((a, b) => a.week - b.week) : [];
  return (
    <div>
      <div className="mb-6 flex flex-col justify-between gap-4 border-b border-border pb-6 sm:flex-row sm:items-end">
        <div className="flex items-center gap-4">{selected && <TeamLogo team={selected} size="lg" />}<div><div className="text-[10px] font-bold uppercase tracking-[0.16em] text-muted-foreground">Team lens</div><h2 className="mt-1 font-display text-3xl font-bold tracking-[-0.05em] text-primary">{selected?.city || 'Select a'} <span className="text-muted-foreground/65">{selected?.name || 'team'}</span></h2><p className="mt-1 text-[12px] text-muted-foreground">{selected?.conference} · {selected?.division}</p></div></div>
        <div className="relative min-w-[210px]"><select value={selected?.code || ''} onChange={(event) => setState({ team: event.target.value, view: 'team' })} className="h-10 w-full appearance-none border border-border bg-card px-3 pr-9 text-[12px] font-semibold text-primary outline-none focus:border-primary" data-testid="select-team-view">{teams.map((team) => <option key={team.code} value={team.code}>{team.city} {team.name}</option>)}</select><ChevronDown className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground" size={15} /></div>
      </div>
      <div className="mb-5 grid grid-cols-2 border border-border bg-card sm:grid-cols-4">
        {[{ label: 'Games', value: teamGames.length }, { label: 'Home', value: teamGames.filter((game) => game.homeTeam === selected?.code).length }, { label: 'Division', value: teamGames.filter((game) => game.divisionGame).length }, { label: 'Prime', value: teamGames.filter((game) => game.primetime).length }].map((item) => <div key={item.label} className="border-r border-border px-4 py-3 last:border-r-0"><div className="font-display text-xl font-bold text-primary">{item.value}</div><div className="text-[10px] font-bold uppercase tracking-[0.12em] text-muted-foreground">{item.label}</div></div>)}
      </div>
      <div className="border border-border bg-card">
        <div className="flex items-center justify-between border-b border-border px-5 py-3"><div className="text-[10px] font-bold uppercase tracking-[0.15em] text-muted-foreground">Full season path</div><span className="text-[11px] text-muted-foreground">{teamGames.length} scheduled</span></div>
        {teamGames.length ? teamGames.map((game) => <GameRow key={game.id} game={game} teams={teams} />) : <EmptyState title="No schedule found" body="Choose another team or refresh the schedule feed." />}
      </div>
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
        <div className="min-w-[1150px]">
          <div className="grid grid-cols-[190px_repeat(18,minmax(68px,1fr))] border-b border-border bg-secondary/50 text-[9px] font-bold uppercase tracking-[0.12em] text-muted-foreground"><div className="px-4 py-3">Team</div>{Array.from({ length: 18 }, (_, i) => <div key={i + 1} className="matrix-cell px-2 py-3 text-center">W{i + 1}</div>)}</div>
          {teams.map((team) => <div key={team.code} className="grid grid-cols-[190px_repeat(18,minmax(68px,1fr))] border-b border-border last:border-b-0"><button onClick={() => setState({ team: team.code, view: 'team' })} className="flex items-center gap-2 px-4 py-2 text-left hover:bg-secondary" data-testid={`button-matrix-team-${team.code}`}><TeamLogo team={team} size="sm" /><span className="truncate text-[11px] font-bold text-primary">{team.code}<span className="ml-1 hidden font-normal text-muted-foreground xl:inline">{team.shortName}</span></span></button>{Array.from({ length: 18 }, (_, i) => { const game = cells.get(`${team.code}-${i + 1}`); if (!game) return <div key={i + 1} className="matrix-cell flex items-center justify-center border-l border-border bg-muted/35 text-[10px] font-bold text-muted-foreground">BYE</div>; const opponent = game.awayTeam === team.code ? game.homeTeam : game.awayTeam; const home = game.homeTeam === team.code; return <button key={i + 1} onClick={() => setState({ week: i + 1, view: 'week' })} className={`matrix-cell border-l border-border px-1 py-2 text-center hover:bg-accent/15 ${game.primetime ? 'bg-accent/10' : ''}`} data-testid={`button-matrix-cell-${team.code}-${i + 1}`}><div className="font-display text-[12px] font-bold text-primary">{home ? 'vs' : '@'} {opponent}</div><div className="mt-0.5 text-[9px] text-muted-foreground">{game.divisionGame ? 'DIV' : game.primetime ? 'PRIME' : '—'}</div></button>; })}</div>)}
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
  const { data, isLoading, isError, refetch } = useGetNflSchedule(SEASON, { query: { queryKey: getGetNflScheduleQueryKey(SEASON), staleTime: 1000 * 60 * 30 } });
  const teams = data?.teams || [];
  const games = data?.games || [];
  const filteredTeams = useMemo(() => teams.filter((team) => `${team.name} ${team.city} ${team.code}`.toLowerCase().includes(state.filter.toLowerCase())), [teams, state.filter]);
  const resolvedState = state.team && teams.some((team) => team.code === state.team) ? state : { ...state, team: teams[0]?.code || '' };
  const content = isLoading ? <LoadingState /> : isError ? <ErrorState retry={() => void refetch()} /> : !data || !teams.length ? <EmptyState title="No schedule data" body="The feed returned no teams for the 2026 season." /> : resolvedState.view === 'team' ? <TeamView games={games} teams={teams} state={resolvedState} setState={setState} /> : resolvedState.view === 'matrix' ? <MatrixView games={games} teams={teams} setState={setState} /> : <WeeklyView games={games} teams={teams} week={resolvedState.week} gameType={resolvedState.gameType} setState={setState} />;
  return (
    <div className="app-shell">
      <Header state={state} setState={setState} teams={filteredTeams.length ? filteredTeams : teams} />
      <main className="mx-auto max-w-[1480px] px-5 pb-12 pt-6 lg:px-8">
        <ViewTabs state={state} setState={setState} />
        <PageIntro state={state} setState={setState} teams={teams} />
        {!isLoading && !isError && data && teams.length > 0 && state.view === 'week' && <StatStrip games={games} teams={teams} week={resolvedState.week} />}
        <div className="dashboard-grid fade-in">
          <section className="min-w-0">{content}</section>
          {!isLoading && !isError && data && teams.length > 0 && <div className="fade-in-delay"><InsightsPanel games={games} teams={teams} week={resolvedState.week} /><div className="mt-4"><ByePanel teams={teams} games={games} week={resolvedState.week} setState={setState} /></div></div>}
        </div>
        <footer className="mt-10 flex flex-col justify-between gap-2 border-t border-border pt-4 text-[10px] uppercase tracking-[0.12em] text-muted-foreground sm:flex-row"><span>StatChasers · 2026 schedule lab</span><span>Source: {data?.source || 'normalized feed'} · Updated {data?.fetchedAt ? new Date(data.fetchedAt).toLocaleDateString() : '—'}</span></footer>
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
  return <QueryClientProvider client={queryClient}><TooltipProvider><WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}><Router /></WouterRouter><Toaster /></TooltipProvider></QueryClientProvider>;
}

export default App;
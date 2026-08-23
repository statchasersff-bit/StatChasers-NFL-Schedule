<?php
/**
 * Schedule data layer: fetch, normalize, cache.
 *
 * A PHP port of artifacts/api-server/src/routes/nfl.ts. The two halves of the feed move on very
 * different clocks, so they are stored and refreshed separately:
 *
 *   - the nflverse slate (dates, venues, lines) changes a few times a season   -> 6 hour TTL
 *   - ESPN's layer (status, live scores, TV) changes by the minute on game day -> 30s while live
 *
 * Both live in options rather than transients: a transient can be evicted by an object cache at
 * any moment, and an evicted schedule means a blank page for whoever asks next. Options give us
 * a last-known-good copy that survives, with the freshness decision made from stored timestamps.
 *
 * @package StatChasers\NFLSchedule
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Fetches, normalizes and caches the NFL schedule.
 */
class SC_NFL_Data {

	const CRON_HOOK      = 'sc_nfl_refresh';
	const CRON_SCHEDULE  = 'sc_nfl_five_minutes';
	const BASE_TTL       = 21600; // 6 hours.
	const ESPN_FULL_TTL  = 21600; // 6 hours: catches flexed kickoffs and late TV assignments.
	const ESPN_LIVE_TTL  = 30;
	const ESPN_IDLE_TTL  = 900;   // 15 minutes.
	const LOCK_TTL       = 120;
	const CSV_URL        = 'https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv';
	const ESPN_URL       = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';
	const EASTERN        = 'America/New_York';

	/**
	 * Wire up cron.
	 *
	 * @return void
	 */
	public static function init() {
		add_filter( 'cron_schedules', array( __CLASS__, 'cron_schedules' ) ); // phpcs:ignore WordPress.WP.CronInterval
		add_action( self::CRON_HOOK, array( __CLASS__, 'run_cron' ) );
	}

	/**
	 * Register the five-minute refresh interval.
	 *
	 * @param array $schedules Existing schedules.
	 * @return array
	 */
	public static function cron_schedules( $schedules ) {
		if ( ! isset( $schedules[ self::CRON_SCHEDULE ] ) ) {
			$schedules[ self::CRON_SCHEDULE ] = array(
				'interval' => 300,
				'display'  => __( 'Every five minutes (StatChasers NFL)', 'sc-nfl' ),
			);
		}
		return $schedules;
	}

	/**
	 * Schedule the recurring refresh and prime the cache out of band.
	 *
	 * @return void
	 */
	public static function activate() {
		if ( ! wp_next_scheduled( self::CRON_HOOK ) ) {
			wp_schedule_event( time() + 60, self::CRON_SCHEDULE, self::CRON_HOOK );
		}
		// Prime immediately rather than making the first visitor wait for the CSV download.
		wp_schedule_single_event( time() + 5, self::CRON_HOOK );
	}

	/**
	 * Clear scheduled refreshes.
	 *
	 * @return void
	 */
	public static function deactivate() {
		wp_clear_scheduled_hook( self::CRON_HOOK );
	}

	/**
	 * Cron entry point: keep every season that has stored data warm.
	 *
	 * @return void
	 */
	public static function run_cron() {
		$seasons = get_option( 'sc_nfl_seasons', array() );
		if ( ! is_array( $seasons ) || empty( $seasons ) ) {
			$seasons = array( (int) SC_NFL_DEFAULT_SEASON );
		}
		foreach ( $seasons as $season ) {
			self::refresh( (int) $season );
		}
	}

	/**
	 * Build the public payload for a season.
	 *
	 * @param int  $season        Season year.
	 * @param bool $allow_network Whether this caller may make blocking HTTP requests to freshen
	 *                            the live layer. True for REST (a poll expects current scores),
	 *                            false for page rendering (a visitor should never wait on ESPN).
	 * @return array Payload matching the NflScheduleResponse schema; `games` is empty if the
	 *               feed has never been fetched successfully.
	 */
	public static function get_schedule( $season, $allow_network = false ) {
		$season = (int) $season;
		$base   = self::get_base( $season );

		if ( empty( $base['rows'] ) ) {
			return self::payload( $season, array(), array() );
		}

		$espn = self::get_espn_store( $season );
		$age  = time() - (int) $espn['updated_at'];
		$ttl  = self::has_live_game( $espn ) ? self::ESPN_LIVE_TTL : self::ESPN_IDLE_TTL;

		if ( $age > $ttl ) {
			if ( $allow_network ) {
				$espn = self::refresh_espn( $season, $base, $espn );
			} else {
				self::schedule_soon();
			}
		}

		return self::payload( $season, $base['rows'], $espn['games'] );
	}

	/**
	 * Refresh whatever is stale for a season. Safe to call repeatedly; it no-ops when fresh.
	 *
	 * @param int $season Season year.
	 * @return void
	 */
	public static function refresh( $season ) {
		$season = (int) $season;
		$base   = self::get_base( $season );
		if ( empty( $base['rows'] ) || ( time() - (int) $base['fetched_at'] ) > self::BASE_TTL ) {
			$base = self::refresh_base( $season );
		}
		if ( empty( $base['rows'] ) ) {
			return;
		}
		self::refresh_espn( $season, $base, self::get_espn_store( $season ) );
	}

	/**
	 * Read the stored slate, building it synchronously the very first time.
	 *
	 * @param int $season Season year.
	 * @return array {rows, fetched_at}
	 */
	private static function get_base( $season ) {
		$base = get_option( self::base_key( $season ) );
		if ( is_array( $base ) && ! empty( $base['rows'] ) ) {
			if ( ( time() - (int) $base['fetched_at'] ) > self::BASE_TTL ) {
				self::schedule_soon();
			}
			return $base;
		}
		// Cold cache. One request pays for the download; the rest render the "loading" notice
		// rather than piling onto a 2 MB fetch.
		if ( ! self::acquire_lock( $season ) ) {
			return array(
				'rows'       => array(),
				'fetched_at' => 0,
			);
		}
		$base = self::refresh_base( $season );
		self::release_lock( $season );
		return $base;
	}

	/**
	 * Download and store the nflverse slate.
	 *
	 * @param int $season Season year.
	 * @return array {rows, fetched_at}
	 */
	private static function refresh_base( $season ) {
		$existing = get_option( self::base_key( $season ) );
		$existing = is_array( $existing ) ? $existing : array(
			'rows'       => array(),
			'fetched_at' => 0,
		);

		$response = wp_remote_get(
			self::CSV_URL,
			array(
				'timeout'    => 30,
				'user-agent' => 'StatChasers NFL Schedule/' . SC_NFL_VERSION . '; ' . home_url( '/' ),
			)
		);

		if ( is_wp_error( $response ) || 200 !== (int) wp_remote_retrieve_response_code( $response ) ) {
			// Keep serving the last good copy; try again on the next cron tick.
			return $existing;
		}

		$rows = self::parse_csv( wp_remote_retrieve_body( $response ), $season );
		if ( empty( $rows ) ) {
			return $existing;
		}

		$base = array(
			'rows'       => $rows,
			'fetched_at' => time(),
		);
		update_option( self::base_key( $season ), $base, false );
		self::remember_season( $season );
		return $base;
	}

	/**
	 * Parse the nflverse CSV, keeping only the regular-season rows for one season and only the
	 * columns this plugin uses. The full file is ~7,000 rows x 46 columns; storing all of it
	 * would bloat wp_options for no benefit.
	 *
	 * @param string $body   Raw CSV.
	 * @param int    $season Season year.
	 * @return array List of compact rows.
	 */
	private static function parse_csv( $body, $season ) {
		$keep = array(
			'game_id',
			'old_game_id',
			'week',
			'gameday',
			'weekday',
			'gametime',
			'away_team',
			'home_team',
			'away_score',
			'home_score',
			'location',
			'stadium',
			'espn',
			'div_game',
			'spread_line',
			'total_line',
		);

		$handle = fopen( 'php://temp', 'r+' );
		if ( false === $handle ) {
			return array();
		}
		fwrite( $handle, $body );
		rewind( $handle );

		$headers = fgetcsv( $handle );
		if ( ! is_array( $headers ) ) {
			fclose( $handle );
			return array();
		}
		$headers = array_map( 'trim', $headers );
		$index   = array_flip( $headers );

		if ( ! isset( $index['season'], $index['game_type'] ) ) {
			fclose( $handle );
			return array();
		}

		$season_key = (string) $season;
		$rows       = array();

		while ( false !== ( $values = fgetcsv( $handle ) ) ) {
			if ( ! is_array( $values ) ) {
				continue;
			}
			$row_season = isset( $values[ $index['season'] ] ) ? $values[ $index['season'] ] : '';
			if ( $row_season !== $season_key ) {
				continue;
			}
			$game_type = isset( $values[ $index['game_type'] ] ) ? $values[ $index['game_type'] ] : '';
			if ( 'REG' !== $game_type ) {
				continue;
			}
			$row = array();
			foreach ( $keep as $column ) {
				$row[ $column ] = isset( $index[ $column ], $values[ $index[ $column ] ] )
					? (string) $values[ $index[ $column ] ]
					: '';
			}
			$rows[] = $row;
		}

		fclose( $handle );
		return $rows;
	}

	/**
	 * Read the stored ESPN layer.
	 *
	 * @param int $season Season year.
	 * @return array {games, updated_at, full_at}
	 */
	private static function get_espn_store( $season ) {
		$espn = get_option( self::espn_key( $season ) );
		if ( ! is_array( $espn ) || ! isset( $espn['games'] ) || ! is_array( $espn['games'] ) ) {
			return array(
				'games'      => array(),
				'updated_at' => 0,
				'full_at'    => 0,
			);
		}
		$espn['updated_at'] = isset( $espn['updated_at'] ) ? (int) $espn['updated_at'] : 0;
		$espn['full_at']    = isset( $espn['full_at'] ) ? (int) $espn['full_at'] : 0;
		return $espn;
	}

	/**
	 * Re-poll ESPN. Sweeps all 18 weeks on a cold cache and every ESPN_FULL_TTL; in between it
	 * only asks about weeks that can still be in progress, so the fast path is one or two
	 * requests rather than eighteen.
	 *
	 * @param int   $season Season year.
	 * @param array $base   Stored slate.
	 * @param array $espn   Stored ESPN layer.
	 * @return array Updated ESPN layer.
	 */
	private static function refresh_espn( $season, $base, $espn ) {
		$now  = time();
		$full = empty( $espn['games'] ) || ( $now - (int) $espn['full_at'] ) > self::ESPN_FULL_TTL;

		if ( $full ) {
			$weeks = range( 1, 18 );
		} else {
			$weeks = self::active_weeks( $base['rows'] );
			if ( empty( $weeks ) ) {
				// Nothing can be in progress; just push the clock forward so we do not re-check
				// on every request until the next full sweep is due.
				$espn['updated_at'] = $now;
				update_option( self::espn_key( $season ), $espn, false );
				return $espn;
			}
		}

		$fetched = 0;
		foreach ( $weeks as $week ) {
			$url = add_query_arg(
				array(
					'dates'      => $season,
					'seasontype' => 2,
					'week'       => (int) $week,
				),
				self::ESPN_URL
			);

			$response = wp_remote_get(
				$url,
				array(
					'timeout'    => 10,
					'headers'    => array( 'accept' => 'application/json' ),
					'user-agent' => 'StatChasers NFL Schedule/' . SC_NFL_VERSION . '; ' . home_url( '/' ),
				)
			);

			if ( is_wp_error( $response ) || 200 !== (int) wp_remote_retrieve_response_code( $response ) ) {
				continue;
			}

			$payload = json_decode( wp_remote_retrieve_body( $response ), true );
			if ( ! is_array( $payload ) || empty( $payload['events'] ) || ! is_array( $payload['events'] ) ) {
				continue;
			}

			foreach ( $payload['events'] as $event ) {
				$parsed = self::read_event( $event );
				if ( null !== $parsed ) {
					$espn['games'][ $parsed['id'] ] = $parsed;
				}
			}
			++$fetched;
		}

		// A total failure leaves the previous data in place instead of blanking TV and scores.
		if ( 0 === $fetched ) {
			return $espn;
		}

		$espn['updated_at'] = $now;
		if ( $full ) {
			$espn['full_at'] = $now;
		}
		update_option( self::espn_key( $season ), $espn, false );
		return $espn;
	}

	/**
	 * Extract the fields we care about from one ESPN scoreboard event.
	 *
	 * @param mixed $event Raw event.
	 * @return array|null
	 */
	private static function read_event( $event ) {
		if ( ! is_array( $event ) || empty( $event['id'] ) ) {
			return null;
		}

		$competition = isset( $event['competitions'][0] ) && is_array( $event['competitions'][0] )
			? $event['competitions'][0]
			: array();

		$names = array();
		if ( ! empty( $competition['broadcasts'] ) && is_array( $competition['broadcasts'] ) ) {
			foreach ( $competition['broadcasts'] as $broadcast ) {
				if ( ! empty( $broadcast['names'] ) && is_array( $broadcast['names'] ) ) {
					$names = array_merge( $names, $broadcast['names'] );
				} elseif ( ! empty( $broadcast['media']['shortName'] ) ) {
					$names[] = $broadcast['media']['shortName'];
				}
			}
		}
		$names = array_values( array_unique( array_filter( array_map( 'strval', $names ) ) ) );

		$type      = isset( $event['status']['type'] ) && is_array( $event['status']['type'] ) ? $event['status']['type'] : array();
		$state     = isset( $type['state'] ) ? (string) $type['state'] : 'pre';
		$detail    = '';
		if ( isset( $type['shortDetail'] ) && '' !== $type['shortDetail'] ) {
			$detail = (string) $type['shortDetail'];
		} elseif ( isset( $type['detail'] ) ) {
			$detail = (string) $type['detail'];
		}

		return array(
			'id'        => (string) $event['id'],
			'network'   => empty( $names ) ? null : implode( ' / ', $names ),
			'state'     => ( 'in' === $state || 'post' === $state ) ? $state : 'pre',
			'completed' => ! empty( $type['completed'] ),
			'detail'    => '' === $detail ? null : $detail,
			'away'      => self::competitor_score( $competition, 'away' ),
			'home'      => self::competitor_score( $competition, 'home' ),
		);
	}

	/**
	 * Pull one side's score out of a competition.
	 *
	 * @param array  $competition Competition node.
	 * @param string $side        'home' or 'away'.
	 * @return int|null
	 */
	private static function competitor_score( $competition, $side ) {
		if ( empty( $competition['competitors'] ) || ! is_array( $competition['competitors'] ) ) {
			return null;
		}
		foreach ( $competition['competitors'] as $competitor ) {
			if ( ! is_array( $competitor ) || ! isset( $competitor['homeAway'] ) || $competitor['homeAway'] !== $side ) {
				continue;
			}
			if ( ! isset( $competitor['score'] ) || '' === $competitor['score'] || ! is_numeric( $competitor['score'] ) ) {
				return null;
			}
			return (int) $competitor['score'];
		}
		return null;
	}

	/**
	 * Weeks holding a game today or yesterday Eastern — the only ones whose score can change.
	 *
	 * @param array $rows Stored slate.
	 * @return array List of week numbers.
	 */
	private static function active_weeks( $rows ) {
		$today     = self::eastern_date( 0 );
		$yesterday = self::eastern_date( -1 );
		$weeks     = array();
		foreach ( $rows as $row ) {
			if ( $row['gameday'] === $today || $row['gameday'] === $yesterday ) {
				$weeks[ (int) $row['week'] ] = true;
			}
		}
		return array_keys( $weeks );
	}

	/**
	 * A date in US Eastern, which is the zone nflverse publishes kickoffs in.
	 *
	 * @param int $offset_days Days to add.
	 * @return string Y-m-d
	 */
	private static function eastern_date( $offset_days = 0 ) {
		try {
			$now = new DateTimeImmutable( 'now', new DateTimeZone( self::EASTERN ) );
		} catch ( Exception $e ) {
			return gmdate( 'Y-m-d' );
		}
		if ( 0 !== $offset_days ) {
			$now = $now->modify( sprintf( '%+d day', $offset_days ) );
		}
		return $now->format( 'Y-m-d' );
	}

	/**
	 * Is anything in progress right now?
	 *
	 * @param array $espn Stored ESPN layer.
	 * @return bool
	 */
	private static function has_live_game( $espn ) {
		foreach ( $espn['games'] as $game ) {
			if ( isset( $game['state'] ) && 'in' === $game['state'] ) {
				return true;
			}
		}
		return false;
	}

	/**
	 * Assemble the response payload.
	 *
	 * @param int   $season Season year.
	 * @param array $rows   Stored slate.
	 * @param array $espn   ESPN games keyed by event id.
	 * @return array
	 */
	private static function payload( $season, $rows, $espn ) {
		$games = array();
		foreach ( $rows as $index => $row ) {
			$games[] = self::normalize_row( $row, $season, $index, $espn );
		}
		return array(
			'season'    => $season,
			'source'    => 'nflverse + espn',
			'fetchedAt' => gmdate( 'c' ),
			'teams'     => self::teams(),
			'games'     => $games,
		);
	}

	/**
	 * Turn one stored CSV row plus its ESPN counterpart into an API game object.
	 *
	 * @param array $row    Compact CSV row.
	 * @param int   $season Season year.
	 * @param int   $index  Row index, used only for the synthetic id fallback.
	 * @param array $espn   ESPN games keyed by event id.
	 * @return array
	 */
	private static function normalize_row( $row, $season, $index, $espn ) {
		$away_team = self::normalize_team_code( $row['away_team'] );
		$home_team = self::normalize_team_code( $row['home_team'] );
		$home_info = self::team_by_code( $home_team );
		$away_info = self::team_by_code( $away_team );

		$location     = '' === $row['location'] ? null : $row['location'];
		$neutral_site = null !== $location && 'neutral' === strtolower( $location );
		$international = $neutral_site || (bool) preg_match(
			'/london|munich|s(a|ã)o paulo|melbourne|mexico|tottenham|wembley/i',
			$location . ' ' . $row['stadium']
		);

		$stadium = '' !== $row['stadium'] ? $row['stadium'] : null;

		// ESPN is the live authority; nflverse only publishes a final score hours after the whistle.
		$entry     = isset( $espn[ $row['espn'] ] ) ? $espn[ $row['espn'] ] : null;
		$csv_away  = self::number_or_null( $row['away_score'] );
		$csv_home  = self::number_or_null( $row['home_score'] );

		if ( null !== $entry ) {
			$is_final = ! empty( $entry['completed'] ) || ( 'post' === $entry['state'] && null !== $entry['away'] );
		} else {
			$is_final = ( null !== $csv_away && null !== $csv_home );
		}

		if ( null !== $entry && 'in' === $entry['state'] ) {
			$status = 'LIVE';
		} elseif ( $is_final ) {
			$status = 'FINAL';
		} else {
			$status = 'SCHEDULED';
		}

		$use_espn_score = ( null !== $entry && 'SCHEDULED' !== $status );
		$away_score     = $use_espn_score && null !== $entry['away'] ? $entry['away'] : $csv_away;
		$home_score     = $use_espn_score && null !== $entry['home'] ? $entry['home'] : $csv_home;

		if ( $international ) {
			$resolved_location = ( null !== $location && 'Neutral' !== $location && 'Home' !== $location )
				? $location
				: self::venue_city( $row['stadium'] );
			if ( null === $resolved_location ) {
				$resolved_location = null !== $home_info ? $home_info['city'] : ( null !== $away_info ? $away_info['city'] : null );
			}
		} elseif ( 'Home' === $location ) {
			$resolved_location = null !== $home_info ? $home_info['city'] : null;
		} else {
			$resolved_location = $location;
		}

		$id = '' !== $row['game_id'] ? $row['game_id'] : $row['old_game_id'];
		if ( '' === $id ) {
			$id = sprintf( '%d-%s-%s-%s-%d', $season, $row['week'], $away_team, $home_team, $index );
		}

		return array(
			'id'           => (string) $id,
			'season'       => (int) $season,
			'week'         => (int) $row['week'],
			'date'         => '' === $row['gameday'] ? null : $row['gameday'],
			'day'          => '' === $row['weekday'] ? null : $row['weekday'],
			'time'         => '' === $row['gametime'] ? null : $row['gametime'],
			'awayTeam'     => $away_team,
			'homeTeam'     => $home_team,
			'awayScore'    => $away_score,
			'homeScore'    => $home_score,
			'status'       => $status,
			'statusDetail' => ( 'SCHEDULED' === $status || null === $entry ) ? null : $entry['detail'],
			'network'      => null !== $entry ? $entry['network'] : null,
			'stadium'      => null === $stadium ? null : str_replace( 'Tottenham Hotspur Stadium', 'Tottenham Hotspur', $stadium ),
			'location'     => $resolved_location,
			'international' => (bool) $international,
			'neutralSite'  => (bool) $neutral_site,
			'divisionGame' => ( 'TRUE' === $row['div_game'] || '1' === $row['div_game'] ),
			'holiday'      => self::classify_holiday( '' === $row['gameday'] ? null : $row['gameday'] ),
			'spreadLine'   => self::number_or_null( $row['spread_line'] ),
			'totalLine'    => self::number_or_null( $row['total_line'] ),
		);
	}

	/**
	 * Numeric CSV field, or null when blank.
	 *
	 * @param string $value Raw value.
	 * @return float|int|null
	 */
	private static function number_or_null( $value ) {
		if ( ! is_string( $value ) || '' === trim( $value ) || ! is_numeric( trim( $value ) ) ) {
			return null;
		}
		$number = (float) trim( $value );
		// Keep whole numbers as ints so scores serialize as 21 rather than 21.0.
		return ( floor( $number ) === $number ) ? (int) $number : $number;
	}

	/**
	 * Fold historic and alternate abbreviations onto the current ones.
	 *
	 * @param string $value Raw code.
	 * @return string
	 */
	private static function normalize_team_code( $value ) {
		$aliases = array(
			'LA'  => 'LAR',
			'STL' => 'LAR',
			'OAK' => 'LV',
			'SD'  => 'LAC',
			'JAC' => 'JAX',
			'WSH' => 'WAS',
		);
		return isset( $aliases[ $value ] ) ? $aliases[ $value ] : (string) $value;
	}

	/**
	 * Thanksgiving is the fourth Thursday in November, so it moves between the 22nd and the 28th.
	 *
	 * @param int $year Year.
	 * @return int Day of month.
	 */
	private static function thanksgiving( $year ) {
		$first_of_november = (int) gmdate( 'w', gmmktime( 0, 0, 0, 11, 1, (int) $year ) );
		return 22 + ( ( 4 - $first_of_november + 7 ) % 7 );
	}

	/**
	 * Tag holiday games — the day itself, not the holiday week.
	 *
	 * @param string|null $date Y-m-d.
	 * @return string|null
	 */
	private static function classify_holiday( $date ) {
		if ( null === $date || '' === $date ) {
			return null;
		}
		$parts = explode( '-', $date );
		if ( count( $parts ) < 3 ) {
			return null;
		}
		$year  = (int) $parts[0];
		$month = (int) $parts[1];
		$day   = (int) $parts[2];

		if ( 11 === $month && $day === self::thanksgiving( $year ) ) {
			return 'THANKSGIVING';
		}
		if ( 12 === $month && 25 === $day ) {
			return 'CHRISTMAS';
		}
		if ( 12 === $month && 24 === $day ) {
			return 'CHRISTMAS EVE';
		}
		return null;
	}

	/**
	 * nflverse only marks international games "Home"/"Neutral", so map the venue to its real city.
	 *
	 * @param string $stadium Raw stadium name.
	 * @return string|null
	 */
	private static function venue_city( $stadium ) {
		$cities = array(
			'Melbourne Cricket Ground'  => 'Melbourne, Australia',
			'Maracana Stadium'          => 'Rio de Janeiro, Brazil',
			'Bernabeu'                  => 'Madrid, Spain',
			'Stade de France'           => 'Paris, France',
			'FC Bayern Munich Stadium'  => 'Munich, Germany',
			'Tottenham Hotspur Stadium' => 'London, UK',
			'Wembley Stadium'           => 'London, UK',
			'Estadio Banorte'           => 'Mexico City, Mexico',
		);
		return isset( $cities[ $stadium ] ) ? $cities[ $stadium ] : null;
	}

	/**
	 * One team by code.
	 *
	 * @param string $code Team code.
	 * @return array|null
	 */
	public static function team_by_code( $code ) {
		foreach ( self::teams() as $team ) {
			if ( $team['code'] === $code ) {
				return $team;
			}
		}
		return null;
	}

	/**
	 * The 32 teams.
	 *
	 * @return array
	 */
	public static function teams() {
		static $teams = null;
		if ( null !== $teams ) {
			return $teams;
		}

		$rows = array(
			array( 'ARI', 'Arizona Cardinals', 'Cardinals', 'Arizona', 'NFC', 'NFC West', '#97233F', '#000000' ),
			array( 'ATL', 'Atlanta Falcons', 'Falcons', 'Atlanta', 'NFC', 'NFC South', '#A71930', '#000000' ),
			array( 'BAL', 'Baltimore Ravens', 'Ravens', 'Baltimore', 'AFC', 'AFC North', '#241773', '#9E7C0C' ),
			array( 'BUF', 'Buffalo Bills', 'Bills', 'Buffalo', 'AFC', 'AFC East', '#00338D', '#C60C30' ),
			array( 'CAR', 'Carolina Panthers', 'Panthers', 'Carolina', 'NFC', 'NFC South', '#0085CA', '#101820' ),
			array( 'CHI', 'Chicago Bears', 'Bears', 'Chicago', 'NFC', 'NFC North', '#0B162A', '#C83803' ),
			array( 'CIN', 'Cincinnati Bengals', 'Bengals', 'Cincinnati', 'AFC', 'AFC North', '#FB4F14', '#000000' ),
			array( 'CLE', 'Cleveland Browns', 'Browns', 'Cleveland', 'AFC', 'AFC North', '#311D00', '#FF3C00' ),
			array( 'DAL', 'Dallas Cowboys', 'Cowboys', 'Dallas', 'NFC', 'NFC East', '#041E42', '#869397' ),
			array( 'DEN', 'Denver Broncos', 'Broncos', 'Denver', 'AFC', 'AFC West', '#FB4F14', '#002244' ),
			array( 'DET', 'Detroit Lions', 'Lions', 'Detroit', 'NFC', 'NFC North', '#0076B6', '#B0B7BC' ),
			array( 'GB', 'Green Bay Packers', 'Packers', 'Green Bay', 'NFC', 'NFC North', '#203731', '#FFB612' ),
			array( 'HOU', 'Houston Texans', 'Texans', 'Houston', 'AFC', 'AFC South', '#03202F', '#A71930' ),
			array( 'IND', 'Indianapolis Colts', 'Colts', 'Indianapolis', 'AFC', 'AFC South', '#002C5F', '#A2AAAD' ),
			array( 'JAX', 'Jacksonville Jaguars', 'Jaguars', 'Jacksonville', 'AFC', 'AFC South', '#006778', '#D7A22A' ),
			array( 'KC', 'Kansas City Chiefs', 'Chiefs', 'Kansas City', 'AFC', 'AFC West', '#E31837', '#FFB81C' ),
			array( 'LV', 'Las Vegas Raiders', 'Raiders', 'Las Vegas', 'AFC', 'AFC West', '#000000', '#A5ACAF' ),
			array( 'LAC', 'Los Angeles Chargers', 'Chargers', 'Los Angeles', 'AFC', 'AFC West', '#0080C6', '#FFC20E' ),
			array( 'LAR', 'Los Angeles Rams', 'Rams', 'Los Angeles', 'NFC', 'NFC West', '#003594', '#FFA300' ),
			array( 'MIA', 'Miami Dolphins', 'Dolphins', 'Miami', 'AFC', 'AFC East', '#008E97', '#FC4C02' ),
			array( 'MIN', 'Minnesota Vikings', 'Vikings', 'Minnesota', 'NFC', 'NFC North', '#4F2683', '#FFC62F' ),
			array( 'NE', 'New England Patriots', 'Patriots', 'New England', 'AFC', 'AFC East', '#002244', '#C60C30' ),
			array( 'NO', 'New Orleans Saints', 'Saints', 'New Orleans', 'NFC', 'NFC South', '#D3BC8D', '#101820' ),
			array( 'NYG', 'New York Giants', 'Giants', 'New York', 'NFC', 'NFC East', '#0B2265', '#A71930' ),
			array( 'NYJ', 'New York Jets', 'Jets', 'New York', 'AFC', 'AFC East', '#125740', '#000000' ),
			array( 'PHI', 'Philadelphia Eagles', 'Eagles', 'Philadelphia', 'NFC', 'NFC East', '#004C54', '#A5ACAF' ),
			array( 'PIT', 'Pittsburgh Steelers', 'Steelers', 'Pittsburgh', 'AFC', 'AFC North', '#FFB612', '#101820' ),
			array( 'SEA', 'Seattle Seahawks', 'Seahawks', 'Seattle', 'NFC', 'NFC West', '#002244', '#69BE28' ),
			array( 'SF', 'San Francisco 49ers', '49ers', 'San Francisco', 'NFC', 'NFC West', '#AA0000', '#B3995D' ),
			array( 'TB', 'Tampa Bay Buccaneers', 'Buccaneers', 'Tampa Bay', 'NFC', 'NFC South', '#D50A0A', '#FF7900' ),
			array( 'TEN', 'Tennessee Titans', 'Titans', 'Tennessee', 'AFC', 'AFC South', '#0C2340', '#4B92DB' ),
			array( 'WAS', 'Washington Commanders', 'Commanders', 'Washington', 'NFC', 'NFC East', '#5A1414', '#FFB81C' ),
		);

		$teams = array();
		foreach ( $rows as $row ) {
			$teams[] = array(
				'code'            => $row[0],
				'name'            => $row[1],
				'shortName'       => $row[2],
				'city'            => $row[3],
				'conference'      => $row[4],
				'division'        => $row[5],
				'primaryColor'    => $row[6],
				'secondaryColor'  => $row[7],
				'logo'            => 'https://a.espncdn.com/i/teamlogos/nfl/500/' . strtolower( $row[0] ) . '.png',
			);
		}
		return $teams;
	}

	/**
	 * Option key for the slate.
	 *
	 * @param int $season Season year.
	 * @return string
	 */
	private static function base_key( $season ) {
		return 'sc_nfl_base_' . (int) $season;
	}

	/**
	 * Option key for the ESPN layer.
	 *
	 * @param int $season Season year.
	 * @return string
	 */
	private static function espn_key( $season ) {
		return 'sc_nfl_espn_' . (int) $season;
	}

	/**
	 * Track which seasons cron should keep warm.
	 *
	 * @param int $season Season year.
	 * @return void
	 */
	private static function remember_season( $season ) {
		$seasons = get_option( 'sc_nfl_seasons', array() );
		if ( ! is_array( $seasons ) ) {
			$seasons = array();
		}
		if ( ! in_array( (int) $season, array_map( 'intval', $seasons ), true ) ) {
			$seasons[] = (int) $season;
			update_option( 'sc_nfl_seasons', $seasons, false );
		}
	}

	/**
	 * Ask cron to refresh on the next request rather than blocking this one.
	 *
	 * @return void
	 */
	private static function schedule_soon() {
		if ( ! wp_next_scheduled( self::CRON_HOOK ) ) {
			wp_schedule_single_event( time() + 10, self::CRON_HOOK );
		}
	}

	/**
	 * Cold-cache build lock, so a burst of traffic triggers one download rather than many.
	 *
	 * @param int $season Season year.
	 * @return bool True when this process owns the lock.
	 */
	private static function acquire_lock( $season ) {
		$key = 'sc_nfl_lock_' . (int) $season;
		if ( get_transient( $key ) ) {
			return false;
		}
		set_transient( $key, 1, self::LOCK_TTL );
		return true;
	}

	/**
	 * Release the build lock.
	 *
	 * @param int $season Season year.
	 * @return void
	 */
	private static function release_lock( $season ) {
		delete_transient( 'sc_nfl_lock_' . (int) $season );
	}
}

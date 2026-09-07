<?php
/**
 * Front-end rendering: the `[nfl_schedule]` shortcode.
 *
 * The whole point of this plugin is that the schedule exists in the HTML WordPress sends, not
 * only in a JavaScript bundle. So every week is written out as a real table. The React app is an
 * enhancement layered on top; if it never loads, the page is still complete.
 *
 * @package StatChasers\NFLSchedule
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Renders the schedule.
 */
class SC_NFL_Render {

	/** Upper bound on structured-data entries, so the page does not carry 100 KB of JSON-LD. */
	const JSONLD_LIMIT = 64;

	/**
	 * Register the shortcode.
	 *
	 * @return void
	 */
	/** Guards against enqueueing twice when both the early hook and the shortcode fire. */
	private static $enqueued = false;

	public static function init() {
		add_shortcode( 'nfl_schedule', array( __CLASS__, 'shortcode' ) );
		add_action( 'wp_enqueue_scripts', array( __CLASS__, 'maybe_enqueue_early' ) );
	}

	/**
	 * Enqueue before wp_head when the shortcode is visible in the post content.
	 *
	 * Enqueueing from inside the shortcode happens during the_content — after wp_head has already
	 * printed — so WordPress defers those styles to the footer and the static table paints unstyled
	 * first. Detecting the shortcode here puts the CSS in the head where it belongs. Page builders
	 * that keep content elsewhere simply fall back to the shortcode-time enqueue.
	 *
	 * @return void
	 */
	public static function maybe_enqueue_early() {
		if ( ! is_singular() ) {
			return;
		}
		$post = get_post();
		if ( ! $post || ! has_shortcode( $post->post_content, 'nfl_schedule' ) ) {
			return;
		}

		$season  = SC_NFL_DEFAULT_SEASON;
		$use_app = true;
		if ( preg_match( '/\[nfl_schedule([^\]]*)\]/', $post->post_content, $match ) ) {
			$atts = shortcode_parse_atts( $match[1] );
			if ( is_array( $atts ) ) {
				if ( isset( $atts['season'] ) ) {
					$season = (int) $atts['season'];
				}
				if ( isset( $atts['app'] ) && 'no' === strtolower( $atts['app'] ) ) {
					$use_app = false;
				}
			}
		}
		self::enqueue( $season, $use_app );
	}

	/**
	 * Shortcode handler.
	 *
	 * Attributes:
	 *   season   Season year. Default SC_NFL_DEFAULT_SEASON.
	 *   heading  Heading tag for week titles: h2 (default), h3 or h4. The page title should own h1.
	 *   jsonld   upcoming (default) | all | none.
	 *   app      yes (default) | no. "no" ships the static table only, with no React bundle.
	 *   width    content (default) | wide (breaks out to 1280px, on viewports over 1400px only) | full (edge to edge).
	 *
	 * @param array|string $atts Shortcode attributes.
	 * @return string
	 */
	public static function shortcode( $atts ) {
		$atts = shortcode_atts(
			array(
				'season'  => SC_NFL_DEFAULT_SEASON,
				'heading' => 'h2',
				'jsonld'  => 'upcoming',
				'app'     => 'yes',
				'width'   => 'content',
			),
			$atts,
			'nfl_schedule'
		);

		$season  = (int) $atts['season'];
		$heading = in_array( strtolower( $atts['heading'] ), array( 'h2', 'h3', 'h4' ), true ) ? strtolower( $atts['heading'] ) : 'h2';
		$payload = SC_NFL_Data::get_schedule( $season, false );

		if ( empty( $payload['games'] ) ) {
			return '<p class="sc-nfl-notice">' . esc_html__( 'The NFL schedule is being loaded. Please check back in a minute.', 'sc-nfl' ) . '</p>';
		}

		$use_app = 'no' !== strtolower( $atts['app'] );
		$width   = strtolower( $atts['width'] );
		$width   = in_array( $width, array( 'content', 'wide', 'full' ), true ) ? $width : 'content';
		self::enqueue( $season, $use_app );

		$teams = self::index_teams( $payload['teams'] );
		$weeks = self::group_by_week( $payload['games'] );

		ob_start();
		?>
		<?php if ( $use_app ) : ?>
			<?php // Runs while the browser is still parsing, so the static table below is never painted
			// for a visitor who will get the app. The timeout restores it if the bundle never boots. ?>
			<script>(function(){var r=document.documentElement;r.classList.add('sc-nfl-js');
			setTimeout(function(){if(!r.classList.contains('sc-nfl-booted')){r.classList.remove('sc-nfl-js');}},8000);})();</script>
		<?php endif; ?>
		<div class="sc-nfl-embed sc-nfl-width-<?php echo esc_attr( $width ); ?>" data-sc-nfl-season="<?php echo esc_attr( (string) $season ); ?>">
			<div class="sc-nfl-static" data-sc-nfl-static>
				<?php echo self::render_week_nav( $weeks ); // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped ?>
				<?php
				foreach ( $weeks as $week => $games ) {
					echo self::render_week( (int) $week, $games, $teams, $heading, $season ); // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped
				}
				?>
			</div>
			<?php if ( $use_app ) : ?>
				<div id="sc-nfl-root" class="sc-nfl-root"></div>
			<?php endif; ?>
		</div>
		<?php
		$html = ob_get_clean();

		$jsonld = self::render_jsonld( $payload['games'], $teams, strtolower( $atts['jsonld'] ), $season );

		return $html . $jsonld;
	}

	/**
	 * Enqueue styles and, optionally, the app bundle.
	 *
	 * @param int  $season  Season year.
	 * @param bool $use_app Whether to load the React bundle.
	 * @return void
	 */
	private static function enqueue( $season, $use_app ) {
		if ( self::$enqueued ) {
			return;
		}
		self::$enqueued = true;

		wp_enqueue_style(
			'sc-nfl-embed',
			SC_NFL_URL . 'assets/sc-nfl-embed.css',
			array(),
			SC_NFL_VERSION
		);

		// Measure the scrollbar so the wide/full widths can subtract it from 100vw instead of
		// overflowing the page sideways.
		//
		// Measuring once at load is not enough: the page is still short at that point, so there is
		// no vertical scrollbar to measure, and none appears until the schedule has rendered. A
		// ResizeObserver catches that later growth. The write is guarded on a changed value, since
		// the property feeds back into layout and an unguarded write can oscillate.
		wp_add_inline_style( 'sc-nfl-embed', ':root{--sc-scrollbar:0px}' );
		wp_register_script( 'sc-nfl-scrollbar', '', array(), SC_NFL_VERSION, false );
		wp_enqueue_script( 'sc-nfl-scrollbar' );
		wp_add_inline_script(
			'sc-nfl-scrollbar',
			'(function(){var last=null,r=document.documentElement;'
				. 'function m(){var v=(window.innerWidth-r.clientWidth)+"px";'
				. 'if(v!==last){last=v;r.style.setProperty("--sc-scrollbar",v);}}'
				. 'm();window.addEventListener("resize",m);window.addEventListener("load",m);'
				. 'if(window.ResizeObserver){new ResizeObserver(m).observe(r);}})();'
		);

		if ( ! $use_app ) {
			return;
		}

		$script = SC_NFL_PATH . 'assets/sc-nfl-schedule.js';
		$style  = SC_NFL_PATH . 'assets/sc-nfl-schedule.css';

		// The bundle is copied in from the app build. Without it the static table simply stands
		// on its own rather than the page erroring. The stylesheet counts as part of the bundle:
		// the app renders as unstyled markup without it, which is worse than the table it replaces.
		if ( ! file_exists( $script ) || ! file_exists( $style ) ) {
			return;
		}

		// The app renders in a shadow root, so its stylesheet is fetched and injected there rather
		// than linked here — that boundary is what keeps the theme's CSS out. Only the at-rules a
		// shadow root ignores (@font-face, @property) are enqueued at document level.
		$document_style = SC_NFL_PATH . 'assets/sc-nfl-schedule.document.css';
		if ( file_exists( $document_style ) ) {
			wp_enqueue_style( 'sc-nfl-app-document', SC_NFL_URL . 'assets/sc-nfl-schedule.document.css', array(), SC_NFL_VERSION );
		}

		wp_enqueue_script( 'sc-nfl-app', SC_NFL_URL . 'assets/sc-nfl-schedule.js', array(), SC_NFL_VERSION, true );

		// The shadow stylesheet is fetched by the bundle rather than linked, so warm it in parallel
		// with the script instead of waiting for the script to start the request.
		add_action(
			'wp_head',
			static function () {
				printf(
					'<link rel="preload" as="style" href="%s" />' . "\n",
					esc_url( SC_NFL_URL . 'assets/sc-nfl-schedule.css?v=' . rawurlencode( SC_NFL_VERSION ) )
				);
			}
		);

		$config = array(
			'apiBase'  => esc_url_raw( rest_url( SC_NFL_Rest::NAMESPACE_V1 ) ),
			'basePath' => wp_parse_url( get_permalink(), PHP_URL_PATH ),
			'season'   => $season,
			'mount'    => '#sc-nfl-root',
			'styleUrl' => esc_url_raw( SC_NFL_URL . 'assets/sc-nfl-schedule.css' ) . '?v=' . rawurlencode( SC_NFL_VERSION ),
		);
		if ( empty( $config['basePath'] ) ) {
			$config['basePath'] = '/';
		}

		// wp_localize_script would stringify the season; inline JSON keeps the real types.
		wp_add_inline_script(
			'sc-nfl-app',
			'window.SC_NFL_SCHEDULE = ' . wp_json_encode( $config ) . ';',
			'before'
		);
	}

	/**
	 * Group games by week, preserving week order and kickoff order within a week.
	 *
	 * @param array $games Games.
	 * @return array week => games
	 */
	private static function group_by_week( $games ) {
		$weeks = array();
		foreach ( $games as $game ) {
			$weeks[ (int) $game['week'] ][] = $game;
		}
		ksort( $weeks );
		foreach ( $weeks as $week => $list ) {
			usort(
				$list,
				static function ( $a, $b ) {
					$left  = (string) $a['date'] . ' ' . (string) $a['time'];
					$right = (string) $b['date'] . ' ' . (string) $b['time'];
					return strcmp( $left, $right );
				}
			);
			$weeks[ $week ] = $list;
		}
		return $weeks;
	}

	/**
	 * Teams keyed by code.
	 *
	 * @param array $teams Teams.
	 * @return array
	 */
	private static function index_teams( $teams ) {
		$indexed = array();
		foreach ( $teams as $team ) {
			$indexed[ $team['code'] ] = $team;
		}
		return $indexed;
	}

	/**
	 * In-page week navigation. Real anchors, so they are crawlable and usable without JS.
	 *
	 * @param array $weeks week => games.
	 * @return string
	 */
	private static function render_week_nav( $weeks ) {
		$items = '';
		foreach ( array_keys( $weeks ) as $week ) {
			$items .= sprintf(
				'<li><a href="#sc-nfl-week-%1$d">%2$s</a></li>',
				(int) $week,
				esc_html( sprintf( /* translators: %d: week number */ __( 'Week %d', 'sc-nfl' ), (int) $week ) )
			);
		}
		return '<nav class="sc-nfl-weeknav" aria-label="' . esc_attr__( 'Jump to week', 'sc-nfl' ) . '"><ul>' . $items . '</ul></nav>';
	}

	/**
	 * One week's table.
	 *
	 * @param int    $week    Week number.
	 * @param array  $games   Games in the week.
	 * @param array  $teams   Teams keyed by code.
	 * @param string $heading Heading tag.
	 * @param int    $season  Season year.
	 * @return string
	 */
	private static function render_week( $week, $games, $teams, $heading, $season ) {
		$title_id = 'sc-nfl-week-' . $week . '-title';
		$range    = self::week_range( $games );

		$rows = '';
		foreach ( $games as $game ) {
			$rows .= self::render_row( $game, $teams );
		}

		return sprintf(
			'<section class="sc-nfl-week" id="sc-nfl-week-%1$d" aria-labelledby="%2$s">'
				. '<%3$s class="sc-nfl-week-title" id="%2$s">%4$s<span class="sc-nfl-week-range">%5$s</span></%3$s>'
				. '<div class="sc-nfl-tablewrap">'
				. '<table class="sc-nfl-table">'
				. '<caption class="sc-nfl-caption">%6$s</caption>'
				. '<thead><tr>'
				. '<th scope="col">%7$s</th><th scope="col">%8$s</th><th scope="col">%9$s</th><th scope="col">%10$s</th>'
				. '</tr></thead>'
				. '<tbody>%11$s</tbody>'
				. '</table>'
				. '</div>'
				. '</section>',
			$week,
			esc_attr( $title_id ),
			$heading,
			esc_html( sprintf( /* translators: %d: week number */ __( 'Week %d', 'sc-nfl' ), $week ) ),
			esc_html( $range ),
			esc_html(
				sprintf(
					/* translators: 1: season year, 2: week number */
					__( '%1$d NFL schedule, week %2$d — kickoff times in US Eastern', 'sc-nfl' ),
					$season,
					$week
				)
			),
			esc_html__( 'Date', 'sc-nfl' ),
			esc_html__( 'Kickoff (ET)', 'sc-nfl' ),
			esc_html__( 'Matchup', 'sc-nfl' ),
			esc_html__( 'TV', 'sc-nfl' ),
			$rows
		);
	}

	/**
	 * One game row.
	 *
	 * @param array $game  Game.
	 * @param array $teams Teams keyed by code.
	 * @return string
	 */
	private static function render_row( $game, $teams ) {
		$away = isset( $teams[ $game['awayTeam'] ] ) ? $teams[ $game['awayTeam'] ]['name'] : $game['awayTeam'];
		$home = isset( $teams[ $game['homeTeam'] ] ) ? $teams[ $game['homeTeam'] ]['name'] : $game['homeTeam'];

		$has_score = ( null !== $game['awayScore'] && null !== $game['homeScore'] );
		if ( $has_score ) {
			$matchup = sprintf(
				/* translators: 1: away team, 2: away score, 3: home team, 4: home score */
				__( '%1$s %2$d at %3$s %4$d', 'sc-nfl' ),
				$away,
				(int) $game['awayScore'],
				$home,
				(int) $game['homeScore']
			);
		} else {
			$matchup = sprintf(
				/* translators: 1: away team, 2: home team */
				__( '%1$s at %2$s', 'sc-nfl' ),
				$away,
				$home
			);
		}

		$badges = '';
		if ( ! empty( $game['divisionGame'] ) ) {
			$badges .= ' <span class="sc-nfl-badge">' . esc_html__( 'Division', 'sc-nfl' ) . '</span>';
		}
		if ( ! empty( $game['international'] ) ) {
			$badges .= ' <span class="sc-nfl-badge">' . esc_html__( 'International', 'sc-nfl' ) . '</span>';
		}
		if ( ! empty( $game['holiday'] ) ) {
			$badges .= ' <span class="sc-nfl-badge">' . esc_html( ucwords( strtolower( $game['holiday'] ) ) ) . '</span>';
		}

		return sprintf(
			'<tr class="sc-nfl-row%1$s">'
				. '<td class="sc-nfl-date">%2$s</td>'
				. '<td class="sc-nfl-kick">%3$s</td>'
				. '<td class="sc-nfl-matchup">%4$s%5$s</td>'
				. '<td class="sc-nfl-tv">%6$s</td>'
				. '</tr>',
			'LIVE' === $game['status'] ? ' is-live' : '',
			esc_html( self::format_date( $game['date'], $game['day'] ) ),
			esc_html( self::format_status( $game ) ),
			esc_html( $matchup ),
			$badges,
			self::render_network( $game['network'] )
		);
	}

	/** Broadcaster marks, loaded once from the generated table. See build-network-logos.mjs. */
	private static $networks = null;

	/**
	 * The TV cell: the broadcaster's logo where there is one, its name where there is not.
	 *
	 * ESPN reports a simulcast as a single string ("ESPN / ABC"), so each side is resolved
	 * separately. Marks are two-tone -- the ink follows the surrounding text colour and the
	 * knockouts fall back to the page canvas -- so they read against whatever the theme paints.
	 *
	 * @param string|null $network Broadcaster name from the feed.
	 * @return string HTML.
	 */
	private static function render_network( $network ) {
		if ( null === self::$networks ) {
			self::$networks = require SC_NFL_PATH . 'includes/network-marks.php';
		}

		$html = '';
		$seen = array();
		foreach ( explode( '/', (string) $network ) as $part ) {
			$key = strtoupper( trim( $part ) );
			if ( ! isset( self::$networks['aliases'][ $key ] ) ) {
				continue;
			}
			$slug = self::$networks['aliases'][ $key ];
			if ( isset( $seen[ $slug ] ) ) {
				continue;
			}
			$seen[ $slug ] = true;
			$mark          = self::$networks['marks'][ $slug ];
			// 'body' is generated markup from a trusted source, never feed data, so it is echoed
			// as-is; everything around it is escaped.
			$html .= sprintf(
				'<svg class="sc-nfl-net" viewBox="%1$s" style="height:%2$sem" role="img" aria-label="%3$s">%4$s</svg>',
				esc_attr( $mark['viewBox'] ),
				esc_attr( $mark['height'] ),
				esc_attr( $mark['label'] ),
				$mark['body']
			);
		}

		if ( '' !== $html ) {
			return $html;
		}
		return esc_html( null === $network || '' === $network ? __( 'TBD', 'sc-nfl' ) : $network );
	}

	/**
	 * Kickoff, or the live/final state when the game is under way or done.
	 *
	 * @param array $game Game.
	 * @return string
	 */
	private static function format_status( $game ) {
		if ( 'LIVE' === $game['status'] ) {
			return ! empty( $game['statusDetail'] ) ? strtoupper( $game['statusDetail'] ) : __( 'LIVE', 'sc-nfl' );
		}
		if ( 'FINAL' === $game['status'] ) {
			return ! empty( $game['statusDetail'] ) ? strtoupper( $game['statusDetail'] ) : __( 'FINAL', 'sc-nfl' );
		}
		return self::format_time( $game['time'] );
	}

	/**
	 * "20:20" -> "8:20 PM ET". nflverse publishes kickoffs in US Eastern, so the zone is stated
	 * rather than left for the reader to assume.
	 *
	 * @param string|null $time HH:MM.
	 * @return string
	 */
	private static function format_time( $time ) {
		if ( empty( $time ) || ! preg_match( '/^(\d{1,2}):(\d{2})/', $time, $match ) ) {
			return __( 'Time TBD', 'sc-nfl' );
		}
		$hour   = (int) $match[1];
		$suffix = $hour >= 12 ? 'PM' : 'AM';
		$hour12 = ( 0 === $hour % 12 ) ? 12 : $hour % 12;
		return sprintf( '%d:%s %s ET', $hour12, $match[2], $suffix );
	}

	/**
	 * "2026-09-13" -> "Sun, Sep 13".
	 *
	 * @param string|null $date Y-m-d.
	 * @param string|null $day  Weekday name from the feed, used as the fallback.
	 * @return string
	 */
	private static function format_date( $date, $day ) {
		if ( empty( $date ) ) {
			return empty( $day ) ? __( 'Date TBD', 'sc-nfl' ) : $day;
		}
		$timestamp = self::midday_utc( $date );
		if ( null === $timestamp ) {
			return empty( $day ) ? $date : $day;
		}
		return gmdate( 'D, M j', $timestamp );
	}

	/**
	 * "Sep 10 – Sep 14" for a week heading.
	 *
	 * @param array $games Games in the week.
	 * @return string
	 */
	private static function week_range( $games ) {
		$dates = array();
		foreach ( $games as $game ) {
			if ( ! empty( $game['date'] ) ) {
				$dates[] = $game['date'];
			}
		}
		if ( empty( $dates ) ) {
			return '';
		}
		sort( $dates );
		$first = self::midday_utc( $dates[0] );
		$last  = self::midday_utc( end( $dates ) );
		if ( null === $first || null === $last ) {
			return '';
		}
		if ( gmdate( 'Y-m-d', $first ) === gmdate( 'Y-m-d', $last ) ) {
			return gmdate( 'M j, Y', $first );
		}
		return gmdate( 'M j', $first ) . ' – ' . gmdate( 'M j, Y', $last );
	}

	/**
	 * Midday UTC for a Y-m-d date.
	 *
	 * Anchored at midday and parsed in a fixed zone so that formatting the result with gmdate()
	 * can never roll the calendar day forward or back, whatever the host's PHP timezone is.
	 *
	 * @param string $date Y-m-d.
	 * @return int|null Unix timestamp.
	 */
	private static function midday_utc( $date ) {
		if ( ! preg_match( '/^(\d{4})-(\d{2})-(\d{2})$/', (string) $date, $match ) ) {
			return null;
		}
		return gmmktime( 12, 0, 0, (int) $match[2], (int) $match[3], (int) $match[1] );
	}

	/**
	 * SportsEvent structured data.
	 *
	 * There is no guaranteed rich result for a schedule listing; this exists to make the entities
	 * (teams, kickoff times, venues) unambiguous. Defaults to upcoming games only, because 272
	 * events would add roughly 100 KB to the page for diminishing returns.
	 *
	 * @param array  $games Games.
	 * @param array  $teams Teams keyed by code.
	 * @param string $mode  upcoming|all|none.
	 * @param int    $season Season year.
	 * @return string
	 */
	private static function render_jsonld( $games, $teams, $mode, $season ) {
		if ( 'none' === $mode ) {
			return '';
		}

		$today     = gmdate( 'Y-m-d' );
		$permalink = get_permalink();
		$selected  = array();

		foreach ( $games as $game ) {
			if ( empty( $game['date'] ) ) {
				continue;
			}
			if ( 'all' !== $mode && $game['date'] < $today ) {
				continue;
			}
			$selected[] = $game;
			if ( 'all' !== $mode && count( $selected ) >= self::JSONLD_LIMIT ) {
				break;
			}
		}

		if ( empty( $selected ) ) {
			return '';
		}

		$items = array();
		foreach ( $selected as $position => $game ) {
			$away = isset( $teams[ $game['awayTeam'] ] ) ? $teams[ $game['awayTeam'] ]['name'] : $game['awayTeam'];
			$home = isset( $teams[ $game['homeTeam'] ] ) ? $teams[ $game['homeTeam'] ]['name'] : $game['homeTeam'];

			$event = array(
				'@type'               => 'SportsEvent',
				'name'                => sprintf( '%s at %s', $away, $home ),
				'sport'               => 'American Football',
				'eventAttendanceMode' => 'https://schema.org/OfflineEventAttendanceMode',
				'eventStatus'         => 'https://schema.org/EventScheduled',
				'homeTeam'            => array(
					'@type' => 'SportsTeam',
					'name'  => $home,
				),
				'awayTeam'            => array(
					'@type' => 'SportsTeam',
					'name'  => $away,
				),
			);

			$start = self::iso_start( $game['date'], $game['time'] );
			if ( null !== $start ) {
				$event['startDate'] = $start;
			}

			$venue_name = ! empty( $game['stadium'] ) ? $game['stadium'] : $game['location'];
			if ( ! empty( $venue_name ) ) {
				$place = array(
					'@type' => 'Place',
					'name'  => $venue_name,
				);
				if ( ! empty( $game['location'] ) && $game['location'] !== $venue_name ) {
					$place['address'] = $game['location'];
				}
				$event['location'] = $place;
			}

			if ( $permalink ) {
				$event['url'] = $permalink . '#sc-nfl-week-' . (int) $game['week'];
			}

			$items[] = array(
				'@type'    => 'ListItem',
				'position' => $position + 1,
				'item'     => $event,
			);
		}

		$graph = array(
			'@context'         => 'https://schema.org',
			'@type'            => 'ItemList',
			'name'             => sprintf( /* translators: %d: season year */ __( '%d NFL schedule', 'sc-nfl' ), $season ),
			'numberOfItems'    => count( $items ),
			'itemListOrder'    => 'https://schema.org/ItemListOrderAscending',
			'itemListElement'  => $items,
		);

		return '<script type="application/ld+json">'
			. wp_json_encode( $graph, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE )
			. '</script>';
	}

	/**
	 * ISO 8601 kickoff with the correct Eastern offset (EDT for most of the season, EST in
	 * December and January). Without the offset a crawler would read the time as UTC.
	 *
	 * @param string      $date Y-m-d.
	 * @param string|null $time HH:MM.
	 * @return string|null
	 */
	private static function iso_start( $date, $time ) {
		if ( empty( $time ) || ! preg_match( '/^(\d{1,2}):(\d{2})/', $time, $match ) ) {
			return null;
		}
		try {
			$stamp = new DateTimeImmutable(
				sprintf( '%s %02d:%02d:00', $date, (int) $match[1], (int) $match[2] ),
				new DateTimeZone( SC_NFL_Data::EASTERN )
			);
		} catch ( Exception $e ) {
			return null;
		}
		return $stamp->format( 'c' );
	}
}

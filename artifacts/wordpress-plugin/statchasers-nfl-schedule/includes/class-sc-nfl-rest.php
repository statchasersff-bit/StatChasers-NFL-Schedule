<?php
/**
 * REST route consumed by the app bundle.
 *
 * The path deliberately mirrors the Express API (`/api/nfl/schedule/{season}`) so the generated
 * TypeScript client needs nothing but a base URL to point here instead.
 *
 * @package StatChasers\NFLSchedule
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Exposes the schedule over the WordPress REST API.
 */
class SC_NFL_Rest {

	const NAMESPACE_V1 = 'statchasers/v1';

	/**
	 * Register the route.
	 *
	 * @return void
	 */
	public static function init() {
		add_action( 'rest_api_init', array( __CLASS__, 'register_routes' ) );
	}

	/**
	 * Route registration.
	 *
	 * @return void
	 */
	public static function register_routes() {
		register_rest_route(
			self::NAMESPACE_V1,
			'/api/nfl/schedule/(?P<season>\d{4})',
			array(
				'methods'             => WP_REST_Server::READABLE,
				'callback'            => array( __CLASS__, 'get_schedule' ),
				'permission_callback' => '__return_true',
				'args'                => array(
					'season' => array(
						'required'          => true,
						'validate_callback' => static function ( $value ) {
							$season = (int) $value;
							return $season >= 2000 && $season <= 2100;
						},
						'sanitize_callback' => 'absint',
					),
				),
			)
		);
	}

	/**
	 * Return the schedule payload.
	 *
	 * Unlike page rendering, a poll from the app is allowed to block on ESPN: it is asking
	 * precisely because it wants the current score.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function get_schedule( $request ) {
		$season  = (int) $request->get_param( 'season' );
		$payload = SC_NFL_Data::get_schedule( $season, true );

		if ( empty( $payload['games'] ) ) {
			return new WP_Error(
				'sc_nfl_unavailable',
				__( 'The NFL schedule is not available yet.', 'sc-nfl' ),
				array( 'status' => 503 )
			);
		}

		$live = false;
		foreach ( $payload['games'] as $game ) {
			if ( 'LIVE' === $game['status'] ) {
				$live = true;
				break;
			}
		}

		$response = rest_ensure_response( $payload );
		$response->header( 'Cache-Control', $live ? 'public, max-age=30' : 'public, max-age=300' );
		return $response;
	}
}

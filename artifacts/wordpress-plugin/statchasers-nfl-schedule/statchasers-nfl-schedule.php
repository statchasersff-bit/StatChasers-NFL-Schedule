<?php
/**
 * Plugin Name:       StatChasers NFL Schedule
 * Plugin URI:        https://statchasers.com/nfl/nfl-schedule/
 * Description:       Renders the NFL schedule as crawlable server-side HTML with SportsEvent structured data, and progressively enhances it with the StatChasers schedule app.
 * Version:           1.0.0+20260823170343
 * Requires at least: 6.0
 * Requires PHP:      7.4
 * Author:            StatChasers
 * License:           GPL-2.0-or-later
 * License URI:       https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain:       sc-nfl
 *
 * @package StatChasers\NFLSchedule
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'SC_NFL_VERSION', '1.0.0+20260823170343' );
define( 'SC_NFL_PATH', plugin_dir_path( __FILE__ ) );
define( 'SC_NFL_URL', plugin_dir_url( __FILE__ ) );

/** Season the shortcode renders when no `season` attribute is given. */
if ( ! defined( 'SC_NFL_DEFAULT_SEASON' ) ) {
	define( 'SC_NFL_DEFAULT_SEASON', 2026 );
}

require_once SC_NFL_PATH . 'includes/class-sc-nfl-data.php';
require_once SC_NFL_PATH . 'includes/class-sc-nfl-render.php';
require_once SC_NFL_PATH . 'includes/class-sc-nfl-rest.php';

SC_NFL_Data::init();
SC_NFL_Render::init();
SC_NFL_Rest::init();

register_activation_hook( __FILE__, array( 'SC_NFL_Data', 'activate' ) );
register_deactivation_hook( __FILE__, array( 'SC_NFL_Data', 'deactivate' ) );

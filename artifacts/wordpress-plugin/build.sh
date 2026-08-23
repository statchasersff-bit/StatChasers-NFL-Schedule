#!/usr/bin/env bash
# Build the schedule app for WordPress and copy the bundle into the plugin.
#
# Usage:  ./artifacts/wordpress-plugin/build.sh [--zip]
#
# Produces artifacts/wordpress-plugin/statchasers-nfl-schedule/assets/sc-nfl-schedule.{js,css},
# and with --zip an installable statchasers-nfl-schedule.zip beside it.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
app="$repo/artifacts/nfl-schedule"
plugin="$here/statchasers-nfl-schedule"

echo "==> Building the WordPress bundle"
( cd "$app" && npm run build:wordpress )

echo "==> Copying bundle into the plugin"
cp "$app/dist/wordpress/sc-nfl-schedule.js" "$plugin/assets/sc-nfl-schedule.js"
cp "$app/dist/wordpress/sc-nfl-schedule.css" "$plugin/assets/sc-nfl-schedule.css"
# Document-scoped at-rules (@font-face, @property) a shadow root ignores. Without this the app
# loses its fonts and every border utility, so treat a missing file as a build failure.
cp "$app/dist/wordpress/sc-nfl-schedule.document.css" "$plugin/assets/sc-nfl-schedule.document.css"

# Keep the enqueued version in step with the bundle so browsers do not serve a stale script.
stamp="$(date -u +%Y%m%d%H%M%S)"
sed -i "s/^ \* Version:           .*/ * Version:           1.0.0+$stamp/" "$plugin/statchasers-nfl-schedule.php"
sed -i "s/define( 'SC_NFL_VERSION', '[^']*' );/define( 'SC_NFL_VERSION', '1.0.0+$stamp' );/" "$plugin/statchasers-nfl-schedule.php"

for required in sc-nfl-schedule.js sc-nfl-schedule.css sc-nfl-schedule.document.css sc-nfl-embed.css; do
	if [[ ! -s "$plugin/assets/$required" ]]; then
		echo "ERROR: $plugin/assets/$required is missing or empty" >&2
		exit 1
	fi
done

echo "==> Bundle in place"
ls -la "$plugin/assets/"

if [[ "${1:-}" == "--zip" ]]; then
	echo "==> Packaging"
	rm -f "$here/statchasers-nfl-schedule.zip"
	( cd "$here" && zip -rq statchasers-nfl-schedule.zip statchasers-nfl-schedule -x '*.DS_Store' )
	echo "==> $here/statchasers-nfl-schedule.zip"
fi

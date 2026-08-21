---
name: NFL schedule feed
description: Durable choices for the StatChasers schedule data source and normalization boundary.
---

The schedule UI should consume one normalized season payload sourced from nflverse on the server. Keep a finite cache because the full regular-season feed is stable for hours, and preserve null dates/times for flexible scheduling rather than inventing values.

**Why:** nflverse uses a compact machine-readable feed but can expose legacy team abbreviations and partial future-season information; normalizing once at the API boundary prevents every view from having its own special cases.

**How to apply:** When adding live scores, weather, or fantasy metadata, extend the normalized game shape and keep weekly, team, matrix, bye, and insight views derived from that same payload.
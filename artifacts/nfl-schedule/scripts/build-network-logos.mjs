/**
 * Rebuilds the broadcaster marks shown in the TV column of the weekly board.
 *
 *   node scripts/build-network-logos.mjs
 *
 * Logos are pulled from Wikimedia (Commons, plus en.wikipedia for the NFL shield, which Commons
 * does not carry) and rewritten into two-tone SVG that the schedule can theme:
 *
 *   currentColor            the ink, so a mark follows the surrounding text colour and stays
 *                           legible on the white card and on the dark card alike;
 *   var(--sc-net-knockout)  the holes a logo punches through its own ink -- the "abc" inside its
 *                           circle, the shield's lettering and stars -- bound to whatever the row
 *                           is sitting on.
 *
 * Full-colour marks were tried first and rejected: at the ~14px the row allows, CBS/FOX/ABC are
 * black wordmarks that vanish on the dark card, and the shield turns to mush. Two-tone reads at
 * that size in both themes, which is the whole job here.
 *
 * Writes, and nothing else:
 *   src/lib/network-logos.ts                                     (the React weekly board)
 *   ../wordpress-plugin/.../includes/network-marks.php           (the static pre-boot table)
 *
 * Both are generated -- edit this file and re-run rather than patching the output.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const PLUGIN = path.resolve(ROOT, '..', 'wordpress-plugin', 'statchasers-nfl-schedule');
const UA = 'statchasers-nfl-schedule logo build (https://statchasers.com/nfl/nfl-schedule/)';

const INK = 'currentColor';
// `Canvas` is the fallback on purpose: the static table inherits the WordPress theme's colours
// and cannot know its own background, so a knockout there falls back to the page canvas. The
// app overrides the variable with the exact card colour.
const HOLE = 'var(--sc-net-knockout, Canvas)';

/**
 * One entry per mark. `roles` maps a fill in the source file to the role it plays here; a fill of
 * `null` means the element carries no fill of its own.
 *
 * `height` is the mark's optical size, in em of the row. Matching marks on height alone makes the
 * portrait ones look shrunken next to a wordmark four times as wide -- a shield set to the same
 * height as "NETFLIX" is a sixth of its area -- so the compact marks are given more of it.
 */
const SOURCES = {
  abc: {
    label: 'ABC',
    host: 'commons.wikimedia.org',
    file: 'File:ABC-2021-LOGO.svg',
    // The source declares 1000x1000 with no viewBox; the circle it draws is r=488.9 about (488.9),
    // scaled by 1.0227, which fills exactly that square.
    viewBox: '0 0 1000 1000',
    height: 1.4,
    roles: { '#07111e': INK, '#f0f0f0': HOLE },
  },
  cbs: { label: 'CBS', host: 'commons.wikimedia.org', file: 'File:CBS 2018.svg', roles: {} },
  espn: {
    label: 'ESPN',
    host: 'commons.wikimedia.org',
    file: 'File:ESPN wordmark.svg',
    roles: { '#e52534': INK },
  },
  fox: {
    label: 'FOX',
    host: 'commons.wikimedia.org',
    file: 'File:Fox Broadcasting Company logo (2019).svg',
    roles: { '#111212': INK },
  },
  nbc: {
    label: 'NBC',
    host: 'commons.wikimedia.org',
    file: 'File:NBC logo 2022.svg',
    roles: {
      '#6e55dc': INK, '#ef1541': INK, '#ff7112': INK,
      '#fccc12': INK, '#069de0': INK, '#05ac3f': INK,
    },
  },
  netflix: {
    label: 'Netflix',
    host: 'commons.wikimedia.org',
    file: 'File:Netflix 2015 logo.svg',
    roles: { '#d81f26': INK },
  },
  nfl: {
    label: 'NFL Network',
    host: 'en.wikipedia.org',
    file: 'File:NFL Network logo.svg',
    // The source is the stacked lockup: shield over a "NETWORK" wordmark, which at row height is
    // an unreadable smudge. Drop the wordmark -- the last group, one path per letter -- and keep
    // the shield, which still reads at 14px. `viewBox` is that shield's own bounds.
    trim: (svg) => {
      const start = svg.lastIndexOf('<g fill="#013369">');
      const end = svg.indexOf('</g>', start);
      if (start < 0 || end < 0) throw new Error('nfl: could not find the NETWORK wordmark group');
      return svg.slice(0, start) + svg.slice(end + 4);
    },
    viewBox: '154.5 0.3 73.2 100.8',
    height: 1.5,
    roles: { '#fff': HOLE, '#ffffff': HOLE, '#013369': INK, '#d50a0a': INK },
  },
  peacock: {
    label: 'Peacock',
    host: 'commons.wikimedia.org',
    file: 'File:NBCUniversal Peacock Logo (2020–2026).svg',
    roles: {
      '#069de0': INK, '#6e55dc': INK, '#05ac3f': INK,
      '#ef1541': INK, '#ff7112': INK, '#fccc12': INK,
    },
  },
  prime: {
    label: 'Prime Video',
    host: 'commons.wikimedia.org',
    file: 'File:Prime Video logo (2024).svg',
    roles: { '#0779ff': INK },
  },
};

/**
 * What the feed calls a broadcaster -> which mark to draw. ESPN hands us one of a small set of
 * names ("FOX", "CBS", "NBC", "Prime Video", "ESPN / ABC", "NFL Net", "Netflix"), but the spelling
 * drifts between the regular season, the playoffs and the international games, so the aliases
 * cover the variants and the simulcast partners too. Anything unlisted falls back to its own name
 * as text, which is a fine outcome -- never a blank cell.
 *
 * Paramount+ is deliberately absent: its lockup is a script wordmark under a mountain, illegible
 * at this size, and the feed reports those games as "CBS" anyway.
 */
const ALIASES = {
  'ABC': 'abc',
  'CBS': 'cbs',
  'CBS SPORTS': 'cbs',
  'ESPN': 'espn',
  'ESPN2': 'espn',
  'ESPN+': 'espn',
  'ESPN DEPORTES': 'espn',
  'ESPNEWS': 'espn',
  'FOX': 'fox',
  'FOX SPORTS': 'fox',
  'NBC': 'nbc',
  'NETFLIX': 'netflix',
  'NFL NET': 'nfl',
  'NFL NETWORK': 'nfl',
  'NFLN': 'nfl',
  'PEACOCK': 'peacock',
  'PRIME': 'prime',
  'PRIME VIDEO': 'prime',
  'AMAZON PRIME VIDEO': 'prime',
};

async function wikimedia(host, file) {
  const query = new URLSearchParams({
    action: 'query', format: 'json', prop: 'imageinfo', iiprop: 'url|mime', titles: file,
  });
  const meta = await fetch(`https://${host}/w/api.php?${query}`, { headers: { 'User-Agent': UA } });
  if (!meta.ok) throw new Error(`${file}: imageinfo ${meta.status}`);
  const pages = Object.values((await meta.json()).query.pages);
  const info = pages[0]?.imageinfo?.[0];
  if (!info) throw new Error(`${file}: not found on ${host}`);
  if (info.mime !== 'image/svg+xml') throw new Error(`${file}: ${info.mime}, expected SVG`);

  const asset = await fetch(info.url, { headers: { 'User-Agent': UA } });
  if (!asset.ok) throw new Error(`${file}: download ${asset.status}`);
  return { svg: await asset.text(), url: info.url.split('?')[0] };
}

/** Inkscape writes fills into `style=""`; hoist the fill out so one code path handles both forms. */
function hoistStyleFill(attrs) {
  return attrs.replace(/\sstyle="([^"]*)"/g, (_, style) => {
    const fill = /(?:^|;)\s*fill\s*:\s*([^;]+)/.exec(style);
    return fill ? ` fill="${fill[1].trim()}"` : '';
  });
}

function normalize(slug, source, raw) {
  const svg = /<svg\b([^>]*)>([\s\S]*)<\/svg>/.exec(raw);
  if (!svg) throw new Error(`${slug}: no <svg> element`);
  const [, attrs] = svg;
  let body = svg[2];

  let viewBox = source.viewBox;
  if (!viewBox) {
    const declared = /\bviewBox="([^"]+)"/.exec(attrs);
    const width = /\bwidth="([\d.]+)/.exec(attrs);
    const height = /\bheight="([\d.]+)/.exec(attrs);
    if (declared) viewBox = declared[1];
    else if (width && height) viewBox = `0 0 ${width[1]} ${height[1]}`;
    else throw new Error(`${slug}: no viewBox and no usable width/height`);
  }

  // Editor leftovers. None of them paint anything, and they drag in namespaces we would have to
  // declare on the inlined element.
  for (const pattern of [
    /<\?xml[^>]*\?>/g, /<!--[\s\S]*?-->/g, /<metadata\b[\s\S]*?<\/metadata>/g,
    /<defs\b[\s\S]*?<\/defs>/g, /<defs\b[^>]*\/>/g,
    /<sodipodi:namedview\b[\s\S]*?\/>/g, /<sodipodi:namedview\b[\s\S]*?<\/sodipodi:namedview>/g,
  ]) body = body.replace(pattern, '');

  const unmapped = new Set();
  body = body.replace(/<(path|g|circle|rect|polygon|ellipse)\b([^>]*?)(\/?)>/g, (_, name, rest, close) => {
    let attributes = hoistStyleFill(rest);
    const fill = /\sfill="([^"]*)"/.exec(attributes);
    const key = fill ? fill[1].trim().toLowerCase() : null;
    attributes = attributes
      .replace(/\sfill="[^"]*"/g, '')
      .replace(/\s(?:id|xml:space|enable-background|inkscape:[\w-]+|sodipodi:[\w-]+)="[^"]*"/g, '');
    if (key === 'none') return `<${name}${attributes}${close}>`;
    // A bare <g> inherits the ink from the root, so only a real colour can be unmapped.
    let role = key === null ? INK : source.roles[key];
    if (!role) {
      unmapped.add(key);
      role = INK;
    }
    return `<${name} fill="${role}"${attributes}${close}>`;
  });
  if (unmapped.size) {
    throw new Error(`${slug}: unmapped fills ${[...unmapped].join(', ')} -- add them to roles`);
  }

  body = body.replace(/\s+/g, ' ').replace(/> </g, '><').trim();
  if (!body.includes('<path')) throw new Error(`${slug}: nothing left to draw`);
  if (!body.includes(INK)) throw new Error(`${slug}: no ink -- the mark would be invisible`);
  return { viewBox, body };
}

const BANNER = 'Generated by scripts/build-network-logos.mjs -- do not edit.';

function emitTs(marks) {
  const entries = Object.entries(marks).map(([slug, mark]) =>
    `  ${slug}: {\n` +
    `    label: ${JSON.stringify(mark.label)},\n` +
    `    source: ${JSON.stringify(mark.url)},\n` +
    `    viewBox: ${JSON.stringify(mark.viewBox)},\n` +
    `    height: ${mark.height},\n` +
    `    body: ${JSON.stringify(mark.body)},\n` +
    `  },`).join('\n');
  const aliases = Object.entries(ALIASES)
    .map(([name, slug]) => `  ${JSON.stringify(name)}: '${slug}',`).join('\n');

  return `// ${BANNER}
// Two-tone broadcaster marks for the weekly board's TV column. \`body\` is inlined into an <svg>
// so the ink follows \`currentColor\`; the knockouts read \`--sc-net-knockout\`, which app.css binds
// to whatever the row is sitting on.

export type NetworkMark = {
  /** Broadcaster name, for the accessible label and the tooltip. */
  label: string;
  /** Where the artwork came from, so the next person can check it against the current logo. */
  source: string;
  viewBox: string;
  /** Optical size in em of the row -- see the note on SOURCES in the generator. */
  height: number;
  /** Inner SVG markup. Generated from trusted sources at build time, never from feed data. */
  body: string;
};

export const NETWORK_MARKS: Record<string, NetworkMark> = {
${entries}
};

const NETWORK_ALIASES: Record<string, keyof typeof NETWORK_MARKS> = {
${aliases}
};

/**
 * The marks for one game's broadcast, in the order the feed lists them.
 *
 * ESPN reports a simulcast as one string ("ESPN / ABC"), so split it and resolve each side. An
 * empty result means "draw the name as text" -- an unrecognised broadcaster still has to show.
 */
export function networkMarks(network: string | null | undefined): NetworkMark[] {
  if (!network) return [];
  const seen = new Set<string>();
  const marks: NetworkMark[] = [];
  for (const part of network.split('/')) {
    const slug = NETWORK_ALIASES[part.trim().toUpperCase()];
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    marks.push(NETWORK_MARKS[slug]);
  }
  return marks;
}
`;
}

function emitPhp(marks) {
  const php = (value) => `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  const entries = Object.entries(marks).map(([slug, mark]) =>
    `\t\t${php(slug)} => array(\n` +
    `\t\t\t'label'   => ${php(mark.label)},\n` +
    `\t\t\t'source'  => ${php(mark.url)},\n` +
    `\t\t\t'viewBox' => ${php(mark.viewBox)},\n` +
    `\t\t\t'height'  => ${mark.height},\n` +
    `\t\t\t'body'    => ${php(mark.body)},\n` +
    `\t\t),`).join('\n');
  const aliases = Object.entries(ALIASES)
    .map(([name, slug]) => `\t\t${php(name)} => ${php(slug)},`).join('\n');

  return `<?php
/**
 * ${BANNER}
 *
 * Two-tone broadcaster marks for the static table's TV column, matching the app's weekly board.
 * 'body' is trusted markup built here from Wikimedia artwork -- it never contains feed data --
 * and is echoed unescaped by SC_NFL_Render.
 *
 * @package StatChasers\\NFLSchedule
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

return array(
	'marks'   => array(
${entries}
	),
	'aliases' => array(
${aliases}
	),
);
`;
}

const marks = {};
for (const [slug, source] of Object.entries(SOURCES)) {
  const { svg, url } = await wikimedia(source.host, source.file);
  const trimmed = source.trim ? source.trim(svg) : svg;
  const { viewBox, body } = normalize(slug, source, trimmed);
  marks[slug] = { label: source.label, url, viewBox, body, height: source.height ?? 1 };
  console.log(`${slug.padEnd(8)} ${String(body.length).padStart(5)} bytes  ${url}`);
}

for (const slug of new Set(Object.values(ALIASES))) {
  if (!marks[slug]) throw new Error(`alias points at unknown mark "${slug}"`);
}

await mkdir(path.join(ROOT, 'src', 'lib'), { recursive: true });
await writeFile(path.join(ROOT, 'src', 'lib', 'network-logos.ts'), emitTs(marks));
await writeFile(path.join(PLUGIN, 'includes', 'network-marks.php'), emitPhp(marks));
console.log('\nwrote src/lib/network-logos.ts and the plugin network-marks.php');

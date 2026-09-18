/**
 * Rebuilds the broadcaster marks shown in the TV column of the weekly board.
 *
 *   node scripts/build-network-logos.mjs      (or: npm run build:logos)
 *
 * Six of the nine come from artwork saved in attached_assets/ -- the sports-division logos, which
 * are the right ones for a schedule: "CBS Sports" and "FOX Sports" rather than the network
 * wordmarks. They are matched by name prefix, not by exact filename, so re-saving one under a new
 * timestamp does not break the build.
 *
 * The other three -- NFL Network, Prime Video, Peacock -- are not in that folder and are pulled
 * from Wikimedia instead, in their own colours, so the whole set reads as one row.
 *
 * Every mark ends up as a self-contained data URI on an <img>: no extra requests, nothing for the
 * WordPress asset path or the shadow root to resolve, and one code path in both consumers.
 * Raster art is trimmed to its own bounds and re-encoded at 96px tall, which is 4x the largest
 * size the row ever draws.
 *
 * Writes, and nothing else:
 *   src/lib/network-logos.ts                                     (the React weekly board)
 *   ../wordpress-plugin/.../includes/network-marks.php           (the static pre-boot table)
 *
 * Both are generated -- edit this file and re-run rather than patching the output.
 */
import { execFile } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, '..');
const ASSETS = path.resolve(ROOT, '..', '..', 'attached_assets');
const PLUGIN = path.resolve(ROOT, '..', 'wordpress-plugin', 'statchasers-nfl-schedule');
const UA = 'statchasers-nfl-schedule logo build (https://statchasers.com/nfl/nfl-schedule/)';

/** Every raster mark is encoded at this height, then scaled down by CSS. */
const RASTER_HEIGHT = 96;

/**
 * One entry per mark.
 *
 * Marks are not given sizes: every one is scaled to fit a single box, a little under the size of a
 * team crest, and `object-fit` sorts out the rest. A shield and a wordmark four times as wide then
 * settle at the right relative weight on their own, which hand-tuned heights never quite did.
 *
 * `scale` is the exception, for a mark that fills its box more heavily than the geometry suggests.
 * FOX Sports is a two-line lockup of solid black type, so at the shared box it reads as the
 * loudest thing in the column even though it measures the same as the rest.
 *
 * `prefix` matches a file in attached_assets/. `wikimedia` fetches one instead, for the
 * broadcasters that folder does not cover.
 */
const SOURCES = {
  abc: { label: 'ABC', prefix: 'ABC_logo' },
  cbs: { label: 'CBS Sports', prefix: 'CBS_Sports' },
  espn: { label: 'ESPN', prefix: 'ESPN_logo' },
  fox: { label: 'FOX Sports', prefix: 'Fox_Sports_Logo', scale: 0.8 },
  nbc: { label: 'NBC', prefix: 'NBC_logo' },
  netflix: {
    label: 'Netflix',
    prefix: 'Netflix_Logo',
    // The only one saved on a white card rather than on transparency. Flood-filling in from the
    // corners lifts the card without touching the white inside a letter, which a plain
    // -transparent would punch through -- the source is lossy enough that its "white" is a spread
    // of near-whites, so it needs the fuzz as well as the flood fill.
    flatten: true,
  },
  nfl: {
    label: 'NFL Network',
    wikimedia: { host: 'en.wikipedia.org', file: 'File:NFL Network logo.svg' },
    // The source is the stacked lockup: shield over a "NETWORK" wordmark, which at row height is
    // an unreadable smudge. Drop the wordmark -- the last group, one path per letter -- and keep
    // the shield, which still reads at 24px. `viewBox` is that shield's own bounds.
    trim: (svg) => {
      const start = svg.lastIndexOf('<g fill="#013369">');
      const end = svg.indexOf('</g>', start);
      if (start < 0 || end < 0) throw new Error('nfl: could not find the NETWORK wordmark group');
      return svg.slice(0, start) + svg.slice(end + 4);
    },
    viewBox: '154.5 0.3 73.2 100.8',
  },
  prime: {
    label: 'Prime Video',
    wikimedia: { host: 'commons.wikimedia.org', file: 'File:Prime Video logo (2024).svg' },
  },
  peacock: {
    label: 'Peacock',
    wikimedia: { host: 'commons.wikimedia.org', file: 'File:NBCUniversal Peacock Logo (2020–2026).svg' },
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

/** The saved file for a mark, matched on prefix so a re-save under a new timestamp still resolves. */
async function findAsset(slug, prefix) {
  const matches = (await readdir(ASSETS))
    .filter((name) => name.startsWith(prefix) && /\.(png|webp|jpe?g)$/i.test(name))
    .sort();
  if (!matches.length) throw new Error(`${slug}: no attached_assets file starting "${prefix}"`);
  // Newest wins when the same logo has been saved more than once; the names carry a timestamp.
  return path.join(ASSETS, matches[matches.length - 1]);
}

async function magick(args) {
  const { stdout } = await run('magick', args, { maxBuffer: 64 * 1024 * 1024, encoding: 'buffer' });
  return stdout;
}

/** Trim to the artwork's own bounds and re-encode small, keeping transparency. */
async function raster(slug, source) {
  const file = await findAsset(slug, source.prefix);
  const out = path.join(ROOT, 'node_modules', '.cache', `sc-net-${slug}.webp`);
  await mkdir(path.dirname(out), { recursive: true });

  const clean = [];
  if (source.flatten) {
    const size = String(await magick([file, '-format', '%[fx:w-1] %[fx:h-1]', 'info:'])).split(' ');
    const [right, bottom] = size;
    clean.push('-alpha', 'set', '-fuzz', '12%', '-fill', 'none');
    for (const [x, y] of [[0, 0], [right, 0], [0, bottom], [right, bottom]]) {
      clean.push('-draw', `alpha ${x},${y} floodfill`);
    }
  }

  await magick([
    file, ...clean,
    '-trim', '+repage',
    '-resize', `x${RASTER_HEIGHT}`,
    '-background', 'none', '-strip', '-quality', '88',
    out,
  ]);

  const [width, height] = String(await magick([out, '-format', '%w %h', 'info:'])).split(' ').map(Number);
  const bytes = await readFile(out);
  if (!width || !height) throw new Error(`${slug}: re-encode produced no image`);
  return { src: `data:image/webp;base64,${bytes.toString('base64')}`, width, height, bytes: bytes.length };
}

async function wikimedia(slug, { host, file }) {
  const query = new URLSearchParams({
    action: 'query', format: 'json', prop: 'imageinfo', iiprop: 'url|mime', titles: file,
  });
  const meta = await fetch(`https://${host}/w/api.php?${query}`, { headers: { 'User-Agent': UA } });
  if (!meta.ok) throw new Error(`${slug}: imageinfo ${meta.status}`);
  const info = Object.values((await meta.json()).query.pages)[0]?.imageinfo?.[0];
  if (!info) throw new Error(`${slug}: ${file} not found on ${host}`);
  if (info.mime !== 'image/svg+xml') throw new Error(`${slug}: ${info.mime}, expected SVG`);

  const asset = await fetch(info.url, { headers: { 'User-Agent': UA } });
  if (!asset.ok) throw new Error(`${slug}: download ${asset.status}`);
  return { svg: await asset.text(), url: info.url.split('?')[0] };
}

/**
 * Strip a downloaded SVG to something safe to inline, keeping its own colours.
 *
 * These ride in an <img src="data:...">, which is its own document: no external references
 * resolve, no script runs, and nothing inherits from the page. So the only job here is dropping
 * editor leftovers and pinning a viewBox, since several sources declare a size and no box.
 */
function cleanSvg(slug, source, raw) {
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

  for (const pattern of [
    /<\?xml[^>]*\?>/g, /<!--[\s\S]*?-->/g, /<metadata\b[\s\S]*?<\/metadata>/g,
    /<defs\b[\s\S]*?<\/defs>/g, /<defs\b[^>]*\/>/g,
    /<sodipodi:namedview\b[\s\S]*?\/>/g, /<sodipodi:namedview\b[\s\S]*?<\/sodipodi:namedview>/g,
    /<script\b[\s\S]*?<\/script>/g, /<image\b[^>]*>/g,
  ]) body = body.replace(pattern, '');

  // Inkscape writes the paint into style=""; hoist the fill so both forms survive minification.
  body = body.replace(/\sstyle="([^"]*)"/g, (_, style) => {
    const fill = /(?:^|;)\s*fill\s*:\s*([^;]+)/.exec(style);
    return fill ? ` fill="${fill[1].trim()}"` : '';
  });
  body = body.replace(/\s(?:id|xml:space|enable-background|inkscape:[\w-]+|sodipodi:[\w-]+)="[^"]*"/g, '');
  body = body.replace(/\s+/g, ' ').replace(/> </g, '><').trim();
  if (!body.includes('<path')) throw new Error(`${slug}: nothing left to draw`);

  const [, , width, height] = viewBox.split(/[\s,]+/).map(Number);
  const markup = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">${body}</svg>`;
  return {
    src: `data:image/svg+xml;base64,${Buffer.from(markup, 'utf8').toString('base64')}`,
    width: Math.round(width),
    height: Math.round(height),
    bytes: markup.length,
  };
}

const BANNER = 'Generated by scripts/build-network-logos.mjs -- do not edit.';

/**
 * Header for both generated files. Kept free of apostrophes so the PHP output stays trivially
 * checkable for balanced quotes without a PHP parser to hand.
 */
const DESCRIPTION = [
  'Broadcaster marks for the TV column, as self-contained data URIs. `width` and `height` are the',
  'pixel size of the artwork itself; CSS scales each one down into a shared box, a little smaller',
  'than a team crest, so the set reads at one weight. `scale` trims that box for the rare mark',
  'whose ink is heavier than its measurements suggest.',
];

function emitTs(marks) {
  const entries = Object.entries(marks).map(([slug, mark]) =>
    `  ${slug}: {\n` +
    `    label: ${JSON.stringify(mark.label)},\n` +
    `    source: ${JSON.stringify(mark.source)},\n` +
    `    width: ${mark.width},\n` +
    `    height: ${mark.height},\n` +
    `    scale: ${mark.scale},\n` +
    `    src: ${JSON.stringify(mark.src)},\n` +
    `  },`).join('\n');
  const aliases = Object.entries(ALIASES)
    .map(([name, slug]) => `  ${JSON.stringify(name)}: '${slug}',`).join('\n');

  return `// ${BANNER}
${DESCRIPTION.map((line) => `// ${line}`).join('\n')}

export type NetworkMark = {
  /** Broadcaster name, for the image's alt text and the cell's tooltip. */
  label: string;
  /** Where the artwork came from, so the next person can check it against the current logo. */
  source: string;
  /** The artwork's own pixel size, so the row reserves the right box before it paints. */
  width: number;
  height: number;
  /** Fraction of the shared box this mark may fill. 1 unless it needs holding back. */
  scale: number;
  src: string;
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
    `\t\t\t'label'  => ${php(mark.label)},\n` +
    `\t\t\t'source' => ${php(mark.source)},\n` +
    `\t\t\t'width'  => ${mark.width},\n` +
    `\t\t\t'height' => ${mark.height},\n` +
    `\t\t\t'scale'  => ${mark.scale},\n` +
    `\t\t\t'src'    => ${php(mark.src)},\n` +
    `\t\t),`).join('\n');
  const aliases = Object.entries(ALIASES)
    .map(([name, slug]) => `\t\t${php(name)} => ${php(slug)},`).join('\n');

  return `<?php
/**
 * ${BANNER}
 *
${DESCRIPTION.map((line) => ` * ${line}`).join('\n')}
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
  let art;
  let origin;
  if (source.wikimedia) {
    const { svg, url } = await wikimedia(slug, source.wikimedia);
    art = cleanSvg(slug, source, source.trim ? source.trim(svg) : svg);
    origin = url;
  } else {
    art = await raster(slug, source);
    origin = path.relative(path.resolve(ROOT, '..', '..'), await findAsset(slug, source.prefix));
  }
  marks[slug] = { label: source.label, source: origin, scale: source.scale ?? 1, ...art };
  console.log(`${slug.padEnd(8)} ${String(art.width).padStart(4)}x${art.height}  ${String(art.bytes).padStart(6)} bytes  ${origin}`);
}

for (const slug of new Set(Object.values(ALIASES))) {
  if (!marks[slug]) throw new Error(`alias points at unknown mark "${slug}"`);
}

await mkdir(path.join(ROOT, 'src', 'lib'), { recursive: true });
await writeFile(path.join(ROOT, 'src', 'lib', 'network-logos.ts'), emitTs(marks));
await writeFile(path.join(PLUGIN, 'includes', 'network-marks.php'), emitPhp(marks));
const total = Object.values(marks).reduce((sum, mark) => sum + mark.src.length, 0);
console.log(`\n${Object.keys(marks).length} marks, ${(total / 1024).toFixed(1)} KB of data URIs`);

#!/usr/bin/env node
/**
 * Render the site's image assets from their sources:
 *
 *   site/favicon.svg      -> site/favicon-16.png, favicon-32.png, favicon-48.png,
 *                            apple-touch-icon.png (180), icon-512.png,
 *                            icon-512-maskable.png, favicon.ico (16+32+48)
 *   bin/assets/og.html    -> site/og.png (1200 x 630)
 *
 * This is the only script in the repo that needs something the repo does not
 * ship: a browser. It uses Playwright, resolved from a directory you name,
 * because windlass itself has zero dependencies and is not going to grow one
 * for a favicon:
 *
 *   PLAYWRIGHT_DIR=/path/to/some/node_modules node bin/build-assets.mjs
 *   node bin/build-assets.mjs --playwright /path/to/some/node_modules
 *
 * The outputs are committed. Nothing on the page reads a number off them, so
 * they carry no claim; the OG image states the finding and nothing else.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = join(ROOT, 'site');

function playwrightDir() {
  const i = process.argv.indexOf('--playwright');
  const fromArg = i >= 0 ? process.argv[i + 1] : null;
  const dir = fromArg || process.env.PLAYWRIGHT_DIR;
  if (!dir) {
    console.error('build-assets: name a node_modules directory that contains playwright: --playwright <dir> or PLAYWRIGHT_DIR=<dir>');
    process.exit(2);
  }
  if (!existsSync(join(dir, 'playwright'))) {
    console.error(`build-assets: no playwright package under ${dir}`);
    process.exit(2);
  }
  return dir;
}

/** ICO container around PNG entries (allowed since Windows Vista). */
function icoFromPngs(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  const dir = [];
  let offset = 6 + 16 * entries.length;
  for (const { size, png } of entries) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0);
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt8(0, 2);
    e.writeUInt8(0, 3);
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += png.length;
    dir.push(e);
  }
  return Buffer.concat([header, ...dir, ...entries.map((x) => x.png)]);
}

async function main() {
  const require = createRequire(import.meta.url);
  const { chromium } = require(join(playwrightDir(), 'playwright'));
  const browser = await chromium.launch({ headless: true });
  try {
    const svg = readFileSync(join(SITE, 'favicon.svg'), 'utf8');
    // Maskable icons are cropped by the platform: no rounded corners, and the
    // mark sits inside the safe zone. Same source, corners squared.
    const maskableSvg = svg.replace('rx="4"', 'rx="0"');
    const dataUrl = (s) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(s)}`;

    const renderSquare = async (source, size) => {
      const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
      await page.setContent(`<!doctype html><html><head><style>html,body{margin:0;background:transparent}img{display:block;width:${size}px;height:${size}px}</style></head><body><img src="${dataUrl(source)}" alt=""></body></html>`);
      const png = await page.screenshot({ type: 'png', omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
      await page.close();
      return png;
    };

    const outputs = [
      ['favicon-16.png', 16, svg], ['favicon-32.png', 32, svg], ['favicon-48.png', 48, svg],
      ['apple-touch-icon.png', 180, svg], ['icon-512.png', 512, svg], ['icon-512-maskable.png', 512, maskableSvg],
    ];
    const pngs = {};
    for (const [name, size, source] of outputs) {
      pngs[name] = await renderSquare(source, size);
      writeFileSync(join(SITE, name), pngs[name]);
    }
    writeFileSync(join(SITE, 'favicon.ico'), icoFromPngs([
      { size: 16, png: pngs['favicon-16.png'] }, { size: 32, png: pngs['favicon-32.png'] }, { size: 48, png: pngs['favicon-48.png'] },
    ]));

    const og = readFileSync(join(ROOT, 'bin', 'assets', 'og.html'), 'utf8');
    const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
    await page.setContent(og);
    writeFileSync(join(SITE, 'og.png'), await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: 1200, height: 630 } }));
    await page.close();
  } finally {
    await browser.close();
  }
  process.stdout.write('build-assets: favicon family (16/32/48/180/512/maskable, .ico) and og.png written to site/\n');
}

main().catch((e) => { console.error(e); process.exit(1); });

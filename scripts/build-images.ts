// Draws the link-preview image from the site's own colour tokens and fonts. The SVG renderer used
// here (librsvg inside sharp) cannot load web fonts, so every letter is shaped with HarfBuzz, the
// shaping engine Chrome and Firefox use, and written out as path data.
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as hb from 'harfbuzzjs';
import sharp from 'sharp';
import { unpackWoff } from './woff.ts';

const require = createRequire(import.meta.url);

const colourNames = ['bg', 'ink', 'mark'] as const;
type Colours = Record<(typeof colourNames)[number], string>;

// The dark theme's value of each colour, from its light-dark() pair. Each token is also registered
// with the same dark value as its @property initial-value; the two must agree.
function readTokens(css: string): { colours: Colours; trackingHeading: number } {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const hex = '(#[0-9a-fA-F]{6})';
  const colours = {} as Colours;
  for (const name of colourNames) {
    const dark = new RegExp(`(?<![\\w-])--${name}:\\s*light-dark\\(\\s*${hex}\\s*,\\s*${hex}\\s*\\)\\s*;`).exec(source)?.[2];
    const initial = new RegExp(`@property\\s+--${name}\\s*\\{[^}]*initial-value:\\s*${hex}\\s*;`).exec(source)?.[1];
    if (!dark || !initial) throw new Error(`tokens.css: no dark hex value for --${name}`);
    if (dark.toLowerCase() !== initial.toLowerCase()) throw new Error(`tokens.css: --${name} is ${dark} in light-dark() but ${initial} in @property`);
    colours[name] = dark;
  }
  const tracking = /(?<![\w-])--tracking-heading:\s*(-?[\d.]+)em\s*;/.exec(source)?.[1];
  if (!tracking) throw new Error('tokens.css: no --tracking-heading in em');
  return { colours, trackingHeading: Number(tracking) };
}

function loadFont(file: string): hb.Font {
  const sfnt = unpackWoff(new Uint8Array(readFileSync(require.resolve(file))));
  return new hb.Font(new hb.Face(new hb.Blob(sfnt)));
}

interface Run {
  font: hb.Font;
  // Each glyph's origin, in font units from the start of the line.
  glyphs: { id: number; x: number; y: number }[];
}

// Shapes one line as the browser would for English text. Blink turns off the ligature features
// whenever letter-spacing is not zero, so a tracked line is shaped without them too.
function shapeLine(font: hb.Font, text: string, trackingEm = 0): Run {
  const buffer = new hb.Buffer();
  buffer.addText(text);
  buffer.setDirection(hb.Direction.LTR);
  buffer.setScript('Latn');
  buffer.setLanguage('en');
  const features = trackingEm === 0 ? [] : ['-liga', '-clig', '-calt'].map((setting) => hb.Feature.fromString(setting)!);
  hb.shape(font, buffer, features);
  const positions = buffer.getGlyphPositions();
  const tracking = trackingEm * font.face.upem;
  let pen = 0;
  const glyphs = buffer.getGlyphInfos().map(({ codepoint: id }, index) => {
    if (id === 0) throw new Error(`the font has no glyph for a character in "${text}"`);
    const { xAdvance, xOffset, yOffset } = positions[index]!;
    const glyph = { id, x: pen + xOffset, y: yOffset };
    pen += xAdvance + tracking;
    return glyph;
  });
  return { font, glyphs };
}

// The line's inked box in font units, y up: where the letters actually reach, not their advances.
function ink(run: Run): { left: number; right: number; top: number; bottom: number } {
  const boxes = run.glyphs.flatMap(({ id, x, y }) => {
    const extents = run.font.glyphExtents(id);
    if (!extents || extents.width === 0) return [];
    return [{ left: x + extents.xBearing, right: x + extents.xBearing + extents.width, top: y + extents.yBearing, bottom: y + extents.yBearing + extents.height }];
  });
  return {
    left: Math.min(...boxes.map((box) => box.left)),
    right: Math.max(...boxes.map((box) => box.right)),
    top: Math.max(...boxes.map((box) => box.top)),
    bottom: Math.min(...boxes.map((box) => box.bottom)),
  };
}

const number = (value: number): string => String(Number(value.toFixed(2)));

// The line as one SVG path, set at a size in pixels with its origin at (x, baseline).
function linePath(run: Run, size: number, x: number, baseline: number): string {
  const scale = size / run.font.face.upem;
  return run.glyphs
    .map((glyph) =>
      run.font
        .glyphToJson(glyph.id)
        .map(({ type, values }) => {
          const points: string[] = [];
          for (let index = 0; index < values.length; index += 2) {
            points.push(`${number(x + (glyph.x + values[index]!) * scale)} ${number(baseline - (glyph.y + values[index + 1]!) * scale)}`);
          }
          return `${type}${points.join(' ')}`;
        })
        .join(''),
    )
    .join('');
}

function svg(viewBox: string, content: string, width?: number, height?: number): string {
  const size = width === undefined ? '' : ` width="${width}" height="${height}"`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}"${size}>${content}</svg>\n`;
}

interface Fonts {
  bold: hb.Font;
  regular: hb.Font;
}

// The link-preview card: the name with its section square and the role line, set like the home
// page's hero at 1600px scaled up and centred on the card. The address is left off, since every
// app prints the domain or the site name beside the image. Text stays well inside a centred 1080
// by 540 area, so a preview cropped towards the middle keeps it, and clear of the bottom-left
// corner, where X lays its own label over the image.
const preview = { width: 1200, height: 630 };

function previewSvg({ colours, trackingHeading }: ReturnType<typeof readTokens>, fonts: Fonts): string {
  const left = 60;
  const nameSize = 168;
  // The hero at 1600px sets the name at 88px and the role line at 32px, 62px from baseline to baseline.
  const roleSize = (nameSize * 32) / 88;
  const roleGap = (nameSize * 62) / 88;

  const name = shapeLine(fonts.bold, 'Alex Kachur', trackingHeading);
  const role = shapeLine(fonts.regular, 'Full-stack & AI developer');
  const capHeight = (ink(shapeLine(fonts.bold, 'H')).top / fonts.bold.face.upem) * nameSize;

  // The name's capitals to the role's baseline, centred on the card.
  const nameBaseline = (preview.height - (capHeight + roleGap)) / 2 + capHeight;
  const roleBaseline = nameBaseline + roleGap;

  // The section title's square: 0.4em wide, 0.35em before the text, 0.15em above the baseline.
  const square = { x: left, size: Math.round(0.4 * nameSize), bottom: Math.round(nameBaseline - 0.15 * nameSize) };
  const nameX = left + 0.4 * nameSize + 0.35 * nameSize;

  // The role lines up with the square by its ink, not its advance box.
  const roleX = left - ink(role).left * (roleSize / fonts.regular.face.upem);

  return svg(
    `0 0 ${preview.width} ${preview.height}`,
    [
      `<rect width="${preview.width}" height="${preview.height}" fill="${colours.bg}"/>`,
      `<rect x="${square.x}" y="${square.bottom - square.size}" width="${square.size}" height="${square.size}" fill="${colours.mark}"/>`,
      `<path d="${linePath(name, nameSize, nameX, nameBaseline)}" fill="${colours.ink}"/>`,
      `<path d="${linePath(role, roleSize, roleX, roleBaseline)}" fill="${colours.ink}"/>`,
    ].join(''),
    preview.width,
    preview.height,
  );
}

// Every raster is drawn straight at its own size and saved without an alpha channel.
function png(image: string): Promise<Buffer> {
  return sharp(Buffer.from(image)).removeAlpha().png({ compressionLevel: 9 }).toBuffer();
}

export async function main(root = process.cwd()): Promise<void> {
  const tokens = readTokens(readFileSync(join(root, 'src', 'styles', 'tokens.css'), 'utf8'));
  const fonts: Fonts = {
    bold: loadFont('@fontsource/barlow/files/barlow-latin-700-normal.woff'),
    regular: loadFont('@fontsource/barlow/files/barlow-latin-400-normal.woff'),
  };

  const generated = join(root, 'src', 'generated');
  mkdirSync(generated, { recursive: true });
  writeFileSync(join(generated, 'link-preview.png'), await png(previewSvg(tokens, fonts)));
}

// Node resolves the entry module through its real path, so a symlinked checkout must compare the same way.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  await main();
}

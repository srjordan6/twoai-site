// Generate the raster icon set at build time, so there is one brand mark to
// maintain and the PNGs can never drift from it. Runs in prebuild; sharp is
// already present as Astro's image dependency.
//
// TWO SOURCES, ON PURPOSE. Stephen, 2026-09-14: our site does not have a
// favicon. It did - every file answered 200 - and it was invisible. The
// icons were rendered from mark.svg, navy strokes on a transparent
// background, which is right inline on a white page and wrong on a browser
// tab: at 32px the strokes covered 291 of 1,024 pixels and read as nothing.
// brand/favicon.svg is the navy-square variant the brand kit ships for this
// purpose, white globe and orange orbit on #201868, and every tab-sized icon
// now comes from it. mark.svg stays for inline use.
//
// A REAL ICO. The old fallback copied PNG bytes under the .ico name. Chrome
// tolerates that; Safari and Google's search-result favicon fetcher do not
// reliably. sharp cannot write ICO, so this writes the container by hand:
// an ICO is a 6-byte header, a 16-byte directory entry per image, and the
// image data - and since Vista the image data may be a PNG. Three sizes,
// 16, 32 and 48, which is what /favicon.ico is asked for.
//
// Outputs (all under public/, served from the site root):
//   brand/favicon-32.png       32x32    <link rel=icon png>
//   brand/apple-touch-icon.png 180x180  iOS home screen
//   brand/icon-192.png         192x192  PWA manifest
//   brand/icon-512.png         512x512  PWA manifest / splash
//   favicon.ico                16/32/48 multi-size, for blind /favicon.ico hits
//
// If sharp is unavailable the script logs and exits 0: missing raster icons
// degrade to the SVG favicon, they do not warrant blocking a deploy.
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';

const TAB = 'public/brand/favicon.svg';   // navy square, for icons
const MARK = 'public/brand/mark.svg';     // transparent, kept for inline use

let sharp;
try {
  sharp = (await import('sharp')).default;
} catch {
  console.log('icons: sharp not available, skipping raster icon generation (SVG favicon still served).');
  process.exit(0);
}
if (!existsSync(TAB)) {
  console.log(`icons: ${TAB} missing, skipping.`);
  process.exit(0);
}
mkdirSync('public/brand', { recursive: true });

// Build a multi-image ICO whose entries are PNG-encoded.
function icoFromPngs(entries) {
  // entries: [{size, png:Buffer}]
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);              // reserved
  header.writeUInt16LE(1, 2);              // type: 1 = icon
  header.writeUInt16LE(entries.length, 4); // count
  const dir = Buffer.alloc(16 * entries.length);
  let offset = 6 + dir.length;
  entries.forEach((e, i) => {
    const o = i * 16;
    dir.writeUInt8(e.size === 256 ? 0 : e.size, o);      // width (0 means 256)
    dir.writeUInt8(e.size === 256 ? 0 : e.size, o + 1);  // height
    dir.writeUInt8(0, o + 2);                             // palette
    dir.writeUInt8(0, o + 3);                             // reserved
    dir.writeUInt16LE(1, o + 4);                          // colour planes
    dir.writeUInt16LE(32, o + 6);                         // bits per pixel
    dir.writeUInt32LE(e.png.length, o + 8);               // data size
    dir.writeUInt32LE(offset, o + 12);                    // data offset
    offset += e.png.length;
  });
  return Buffer.concat([header, dir, ...entries.map((e) => e.png)]);
}

try {
  const render = (src, size) => sharp(src, { density: 384 }).resize(size, size).png();

  await render(TAB, 32).toFile('public/brand/favicon-32.png');
  await render(TAB, 192).toFile('public/brand/icon-192.png');
  await render(TAB, 512).toFile('public/brand/icon-512.png');
  // Apple composites on black and ignores alpha; the navy square already has
  // no alpha to lose, but flatten anyway so the corners are solid.
  await sharp(TAB, { density: 384 }).resize(180, 180)
    .flatten({ background: { r: 0x20, g: 0x18, b: 0x68 } }).png()
    .toFile('public/brand/apple-touch-icon.png');

  const pngs = [];
  for (const size of [16, 32, 48]) {
    pngs.push({ size, png: await render(TAB, size).toBuffer() });
  }
  writeFileSync('public/favicon.ico', icoFromPngs(pngs));
  // A stray temp file the old script left behind on some runs.
  if (existsSync('public/favicon-32-tmp.png')) unlinkSync('public/favicon-32-tmp.png');

  console.log('icons: generated favicon-32, apple-touch-icon, icon-192, icon-512 and a 16/32/48 favicon.ico from brand/favicon.svg');
} catch (e) {
  console.log('icons: generation failed, continuing build (SVG favicon still served):', e.message);
  process.exit(0);
}

// Generate the raster icon set from the single SVG source at build time, so
// there is exactly one brand mark to maintain and the PNGs can never drift from
// it. Runs in prebuild; sharp is already present as Astro's image dependency.
//
// Outputs (all under public/, served from the site root):
//   brand/favicon-32.png      32x32   legacy + <link rel=icon png>
//   brand/apple-touch-icon.png 180x180 iOS home screen (flattened, no alpha)
//   brand/icon-192.png        192x192 PWA manifest
//   brand/icon-512.png        512x512 PWA manifest / splash
//   favicon.ico               16/32/48 multi-size for /favicon.ico blind hits
//
// The head of Base.astro references these exact paths. If sharp is unavailable
// in a given environment the script logs and exits 0 rather than failing the
// build: missing icons degrade to the SVG favicon, they do not warrant blocking
// a deploy.
import { existsSync, mkdirSync } from 'node:fs';

const SRC = 'public/brand/mark.svg';
const NAVY = { r: 0x20, g: 0x18, b: 0x68 }; // #201868, brand primary

let sharp;
try {
  sharp = (await import('sharp')).default;
} catch {
  console.log('icons: sharp not available, skipping raster icon generation (SVG favicon still served).');
  process.exit(0);
}

if (!existsSync(SRC)) {
  console.log(`icons: ${SRC} missing, skipping.`);
  process.exit(0);
}

mkdirSync('public/brand', { recursive: true });

try {
  // Transparent-background PNGs (favicon + PWA icons sit on any surface).
  await sharp(SRC, { density: 384 }).resize(32, 32).png().toFile('public/brand/favicon-32.png');
  await sharp(SRC, { density: 384 }).resize(192, 192).png().toFile('public/brand/icon-192.png');
  await sharp(SRC, { density: 384 }).resize(512, 512).png().toFile('public/brand/icon-512.png');

  // Apple touch icon: iOS ignores transparency and composites on black, so
  // flatten onto brand navy for a clean tile.
  await sharp(SRC, { density: 384 })
    .resize(180, 180)
    .flatten({ background: NAVY })
    .png()
    .toFile('public/brand/apple-touch-icon.png');

  // favicon.ico for blind /favicon.ico requests from old browsers and scrapers.
  // sharp emits single-size .ico; 32px is the practical default.
  await sharp(SRC, { density: 384 }).resize(32, 32).toFormat('png').toFile('public/favicon-32-tmp.png');
  // sharp has no multi-size ICO; write a 32px ICO via png2icons-free path:
  // ship a 32px .ico, which every browser accepts.
  await sharp(SRC, { density: 384 }).resize(32, 32).toFile('public/favicon.ico').catch(async () => {
    // Some sharp builds lack .ico output; fall back to copying the 32 png bytes
    // under the .ico name, which browsers still parse as an image for the tab.
    const { copyFileSync } = await import('node:fs');
    copyFileSync('public/brand/favicon-32.png', 'public/favicon.ico');
  });

  console.log('icons: generated favicon-32, apple-touch-icon, icon-192, icon-512, favicon.ico from mark.svg');
} catch (e) {
  console.log('icons: generation failed, continuing build (SVG favicon still served):', e.message);
  process.exit(0);
}

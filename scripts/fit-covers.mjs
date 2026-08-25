// Normalise the book covers in public/covers/ to the size the shelf actually
// renders them at, at build time.
//
// WHY THIS IS A BUILD STEP AND NOT A ONE-OFF RESIZE. The Amazon shelf renders
// on every page of the site, so its cover art is the most-requested set of
// images here. The covers are hand-added when a book publishes, and the source
// a publisher hands you is a Kindle master: Volume VI arrived at 1600x2560 and
// 1.1MB, roughly forty times its neighbours, and shipped that way on 2026-08-24
// because nothing was watching. A person remembering to resize is not a
// control. This is.
//
// Anything wider than TARGET_W is resampled down and re-encoded; anything
// already at or under it is left alone, so the step is idempotent and costs
// nothing on a normal build. Aspect ratio is preserved rather than forced,
// because a cover squeezed to a fixed height is a defaced cover.
//
// Runs in prebuild, before astro build reads public/. Like gen-icons.mjs it
// exits 0 if sharp is unavailable: a large cover is a page-weight problem, not
// a reason to block a deploy.
import { existsSync, readdirSync, statSync } from 'node:fs';

const DIR = 'public/covers';
const TARGET_W = 320; // the width the shelf renders; see AmazonShelf.astro
const QUALITY = 82;

let sharp;
try {
  sharp = (await import('sharp')).default;
} catch {
  console.log('covers: sharp not available, skipping cover normalisation.');
  process.exit(0);
}

if (!existsSync(DIR)) {
  console.log(`covers: ${DIR} missing, skipping.`);
  process.exit(0);
}

try {
  let touched = 0;
  for (const name of readdirSync(DIR)) {
    if (!/\.(jpe?g|png)$/i.test(name)) continue;
    const path = `${DIR}/${name}`;
    const before = statSync(path).size;
    const meta = await sharp(path).metadata();
    if (!meta.width || meta.width <= TARGET_W) continue;

    // Read to a buffer first: sharp cannot write to the file it is reading.
    const out = await sharp(path)
      .resize({ width: TARGET_W, withoutEnlargement: true })
      .jpeg({ quality: QUALITY, progressive: true, mozjpeg: true })
      .toBuffer();
    const { writeFileSync } = await import('node:fs');
    writeFileSync(path, out);
    touched++;
    console.log(
      `covers: ${name} ${meta.width}px ${(before / 1024).toFixed(0)}KB -> ${TARGET_W}px ${(out.length / 1024).toFixed(0)}KB`
    );
  }
  console.log(touched ? `covers: normalised ${touched}` : 'covers: all within size, nothing to do');
} catch (e) {
  console.log('covers: normalisation failed, continuing build:', e.message);
  process.exit(0);
}

// Supply-chain guard, run at the very start of prebuild.
//
// TWO THINGS IT CHECKS, in order of importance:
//
// 1. LOCKFILE INTEGRITY (hard gate). package-lock.json must exist and must
//    agree with package.json. `npm ci` -- the command the Cloudflare build
//    uses -- already refuses to run when they disagree, so this is a clearer,
//    earlier failure with a message that says what to do, rather than an
//    opaque ci error deep in the install log. A build that reaches this
//    script with a drifted lockfile is a build whose dependency tree nobody
//    reviewed, and that is exactly the supply-chain hole this closes.
//
// 2. KNOWN ADVISORIES (soft, advisory only). `npm audit` needs the registry,
//    and the Cloudflare build sandbox may not have egress to it. A hard fail
//    here would mean a network hiccup at npm takes the whole site's deploys
//    down, trading a supply-chain risk for an availability risk. So the audit
//    result is LOGGED and never fails the build: the real protection is the
//    pinned lockfile above plus Dependabot PRs, both of which are reviewed by
//    a human before they can change what ships. This just surfaces anything
//    already known against the current pinned tree.

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

// ---- 1. Lockfile must exist.
if (!existsSync('package-lock.json')) {
  console.error(
    'SUPPLY CHAIN: package-lock.json is missing. The build installs with ' +
    '`npm ci`, which requires it. Run `npm install` locally, commit the ' +
    'lockfile, and redeploy. Refusing to build an unpinned dependency tree.'
  );
  process.exit(1);
}

// ---- 1b. Lockfile must agree with package.json (the `npm ci` precondition,
// checked here so the message is legible). Compare the dependency name->range
// sets; a mismatch means someone edited package.json without regenerating the
// lock, so the tree that would install is not the one that was reviewed.
try {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
  const declared = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const rootLock = (lock.packages && lock.packages['']) || {};
  const locked = { ...(rootLock.dependencies || {}), ...(rootLock.devDependencies || {}) };
  const drift = [];
  for (const [name, range] of Object.entries(declared)) {
    if (locked[name] !== range) drift.push(name);
  }
  if (drift.length) {
    console.error(
      'SUPPLY CHAIN: package.json and package-lock.json disagree on: ' +
      drift.join(', ') +
      '. Run `npm install` to regenerate the lockfile and commit it. ' +
      '`npm ci` would refuse this tree; failing early with a clear reason.'
    );
    process.exit(1);
  }
  console.log('supply-chain: lockfile present and in sync with package.json.');
} catch (e) {
  console.error('SUPPLY CHAIN: could not compare package.json and lockfile:', e.message);
  process.exit(1);
}

// ---- 2. Known advisories, advisory only. Never fails the build.
try {
  execSync('npm audit --omit=dev --audit-level=high', { stdio: 'pipe', timeout: 30000 });
  console.log('supply-chain: npm audit found no high or critical advisories.');
} catch (e) {
  const out = `${e.stdout || ''}${e.stderr || ''}`;
  if (/ENOTFOUND|ETIMEDOUT|network|EAI_AGAIN|registry/i.test(out)) {
    console.log('supply-chain: npm audit skipped (no registry access from the build sandbox).');
  } else {
    console.log(
      'supply-chain: npm audit reported advisories against the pinned tree. ' +
      'This does NOT fail the build; review and let Dependabot bump the ' +
      'affected packages. Details:\n' + out.slice(0, 2000)
    );
  }
}

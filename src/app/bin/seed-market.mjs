/**
 * Marketplace bootstrap for the fnOS app — ONLINE model.
 *
 * dshmarket (npm, from dsh-market/dsh-market) is NOT vendored in the fpk any
 * more: it is installed into the web profile by cmd/main's
 * install_market_online() (`dsh plugin --profile web add dshmarket`, a real
 * pnpm install) on first boot, and from then on the user owns its version —
 * in-panel self-updates persist across restarts instead of being reverted by
 * a reseed (the failure mode of the vendored-symlink era).
 *
 * This script is idempotent and safe to re-run on every boot. What it does:
 *
 * 1. PATH shims ($TRIM_PKGVAR/bin/{dsh,pnpm}). The market's one-click
 *    install re-invokes the dsh CLI and needs `pnpm` on PATH, which fnOS
 *    does not ship; the vendored pnpm (toolchain, still in the runtime tree)
 *    makes the market's probe succeed immediately. Shims are regenerated
 *    every boot: fnpack's file modes cannot be trusted for exec bits.
 *
 * 2. Legacy cleanup: profiles/node_modules/dshmarket (the vendored era's
 *    parent-level resolution symlink) is removed when it is a symlink —
 *    after an app upgrade the runtime tree no longer carries dshmarket and
 *    the link dangles. The profile-LOCAL copy is the user's real install
 *    now and is never touched here.
 *
 * 3. Install decision, printed as NEEDS_MARKET_INSTALL on stdout for
 *    cmd/main (which performs the actual online install and re-runs this
 *    script to stamp success):
 *      - rows present + profile-local node_modules/dshmarket resolves
 *          -> healthy; refresh the presence stamp and leave it alone
 *            (self-updates must never be clobbered).
 *      - rows present but the local copy is missing/dangling
 *          -> vendored-era symlink after an upgrade, or a broken install:
 *            NEEDS (the CLI add reconciles node_modules to the manifest).
 *      - no rows + presence stamp -> the user removed the market; respected.
 *      - anything else (fresh device, never installed) -> NEEDS.
 *
 * 4. --seed-bare: offline fallback that writes a minimal bootable web
 *    profile (dsh's own in-box bundles only, zero network) so a first boot
 *    without connectivity still serves; the market installs on a later
 *    start. Only acts when no profile manifest exists.
 *
 * 5. Recovery rotation: the boot watchdog parks broken profiles as
 *    profiles/web.recovery.<ts>; keep the newest two for inspection.
 */
import fs from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const readArg = (name) => {
  const index = args.indexOf(name)
  return index === -1 || index + 1 >= args.length ? undefined : args[index + 1]
}
const runtimeDir = readArg('--runtime')
const homeDir = readArg('--home')
const bindir = readArg('--bindir') ?? path.join(path.dirname(homeDir ?? ''), 'bin')
if (runtimeDir === undefined || homeDir === undefined) {
  console.error('usage: seed-market.mjs --runtime <dir> --home <DSH_HOME> [--bindir <dir>] [--seed-bare]')
  process.exit(1)
}

const log = (message) => console.log(`seed-market: ${message}`)
const nodeModules = path.join(runtimeDir, 'node_modules')
const MARKET_PACKAGE = 'dshmarket'
const WEB_TEMPLATE_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']

// --- 1. PATH shims -----------------------------------------------------------

fs.mkdirSync(bindir, { recursive: true })
const dshEntry = path.join(nodeModules, '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const pnpmPkg = JSON.parse(fs.readFileSync(path.join(nodeModules, 'pnpm', 'package.json'), 'utf8'))
const pnpmEntry = path.join(nodeModules, 'pnpm', typeof pnpmPkg.bin === 'string' ? pnpmPkg.bin : pnpmPkg.bin?.pnpm)
for (const [name, target] of [
  ['dsh', dshEntry],
  ['pnpm', pnpmEntry],
]) {
  if (!fs.existsSync(target)) {
    log(`shim target missing: ${target}`)
    continue
  }
  const file = path.join(bindir, name)
  fs.writeFileSync(file, `#!/bin/sh\nexec node ${JSON.stringify(target)} "$@"\n`)
  fs.chmodSync(file, 0o755)
}

// --- 2. legacy parent-level symlink cleanup ------------------------------------

const legacyLink = path.join(homeDir, 'profiles', 'node_modules', MARKET_PACKAGE)
try {
  if (fs.lstatSync(legacyLink).isSymbolicLink()) {
    fs.rmSync(legacyLink, { force: true })
    log('removed the vendored-era parent-level market symlink')
  }
} catch {
  /* absent — fine */
}

// --- 3. install decision --------------------------------------------------------

const profileDir = path.join(homeDir, 'profiles', 'web')
const manifestFile = path.join(profileDir, 'package.json')
const stampFile = path.join(homeDir, 'market-present')
const localCopy = path.join(profileDir, 'node_modules', MARKET_PACKAGE)

if (fs.existsSync(manifestFile)) {
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
  const hasRow = manifest.dependencies?.[MARKET_PACKAGE] !== undefined
    || manifest.dsh?.profile?.bundles?.includes(MARKET_PACKAGE) === true
  if (hasRow && fs.existsSync(localCopy)) {
    // Presence marker only — never a version: the user owns updates.
    fs.writeFileSync(stampFile, `${new Date().toISOString()}\n`)
  } else if (hasRow || !fs.existsSync(stampFile)) {
    // Rows without a resolvable copy (dangling vendored symlink after an
    // upgrade, broken install), or a profile that never saw the market.
    console.log('NEEDS_MARKET_INSTALL')
  }
  // else: no rows + stamp -> the user removed the market; respected.
} else if (args.includes('--seed-bare')) {
  // --- 4. offline bare-profile fallback ----------------------------------------
  fs.mkdirSync(profileDir, { recursive: true })
  fs.writeFileSync(manifestFile, `${JSON.stringify({
    name: 'dsh-profile-web',
    private: true,
    dsh: { profile: { bundles: [...WEB_TEMPLATE_BUNDLES] } },
  }, null, 2)}\n`)
  fs.writeFileSync(path.join(profileDir, 'pnpm-workspace.yaml'), 'packages:\n- .\nnodeLinker: hoisted\nautoInstallPeers: false\n')
  fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), '# dsh profile user patch layer — edit this file, not cordis.yml.\n[]\n')
  log('seeded a bare web profile (market deferred to a later start)')
} else {
  console.log('NEEDS_MARKET_INSTALL')
}

// --- 5. recovery rotation ------------------------------------------------------

{
  const profilesDir = path.join(homeDir, 'profiles')
  if (fs.existsSync(profilesDir)) {
    const names = fs
      .readdirSync(profilesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^web\.recovery\./.test(entry.name))
      .map((entry) => entry.name)
      .sort()
    for (const name of names.slice(0, -2)) {
      fs.rmSync(path.join(profilesDir, name), { recursive: true, force: true })
      log(`removed old recovery backup ${name}`)
    }
  }
}

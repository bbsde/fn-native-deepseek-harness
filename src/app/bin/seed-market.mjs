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
import { spawnSync } from 'node:child_process'

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

// --- 4.5 node-pty alignment (terminal plugins) ---------------------------------
//
// Terminal plugins (dsh-better-sidebar) depend on node-pty@^1.1.0, which
// ships NO prebuilds: on stock fnOS (no g++/make) it can never compile, and
// pnpm 10 blocks dependency build scripts anyway — the sidebar terminal dies
// with "node-pty 加载失败" out of the box. The dsh runtime's own node-pty
// carries full prebuilds (linux-x64/arm64 included) and loads without any
// toolchain (verified: --ignore-scripts install + spawn OK). Pin the
// profile's resolution to the runtime's version via a pnpm override — the
// plugin's own repair flow states the same goal ("node-pty 与 DSH 核心保持
// 同一版本"). The override is pre-seeded so the FIRST install of such a
// plugin resolves the prebuilt version directly; a later `dsh plugin add`
// that wipes it is re-healed on the next start.
{
  const runtimePtyPkg = path.join(nodeModules, 'node-pty', 'package.json')
  if (fs.existsSync(runtimePtyPkg) && fs.existsSync(manifestFile)) {
    const want = JSON.parse(fs.readFileSync(runtimePtyPkg, 'utf8')).version
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
    const overrideNow = manifest.pnpm?.overrides?.['node-pty']
    let have = null
    try {
      have = JSON.parse(fs.readFileSync(path.join(profileDir, 'node_modules', 'node-pty', 'package.json'), 'utf8')).version
    } catch {}
    if (overrideNow !== want) {
      manifest.pnpm ??= {}
      manifest.pnpm.overrides ??= {}
      manifest.pnpm.overrides['node-pty'] = want
      fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`)
      log(`pinned profile node-pty to the runtime's ${want} (prebuilt, no toolchain needed)`)
    }
    if (have !== null && have !== want) {
      log(`re-aligning installed node-pty ${have} -> ${want}`)
      const pkgvar = path.dirname(bindir)
      const result = spawnSync(path.join(bindir, 'pnpm'), ['install', '--prefer-offline'], {
        cwd: profileDir,
        timeout: 300_000,
        env: {
          ...process.env,
          HOME: homeDir,
          DSH_HOME: homeDir,
          npm_config_registry: 'https://registry.npmmirror.com',
          npm_config_cache: path.join(pkgvar, '.npm-cache'),
          XDG_CACHE_HOME: path.join(pkgvar, '.xdg', 'cache'),
          XDG_CONFIG_HOME: path.join(pkgvar, '.xdg', 'config'),
          XDG_DATA_HOME: path.join(pkgvar, '.xdg', 'data'),
          PATH: `${bindir}:/var/apps/nodejs_v24/target/bin:/usr/bin:/bin`,
        },
        stdio: ['ignore', 'inherit', 'inherit'],
      })
      if (result.status === 0) log(`profile node-pty aligned to ${want}`)
      else log(`node-pty alignment install failed (status ${result.status ?? result.error}); retrying on the next start`)
    }
  }
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

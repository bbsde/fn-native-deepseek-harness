/**
 * Contract test for seed-market.mjs (online model): shim generation, the
 * vendored-era symlink cleanup, and above all the install DECISION matrix —
 * healthy installs are never touched (self-updates persist), removals are
 * respected, dangling copies ask for a reinstall, and the offline fallback
 * seeds a bootable bare profile.
 *
 * Plain node, no deps:    node scripts/test-seed-market.mjs
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
const seedBin = path.join(repo, 'src', 'app', 'bin', 'seed-market.mjs')

function makeTmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-seed-'))
  const runtime = path.join(dir, 'runtime')
  const home = path.join(dir, 'home')
  fs.mkdirSync(path.join(runtime, 'node_modules', '@deepseek-ai', 'dsh', 'lib'), { recursive: true })
  fs.writeFileSync(path.join(runtime, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), '/*stub*/\n')
  fs.mkdirSync(path.join(runtime, 'node_modules', 'pnpm', 'bin'), { recursive: true })
  fs.writeFileSync(path.join(runtime, 'node_modules', 'pnpm', 'package.json'), JSON.stringify({ name: 'pnpm', bin: { pnpm: 'bin/pnpm.cjs' } }))
  fs.writeFileSync(path.join(runtime, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'), '/*stub*/\n')
  fs.mkdirSync(home, { recursive: true })
  return { dir, runtime, home, bindir: path.join(dir, 'bin') }
}

function runSeed(ctx, extra = []) {
  const res = spawnSync(process.execPath, [seedBin, '--runtime', ctx.runtime, '--home', ctx.home, '--bindir', ctx.bindir, ...extra], { encoding: 'utf8' })
  return { status: res.status, out: res.stdout + res.stderr }
}

const failures = []
const check = (name, ok) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`)
  if (!ok) failures.push(name)
}
const shims = (ctx) => fs.existsSync(path.join(ctx.bindir, 'dsh')) && fs.existsSync(path.join(ctx.bindir, 'pnpm'))

// 1. Fresh device: shims land, install requested.
{
  const ctx = makeTmp()
  const r = runSeed(ctx)
  check('fresh: shims written', shims(ctx))
  check('fresh: NEEDS_MARKET_INSTALL printed', r.out.includes('NEEDS_MARKET_INSTALL'))
  check('fresh: no stamp yet', !fs.existsSync(path.join(ctx.home, 'market-present')))
}

// 2. Healthy install (rows + resolvable local copy): never touched, stamped.
{
  const ctx = makeTmp()
  const profile = path.join(ctx.home, 'profiles', 'web')
  fs.mkdirSync(path.join(profile, 'node_modules', 'dshmarket'), { recursive: true })
  fs.writeFileSync(path.join(profile, 'package.json'), JSON.stringify({
    dependencies: { dshmarket: '1.99.0' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dshmarket'] } },
  }))
  const versionFile = path.join(profile, 'node_modules', 'dshmarket', 'version.txt')
  fs.writeFileSync(versionFile, 'user-owned')
  const r = runSeed(ctx)
  check('healthy: no NEEDS', !r.out.includes('NEEDS_MARKET_INSTALL'))
  check('healthy: stamp written', fs.existsSync(path.join(ctx.home, 'market-present')))
  check('healthy: local copy untouched', fs.readFileSync(versionFile, 'utf8') === 'user-owned')
}

// 3. Vendored-era dangling symlink under the profile: reinstall requested,
//    and the parent-level legacy link is removed (symlink only, never a
//    real directory).
{
  const ctx = makeTmp()
  const profile = path.join(ctx.home, 'profiles', 'web')
  fs.mkdirSync(path.join(profile, 'node_modules'), { recursive: true })
  fs.writeFileSync(path.join(profile, 'package.json'), JSON.stringify({ dependencies: { dshmarket: '1.15.0' } }))
  try {
    fs.symlinkSync(path.join(ctx.runtime, 'node_modules', 'dshmarket'), path.join(profile, 'node_modules', 'dshmarket'), 'dir')
  } catch {
    /* Windows without symlink privilege: existence-based checks still hold */
  }
  fs.mkdirSync(path.join(ctx.home, 'profiles', 'node_modules'), { recursive: true })
  try {
    fs.symlinkSync(path.join(ctx.runtime, 'node_modules', 'dshmarket'), path.join(ctx.home, 'profiles', 'node_modules', 'dshmarket'), 'dir')
  } catch { /* ditto */ }
  const r = runSeed(ctx)
  check('dangling: NEEDS_MARKET_INSTALL printed', r.out.includes('NEEDS_MARKET_INSTALL'))
  const legacy = path.join(ctx.home, 'profiles', 'node_modules', 'dshmarket')
  const legacyGone = !fs.existsSync(legacy) || !fs.lstatSync(legacy).isSymbolicLink()
  check('dangling: parent-level legacy symlink removed', legacyGone)
}

// 4. User removed the market (rows gone, stamp present): respected.
{
  const ctx = makeTmp()
  fs.mkdirSync(path.join(ctx.home, 'profiles', 'web'), { recursive: true })
  fs.writeFileSync(path.join(ctx.home, 'profiles', 'web', 'package.json'), JSON.stringify({ name: 'dsh-profile-web' }))
  fs.writeFileSync(path.join(ctx.home, 'market-present'), 'stamp\n')
  const r = runSeed(ctx)
  check('removed: no NEEDS', !r.out.includes('NEEDS_MARKET_INSTALL'))
}

// 5. Offline fallback: bare profile seeds bootable rows (no market), does
//    not request an install in the same pass; an existing profile is
//    left untouched.
{
  const ctx = makeTmp()
  const r = runSeed(ctx, ['--seed-bare'])
  const manifestFile = path.join(ctx.home, 'profiles', 'web', 'package.json')
  check('bare: manifest written', fs.existsSync(manifestFile))
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
  check('bare: template bundles only, no market row', manifest.dsh.profile.bundles.includes('@deepseek-ai/dsh-base') && !manifest.dsh.profile.bundles.includes('dshmarket'))
  check('bare: no NEEDS printed', !r.out.includes('NEEDS_MARKET_INSTALL'))
  check('bare: workspace + patch stubs written', fs.existsSync(path.join(ctx.home, 'profiles', 'web', 'pnpm-workspace.yaml')) && fs.existsSync(path.join(ctx.home, 'profiles', 'web', 'cordis.patch.yml')))
  const before = fs.readFileSync(manifestFile, 'utf8')
  runSeed(ctx, ['--seed-bare'])
  check('bare: existing profile untouched on re-run', fs.readFileSync(manifestFile, 'utf8') === before)
}

// 6. A real (non-symlink) parent-level directory is never removed.
{
  const ctx = makeTmp()
  const real = path.join(ctx.home, 'profiles', 'node_modules', 'dshmarket')
  fs.mkdirSync(real, { recursive: true })
  fs.writeFileSync(path.join(real, 'keep.txt'), 'x')
  runSeed(ctx)
  check('parent-level real directory preserved', fs.existsSync(path.join(real, 'keep.txt')))
}

if (failures.length > 0) {
  console.error(`seed-market: ${failures.length} check(s) failed`)
  process.exit(1)
}
console.log('seed-market: all checks passed')

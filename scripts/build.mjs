/**
 * Pinned-version build path (no npm lookup, no dist copy): stamps the fpk
 * version from dshVersion, then for each target architecture installs the
 * runtime (fetch), rewrites the dist, packs the runtime tarball, and packs
 * with fnpack. ./build.sh is the primary entry and also handles the icon
 * freshness guard + the final per-arch fpk naming; this script mirrors the
 * per-arch core so `npm run build` works for local iteration.
 *
 * Architectures: DSH_ARCHS (space-separated, default "x86_64 arm64").
 * fnOS packages are single-arch (manifest platform=x86|arm) and embed
 * arch-specific native modules, so one fpk is produced per arch.
 */
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const run = (command, cwd) => execSync(command, { cwd, stdio: 'inherit' })

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const manifest = path.join(root, 'src', 'manifest')
fs.writeFileSync(manifest, fs.readFileSync(manifest, 'utf8').replace(/^version=.*$/m, `version=${pkg.dshVersion}`))

const archs = (process.env.DSH_ARCHS || process.env.DSH_ARCH || 'x86_64 arm64').split(/\s+/).filter(Boolean)
const platformFor = (arch) => (arch === 'arm64' ? 'arm' : 'x86')

for (const arch of archs) {
  const pkgPlatform = platformFor(arch)
  console.log(`=== build.mjs: architecture ${arch} (platform=${pkgPlatform}) ===`)
  run(`DSH_ARCH=${arch} node scripts/fetch-dsh.mjs`, root)
  run(`DSH_ARCH=${arch} node scripts/rewrite-dist.mjs`, root)
  run(`DSH_ARCH=${arch} node scripts/pack-runtime.mjs`, root)
  fs.copyFileSync(
    path.join(root, 'src', 'app', `runtime-${arch}.tar.gz`),
    path.join(root, 'src', 'app', 'runtime.tar.gz'),
  )
  fs.writeFileSync(
    manifest,
    fs.readFileSync(manifest, 'utf8').replace(/^platform=.*$/m, `platform=${pkgPlatform}`),
  )
  run('fnpack build', path.join(root, 'src'))
}

// Leave the committed manifest defaulting to x86.
fs.writeFileSync(manifest, fs.readFileSync(manifest, 'utf8').replace(/^platform=.*$/m, 'platform=x86'))
console.log('build.mjs: done')

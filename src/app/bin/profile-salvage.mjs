/**
 * Last-known-good snapshots and surgical recovery for the web profile.
 *
 * dsh boots a profile strictly from its manifest — loadProfile resolves every
 * `dsh.profile.bundles` entry (reconcilePlugins only runs as part of an
 * explicit `dsh plugin` command, never at boot) — so a plugin that kills the
 * web boot can be disabled by restoring the manifest alone. The boot
 * watchdog in cmd/main builds on that: after every successful boot it
 * snapshots the profile's volatile INPUT files here, and when a later boot
 * fails it restores that snapshot into the parked profile, deleting the
 * node_modules entries of plugins installed since. One broken plugin then
 * costs only itself; the plugins that were running at the last good boot
 * survive. A fresh reseed stays as the fallback for when even the last-good
 * shape fails to boot (e.g. a runtime upgrade renamed its in-box bundles).
 *
 * Snapshotted files (inputs only): package.json, pnpm-workspace.yaml,
 * cordis.patch.yml, pnpm-lock.yaml. The composed cordis.yml is boot output;
 * --restore deletes it so it is recomposed from the restored inputs.
 *
 * Modes:
 *   --snapshot --profile <dir> --lastgood <dir>
 *       Copy each input file when its content differs from the snapshot (and
 *       drop snapshot entries whose input no longer exists). Never fatal.
 *   --restore --profile <dir> --lastgood <dir>
 *       Overwrite the profile's inputs with the snapshot, keep the broken
 *       manifest as package.json.broken for inspection, delete node_modules
 *       entries for dependencies the broken manifest added. Prints the
 *       removed package names (comma-separated) to stdout; diagnostics go to
 *       stderr. Exits non-zero when no usable snapshot exists.
 */
import fs from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const readArg = (name) => {
  const index = args.indexOf(name)
  return index === -1 || index + 1 >= args.length ? undefined : args[index + 1]
}
const mode = args.includes('--snapshot') ? 'snapshot' : args.includes('--restore') ? 'restore' : undefined
const profileDir = readArg('--profile')
const lastgoodDir = readArg('--lastgood')
if (mode === undefined || profileDir === undefined || lastgoodDir === undefined) {
  console.error('usage: profile-salvage.mjs --snapshot|--restore --profile <dir> --lastgood <dir>')
  process.exit(1)
}

const log = (message) => console.error(`profile-salvage: ${message}`)
const INPUT_FILES = ['package.json', 'pnpm-workspace.yaml', 'cordis.patch.yml', 'pnpm-lock.yaml']

const readDeps = (file) => {
  try {
    return Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).dependencies ?? {})
  } catch {
    return null // missing or unparsable manifest
  }
}

if (mode === 'snapshot') {
  if (!fs.existsSync(path.join(profileDir, 'package.json'))) {
    log('profile has no package.json; snapshot untouched')
    process.exit(0)
  }
  fs.mkdirSync(lastgoodDir, { recursive: true })
  for (const name of INPUT_FILES) {
    const from = path.join(profileDir, name)
    const to = path.join(lastgoodDir, name)
    if (fs.existsSync(from)) {
      let same = false
      try {
        same = fs.existsSync(to) && fs.readFileSync(from).equals(fs.readFileSync(to))
      } catch {
        same = false
      }
      if (!same) {
        fs.copyFileSync(from, to)
        log(`snapshotted ${name}`)
      }
    } else if (fs.existsSync(to)) {
      fs.rmSync(to, { force: true })
      log(`dropped ${name} from the snapshot (absent in profile)`)
    }
  }
  process.exit(0)
}

// --- --restore -----------------------------------------------------------------

const lastgoodManifest = path.join(lastgoodDir, 'package.json')
const goodDeps = readDeps(lastgoodManifest)
if (goodDeps === null) {
  log(`no usable snapshot manifest at ${lastgoodManifest}`)
  process.exit(2)
}
const brokenManifest = path.join(profileDir, 'package.json')
const brokenDeps = readDeps(brokenManifest) ?? []
const culprits = brokenDeps.filter((name) => !goodDeps.includes(name))

if (fs.existsSync(brokenManifest)) {
  fs.copyFileSync(brokenManifest, `${brokenManifest}.broken`)
  log('kept the broken manifest as package.json.broken')
}
for (const name of INPUT_FILES) {
  const to = path.join(profileDir, name)
  fs.rmSync(to, { force: true })
  if (fs.existsSync(path.join(lastgoodDir, name))) {
    fs.copyFileSync(path.join(lastgoodDir, name), to)
    log(`restored ${name}`)
  }
}
fs.rmSync(path.join(profileDir, 'cordis.yml'), { force: true })
const nodeModulesDir = path.join(profileDir, 'node_modules')
for (const name of culprits) {
  try {
    fs.rmSync(path.join(nodeModulesDir, name), { recursive: true, force: true })
    // Prune scope dirs (@owner) left empty by the removal.
    let dir = path.dirname(path.join(nodeModulesDir, name))
    while (dir !== nodeModulesDir) {
      if (fs.existsSync(dir) && fs.readdirSync(dir).length > 0) break
      fs.rmdirSync(dir)
      dir = path.dirname(dir)
    }
  } catch (error) {
    log(`could not remove node_modules/${name} (${error.message}); it stays but will not load`)
  }
}
// Removing a package leaves its pnpm .bin shims dangling, and a dangling
// symlink anywhere in the data dir aborts the appcenter upgrade's recursive
// chown with ENOENT (cmd/main and the install callbacks sweep the rest of
// the tree). Valid shims are kept: statSync only throws for broken links.
const binDir = path.join(nodeModulesDir, '.bin')
try {
  for (const entry of fs.readdirSync(binDir, { withFileTypes: true })) {
    if (!entry.isSymbolicLink()) continue
    const link = path.join(binDir, entry.name)
    try {
      fs.statSync(link)
    } catch {
      fs.rmSync(link, { force: true })
      log(`removed dangling .bin shim ${entry.name}`)
    }
  }
} catch {
  // no .bin directory — nothing to sweep
}
console.log(culprits.join(', '))

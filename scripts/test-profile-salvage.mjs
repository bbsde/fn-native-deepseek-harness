/**
 * Local contract test for src/app/bin/profile-salvage.mjs (no device needed):
 * snapshot captures the input files, restore rolls the profile back to the
 * snapshot and deletes only the plugins added since. Run: node scripts/test-profile-salvage.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const salvageBin = path.join(root, 'src', 'app', 'bin', 'profile-salvage.mjs')
const tmp = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TEMP ?? '/tmp'), 'salvage-test-'))
const profile = path.join(tmp, 'web')
const lastgood = path.join(tmp, 'lastgood-web')
let failures = 0

const ok = (label, cond) => {
  if (cond) return
  failures += 1
  console.error(`FAIL: ${label}`)
}
const write = (dir, name, text) => {
  fs.mkdirSync(path.join(dir, path.dirname(name)), { recursive: true })
  fs.writeFileSync(path.join(dir, name), text)
}
const read = (dir, name) => fs.readFileSync(path.join(dir, name), 'utf8')
const run = (mode) =>
  spawnSync(process.execPath, [salvageBin, mode, '--profile', profile, '--lastgood', lastgood], { encoding: 'utf8' })

// A healthy profile: market + one user plugin, no lock file yet.
write(profile, 'package.json', `${JSON.stringify({
  name: 'dsh-profile-web',
  private: true,
  dependencies: { dshmarket: '1.14.1', '@openviking/dsh-memory-plugin': 'github:x' },
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dshmarket', '@openviking/dsh-memory-plugin'] } },
}, null, 2)}\n`)
write(profile, 'pnpm-workspace.yaml', 'packages:\n- .\n')
write(profile, 'cordis.patch.yml', '# good\n[]\n')
write(profile, 'node_modules/dshmarket/.keep', '')
write(profile, 'node_modules/@openviking/dsh-memory-plugin/.keep', '')

let r = run('--snapshot')
ok('snapshot exits 0', r.status === 0)
ok('snapshot keeps package.json', fs.existsSync(path.join(lastgood, 'package.json')))
ok('snapshot keeps patch layer', fs.existsSync(path.join(lastgood, 'cordis.patch.yml')))
ok('snapshot does not keep absent lock', !fs.existsSync(path.join(lastgood, 'pnpm-lock.yaml')))
ok('snapshot does not touch node_modules', !fs.existsSync(path.join(lastgood, 'node_modules')))

// User installs a plugin that breaks the boot and edits the patch layer.
write(profile, 'package.json', `${JSON.stringify({
  name: 'dsh-profile-web',
  private: true,
  dependencies: { dshmarket: '1.14.1', '@openviking/dsh-memory-plugin': 'github:x', '@openma/deepseek-harness-tui': '^0.2.8' },
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dshmarket', '@openviking/dsh-memory-plugin', '@openma/deepseek-harness-tui'] } },
}, null, 2)}\n`)
write(profile, 'cordis.patch.yml', ': { broken')
write(profile, 'pnpm-lock.yaml', 'lockfileVersion: 9\n')
write(profile, 'cordis.yml', 'composed-by-boot\n')
write(profile, 'node_modules/@openma/deepseek-harness-tui/.keep', '')
write(profile, 'node_modules/dshmarket/cli.js', '')
// pnpm .bin shims: one dangling (its package is about to be removed), one
// valid — restore must drop only the broken one, or the appcenter upgrade
// chown walk trips over it later. Skipped where the OS refuses file
// symlinks (plain Windows without Developer Mode).
let shims = true
fs.mkdirSync(path.join(profile, 'node_modules', '.bin'), { recursive: true })
try {
  fs.symlinkSync('../@openma/deepseek-harness-tui/bin.js', path.join(profile, 'node_modules', '.bin', 'dsh-tui'))
  fs.symlinkSync('../dshmarket/cli.js', path.join(profile, 'node_modules', '.bin', 'dshmarket'))
} catch {
  shims = false
}

r = run('--restore')
ok('restore exits 0', r.status === 0)
ok('restore reports the culprit', r.stdout.trim() === '@openma/deepseek-harness-tui')
ok('manifest rolled back', !read(profile, 'package.json').includes('openma'))
ok('patch layer rolled back', read(profile, 'cordis.patch.yml') === '# good\n[]\n')
ok('lock not in lastgood removed from profile', !fs.existsSync(path.join(profile, 'pnpm-lock.yaml')))
ok('composed cordis.yml dropped', !fs.existsSync(path.join(profile, 'cordis.yml')))
ok('culprit node_modules deleted', !fs.existsSync(path.join(profile, 'node_modules', '@openma')))
ok('good plugins kept', fs.existsSync(path.join(profile, 'node_modules', '@openviking', 'dsh-memory-plugin')))
ok('broken manifest kept as evidence', read(profile, 'package.json.broken').includes('openma'))
if (shims) {
  // existsSync stats the TARGET, so a dangling link would read as absent —
  // assert on the link itself.
  const shim = (name) => {
    try {
      fs.lstatSync(path.join(profile, 'node_modules', '.bin', name))
      return true
    } catch {
      return false
    }
  }
  ok('dangling .bin shim removed', !shim('dsh-tui'))
  ok('valid .bin shim kept', shim('dshmarket'))
}

// No usable snapshot -> restore must refuse (exit 2), not touch the profile.
fs.rmSync(lastgood, { recursive: true, force: true })
r = run('--restore')
ok('restore without snapshot exits 2', r.status === 2)

fs.rmSync(tmp, { recursive: true, force: true })
if (failures === 0) {
  console.log('profile-salvage: all checks passed')
} else {
  console.error(`${failures} check(s) failed`)
  process.exit(1)
}

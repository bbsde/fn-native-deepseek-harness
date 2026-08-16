/**
 * Packs the staged (and rewritten) dsh runtime into a single tarball for the
 * fpk. One big file installs in seconds; the per-file ACL ceremony fnOS runs
 * on 33k node_modules entries was what made installation take minutes. The
 * tar is extracted to $TRIM_PKGVAR/runtime by cmd/install_callback.
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const staged = path.join(root, 'cache', 'dsh-runtime')
const out = path.join(root, 'src', 'app', 'runtime.tar.gz')

if (!fs.existsSync(path.join(staged, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))) {
  console.error(`staged runtime missing (run fetch + rewrite first): ${staged}`)
  process.exit(1)
}
fs.rmSync(out, { force: true })
fs.mkdirSync(path.dirname(out), { recursive: true })

// Relative paths + cwd: GNU tar reads "D:/..." as host:path (remote tar),
// so absolute Windows paths must stay out of the argument list.
const tar = spawnSync(
  'tar',
  ['czf', path.join('src', 'app', 'runtime.tar.gz'), '-C', path.join('cache', 'dsh-runtime'), 'package.json', 'node_modules'],
  { cwd: root, stdio: 'inherit' },
)
if (tar.status !== 0) {
  console.error(`tar failed with status ${tar.status ?? tar.error}`)
  process.exit(1)
}
const size = fs.statSync(out).size
console.log(`packed ${path.relative(root, out)} (${(size / 1024 / 1024).toFixed(1)} MB)`)

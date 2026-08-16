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

// The harness's glob/grep tools spawn a vendored ripgrep
// (@vscode/ripgrep-<platform>/bin/rg) — the only file in the tree that must
// carry an exec bit to work (native .node/.so files load via dlopen, which
// needs read only). A staging chain that drops the exec bit (e.g. the old
// Windows/MSYS tar round-trip) therefore ships a runtime where everything
// runs except glob/grep, which fail with "ripgrep launch failed" (EACCES at
// spawn). Force 0o755 here so the tar always records an executable rg, and
// verify it is a Linux ELF like fetch does for pty.node.
const rgBin = path.join(staged, 'node_modules', '@vscode', 'ripgrep-linux-x64', 'bin', 'rg')
if (!fs.existsSync(rgBin)) {
  console.error(`vendored ripgrep missing from staged tree: ${rgBin}`)
  process.exit(1)
}
const rgMagic = fs.readFileSync(rgBin).subarray(0, 4)
if (!(rgMagic[0] === 0x7f && rgMagic[1] === 0x45 && rgMagic[2] === 0x4c && rgMagic[3] === 0x46)) {
  console.error(`vendored ripgrep is not a Linux ELF: ${rgBin}`)
  process.exit(1)
}
fs.chmodSync(rgBin, 0o755)

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

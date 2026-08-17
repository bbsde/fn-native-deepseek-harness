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

// DSH_ARCH selects which staged tree + ripgrep binary to pack. Must match the
// value used in fetch-dsh.mjs.
const arch = process.env.DSH_ARCH === 'arm64' ? 'arm64' : 'x86_64'
const rgPlatform = arch === 'arm64' ? 'ripgrep-linux-arm64' : 'ripgrep-linux-x64'

const staged = path.join(root, 'cache', `dsh-runtime-${arch}`)
const out = path.join(root, 'src', 'app', `runtime-${arch}.tar.gz`)

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
const rgBin = path.join(staged, 'node_modules', '@vscode', rgPlatform, 'bin', 'rg')
if (!fs.existsSync(rgBin)) {
  console.error(`vendored ripgrep missing from staged tree: ${rgBin}`)
  process.exit(1)
}
const rgMagic = fs.readFileSync(rgBin).subarray(0, 20)
if (!(rgMagic[0] === 0x7f && rgMagic[1] === 0x45 && rgMagic[2] === 0x4c && rgMagic[3] === 0x46)) {
  console.error(`vendored ripgrep is not a Linux ELF: ${rgBin}`)
  process.exit(1)
}
// e_machine at offset 18 (little-endian): 0xb7 = AArch64, 0x3e = x86-64.
// Guards against an x64 rg sneaking into the arm64 package.
const expectedMachine = arch === 'arm64' ? 0xb7 : 0x3e
const rgMachine = rgMagic[18] | (rgMagic[19] << 8)
if (rgMachine !== expectedMachine) {
  console.error(`vendored ripgrep is for the wrong architecture (e_machine=0x${rgMachine.toString(16)}, expected 0x${expectedMachine.toString(16)} for ${arch}): ${rgBin}`)
  process.exit(1)
}
fs.chmodSync(rgBin, 0o755)

fs.rmSync(out, { force: true })
fs.mkdirSync(path.dirname(out), { recursive: true })

// Relative paths + cwd: GNU tar reads "D:/..." as host:path (remote tar),
// so absolute Windows paths must stay out of the argument list.
const tar = spawnSync(
  'tar',
  ['czf', `src/app/runtime-${arch}.tar.gz`, '-C', `cache/dsh-runtime-${arch}`, 'package.json', 'node_modules'],
  { cwd: root, stdio: 'inherit' },
)
if (tar.status !== 0) {
  console.error(`tar failed with status ${tar.status ?? tar.error}`)
  process.exit(1)
}
const size = fs.statSync(out).size
console.log(`packed ${path.relative(root, out)} (${(size / 1024 / 1024).toFixed(1)} MB)`)

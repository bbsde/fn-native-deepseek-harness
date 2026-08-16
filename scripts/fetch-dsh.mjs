/**
 * Installs the pinned @deepseek-ai/dsh release into src/app/dsh.
 *
 * dsh has native runtime dependencies (node-pty, koffi) whose Linux-x64
 * binaries are selected/built by install scripts, so the npm install MUST run
 * on a Linux-x64 host that shares the target Node major (nodejs_v24 on the
 * NAS). This script performs the install remotely on the build NAS over SSH
 * and ships the tree back as a tarball, which also preserves symlinks on the
 * Windows dev machine.
 *
 * The remote install runs dependency install scripts by necessity; it happens
 * on the dedicated build NAS (DSH_BUILD_HOST, default "nas31" from
 * ~/.ssh/config), not on this machine. spawnSync/`bash -s` keeps the remote
 * script out of Windows shell quoting.
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const version = pkg.dshVersion
if (typeof version !== 'string' || version === '') {
  console.error('package.json is missing the pinned "dshVersion" field')
  process.exit(1)
}

const host = process.env.DSH_BUILD_HOST ?? 'nas31'
const remoteDir = `/tmp/dsh-fpk-build/${version}`
const dest = path.join(root, 'src', 'app', 'dsh')

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options })
  if (result.status !== 0) {
    console.error(`${command} ${args.join(' ')} failed with status ${result.status ?? result.error}`)
    process.exit(1)
  }
}

const remoteScript = `
set -e
runtime=/var/apps/nodejs_v24/target
[ -x "\$runtime/bin/npm" ] || { echo 'nodejs_v24 runtime missing on build host' >&2; exit 1; }
rm -rf '${remoteDir}'
mkdir -p '${remoteDir}'
printf '%s' '${JSON.stringify({ name: 'dsh-runtime', private: true, dependencies: { '@deepseek-ai/dsh': version } })}' > '${remoteDir}/package.json'
cd '${remoteDir}'
export PATH="\$runtime/bin:\$PATH"
npm install --omit=dev --no-audit --no-fund --loglevel=error
tar czf runtime.tar.gz package.json node_modules
ls -la runtime.tar.gz
`

console.log(`Installing @deepseek-ai/dsh@${version} on ${host} (linux-x64, node 24) ...`)
// stdin must be a pipe for `input` to reach bash -s.
run('ssh', [host, 'bash -s'], { stdio: ['pipe', 'inherit', 'inherit'], input: remoteScript })

// npm artifacts carry read-only attributes on Windows; plain rmSync hits EPERM.
if (fs.existsSync(dest)) {
  run('bash', ['-c', `rm -rf '${dest.replaceAll("'", "'\\''")}'`])
}
fs.mkdirSync(dest, { recursive: true })
console.log('Fetching runtime back ...')
run('scp', ['-q', `${host}:${remoteDir}/runtime.tar.gz`, path.join(dest, 'runtime.tar.gz')])
run('tar', ['xzf', 'runtime.tar.gz'], { cwd: dest })
fs.rmSync(path.join(dest, 'runtime.tar.gz'))
run('ssh', [host, `rm -rf '${remoteDir}'`])

const entry = path.join(dest, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
if (!fs.existsSync(entry)) {
  console.error(`expected dsh entry not found: ${entry}`)
  process.exit(1)
}
// node-pty natives land in prebuilds/linux-x64 (prebuilt) or build/Release
// (compiled on the build host); either way the file must be a Linux ELF.
const ptyCandidates = [
  path.join(dest, 'node_modules', 'node-pty', 'prebuilds', 'linux-x64', 'pty.node'),
  path.join(dest, 'node_modules', 'node-pty', 'build', 'Release', 'pty.node'),
]
const pty = ptyCandidates.find((file) => fs.existsSync(file))
if (pty === undefined) {
  console.error(`node-pty native module missing (checked ${ptyCandidates.join(', ')})`)
  process.exit(1)
}
const magic = fs.readFileSync(pty).subarray(0, 4)
if (!(magic[0] === 0x7f && magic[1] === 0x45 && magic[2] === 0x4c && magic[3] === 0x46)) {
  console.error(`node-pty native at ${pty} is not a Linux ELF (got ${magic.toString('hex')})`)
  process.exit(1)
}
if (!fs.existsSync(path.join(dest, 'node_modules', 'koffi', 'package.json'))) {
  console.error('koffi package missing from the runtime tree')
  process.exit(1)
}
console.log(`dsh entry OK; node-pty linux-x64 ELF OK (${path.relative(dest, pty)})`)

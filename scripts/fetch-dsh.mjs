/**
 * Installs the pinned @deepseek-ai/dsh release into cache/dsh-runtime.
 *
 * dsh has native runtime dependencies (node-pty, koffi) whose Linux-x64
 * binaries are selected/built by install scripts, so the npm install MUST run
 * on a Linux-x64 host that shares the target Node major (nodejs_v24 on the
 * NAS). This script performs the install remotely on the build NAS over SSH
 * and ships the tree back as a tarball, which also preserves symlinks on the
 * Windows dev machine. The staged tree is later packed into a single
 * runtime.tar.gz by scripts/pack-runtime.mjs.
 *
 * The remote install runs dependency install scripts by necessity; it happens
 * on the dedicated build NAS (DSH_BUILD_HOST, default "nas31" from
 * ~/.ssh/config), not on this machine. spawnSync/`bash -s` keeps the remote
 * script out of Windows shell quoting.
 *
 * When the workspace already lives on a Linux-x64 fnOS box (e.g. the project
 * was moved onto the NAS itself), set DSH_BUILD_HOST=local to skip SSH
 * entirely: the install runs in place with the same nodejs_v24 runtime that
 * the installed app uses, straight into cache/dsh-runtime. The npm cache is
 * redirected under cache/npm-cache so the build never touches the app's own
 * DSH_HOME state (npm_config_cache in that environment points at
 * $DSH_HOME/.npm-cache, which does not exist for a build tree).
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

// DSH_ARCH selects the target CPU architecture of the runtime tree. This
// matters because node-pty/koffi/ripgrep ship architecture-specific native
// binaries. fnOS packages are single-arch (manifest platform=x86|arm), so the
// build produces one fpk per arch. Values: x86_64 (default) | arm64.
const arch = process.env.DSH_ARCH === 'arm64' ? 'arm64' : 'x86_64'
const isArm = arch === 'arm64'
// npm/Node platform triple used by native module layouts.
const nodePlatformArch = isArm ? 'linux-arm64' : 'linux-x64'

// Default to a local install on this fnOS box. The old remote build host
// (nas31) is no longer used; x86 is built with the device's own nodejs_v24
// and arm64 via an emulated container (see the isArm branch below).
const host = process.env.DSH_BUILD_HOST ?? 'local'
const localBuild = host === 'local'
const remoteDir = `/tmp/dsh-fpk-build/${version}`
const dest = path.join(root, 'cache', `dsh-runtime-${arch}`)

// HTTP proxy for the arm64 Docker build: the QEMU container reaches the host
// proxy at 127.0.0.1:<port> only with --net=host. Falls back to DSH_PROXY or
// the common 7890.
const dockerProxy = process.env.DSH_PROXY || 'http://127.0.0.1:7890'

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options })
  if (result.status !== 0) {
    console.error(`${command} ${args.join(' ')} failed with status ${result.status ?? result.error}`)
    process.exit(1)
  }
}

// On a native arm64 host (GitHub's ubuntu-24.04-arm runner) the runtime tree
// installs directly with the ambient npm — no QEMU container needed. The
// emulated-container path below only applies when an x86 host builds arm64.
const nativeArm = isArm && process.arch === 'arm64'

if (localBuild || nativeArm) {
  // Same runtime the installed app runs on; fall back to ambient node when
  // not on fnOS. Node major must match the target (24) so node-pty/koffi
  // natives are selected for the right ABI.
  const fnosNode = '/var/apps/nodejs_v24/target'
  const runtimeBin = fs.existsSync(path.join(fnosNode, 'bin', 'npm')) ? path.join(fnosNode, 'bin') : null
  const nodeMajor = Number.parseInt(process.versions.node.split('.')[0], 10)
  if (runtimeBin === null && nodeMajor !== 24) {
    console.error(`local build needs node major 24 (running ${process.versions.node}) or fnOS nodejs_v24`)
    process.exit(1)
  }
  fs.rmSync(dest, { recursive: true, force: true })
  fs.mkdirSync(dest, { recursive: true })
  fs.mkdirSync(path.join(root, 'cache', 'npm-cache'), { recursive: true })
  fs.writeFileSync(
    path.join(dest, 'package.json'),
    JSON.stringify({ name: 'dsh-runtime', private: true, dependencies: { '@deepseek-ai/dsh': version } }),
  )
  console.log(`Installing @deepseek-ai/dsh@${version} locally (${nodePlatformArch}, node ${runtimeBin ? '24 (nodejs_v24)' : process.versions.node}) ...`)
  const env = {
    ...process.env,
    npm_config_cache: path.join(root, 'cache', 'npm-cache'),
    // node-pty compiles from source (no linux-x64 prebuilds in the tarball);
    // node-gyp mkdirs its cache under XDG_CACHE_HOME and downloads node headers
    // into its devdir — both must stay inside the workspace cache on fnOS,
    // where the ambient XDG paths point at the app's own DSH_HOME state.
    XDG_CACHE_HOME: path.join(root, 'cache', 'xdg-cache'),
    npm_config_devdir: path.join(root, 'cache', 'node-gyp'),
    ...(runtimeBin ? { PATH: `${runtimeBin}:${process.env.PATH}` } : {}),
  }
  run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: dest, env })
} else if (isArm && !nativeArm) {
  // arm64 build: there is no arm64 build NAS in this setup, and node-pty has
  // no linux-arm64 prebuild, so we compile inside an emulated arm64 container
  // on this x86 host (QEMU binfmt + an arm64 node image). The container uses
  // --net=host so it can reach the host HTTP proxy (DSH_PROXY, default
  // 127.0.0.1:7890) for apt + npm. The staged tree is written into `dest`
  // via a bind mount.
  const dockerImage = process.env.DSH_ARM_IMAGE || 'arm64v8/node:24'
  const proxy = dockerProxy
  const innerScript = `
set -e
export http_proxy=${proxy} https_proxy=${proxy}
export npm_config_proxy=${proxy} npm_config_https_proxy=${proxy}
export npm_config_registry=https://registry.npmmirror.com
export DEBIAN_FRONTEND=noninteractive
apt-get update -o Acquire::http::Timeout=30
apt-get install -y g++ make python3
mkdir -p /out
cd /out
printf '%s' '${JSON.stringify({ name: 'dsh-runtime', private: true, dependencies: { '@deepseek-ai/dsh': version } })}' > package.json
npm install --omit=dev --no-audit --no-fund --loglevel=error --no-package-lock
`
  fs.rmSync(dest, { recursive: true, force: true })
  fs.mkdirSync(dest, { recursive: true })
  const containerName = `dsh-arm-build-${version}`
  // The dsh user is not in the docker group in the running session, so the
  // docker invocation needs sudo. The container itself runs the build as root
  // and reaches the host proxy via --net=host; no host PATH is involved there.
  run('sudo', [
    'docker', 'run', '--rm', '--platform', 'linux/arm64', '--net=host',
    '--name', containerName,
    '-v', `${dest}:/out`,
    dockerImage,
    'bash', '-c', innerScript,
  ])
  // The container runs as root, so the staged tree is owned by root; reclaim
  // it so later steps (pack-runtime's chmod on rg) run as the unprivileged
  // build user without EPERM.
  run('sudo', ['chown', '-R', `${process.getuid()}:${process.getgid()}`, dest])
  if (!fs.existsSync(path.join(dest, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))) {
    console.error('arm64 docker build did not produce a dsh tree in the staging dir')
    process.exit(1)
  }
  // npm inside the emulated container does not reliably resolve the arm64
  // ripgrep optional dep — it installs the x64 binary instead (and any
  // in-container follow-up install gets pruned by npm's tree reconciliation).
  // Bypass npm entirely: fetch the arm64 ripgrep tarball directly from the
  // China mirror on the host and extract it into node_modules.
  {
    const rgDir = path.join(dest, 'node_modules', '@vscode', 'ripgrep-linux-arm64')
    const rgVersion = (() => {
      try {
        return JSON.parse(fs.readFileSync(path.join(dest, 'node_modules', '@vscode', 'ripgrep', 'package.json'), 'utf8')).version
      } catch {
        return '1.18.0'
      }
    })()
    const mirror = process.env.DSH_NPM_MIRROR || 'https://registry.npmmirror.com'
    const tgz = path.join(root, 'cache', `ripgrep-linux-arm64-${rgVersion}.tgz`)
    console.log(`Fetching @vscode/ripgrep-linux-arm64@${rgVersion} from mirror ...`)
    run('curl', ['-fsSL', '-o', tgz, `${mirror}/@vscode/ripgrep-linux-arm64/-/ripgrep-linux-arm64-${rgVersion}.tgz`])
    fs.rmSync(rgDir, { recursive: true, force: true })
    fs.mkdirSync(rgDir, { recursive: true })
    run('tar', ['xzf', tgz, '-C', rgDir, '--strip-components=1'])
    if (!fs.existsSync(path.join(rgDir, 'bin', 'rg'))) {
      console.error(`arm64 ripgrep binary missing after extract: ${path.join(rgDir, 'bin', 'rg')}`)
      process.exit(1)
    }
  }
} else {
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
}

const entry = path.join(dest, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
if (!fs.existsSync(entry)) {
  console.error(`expected dsh entry not found: ${entry}`)
  process.exit(1)
}
// node-pty natives land in prebuilds/linux-<arch> (prebuilt) or build/Release
// (compiled on the build host); either way the file must be a Linux ELF.
const ptyCandidates = [
  path.join(dest, 'node_modules', 'node-pty', 'prebuilds', nodePlatformArch, 'pty.node'),
  path.join(dest, 'node_modules', 'node-pty', 'build', 'Release', 'pty.node'),
]
const pty = ptyCandidates.find((file) => fs.existsSync(file))
if (pty === undefined) {
  console.error(`node-pty native module missing (checked ${ptyCandidates.join(', ')})`)
  process.exit(1)
}
const magic = fs.readFileSync(pty).subarray(0, 20)
if (!(magic[0] === 0x7f && magic[1] === 0x45 && magic[2] === 0x4c && magic[3] === 0x46)) {
  console.error(`node-pty native at ${pty} is not a Linux ELF (got ${magic.subarray(0, 4).toString('hex')})`)
  process.exit(1)
}
// ELF e_machine at offset 18 (little-endian): 0xb7 = AArch64, 0x3e = x86-64.
// Verifying it catches "staged as arm but actually built x64" mistakes that
// the magic check alone would let through.
const expectedMachine = isArm ? 0xb7 : 0x3e
const machine = magic[18] | (magic[19] << 8)
if (machine !== expectedMachine) {
  console.error(`node-pty native at ${pty} is for the wrong architecture (e_machine=0x${machine.toString(16)}, expected 0x${expectedMachine.toString(16)} for ${arch})`)
  process.exit(1)
}
if (!fs.existsSync(path.join(dest, 'node_modules', 'koffi', 'package.json'))) {
  console.error('koffi package missing from the runtime tree')
  process.exit(1)
}
console.log(`dsh entry OK; node-pty ${nodePlatformArch} ELF OK (${path.relative(dest, pty)})`)

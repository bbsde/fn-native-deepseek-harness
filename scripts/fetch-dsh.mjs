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

// A pnpm for the `dsh plugin add` machinery rides in the same runtime tree
// (tooling, not a plugin: it stays vendored so first-boot online installs
// never depend on the host shipping pnpm). dshmarket itself is NOT vendored:
// the market installs online into the profile on first boot, so self-updates
// persist (see src/app/bin/seed-market.mjs and cmd/main).
const pnpmVersion = pkg.pnpmVersion
if (typeof pnpmVersion !== 'string' || pnpmVersion === '') {
  console.error('package.json is missing the pinned "pnpmVersion" field')
  process.exit(1)
}
const stagingManifest = () => ({
  name: 'dsh-runtime',
  private: true,
  dependencies: {
    '@deepseek-ai/dsh': version,
    pnpm: pnpmVersion,
  },
})

// Registry selection: nas31 and the fnOS-local build sit behind CN networks
// where registry.npmjs.org crawls (a cold 535-package install took ~10 min
// there, dominated by tarball downloads). Those paths default to Alibaba's
// npmmirror; CI's US runners keep npmjs. DSH_NPM_REGISTRY overrides, and the
// mirror preset also points node-gyp's header download at the npmmirror
// node dist so node-pty's compile never waits on nodejs.org.
const NPM_MIRROR = 'https://registry.npmmirror.com'
const NPM_DEFAULT = 'https://registry.npmjs.org'
const mirrorEnv = {
  npm_config_registry: NPM_MIRROR,
  NODEJS_ORG_MIRROR: 'https://npmmirror.com/mirrors/node/',
}

// DSH_ARCH selects the target CPU architecture of the runtime tree. This
// matters because node-pty/koffi/ripgrep ship architecture-specific native
// binaries. fnOS packages are single-arch (manifest platform=x86|arm), so the
// build produces one fpk per arch. Values: x86_64 (default) | arm64.
const arch = process.env.DSH_ARCH === 'arm64' ? 'arm64' : 'x86_64'
const isArm = arch === 'arm64'
// npm/Node platform triple used by native module layouts.
const nodePlatformArch = isArm ? 'linux-arm64' : 'linux-x64'

// Default to a local install (this fnOS box for x86, or the CI arm64 runner).
// The legacy remote build host (nas31) is only used when DSH_BUILD_HOST names it.
const host = process.env.DSH_BUILD_HOST ?? 'local'
const localBuild = host === 'local'
const remoteDir = `/tmp/dsh-fpk-build/${version}`
const dest = path.join(root, 'cache', `dsh-runtime-${arch}`)

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options })
  if (result.status !== 0) {
    console.error(`${command} ${args.join(' ')} failed with status ${result.status ?? result.error}`)
    process.exit(1)
  }
}

// On a native arm64 host (GitHub's ubuntu-24.04-arm runner) the runtime tree
// installs directly with the ambient npm. There is no emulated-container path
// any more: local x86 hosts cannot build arm64 (use CI).
const nativeArm = isArm && process.arch === 'arm64'

if ((localBuild && !isArm) || nativeArm) {
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
  fs.writeFileSync(path.join(dest, 'package.json'), JSON.stringify(stagingManifest()))
  // fnOS nodejs_v24 present -> this is the CN NAS box: default to the mirror.
  const onFnos = runtimeBin !== null
  const registry = process.env.DSH_NPM_REGISTRY ?? (onFnos ? NPM_MIRROR : NPM_DEFAULT)
  console.log(`Installing @deepseek-ai/dsh@${version} locally (${nodePlatformArch}, node ${runtimeBin ? '24 (nodejs_v24)' : process.versions.node}, registry ${registry}) ...`)
  const env = {
    ...process.env,
    npm_config_cache: path.join(root, 'cache', 'npm-cache'),
    npm_config_registry: registry,
    // node-pty compiles from source (no linux-x64 prebuilds in the tarball);
    // node-gyp mkdirs its cache under XDG_CACHE_HOME and downloads node headers
    // into its devdir — both must stay inside the workspace cache on fnOS,
    // where the ambient XDG paths point at the app's own DSH_HOME state.
    XDG_CACHE_HOME: path.join(root, 'cache', 'xdg-cache'),
    npm_config_devdir: path.join(root, 'cache', 'node-gyp'),
    ...(registry === NPM_MIRROR ? mirrorEnv : {}),
    ...(runtimeBin ? { PATH: `${runtimeBin}:${process.env.PATH}` } : {}),
  }
  run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: dest, env })
} else if (isArm) {
  // arm64 builds happen on GitHub Actions' native arm64 runner (see
  // .github/workflows/build.yml). Building arm64 on a local x86 host used to
  // run a QEMU-emulated container, which took ~40 minutes per build and needed
  // a host proxy; that path was removed in favour of CI.
  console.error('arm64 builds are produced by GitHub Actions (ubuntu-24.04-arm runner); local arm64 builds require a native arm64 host (DSH_BUILD_HOST=local on arm64).')
  process.exit(1)
} else {
  // nas31 sits behind a CN network: default the remote install to npmmirror.
  const registry = process.env.DSH_NPM_REGISTRY ?? NPM_MIRROR
  const nodeMirror = registry === NPM_MIRROR ? 'https://npmmirror.com/mirrors/node/' : 'https://nodejs.org/download/release/'
  const remoteScript = `
set -e
runtime=/var/apps/nodejs_v24/target
[ -x "\$runtime/bin/npm" ] || { echo 'nodejs_v24 runtime missing on build host' >&2; exit 1; }
rm -rf '${remoteDir}'
mkdir -p '${remoteDir}'
printf '%s' '${JSON.stringify(stagingManifest())}' > '${remoteDir}/package.json'
cd '${remoteDir}'
export PATH="\$runtime/bin:\$PATH"
export npm_config_registry='${registry}'
export NODEJS_ORG_MIRROR='${nodeMirror}'
npm install --omit=dev --no-audit --no-fund --loglevel=error
tar czf runtime.tar.gz package.json node_modules
ls -la runtime.tar.gz
`

  console.log(`Installing @deepseek-ai/dsh@${version} on ${host} (linux-x64, node 24, registry ${registry}) ...`)
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

// Bundled toolchain check: the pnpm that `dsh plugin add` shells out to.
// rewrite-dist.mjs and cmd/main both assume it is here.
if (!fs.existsSync(path.join(dest, 'node_modules', 'pnpm', 'package.json'))) {
  console.error('pnpm package missing from the runtime tree')
  process.exit(1)
}
console.log(`dsh entry OK; node-pty ${nodePlatformArch} ELF OK (${path.relative(dest, pty)}); pnpm OK`)

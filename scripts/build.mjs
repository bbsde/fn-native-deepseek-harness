/**
 * Pinned-version build path (no npm lookup, no dist copy): stamps the fpk
 * version from dshVersion, installs the runtime remotely, rewrites the dist,
 * and packs with fnpack. ./build.sh is the primary entry.
 */
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const run = (command, cwd) => execSync(command, { cwd, stdio: 'inherit' })

// The fpk version mirrors the upstream dsh version (same policy as build.sh).
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const manifest = path.join(root, 'src', 'manifest')
fs.writeFileSync(manifest, fs.readFileSync(manifest, 'utf8').replace(/^version=.*$/m, `version=${pkg.dshVersion}`))

run('node scripts/fetch-dsh.mjs', root)
run('node scripts/rewrite-dist.mjs', root)
run('fnpack build', path.join(root, 'fpk'))

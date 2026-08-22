#!/usr/bin/env node
// Contract test for the fnOS authorized-directory hop synthesis patched into
// dsh-host-directory-picker-browse by scripts/rewrite-dist.mjs
// (patchPickerGrants). Verifies against the STAGED runtime tree:
//   1. the patch marker/export is present,
//   2. fnosGrantHopRows computes next-hop rows for every unlistable layer of
//      a granted chain and returns null everywhere else (upstream error
//      preserved),
//   3. BrowseDirectoryPicker.list() still lists real directories and still
//      rejects unreadable targets with the upstream error when no grant
//      applies.
// The EACCES catch-arm itself cannot be produced portably (trimacl is
// fnOS-only), so its wiring is covered by rewrite-dist's string gates.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const arch = process.env.DSH_ARCH === 'arm64' ? 'arm64' : 'x86_64'
const libPath = path.join(root, 'cache', `dsh-runtime-${arch}`, 'node_modules',
  '@deepseek-ai', 'dsh-host-directory-picker-browse', 'lib', 'index.js')

if (!fs.existsSync(libPath)) {
  console.error(`staged lib not found: ${libPath} (run the fetch first)`)
  process.exit(1)
}

let failures = 0
const check = (name, actual, expected) => {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) console.log(`  ok   ${name}`)
  else {
    failures++
    console.error(`  FAIL ${name}\n    expected ${e}\n    actual   ${a}`)
  }
}

const source = fs.readFileSync(libPath, 'utf8')
if (!source.includes('fnosGrantHopRows')) {
  console.error('staged lib is not patched; run: node scripts/rewrite-dist.mjs')
  process.exit(1)
}

const mod = await import(pathToFileURL(libPath))
check('fnosGrantHopRows exported', typeof mod.fnosGrantHopRows, 'function')

// --- hop computation (pure string logic; the patched code only ever sees
// POSIX paths on fnOS) -------------------------------------------------------
const hops = mod.fnosGrantHopRows
const grantsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-picker-grants-'))
const grantsFile = path.join(grantsDir, 'accessible-paths')

fs.writeFileSync(grantsFile, '/vol3/1000/Projects\n/vol2/media\n\nnot-a-path\n')
process.env.DSH_ACCESSIBLE_PATHS_FILE = grantsFile
check('root lists granted volumes, sorted', hops('/'), [
  { name: 'vol2', path: '/vol2', hidden: false },
  { name: 'vol3', path: '/vol3', hidden: false },
])
check('unlistable layer shows the next hop', hops('/vol3'), [
  { name: '1000', path: '/vol3/1000', hidden: false },
])
check('second layer keeps walking', hops('/vol3/1000'), [
  { name: 'Projects', path: '/vol3/1000/Projects', hidden: false },
])
check('granted root itself is NOT virtualized', hops('/vol3/1000/Projects'), null)
check('sibling volume with its own grant', hops('/vol2'), [
  { name: 'media', path: '/vol2/media', hidden: false },
])
check('path with no grants falls back to the upstream error', hops('/vol1'), null)
check('below a granted root falls back to real listing', hops('/vol2/media/sub'), null)

fs.writeFileSync(grantsFile, '  /vol3/1000/Projects/  \n/vol3/.archive\n')
check('trailing slash/whitespace tolerated, hidden hops flagged', hops('/vol3'), [
  { name: '.archive', path: '/vol3/.archive', hidden: true },
  { name: '1000', path: '/vol3/1000', hidden: false },
])

process.env.DSH_ACCESSIBLE_PATHS_FILE = path.join(grantsDir, 'missing.txt')
check('unreadable grants file → null', hops('/vol3'), null)
delete process.env.DSH_ACCESSIBLE_PATHS_FILE
check('unset env → null', hops('/vol3'), null)

// --- upstream listing behavior stays intact ----------------------------------
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-picker-list-'))
fs.mkdirSync(path.join(workspace, 'alpha'))
fs.mkdirSync(path.join(workspace, '.beta'))
fs.writeFileSync(path.join(workspace, 'file.txt'), 'x')

// --- inaccessible-row filtering ----------------------------------------------
// fnosGrantRoots parsing/fallbacks plus fnosRowEnterable semantics (the
// access() probe answers correctly on both platforms for these cases).
process.env.DSH_ACCESSIBLE_PATHS_FILE = grantsFile
fs.writeFileSync(grantsFile, '/vol3/1000/Projects\n')
check('grant roots parsed', mod.fnosGrantRoots(), ['/vol3/1000/Projects'])
const enterable = mod.fnosRowEnterable
check('row on the grant chain survives without access (chain exemption)',
  await enterable('/vol3', ['/vol3/1000/Projects']), true)
check('row equal to a grant root survives',
  await enterable('/vol3/1000/Projects', ['/vol3/1000/Projects']), true)
check('accessible row survives',
  await enterable(workspace, []), true)
check('inaccessible row is hidden',
  await enterable(path.join(grantsDir, 'no-such-dir'), []), false)
check('row off every chain still needs access',
  await enterable('/vol2', ['/vol3/1000/Projects']), false)
const picker = new mod.default({ reflect: { provide() {} } }, { maxEntries: 1000 })
const real = await picker.list(workspace)
check('real listing: dirs only, name-sorted', real.entries.map((e) => e.name), ['.beta', 'alpha'])
check('real listing: home surfaced', typeof real.home, 'string')
check('real listing: breadcrumb ends at the target', real.crumbs.at(-1).path, real.path)
let rejected = null
try {
  await picker.list(path.join(workspace, 'file.txt'))
} catch (error) {
  rejected = error
}
check('unreadable target still rejects upstream-style',
  rejected instanceof Error && /cannot list/.test(rejected.message), true)

fs.rmSync(grantsDir, { recursive: true, force: true })
fs.rmSync(workspace, { recursive: true, force: true })

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`)
  process.exit(1)
}
console.log('\nAll picker grant-hop checks passed.')

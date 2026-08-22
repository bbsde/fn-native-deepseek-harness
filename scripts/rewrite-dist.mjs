/**
 * Rewrites root-absolute URLs in the dsh web client artifacts so they live
 * under the fnOS gateway prefix. The browser loads the app through
 * /app/deepseek-harness, but dsh builds every URL against the origin root,
 * so without this step requests escape the prefix and the fnOS gateway
 * answers 404 before they ever reach dsh.
 *
 * Two artifact families are touched:
 *   1. @deepseek-ai/dsh-web-frontend/dist — the shell (index.html, assets,
 *      manifest.webmanifest)
 *   2. every package declaring a web `dsh.client` bundle (served at runtime
 *      as /plugins/<package>/client.js; the RPC transport's "/api" constants
 *      live there, not in the shell) — this includes the vendored dshmarket,
 *      whose panel RPC posts to "/dsh-market/…" routes
 *
 * This is a build-time patch over upstream artifacts, deliberately not a
 * source fork. Every rule is verified: the build fails loudly when a pattern
 * disappears (upstream changed how bundles are emitted) instead of shipping
 * a silently broken app. Re-verify against each new dshVersion.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const prefix = process.env.GATEWAY_PREFIX ?? '/app/dsh'
const arch = process.env.DSH_ARCH === 'arm64' ? 'arm64' : 'x86_64'
const runtime = path.join(root, 'cache', `dsh-runtime-${arch}`, 'node_modules')
const dist = path.join(runtime, '@deepseek-ai', 'dsh-web-frontend', 'dist')

if (!fs.existsSync(path.join(dist, 'index.html'))) {
  console.error(`dist not found (run "npm run fetch" first): ${dist}`)
  process.exit(1)
}

// String-start anchored on the opening quote so external URLs (https://api.…),
// relative specifiers ("assets/langs/…", resolved against the prefixed
// document URL and therefore already correct), and already-prefixed values
// cannot match.
const TEXT_RULES = [
  ['"/api', `"${prefix}/api`],
  ["'/api", `'${prefix}/api`],
  ['`/api', `\`${prefix}/api`],
  ['"/assets/', `"${prefix}/assets/`],
  ["'/assets/", `'${prefix}/assets/`],
  ['`/assets/', `\`${prefix}/assets/`],
  ['"/plugins/', `"${prefix}/plugins/`],
  ["'/plugins/", `'${prefix}/plugins/`],
  ['`/plugins/', `\`${prefix}/plugins/`],
  ['"/favicon', `"${prefix}/favicon`],
  ["'/favicon", `'${prefix}/favicon`],
  ['"/manifest.webmanifest', `"${prefix}/manifest.webmanifest`],
]
// The PWA manifest points its scope/start_url at the origin root.
const MANIFEST_RULES = [
  ['"start_url": "/"', `"start_url": "${prefix}/"`],
  ['"scope": "/"', `"scope": "${prefix}/"`],
  ['"id": "/"', `"id": "${prefix}/"`],
]
// The PWA manifest cannot be served usefully behind the fnOS gateway: the
// browser's manifest prefetch arrives without NAS login state, the gateway
// answers plain text ("invalid token"), and Chrome's manifest parser logs
// "Line: 1, column: 1, Syntax error" in the console on every page load. The
// app is opened as a fnOS tab and never installed as a PWA, so the link is
// dropped instead. Matches both the root-absolute and already-prefixed href.
const MANIFEST_LINK = /<link\s+rel="manifest"\s+href="[^"]*manifest\.webmanifest"\s*\/?>/

// The generic connection RPC channel constant ("/api") is prefixed by TEXT_RULES
// into a multi-segment path ("/app/dsh/api"), but the client validates channel
// strings against a single-segment pattern; without this widening every generic
// RPC call (commands/list, commands/execute, …) throws client-side before any
// network I/O — the slash-command menu and the permission preset switch die
// silently. Server-side copies (lib/index.js) are not client bundles: they keep
// the original single-segment constant and must stay untouched.
const CHANNEL_PATTERN_RULE = [
  [String.raw`/^\/[A-Za-z0-9._~-]+$/`, String.raw`/^\/[A-Za-z0-9._~\/-]+$/`],
]

// 0.1.1-rc.x gates the settings/credentials RPC plane client-side: the
// connection bundle classifies the page by its own location.hostname, and a
// non-loopback page — always the case behind the fnOS gateway, where the app
// lives at http://<nas-lan-ip>/app/dsh — builds every settings consumer in
// "memory" mode, so no settings.* RPC is ever sent and the Models page dies
// with "settings are unavailable in this browser". location is browser-
// internal state no proxy can rewrite, and behind the relay every browser
// request terminates on loopback behind an admin-gated gateway, which makes
// the page loopback-equivalent — so the classification is pinned to true.
// Server-side copies (lib/index.js) must stay untouched: their Host-header
// fence is what the relay satisfies by rewriting Host/Origin.
const LOOPBACK_RULE = [
  [
    'isLoopback: pageLocation === void 0 || isLoopbackHostname(pageLocation.hostname),',
    'isLoopback: true,',
  ],
]

// dshmarket's client-bundle rewrites (the "/dsh-market/…" panel RPC routes
// and the raw.githubusercontent.com/github.com avatar CDN fetches) used to be
// baked here in the vendored era. The market now installs ONLINE at first
// boot, so its client arrives at run time — those rules live in the relay
// (src/app/bin/relay.mjs JS_RULES) and apply to any /plugins/* javascript.

const ruleSetsFor = (file) =>
  file.endsWith('.webmanifest')
    ? [TEXT_RULES, MANIFEST_RULES]
    : [TEXT_RULES, CHANNEL_PATTERN_RULE, LOOPBACK_RULE]

/** Collect the ./client export target(s) of one package exports map. */
function clientExportTargets(exportsMap) {
  const entry = exportsMap?.['./client']
  if (entry === undefined) return []
  const values = []
  const visit = (node) => {
    if (typeof node === 'string') values.push(node)
    else if (node !== null && typeof node === 'object') for (const key of Object.keys(node)) visit(node[key])
  }
  visit(entry)
  return values.filter((value) => value.endsWith('.js') && !value.endsWith('.js.map'))
}

/** All on-disk web client bundles declared by installed packages (any scope). */
function discoverClientBundles() {
  const bundles = []
  const probe = (dir, name) => {
    const pkgFile = path.join(dir, name, 'package.json')
    if (!fs.existsSync(pkgFile)) return
    const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'))
    const decl = pkg.dsh?.client
    if (decl?.platform !== 'web') return
    for (const rel of clientExportTargets(pkg.exports)) {
      const file = path.join(dir, name, rel)
      if (fs.existsSync(file)) bundles.push(file)
    }
  }
  // Scoped (@deepseek-ai/*, @dsh-market/*) and top-level packages alike:
  // discovery is driven by the dsh.client declaration, not by who published
  // the package. .bin and dotfiles have no package.json probe hits.
  for (const entry of fs.readdirSync(runtime, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    if (entry.name.startsWith('@')) {
      const scopeDir = path.join(runtime, entry.name)
      for (const name of fs.readdirSync(scopeDir)) probe(scopeDir, name)
    } else {
      probe(runtime, entry.name)
    }
  }
  return bundles
}

const report = []
function rewriteFile(file, ruleSets) {
  const original = fs.readFileSync(file, 'utf8')
  let out = original
  const hits = []
  for (const rules of ruleSets) {
    for (const [from, to] of rules) {
      const count = out.split(from).length - 1
      if (count > 0) {
        out = out.replaceAll(from, to)
        hits.push({ from, count })
      }
    }
  }
  if (out !== original) {
    fs.writeFileSync(file, out)
    report.push({ file, hits })
  }
}

function walk(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, files)
    else if (/\.(html|js|css|webmanifest)$/.test(entry.name)) files.push(full)
  }
  return files
}

// --- rewrite ----------------------------------------------------------------

const clientBundles = discoverClientBundles()
const failures = []

// Same-version rebuilds re-run this script over an already-rewritten tree,
// where the patterns below no longer match and the count gates would fail.
// Detect that state by the patched forms themselves and skip. The widened
// channel pattern and the pinned loopback flag must be present too, so a tree
// rewritten before either rule existed still receives the missing patch.
{
  const htmlNow = fs.readFileSync(path.join(dist, 'index.html'), 'utf8')
  const connBundle = clientBundles.find((file) => file.includes('dsh-client-connection'))
  const jsNow = connBundle === undefined ? '' : fs.readFileSync(connBundle, 'utf8')
  if (
    htmlNow.includes(`"${prefix}/assets/`) &&
    !htmlNow.includes('manifest.webmanifest') &&
    jsNow.includes(`"${prefix}/api`) &&
    jsNow.includes(CHANNEL_PATTERN_RULE[0][1]) &&
    !jsNow.includes(LOOPBACK_RULE[0][0])
  ) {
    console.log('Runtime already carries the gateway prefix; rewrite skipped.')
    process.exit(0)
  }
}

for (const file of walk(dist)) rewriteFile(file, ruleSetsFor(file))
for (const file of clientBundles) rewriteFile(file, ruleSetsFor(file))

// --- verification -----------------------------------------------------------

// Strip the manifest <link> after the text rules have run, so the regex sees
// the prefixed href as well as the original. Gated like every other rule: a
// zero-match on a tree that still references the manifest means upstream
// changed the tag and this step silently stopped working, which must fail
// the build. An absent link with no manifest reference at all is a previous
// pass's strip — idempotent re-runs must not fail on it.
{
  const file = path.join(dist, 'index.html')
  const html = fs.readFileSync(file, 'utf8')
  const stripped = html.replace(MANIFEST_LINK, '')
  if (stripped === html) {
    if (html.includes('manifest.webmanifest')) failures.push('index.html: manifest <link> not found — upstream tag format changed')
  } else fs.writeFileSync(file, stripped)
}

const html = fs.readFileSync(path.join(dist, 'index.html'), 'utf8')
if (!html.includes(`"${prefix}/assets/`)) failures.push('index.html: no /assets/ rewrite landed')

const connectionBundle = clientBundles.find((file) => file.includes('dsh-client-connection'))
if (connectionBundle === undefined) {
  failures.push('dsh-client-connection client bundle not discovered — package layout changed')
} else {
  const contents = fs.readFileSync(connectionBundle, 'utf8')
  if (!contents.includes(`"${prefix}/api`)) {
    failures.push('dsh-client-connection client bundle: no /api rewrite landed')
  }
  if (!contents.includes(CHANNEL_PATTERN_RULE[0][1])) {
    failures.push('dsh-client-connection client bundle: channel pattern not widened for the multi-segment prefix (generic RPC would throw client-side)')
  }
  // Family marker, looser than the rule's exact `from`: any surviving shape
  // of the page-location classification (upstream renamed a local, the rule
  // stopped matching) means the settings plane is dead behind the gateway.
  // Absent entirely in much older upstreams, which is not a failure.
  if (contents.includes('isLoopbackHostname(pageLocation.hostname)')) {
    failures.push('dsh-client-connection client bundle: page-location loopback classification not pinned (settings would be unavailable behind the gateway)')
  }
}

// No root-absolute escapes may remain in anything we rewrote.
for (const { file } of report) {
  const contents = fs.readFileSync(file, 'utf8')
  for (const rules of ruleSetsFor(file)) {
    for (const [from] of rules) {
      if (contents.includes(from)) failures.push(`${path.relative(root, file)} still contains unrewritten ${from}`)
    }
  }
}

let total = 0
for (const { file, hits } of report) {
  for (const { count } of hits) total += count
  console.log(`${path.relative(root, file)}`)
  for (const { from, count } of hits) console.log(`  ${count}\t${from}`)
}
console.log(`Rewrote ${total} references across ${report.length} files (${clientBundles.length} client bundles scanned).`)

if (failures.length > 0) {
  console.error('\nRewrite verification FAILED:')
  for (const failure of failures) console.error(`  - ${failure}`)
console.error('\nThe pinned dsh release emits URLs this script does not recognize.')
console.error('Inspect the client bundles, adjust the rule sets, and re-run.')
  process.exit(1)
}
console.log('Verification passed.')

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
// 0.1.5-rc.x prepended a `transport?.ownsHost === true` clause to the same
// expression (and kept the trailing comma) — the pin still covers it, since
// browser requests all terminate on the relay either way. Server-side copies
// (lib/index.js) must stay untouched: their Host-header fence is what the
// relay satisfies by rewriting Host/Origin.
const LOOPBACK_RULE = [
  [
    'isLoopback: transport?.ownsHost === true || pageLocation === void 0 || isLoopbackHostname(pageLocation.hostname),',
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

// --- fnOS authorized-directory virtual browsing (directory picker) -----------
// fnOS volumes mount with trimacl: a「配置访问权限」grant gives the app user
// read/write inside the granted directory (kernel-enforced) but only traverse
// (--x) on the ancestor layers — opendir there always fails with EACCES, and
// posix ACLs are NOT executed on trimacl volumes, so the listing right cannot
// be granted with setfacl/chmod (fn-native-moviepilot proved this across
// three releases). The picker host backend below is therefore patched to
// synthesize the next hop of the granted chain whenever a listing dies on
// permissions. The grant list (DSH_ACCESSIBLE_PATHS_FILE →
// $TRIM_PKGVAR/accessible-paths, written by cmd/config_callback from
// TRIM_DATA_ACCESSIBLE_PATHS) is re-read on every listing, so authorization
// changes apply without a restart. Absent list / no grant under the path →
// upstream behavior stands.
const pickerPath = path.join(
  runtime, '@deepseek-ai', 'dsh-host-directory-picker-browse', 'lib', 'index.js'
)
const pickerMarker = 'fnosGrantHopRows'
const pickerFilterMarker = 'fnosRowEnterable'
const pickerAlreadyPatched = () =>
  fs.existsSync(pickerPath)
  && fs.readFileSync(pickerPath, 'utf8').includes(pickerMarker)
  && fs.readFileSync(pickerPath, 'utf8').includes(pickerFilterMarker)

const PICKER_IMPORT_ANCHOR =
  'import { mkdir, opendir, stat } from "node:fs/promises";'
const PICKER_DOC_ANCHOR =
  '/** The `ctx.directoryPicker` browse implementation (stable capability object per service life). */'
const PICKER_TRUNCATED_ANCHOR = '\t\tlet truncated = evicted;'
const PICKER_ROW_ANCHOR = [
  '\t\t\tconst row = await directoryRow(target, candidate.name, candidate.isDirectory, candidate.isSymbolicLink, signal);',
  '\t\t\tif (row === null) continue;',
].join('\n')
const PICKER_CATCH_ANCHOR = [
  '\t\t} catch (error) {',
  '\t\t\tsignal?.throwIfAborted();',
  '\t\t\tthrow new DirectoryPickerError("directory-unreadable", target, `cannot list ${target}: ${messageOf(error)}`);',
  '\t\t}',
].join('\n')
const PICKER_EXPORT_ANCHOR =
  'export { boundedInsert, BrowseDirectoryPicker as default, fullyQualified, raceAbort };'
// Tab-indented to match the file; exported for the contract test
// (scripts/test-picker-grant-hops.mjs).
const PICKER_HOPS_FN = [
  '/**',
  '* fnOS trimacl volumes leave the ancestor layers of a 配置访问权限 grant',
  '* traverse-only (--x): opendir there fails with EACCES, so the picker can',
  '* never walk down to the granted directory. These fn-native packaging shims',
  '* consult the DSH_ACCESSIBLE_PATHS_FILE grant list (one absolute path per',
  '* line, maintained by cmd/config_callback and re-read on every listing, so',
  '* authorization changes apply without a restart).',
  '*/',
  'function fnosGrantRoots() {',
  '\tconst grantsFile = process.env.DSH_ACCESSIBLE_PATHS_FILE;',
  '\tif (!grantsFile) return [];',
  '\tlet raw;',
  '\ttry {',
  '\t\traw = readFileSync(grantsFile, "utf8");',
  '\t} catch {',
  '\t\treturn [];',
  '\t}',
  '\tconst roots = [];',
  '\tfor (let line of raw.split("\\n")) {',
  '\t\tline = line.trim();',
  '\t\tif (!line.startsWith("/")) continue;',
  '\t\troots.push(line.length > 1 && line.endsWith("/") ? line.slice(0, -1) : line);',
  '\t}',
  '\treturn roots;',
  '}',
  '/**',
  '* Rows for the next hops of the granted chains under target, or null when',
  '* no grant lives there (the upstream unreadable-directory error stands).',
  '*/',
  'function fnosGrantHopRows(target) {',
  '\tconst base = target.length > 1 && target.endsWith("/") ? target.slice(0, -1) : target;',
  '\tconst prefix = base === "/" ? "/" : base + "/";',
  '\tconst hops = new Set();',
  '\tfor (const root of fnosGrantRoots()) {',
  '\t\tif (!root.startsWith(prefix)) continue;',
  '\t\tconst hop = root.slice(prefix.length).split("/")[0];',
  '\t\tif (hop !== "") hops.add(hop);',
  '\t}',
  '\tif (hops.size === 0) return null;',
  '\treturn [...hops].sort((left, right) => left.localeCompare(right)).map((hop) => ({',
  '\t\tname: hop,',
  '\t\tpath: base === "/" ? "/" + hop : base + "/" + hop,',
  '\t\thidden: hop.startsWith(".")',
  '\t}));',
  '}',
  '/**',
  '* Whether a listed directory row should stay visible: fnOS grants rarely',
  '* cover a whole level, so real listings are full of directories this app',
  '* cannot open — hide them instead of offering rows that error on click.',
  '* Directories on the chain TOWARD a granted directory are exempt: they are',
  '* traverse-only by design (the hop synthesis handles their listing), so the',
  '* access probe would wrongly hide the only path down to the grant.',
  '*/',
  'async function fnosRowEnterable(rowPath, roots) {',
  '\tfor (const root of roots) {',
  '\t\tif (root === rowPath || root.startsWith(rowPath.endsWith("/") ? rowPath : rowPath + "/")) return true;',
  '\t}',
  '\ttry {',
  '\t\tawait access(rowPath, constants.R_OK | constants.X_OK);',
  '\t\treturn true;',
  '\t} catch {',
  '\t\treturn false;',
  '\t}',
  '}',
  '',
  '',
].join('\n')

function patchPickerGrants(failures) {
  if (!fs.existsSync(pickerPath)) {
    failures.push(
      'dsh-host-directory-picker-browse/lib/index.js not found — upstream layout changed, the authorized-directory browsing patch needs a new anchor'
    )
    return
  }
  if (pickerAlreadyPatched()) {
    report.push({ file: pickerPath, hits: [{ from: 'fnos grant shims (already present)', count: 0 }] })
    return
  }
  const original = fs.readFileSync(pickerPath, 'utf8')
  const replacements = [
    [PICKER_IMPORT_ANCHOR, [
      'import { access, mkdir, opendir, stat } from "node:fs/promises";',
      'import { constants, readFileSync } from "node:fs";',
    ].join('\n')],
    [PICKER_DOC_ANCHOR, PICKER_HOPS_FN + PICKER_DOC_ANCHOR],
    [PICKER_CATCH_ANCHOR, PICKER_CATCH_ANCHOR.replace(
      '\t\t\tthrow new DirectoryPickerError("directory-unreadable", target, `cannot list ${target}: ${messageOf(error)}`);',
      [
        '\t\t\tconst fnosHops = fnosGrantHopRows(target);',
        '\t\t\tif (fnosHops !== null) return {',
        '\t\t\t\tpath: target,',
        '\t\t\t\thome,',
        '\t\t\t\tcrumbs: ancestryCrumbs(target),',
        '\t\t\t\tentries: fnosHops,',
        '\t\t\t\ttruncated: false',
        '\t\t\t};',
        '\t\t\tthrow new DirectoryPickerError("directory-unreadable", target, `cannot list ${target}: ${messageOf(error)}`);',
      ].join('\n')
    )],
    [PICKER_TRUNCATED_ANCHOR, [
      PICKER_TRUNCATED_ANCHOR,
      '\t\tconst fnosRoots = fnosGrantRoots();',
    ].join('\n')],
    [PICKER_ROW_ANCHOR, [
      PICKER_ROW_ANCHOR,
      '\t\t\tif (!await fnosRowEnterable(row.path, fnosRoots)) continue;',
    ].join('\n')],
    [PICKER_EXPORT_ANCHOR, PICKER_EXPORT_ANCHOR.replace(
      'fullyQualified, raceAbort };',
      'fnosGrantHopRows, fnosGrantRoots, fnosRowEnterable, fullyQualified, raceAbort };'
    )],
  ]
  let out = original
  const hits = []
  for (const [from, to] of replacements) {
    const count = out.split(from).length - 1
    if (count !== 1) {
      failures.push(
        `dsh-host-directory-picker-browse: anchor matched ${count} times (expected 1): ${JSON.stringify(from.slice(0, 70))}…`
      )
      return
    }
    out = out.replace(from, to)
    hits.push({ from: from.slice(0, 50), count })
  }
  fs.writeFileSync(pickerPath, out)
  report.push({ file: pickerPath, hits })
}

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
// channel pattern, the pinned loopback flag and the picker grant patch must
// be present too, so a tree rewritten before any of those rules existed
// still receives the missing patch.
{
  const htmlNow = fs.readFileSync(path.join(dist, 'index.html'), 'utf8')
  const connBundle = clientBundles.find((file) => file.includes('dsh-client-connection'))
  const jsNow = connBundle === undefined ? '' : fs.readFileSync(connBundle, 'utf8')
  if (
    // 0.1.5-rc.x shells reference assets relatively ("./assets/…"); older
    // shells carried the rewritten root-absolute form. Both mean done.
    (htmlNow.includes(`"${prefix}/assets/`) || htmlNow.includes('"./assets/')) &&
    !htmlNow.includes('manifest.webmanifest') &&
    jsNow.includes(`"${prefix}/api`) &&
    jsNow.includes(CHANNEL_PATTERN_RULE[0][1]) &&
    !jsNow.includes(LOOPBACK_RULE[0][0]) &&
    pickerAlreadyPatched()
  ) {
    console.log('Runtime already carries the gateway prefix; rewrite skipped.')
    process.exit(0)
  }
}

for (const file of walk(dist)) rewriteFile(file, ruleSetsFor(file))
for (const file of clientBundles) rewriteFile(file, ruleSetsFor(file))
patchPickerGrants(failures)

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
// 0.1.5-rc.x ships shell assets by relative specifier ("./assets/…"), which
// the browser resolves against the already-prefixed document URL — no rewrite
// wanted. The legacy root-absolute form must carry the gateway prefix instead.
// Either shape is acceptable; neither means the shell would load assets from
// outside the gateway and 404 at the fnOS layer.
if (!html.includes('"./assets/') && !html.includes(`"${prefix}/assets/`))
  failures.push('index.html: no /assets/ rewrite landed')

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

// The picker grant patch must be wired, not just present: the list() catch
// arm has to consult the hop builder before throwing the unreadable error,
// and the row loop has to filter inaccessible directories.
if (fs.existsSync(pickerPath)) {
  const pickerContents = fs.readFileSync(pickerPath, 'utf8')
  if (!pickerContents.includes('const fnosHops = fnosGrantHopRows(target);')) {
    failures.push('dsh-host-directory-picker-browse: authorized-directory hop synthesis not wired into list() (grant browsing would stay broken)')
  }
  if (!pickerContents.includes('if (!await fnosRowEnterable(row.path, fnosRoots)) continue;')) {
    failures.push('dsh-host-directory-picker-browse: inaccessible-row filtering not wired into list() (dead rows would still show)')
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

/**
 * Contract test for the relay's runtime plugin-JS rewriting: client bundles
 * served under /plugins/ (the market and any online-installed plugin) get
 * their root-absolute routes prefixed with the gateway prefix and their
 * GitHub CDN fetches routed through the acceleration proxy — while core
 * assets, non-JS plugin files, and lookalike paths stay untouched.
 *
 * Plain node, no deps:    node scripts/test-relay-js-rewrite.mjs
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
const relayBin = path.join(repo, 'src', 'app', 'bin', 'relay.mjs')
const backendPort = 13101
const relayPort = 13102
const prefix = '/app/dsh'

// A bundle mixing everything the rules must and must not touch.
const pluginBody = [
  'fetch("/dsh-market/status")',
  "fetch('/dsh-market/install')",
  'fetch(`/dsh-market/update`)',
  'fetch("/api/events.mux")',
  'fetch("/plugins/other/client.js")',
  'fetch(`/assets/langs/zh.js`)',           // runtime plugins: prefixed too
  'fetch(`/https://raw.githubusercontent.com/o/r/main/README.md`)',
  'fetch(`https://raw.githubusercontent.com/o/r/main/README.md`)',
  'fetch(`https://github.com/${encodeURIComponent(owner)}.png?size=96`)',
  // must stay untouched:
  'fetch("/apis/v2/thing")',                // lookalike path
  'fetch("https://api.example.com/x")',     // absolute URL
  'fetch("relative/thing.js")',             // relative specifier
  'fetch("/app/dsh/plugins/already/client.js")', // idempotency
].join('\n')

const backend = http.createServer((req, res) => {
  if (req.url === '/plugins/dshmarket/client.js') {
    res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8' })
    res.end(pluginBody)
  } else if (req.url === '/plugins/dshmarket/style.css') {
    res.writeHead(200, { 'content-type': 'text/css' })
    res.end(pluginBody)
  } else {
    res.writeHead(200, { 'content-type': 'application/javascript' })
    res.end(pluginBody)
  }
})
await new Promise((resolve) => backend.listen(backendPort, '127.0.0.1', resolve))

const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-relay-js-'))

function startRelay(port, extraArgs) {
  const child = spawn(process.execPath, [
    relayBin, '--tcp-port', String(port), '--target', `127.0.0.1:${backendPort}`,
    '--prefix', prefix, ...extraArgs,
  ], { stdio: ['ignore', 'pipe', 'pipe'] })
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`relay on ${port} did not start`)), 10_000)
    child.stderr.on('data', (chunk) => {
      if (String(chunk).includes('listening on')) { clearTimeout(timer); resolve(child) }
    })
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`relay on ${port} exited: ${code}`)) })
  })
}
const relayDefault = await startRelay(relayPort, ['--restart-flag', path.join(tmpdir, 'flag')])

async function getBody(pathname) {
  const res = await fetch(`http://127.0.0.1:${relayPort}${pathname}`, { headers: { 'x-trim-isadmin': 'true' } })
  return res.text()
}

const failures = []
const check = (name, ok) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`)
  if (!ok) failures.push(name)
}

const js = await getBody(`${prefix}/plugins/dshmarket/client.js`)
check('plugin js: "/dsh-market/ prefixed', js.includes(`fetch("${prefix}/dsh-market/status")`))
check("plugin js: '/dsh-market/ prefixed", js.includes(`fetch('${prefix}/dsh-market/install')`))
check('plugin js: `/dsh-market/ prefixed', js.includes(`fetch(\`${prefix}/dsh-market/update\`)`))
check('plugin js: "/api/ prefixed', js.includes(`fetch("${prefix}/api/events.mux")`))
check('plugin js: "/plugins/ prefixed', js.includes(`fetch("${prefix}/plugins/other/client.js")`))
check('plugin js: `/assets/ prefixed', js.includes(`fetch(\`${prefix}/assets/langs/zh.js\`)`))
check('plugin js: raw.githubusercontent via proxy', js.includes('`https://gh-proxy.com/https://raw.githubusercontent.com/o/r/main/README.md`'))
check('plugin js: avatar via proxy avatar host', js.includes('`https://gh-proxy.com/https://avatars.githubusercontent.com/${encodeURIComponent(owner)}?size=96`'))
check('plugin js: lookalike "/apis/v2 untouched', js.includes('fetch("/apis/v2/thing")'))
check('plugin js: absolute https URL untouched', js.includes('fetch("https://api.example.com/x")'))
check('plugin js: relative specifier untouched', js.includes('fetch("relative/thing.js")'))
check('plugin js: already-prefixed stays single-prefixed', js.includes('fetch("/app/dsh/plugins/already/client.js")') && !js.includes(`${prefix}${prefix}`))
check('plugin js: `/https://raw lookalike untouched', js.includes('fetch(`/https://raw.githubusercontent.com/o/r/main/README.md`)'))

const css = await getBody(`${prefix}/plugins/dshmarket/style.css`)
check('plugin css body untouched', css === pluginBody)

const core = await getBody(`${prefix}/assets/app.js`)
check('core asset path untouched (build-time rewrite owns it)', core === pluginBody)

// --gh-proxy off disables the CDN rewrites only; path prefixes remain.
const relayOff = await startRelay(relayPort + 1, ['--gh-proxy', 'off'])
const offRes = await fetch(`http://127.0.0.1:${relayPort + 1}${prefix}/plugins/dshmarket/client.js`, { headers: { 'x-trim-isadmin': 'true' } })
const offJs = await offRes.text()
check('gh-proxy off: CDN URLs untouched', offJs.includes('`https://raw.githubusercontent.com/o/r/main/README.md`'))
check('gh-proxy off: path prefixes still applied', offJs.includes(`fetch("${prefix}/dsh-market/status")`))

for (const child of [relayDefault, relayOff]) {
  child.on('exit', () => {})
  child.kill('SIGTERM')
}
backend.close()
backend.closeAllConnections?.()
fs.rmSync(tmpdir, { recursive: true, force: true })

if (failures.length > 0) {
  console.error(`relay js rewrite: ${failures.length} check(s) failed`)
  process.exit(1)
}
console.log('relay js rewrite: all checks passed')

/**
 * Contract test for the relay's market-restart interception (relay.mjs
 * --restart-flag): the market client POSTs <prefix>/dsh-market/restart and
 * accepts a bare "202 {ok:true}"; the relay must answer that itself, touch
 * the flag file for the supervisor, and never forward the request — while
 * every other /dsh-market/* request (and a relay started without the flag)
 * keeps flowing to the backend untouched.
 *
 * Plain node, no deps:    node scripts/test-relay-restart-intercept.mjs
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
const relayBin = path.join(repo, 'src', 'app', 'bin', 'relay.mjs')
const backendPort = 13091
const relayPortA = 13092 // with --restart-flag
const relayPortB = 13093 // without (legacy/local-test pass-through)
const prefix = '/app/dsh'

const seen = []
const backend = http.createServer((req, res) => {
  let body = ''
  req.on('data', (chunk) => { body += chunk })
  req.on('end', () => {
    seen.push({ method: req.method, url: req.url, host: req.headers.host })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ boot: 'test-boot-1', echoed: body }))
  })
})
await new Promise((resolve) => backend.listen(backendPort, '127.0.0.1', resolve))

const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-relay-restart-'))
const flagFile = path.join(tmpdir, 'restart-web')

const relays = []
function startRelay(port, extraArgs) {
  const child = spawn(process.execPath, [
    relayBin, '--tcp-port', String(port), '--target', `127.0.0.1:${backendPort}`,
    '--prefix', prefix, ...extraArgs,
  ], { stdio: ['ignore', 'pipe', 'pipe'] })
  relays.push(child)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`relay on ${port} did not start`)), 10_000)
    child.stderr.on('data', (chunk) => {
      if (String(chunk).includes('listening on')) { clearTimeout(timer); resolve() }
    })
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`relay on ${port} exited: ${code}`)) })
  })
}
await startRelay(relayPortA, ['--restart-flag', flagFile])
await startRelay(relayPortB, [])

async function post(port, pathname, admin) {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(admin ? { 'x-trim-isadmin': 'true' } : {}) },
    body: '{}',
  })
  const text = await res.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    body = { raw: text }
  }
  return { status: res.status, body }
}
async function get(port, pathname) {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, { headers: { 'x-trim-isadmin': 'true' } })
  return { status: res.status, body: await res.text() }
}

const failures = []
const check = (name, ok) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`)
  if (!ok) failures.push(name)
}

// 1. The restart POST is intercepted: 202 {ok:true}, flag written, backend untouched.
seen.length = 0
const r1 = await post(relayPortA, `${prefix}/dsh-market/restart`, true)
check('restart POST -> 202', r1.status === 202)
check('restart POST body {ok:true}', r1.body.ok === true)
check('restart flag file written', fs.existsSync(flagFile))
check('backend saw nothing', seen.length === 0)

// 2. Non-admin gets the 403 long before any restart machinery.
fs.rmSync(flagFile, { force: true })
const r2 = await post(relayPortA, `${prefix}/dsh-market/restart`, false)
check('non-admin restart POST -> 403', r2.status === 403)
check('no flag for non-admin', !fs.existsSync(flagFile))
check('backend still untouched', seen.length === 0)

// 3. Other market traffic (the status poll the client uses while waiting)
//    forwards with the prefix stripped and the fence host applied.
const r3 = await post(relayPortA, `${prefix}/dsh-market/status`, true)
check('status POST forwards -> 200 boot json', r3.status === 200 && r3.body.boot === 'test-boot-1')
check('status forwarded to backend path', seen.some((s) => s.method === 'POST' && s.url === '/dsh-market/status'))
check('status forwarded with fence host', seen.some((s) => s.host === `127.0.0.1:${backendPort}`))

// 4. Method matters: GET on the restart path is not the RPC and forwards.
const r4 = await get(relayPortA, `${prefix}/dsh-market/restart`)
check('GET restart path forwards (not intercepted)', seen.some((s) => s.method === 'GET' && s.url === '/dsh-market/restart'))

// 5. Without --restart-flag the POST forwards (local-test/legacy behavior).
fs.rmSync(flagFile, { force: true })
const r5 = await post(relayPortB, `${prefix}/dsh-market/restart`, true)
check('no-flag relay forwards the restart POST', seen.some((s) => s.method === 'POST' && s.url === '/dsh-market/restart'))
check('no flag file created by pass-through', !fs.existsSync(flagFile))

await Promise.all(relays.map((child) => new Promise((resolve) => {
  child.on('exit', resolve)
  child.kill('SIGTERM')
  setTimeout(resolve, 3000).unref?.()
})))
backend.close()
backend.closeAllConnections?.()
fs.rmSync(tmpdir, { recursive: true, force: true })

if (failures.length > 0) {
  console.error(`relay restart intercept: ${failures.length} check(s) failed`)
  process.exit(1)
}
console.log('relay restart intercept: all checks passed')

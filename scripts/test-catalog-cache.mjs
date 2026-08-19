/**
 * Local contract test for src/app/bin/catalog-cache.mjs (no device needed):
 * cold fetch, 304 revalidation, background refresh, origin-down resilience,
 * serving from disk across restarts, and 503 when cold with a dead origin.
 * Run: node scripts/test-catalog-cache.mjs
 */
import http from 'node:http'
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const cacheBin = path.join(root, 'src', 'app', 'bin', 'catalog-cache.mjs')
const tmp = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TEMP ?? '/tmp'), 'market-cache-test-'))
let failures = 0

const ok = (label, cond) => {
  if (cond) return
  failures += 1
  console.error(`FAIL: ${label}`)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const freePort = () =>
  new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
    probe.on('error', reject)
  })

// --- fake origin -----------------------------------------------------------
const originPort = await freePort()
const catalogV1 = { name: 'awesome-dsh-plugin', updated: '2026-08-18', plugins: [{ name: 'one' }] }
const catalogV2 = { name: 'awesome-dsh-plugin', updated: '2026-08-19', plugins: [{ name: 'one' }, { name: 'two' }] }
let originBody = catalogV1
let originEtag = '"v1"'
let originHealthy = true
const originUrl = `http://127.0.0.1:${originPort}/plugins.json`
const originServer = http
  .createServer((req, res) => {
    if (!originHealthy) {
      res.writeHead(503, { 'content-type': 'text/plain' }).end('origin down')
      return
    }
    if (req.headers['if-none-match'] === originEtag) {
      res.writeHead(304, { etag: originEtag }).end()
      return
    }
    res.writeHead(200, { 'content-type': 'application/json', etag: originEtag }).end(JSON.stringify(originBody))
  })
  .listen(originPort, '127.0.0.1')

// --- cache server lifecycle ------------------------------------------------
const cachePort = await freePort()
const cacheDir = path.join(tmp, 'cache')
const startCache = () =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      cacheBin, '--port', String(cachePort), '--origin', originUrl, '--cache-dir', cacheDir,
      '--min-refresh-ms', '300', '--origin-timeout-ms', '5000', '--cold-wait-ms', '2000',
    ], { stdio: ['ignore', 'pipe', 'pipe'] })
    child.stderr.on('data', (d) => process.stderr.write(`[cache] ${d}`))
    child.on('exit', (code) => { if (code !== 0 && !child.killed) reject(new Error(`cache exited ${code}`)) })
    const poll = async () => {
      for (let i = 0; i < 60; i += 1) {
        try {
          const res = await fetch(`http://127.0.0.1:${cachePort}/healthz`)
          if (res.ok) return resolve(child)
        } catch {}
        await sleep(250)
      }
      reject(new Error('cache never became healthy'))
    }
    void poll()
  })

const get = (headers) => fetch(`http://127.0.0.1:${cachePort}/plugins.json`, { headers })
// Wait until a plain GET returns a body whose "updated" field equals `updated`.
const pollFor = async (updated, label) => {
  for (let i = 0; i < 40; i += 1) {
    const res = await get()
    if (res.ok) {
      const data = await res.json()
      if (data.updated === updated) return { res, data }
    }
    await sleep(250)
  }
  throw new Error(`never observed catalog ${label}`)
}

let cache = await startCache()

// Cold start: first GET waits for the background first fetch, answers v1+etag.
{
  const { res, data } = await pollFor('2026-08-18', 'v1')
  ok('cold GET serves the fetched catalog', data.plugins.length === 1)
  ok('cold GET passes the etag through', res.headers.get('etag') === '"v1"')
}
// Revalidation: same validator earns a 304, like dshmarket's memo sends.
{
  const res = await get({ 'if-none-match': '"v1"' })
  ok('matching validator gets 304', res.status === 304)
}
// Background refresh: origin moves to v2; after the refresh interval the
// served copy follows (the stale answer comes first by design).
originBody = catalogV2
originEtag = '"v2"'
{
  const { res, data } = await pollFor('2026-08-19', 'v2')
  ok('refreshed catalog is served', data.plugins.length === 2)
  ok('new etag is served', res.headers.get('etag') === '"v2"')
  const stale = await get({ 'if-none-match': '"v1"' })
  ok('stale validator gets a full 200', stale.status === 200 && (await stale.json()).updated === '2026-08-19')
}
// Origin down: the cache keeps serving the last good copy; the failing
// background refresh must never leak into the panel answer.
originHealthy = false
{
  await sleep(700) // past the refresh interval: a refresh attempt runs and fails
  const res = await get()
  ok('origin down still serves the cached copy', res.status === 200 && (await res.json()).updated === '2026-08-19')
  const res304 = await get({ 'if-none-match': '"v2"' })
  ok('origin down still honors 304', res304.status === 304)
}
// Restart with the origin still down: the disk cache IS the fast path now.
cache.kill()
await sleep(500)
cache = await startCache()
{
  const res = await get()
  ok('after restart the disk cache serves immediately', res.status === 200)
  const data = await res.json()
  ok('disk copy is the last good catalog', data.updated === '2026-08-19')
}
// Cold cache + dead origin: bounded 503, the retryable dshmarket error path.
fs.rmSync(cacheDir, { recursive: true, force: true })
cache.kill()
await sleep(500)
cache = await startCache()
{
  const started = Date.now()
  const res = await get()
  ok('cold with dead origin is 503', res.status === 503)
  ok('cold 503 respects the wait bound', Date.now() - started < 10_000)
}

cache.kill()
originServer.close()
fs.rmSync(tmp, { recursive: true, force: true })
if (failures === 0) {
  console.log('catalog-cache: all checks passed')
} else {
  console.error(`${failures} check(s) failed`)
  process.exit(1)
}

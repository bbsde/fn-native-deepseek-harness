/**
 * Loopback stale-while-revalidate cache for the market's plugin catalog.
 *
 * dshmarket revalidates its catalog (awesome-dsh-plugin.com, ~1.25 MB JSON,
 * 1500+ plugins) against the origin on EVERY panel open and keeps the ETag
 * memo in memory only, so the first open after every app restart pays a full
 * download. Measured from a CN NAS: handshake fast, body throttled — the full
 * file took 12.7s / 137.9s / 80.8s across three tries against dshmarket's
 * 15s x2 budget, i.e. a timeout and a retryable error on most restarts.
 * gh-proxy cannot front the domain (non-GitHub hosts are 403) and the file
 * has no raw.githubusercontent mirror (it is a CI build artifact, the repo
 * only carries the source data), so the acceleration has to be local.
 *
 * This server binds 127.0.0.1 only; cmd/main points DSHM_REGISTRY_URL at it.
 *
 *   GET /plugins.json  the cached copy is answered immediately (304 on a
 *                      matching If-None-Match); a background refresh runs
 *                      when the copy is older than --min-refresh-ms. With no
 *                      cached copy the request waits (bounded by
 *                      --cold-wait-ms) for the in-flight first fetch and
 *                      answers 503 if it does not land in time.
 *   GET /healthz       liveness probe for cmd/main's bind check
 *
 * A fetched body only replaces the cache when it parses as a catalog (a
 * non-empty `plugins` array), so a broken origin answer never corrupts a
 * good copy. An unreachable origin leaves the stale copy served — the
 * deliberate trade-off against upstream's fail-loud catalog: on a NAS,
 * yesterday's catalog beats a 30s spinner. Upstream's install-source check
 * still runs against whatever catalog is served, unchanged.
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const readArg = (name, fallback) => {
  const index = args.indexOf(name)
  return index === -1 || index + 1 >= args.length ? fallback : args[index + 1]
}
const port = Number(readArg('--port', '3180'))
const origin = readArg('--origin', 'https://awesome-dsh-plugin.com/plugins.json')
const cacheDir = readArg('--cache-dir', '.')
const minRefreshMs = Number(readArg('--min-refresh-ms', String(5 * 60_000)))
// Generous on purpose: the observed worst full fetch was ~138s. This runs in
// the background, so the budget costs the panel nothing.
const originTimeoutMs = Number(readArg('--origin-timeout-ms', String(180_000)))
// dshmarket gives up after 15s x2; holding its second attempt longer than
// that on a cold cache buys nothing.
const coldWaitMs = Number(readArg('--cold-wait-ms', String(25_000)))

const log = (message) => console.log(`market-cache: ${message}`)
const bodyFile = path.join(cacheDir, 'plugins.json')
const metaFile = path.join(cacheDir, 'meta.json')

const readCache = () => {
  try {
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'))
    const body = fs.readFileSync(bodyFile, 'utf8')
    return { etag: meta.etag ?? null, modified: meta.modified ?? null, fetchedAt: meta.fetchedAt ?? 0, body }
  } catch {
    return null
  }
}

let cache = readCache()
if (cache !== null) {
  log(`loaded cached catalog (etag ${cache.etag ?? '?'}, ${Math.round((Date.now() - cache.fetchedAt) / 1000)}s old)`)
} else {
  log(`no cached catalog yet; first fetch from ${origin} runs in the background`)
}

let refreshing = false
const persist = () => {
  fs.mkdirSync(cacheDir, { recursive: true })
  fs.writeFileSync(`${metaFile}.tmp`, `${JSON.stringify({
    etag: cache.etag, modified: cache.modified, fetchedAt: cache.fetchedAt, origin,
  }, null, 2)}\n`)
  fs.renameSync(`${metaFile}.tmp`, metaFile)
}

const refresh = async (reason) => {
  if (refreshing) return
  refreshing = true
  try {
    const headers = {}
    // ETag first, exactly like dshmarket: exact where a date has 1s
    // resolution, and an origin handed both validators must satisfy both.
    if (cache?.etag != null) headers['if-none-match'] = cache.etag
    else if (cache?.modified != null) headers['if-modified-since'] = cache.modified
    log(`refreshing catalog (${reason})`)
    const res = await fetch(origin, { signal: AbortSignal.timeout(originTimeoutMs), headers })
    if (res.status === 304) {
      // The origin still vouches for exactly what we have; only the clock
      // moves, so the refresh throttle keeps working across restarts.
      cache = { ...cache, fetchedAt: Date.now() }
      persist()
      log('origin confirms the cached catalog (304)')
      return
    }
    if (!res.ok) {
      log(`origin answered HTTP ${res.status}; keeping the cached copy`)
      return
    }
    const body = await res.text()
    const data = JSON.parse(body)
    if (!Array.isArray(data.plugins) || data.plugins.length === 0) {
      log('origin answer is not a catalog (no plugins array); keeping the cached copy')
      return
    }
    const next = {
      etag: res.headers.get('etag'),
      modified: res.headers.get('last-modified'),
      fetchedAt: Date.now(),
      body,
    }
    fs.mkdirSync(cacheDir, { recursive: true })
    fs.writeFileSync(`${bodyFile}.tmp`, body)
    fs.renameSync(`${bodyFile}.tmp`, bodyFile)
    cache = next
    persist()
    log(`catalog refreshed (${body.length} bytes, etag ${next.etag ?? '?'})`)
  } catch (error) {
    log(`refresh failed (${error.message ?? error}); keeping the cached copy`)
  } finally {
    refreshing = false
  }
}

const server = http.createServer((req, res) => {
  if (req.method !== 'GET') {
    res.writeHead(405, { 'content-type': 'text/plain' }).end('GET only')
    return
  }
  const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
  if (pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' }).end('ok')
    return
  }
  if (pathname !== '/plugins.json') {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found')
    return
  }

  const serve = () => {
    const validator = req.headers['if-none-match']
    if (validator !== undefined && cache.etag !== null && validator === cache.etag) {
      res.writeHead(304, { etag: cache.etag }).end()
      return true
    }
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      ...(cache.etag !== null ? { etag: cache.etag } : {}),
      ...(cache.modified !== null ? { 'last-modified': cache.modified } : {}),
    })
    res.end(cache.body)
    return true
  }

  if (cache !== null) {
    if (serve() && Date.now() - cache.fetchedAt >= minRefreshMs) {
      void refresh(`cached copy is ${Math.round((Date.now() - cache.fetchedAt) / 1000)}s old`)
    }
    return
  }
  // Cold cache: the first fetch is (or is about to be) in flight — wait for
  // it, but never longer than dshmarket's own patience.
  const started = Date.now()
  void refresh('cold start')
  const waitForFirstFetch = async () => {
    while (cache === null && Date.now() - started < coldWaitMs) {
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    if (cache !== null && serve()) return
    res.writeHead(503, { 'content-type': 'text/plain' })
    res.end('catalog not fetched yet; retry shortly')
  }
  void waitForFirstFetch()
})

server.on('error', (error) => {
  log(`server error: ${error.message}`)
  process.exit(1)
})
server.listen(port, '127.0.0.1', () => {
  log(`listening on http://127.0.0.1:${server.address().port}/plugins.json (origin ${origin})`)
  if (cache === null || Date.now() - cache.fetchedAt >= minRefreshMs) void refresh('startup')
})

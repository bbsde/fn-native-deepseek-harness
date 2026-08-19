#!/usr/bin/env node
/**
 * fnOS unified-gateway adapter for DeepSeek Harness (dsh web).
 *
 * dsh refuses to bind beyond loopback (its Web UI can execute code, and it
 * has no authentication layer of its own), so it stays on 127.0.0.1 and this
 * adapter is what the fnOS gateway talks to. For every forwarded request it:
 *
 *   - rejects anyone the gateway did not mark as an administrator
 *     (X-Trim-Isadmin); this surface is equivalent to a host shell
 *   - strips the gateway prefix (/app/dsh) from the path
 *   - rewrites Host/Origin/Referer to the loopback authority so dsh's
 *     browser-trust fence accepts the forwarded request
 *   - drops accept-encoding so responses are rewritable
 *   - prefixes the root-absolute URLs dsh injects into index.html at request
 *     time (the __DSH_BOOT__ plugin graph under /plugins/)
 *   - prefixes the root-absolute URLs inside RUNTIME-INSTALLED plugin client
 *     bundles (javascript under /plugins/, e.g. the online-installed market's
 *     "/dsh-market/…" panel RPC) and routes its GitHub CDN fetches through
 *     the acceleration proxy (--gh-proxy)
 *
 * WebSocket upgrades are proxied with the same path/header treatment.
 *
 * POST <prefix>/dsh-market/restart is intercepted (when --restart-flag is
 * given): dshmarket's own self-restart spawns a detached replacement that no
 * supervisor tracks — the app's dsh.pid goes permanently stale (the app center
 * then shows "stopped" forever) and the replacement inherits the runtime lib
 * dir as cwd. Answering with the 202 the market client expects and touching
 * the flag file lets cmd/main's supervisor perform a tracked restart instead.
 *
 * Usage:
 *   node relay.mjs --socket <path> --target 127.0.0.1:3080 --prefix /app/dsh
 *   node relay.mjs --tcp-port 13080 ...   # local testing without Unix sockets
 *
 * --test-allow-anonymous exists ONLY for local browser verification before the
 * gateway exists; it disables the admin gate and must never appear in cmd/main
 * or any production invocation.
 */

import http from 'node:http'
import fs from 'node:fs'

function arg(name, fallback) {
  const at = process.argv.indexOf(`--${name}`)
  return at !== -1 && process.argv[at + 1] !== undefined ? process.argv[at + 1] : fallback
}

const PREFIX = arg('prefix', '/app/dsh')
const SOCKET_PATH = arg('socket', '')
const TCP_PORT = Number(arg('tcp-port', '0'))
const ALLOW_ANONYMOUS = process.argv.includes('--test-allow-anonymous')
// Empty (the default, e.g. in local tests) keeps the restart POST forwarded.
const RESTART_FLAG_PATH = arg('restart-flag', '')
// Acceleration-proxy root for the market client's GitHub CDN fetches
// (READMEs, screenshots, avatars — raw.githubusercontent.com and friends do
// not resolve on CN networks). cmd/main passes its resolved github-accel
// value so the device-level override reaches this runtime rewrite; "off"
// disables the CDN rules. Must stay in sync with cmd/main's default.
const GH_PROXY_ROOT = arg('gh-proxy', 'https://gh-proxy.com/')
const TARGET = arg('target', '127.0.0.1:3080')
const colon = TARGET.lastIndexOf(':')
const BACKEND_HOST = TARGET.slice(0, colon)
const BACKEND_PORT = Number(TARGET.slice(colon + 1))
const FENCE_AUTHORITY = `127.0.0.1:${BACKEND_PORT}`
const LOOPBACK_ORIGIN = `http://${FENCE_AUTHORITY}`

// Root-absolute references the server splices into index.html per request.
// The static dist is already rewritten at build time (scripts/rewrite-dist.mjs);
// these rules cover what only exists at runtime. Already-prefixed values
// ("/app/.../plugins/") cannot match, so the rewrite is idempotent.
const HTML_RULES = [
  ['"/plugins/', `"${PREFIX}/plugins/`],
  ['"/assets/', `"${PREFIX}/assets/`],
  ['"/favicon', `"${PREFIX}/favicon`],
]

// Runtime-installed plugin client bundles (anything served under /plugins/)
// were never seen at build time, so their root-absolute URLs — panel RPC
// routes like dshmarket's "/dsh-market/…", generic "/api/…" calls — arrive
// unprefixed and would miss the gateway prefix. Same quote-anchoring trick
// as HTML_RULES keeps it idempotent: an already-prefixed value can no longer
// match. Unlike the build-time rules these carry a trailing slash on every
// path ("/api/" not "/api"): runtime bundles come from arbitrary plugins,
// and "/apis/…" or "/apiv2/…" lookalikes must not be mangled.
const JS_PATH_RULES = [
  ['"/api/', `"${PREFIX}/api/`],
  ["'/api/", `'${PREFIX}/api/`],
  ['`/api/', `\`${PREFIX}/api/`],
  ['"/assets/', `"${PREFIX}/assets/`],
  ["'/assets/", `'${PREFIX}/assets/`],
  ['`/assets/', `\`${PREFIX}/assets/`],
  ['"/plugins/', `"${PREFIX}/plugins/`],
  ["'/plugins/", `'${PREFIX}/plugins/`],
  ['`/plugins/', `\`${PREFIX}/plugins/`],
  // dshmarket's panel RPC: 22 endpoints, plain double-quoted strings
  // (verified against the 1.14.x builds; quote variants kept for safety).
  ['"/dsh-market/', `"${PREFIX}/dsh-market/`],
  ["'/dsh-market/", `'${PREFIX}/dsh-market/`],
  ['`/dsh-market/', `\`${PREFIX}/dsh-market/`],
]
// dshmarket's detail view pulls READMEs/screenshots from
// raw.githubusercontent.com and author avatars from github.com DIRECTLY in
// the browser; on CN networks those hosts do not resolve. github.com/<o>.png
// is a redirect page the proxy does not rewrite, so avatars go to the direct
// avatar host instead. Identical to the build-time rules of the vendored
// era, now applied at runtime.
// NOTE: plain quotes below on purpose — the avatar rule must match the
// LITERAL text "${encodeURIComponent(owner)}" as it appears in the bundle,
// so no template literals here.
const JS_CDN_RULES = GH_PROXY_ROOT === '' || /^(off|none)$/i.test(GH_PROXY_ROOT)
  ? []
  : [
      ['`https://raw.githubusercontent.com/', '`' + GH_PROXY_ROOT + 'https://raw.githubusercontent.com/'],
      ['`https://github.com/${encodeURIComponent(owner)}.png?size=96', '`' + GH_PROXY_ROOT + 'https://avatars.githubusercontent.com/${encodeURIComponent(owner)}?size=96'],
    ]

function rewritePluginJs(body) {
  let out = body
  for (const [from, to] of JS_PATH_RULES) out = out.replaceAll(from, to)
  for (const [from, to] of JS_CDN_RULES) out = out.replaceAll(from, to)
  return out
}

// The fnOS desktop serves this page over plain HTTP on a LAN address, which is
// not a secure context: crypto.randomUUID is undefined there and the dsh
// client bundles call it for RPC correlation IDs (e.g. the workspace picker).
// getRandomValues IS available in insecure contexts, so polyfill UUID v4 from
// it. Injected as a classic script in <head>, ahead of the deferred module
// bundles.
const SECURE_CONTEXT_POLYFILL = '<script>(function(){if(typeof crypto==="undefined"||typeof crypto.randomUUID==="function")return;'
  + 'var gen=crypto.getRandomValues?function(){var b=crypto.getRandomValues(new Uint8Array(16));'
  + 'b[6]=b[6]&15|64;b[8]=b[8]&63|128;var h="";for(var i=0;i<16;i++)h+=b[i].toString(16).padStart(2,"0");'
  + 'return h.slice(0,8)+"-"+h.slice(8,12)+"-"+h.slice(12,16)+"-"+h.slice(16,20)+"-"+h.slice(20)}'
  + ':function(){return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g,function(c){var m=Math.random()*16|0;'
  + 'return (c==="x"?m:m&3|8).toString(16)})};'
  + 'try{Object.defineProperty(crypto,"randomUUID",{value:gen,configurable:true,writable:true})}catch(e){}})();</script>'

function log(message) {
  process.stderr.write(`${new Date().toISOString()} relay: ${message}\n`)
}

function isAdmin(req) {
  if (ALLOW_ANONYMOUS) return true
  return req.headers['x-trim-isadmin'] === 'true'
}

// Map a gateway path back to what dsh serves at loopback root.
// Returns the target path with query, or null when outside the prefix.
function stripPrefix(rawUrl) {
  const parsed = new URL(rawUrl, 'http://x')
  let path = parsed.pathname
  if (path === PREFIX) path = '/'
  else if (path.startsWith(`${PREFIX}/`)) path = path.slice(PREFIX.length) || '/'
  else return null
  return path + parsed.search
}

function forwardHeaders(headers) {
  const out = { ...headers }
  out.host = FENCE_AUTHORITY
  if (out.origin !== undefined) out.origin = LOOPBACK_ORIGIN
  if (out.referer !== undefined) out.referer = `${LOOPBACK_ORIGIN}/`
  delete out['accept-encoding']
  return out
}

function rewriteHtml(body) {
  let out = body
  for (const [from, to] of HTML_RULES) out = out.replaceAll(from, to)
  const anchor = out.indexOf('<head>')
  if (anchor !== -1) return out.slice(0, anchor + 6) + SECURE_CONTEXT_POLYFILL + out.slice(anchor + 6)
  return SECURE_CONTEXT_POLYFILL + out
}

function deny(res, code, message) {
  res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8' })
  res.end(message)
}

function rawReply(socket, code, message) {
  socket.write(`HTTP/1.1 ${code} ${message}\r\ncontent-type: text/plain; charset=utf-8\r\nconnection: close\r\n\r\n${message}\n`)
  socket.destroy()
}

function serializeStatusLineAndHeaders(statusCode, statusMessage, headers) {
  let head = `HTTP/1.1 ${statusCode} ${statusMessage ?? ''}\r\n`
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue
    for (const item of Array.isArray(value) ? value : [value]) head += `${key}: ${item}\r\n`
  }
  return `${head}\r\n`
}

const server = http.createServer((req, res) => {
  if (!isAdmin(req)) {
    deny(res, 403, 'DeepSeek Harness is restricted to fnOS administrators.')
    return
  }
  const target = stripPrefix(req.url)
  if (target === null) {
    deny(res, 404, 'outside gateway prefix')
    return
  }
  // The market's self-restart button, rerouted to supervised restarts (see
  // the header comment). The client only checks "202 + ok" and then polls
  // /dsh-market/status until the boot id changes — which a tracked restart
  // satisfies within its 60s patience window.
  if (RESTART_FLAG_PATH !== '' && req.method === 'POST' && target === '/dsh-market/restart') {
    req.resume()
    try {
      fs.writeFileSync(RESTART_FLAG_PATH, `${new Date().toISOString()}\n`)
    } catch (error) {
      log(`could not write the restart flag: ${error.message}`)
      deny(res, 500, 'could not request a supervised restart')
      return
    }
    res.writeHead(202, { 'content-type': 'application/json' })
    res.end('{"ok":true}')
    return
  }
  const upstream = http.request(
    {
      host: BACKEND_HOST,
      port: BACKEND_PORT,
      method: req.method,
      path: target,
      headers: forwardHeaders(req.headers),
    },
    (upstreamRes) => {
      const type = String(upstreamRes.headers['content-type'] ?? '')
      if (type.includes('text/html')) {
        const chunks = []
        upstreamRes.on('data', (chunk) => chunks.push(chunk))
        upstreamRes.on('end', () => {
          const body = rewriteHtml(Buffer.concat(chunks).toString('utf8'))
          const headers = { ...upstreamRes.headers }
          delete headers['content-length']
          delete headers['transfer-encoding']
          res.writeHead(upstreamRes.statusCode, headers)
          res.end(body)
        })
        upstreamRes.on('error', () => res.destroy())
      } else if (type.includes('javascript') && target.startsWith('/plugins/')) {
        // Runtime-installed plugin clients need the gateway prefix baked into
        // their bundle URLs (see JS_PATH_RULES); buffer, rewrite, forward.
        const chunks = []
        upstreamRes.on('data', (chunk) => chunks.push(chunk))
        upstreamRes.on('end', () => {
          const body = rewritePluginJs(Buffer.concat(chunks).toString('utf8'))
          const headers = { ...upstreamRes.headers }
          delete headers['content-length']
          delete headers['transfer-encoding']
          res.writeHead(upstreamRes.statusCode, headers)
          res.end(body)
        })
        upstreamRes.on('error', () => res.destroy())
      } else {
        res.writeHead(upstreamRes.statusCode, upstreamRes.headers)
        upstreamRes.pipe(res)
      }
    },
  )
  upstream.on('error', (error) => {
    log(`upstream error on ${target}: ${error.message}`)
    if (!res.headersSent) deny(res, 502, 'dsh web is not reachable; try restarting the app.')
    else res.destroy()
  })
  req.pipe(upstream)
})

server.on('upgrade', (req, socket, head) => {
  if (!isAdmin(req)) {
    rawReply(socket, 403, 'Forbidden')
    return
  }
  const target = stripPrefix(req.url)
  if (target === null) {
    rawReply(socket, 404, 'Not Found')
    return
  }
  const headers = forwardHeaders(req.headers)
  headers.connection = 'Upgrade'
  headers.upgrade = req.headers.upgrade
  const upstream = http.request({
    host: BACKEND_HOST,
    port: BACKEND_PORT,
    method: 'GET',
    path: target,
    headers,
  })
  upstream.on('upgrade', (upstreamRes, upstreamSocket, upstreamHead) => {
    socket.write(serializeStatusLineAndHeaders(101, 'Switching Protocols', upstreamRes.headers))
    if (upstreamHead.length > 0) socket.write(upstreamHead)
    if (head.length > 0) upstreamSocket.write(head)
    upstreamSocket.pipe(socket)
    socket.pipe(upstreamSocket)
    const drop = () => {
      upstreamSocket.destroy()
      socket.destroy()
    }
    upstreamSocket.on('error', drop)
    socket.on('error', drop)
  })
  // Non-101 replies to an upgrade attempt (e.g. the fence rejecting).
  upstream.on('response', (upstreamRes) => {
    socket.write(serializeStatusLineAndHeaders(upstreamRes.statusCode, upstreamRes.statusMessage, upstreamRes.headers))
    upstreamRes.pipe(socket)
  })
  upstream.on('error', (error) => {
    log(`upstream upgrade error on ${target}: ${error.message}`)
    rawReply(socket, 502, 'Bad Gateway')
  })
  upstream.end()
})

function onListening() {
  const where = TCP_PORT ? `127.0.0.1:${TCP_PORT}` : SOCKET_PATH
  log(`listening on ${where}, forwarding to ${BACKEND_HOST}:${BACKEND_PORT}, prefix ${PREFIX}`)
}

if (TCP_PORT) {
  server.listen(TCP_PORT, '127.0.0.1', onListening)
} else if (SOCKET_PATH) {
  try {
    fs.unlinkSync(SOCKET_PATH)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  server.listen(SOCKET_PATH, () => {
    // The gateway process must be able to connect; default socket ownership
    // is the app user only.
    try {
      fs.chmodSync(SOCKET_PATH, 0o666)
    } catch {
      log(`could not chmod ${SOCKET_PATH}; gateway may fail to connect`)
    }
    onListening()
  })
} else {
  log('either --socket or --tcp-port is required')
  process.exit(1)
}

process.on('SIGTERM', () => {
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 5000).unref()
})

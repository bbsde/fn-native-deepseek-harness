/**
 * GitHub tarball acceleration preload. pnpm fetches git-hosted dependencies
 * as https://codeload.github.com/<owner>/<repo>/tar.gz/<sha> with a plain
 * HTTPS request — NOT through the git CLI — so the insteadOf rewrite in
 * cmd/main never sees those URLs and CN networks stall on every GitHub-
 * sourced plugin install. cmd/main loads this file via NODE_OPTIONS=--require
 * when acceleration is enabled; the rewrite then covers every Node process
 * in the app's tree (dsh, the dsh CLI wrapper, pnpm and its children).
 *
 * Only codeload tarball URLs are rewritten. Everything else passes through
 * untouched, and no rewrite failure may ever break a request.
 *
 * DSH_GH_ACCEL holds the proxy root (e.g. https://gh-proxy.com/); a full
 * insteadOf-style prefix is accepted too and normalized back to the root.
 */
const root0 = process.env.DSH_GH_ACCEL ?? ''
let root = root0
if (root.endsWith('https://github.com/')) root = root.slice(0, -'https://github.com/'.length)
if (root !== '' && !root.endsWith('/')) root += '/'
if (root !== '') {
  const rewrite = (url) => (url.startsWith('https://codeload.github.com/') ? root + url : null)

  {
    const original = globalThis.fetch
    if (typeof original === 'function') {
      globalThis.fetch = (input, init) => {
        try {
          const url = typeof input === 'string' ? input : input instanceof URL ? input.href : undefined
          const to = url === undefined ? null : rewrite(url)
          if (to !== null) input = typeof input === 'string' ? to : new URL(to)
        } catch { /* never break a fetch */ }
        return original.call(globalThis, input, init)
      }
    }
  }

  {
    const https = require('node:https')
    const originalRequest = https.request
    https.request = function (...args) {
      try {
        if (typeof args[0] === 'string') {
          const to = rewrite(args[0])
          if (to !== null) args[0] = to
        } else if (args[0] instanceof URL) {
          const to = rewrite(args[0].href)
          if (to !== null) args[0] = new URL(to)
        } else if (args[0] !== null && typeof args[0] === 'object') {
          const options = args[0]
          if (options.hostname === 'codeload.github.com' || options.host === 'codeload.github.com') {
            const parsed = new URL(root + `https://codeload.github.com${options.path ?? '/'}`)
            options.protocol = parsed.protocol
            options.hostname = parsed.hostname
            options.host = parsed.host
            options.path = `${parsed.pathname}${parsed.search}`
          }
        }
      } catch { /* never break a request */ }
      return originalRequest.apply(https, args)
    }
  }
}
module.exports = {}

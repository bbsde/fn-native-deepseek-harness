#!/usr/bin/env node
// Contract test for the base-path shim injected by src/app/bin/relay.mjs
// (BASE_PATH_SHIM_BODY). The shim's body is extracted from the relay source
// between the __DSH_BASE_SHIM__ markers, <PREFIX> is substituted, and the
// code is evaluated in a vm sandbox with stubbed browser globals; every
// wrapped API (fetch / XHR / WebSocket / EventSource / sendBeacon /
// script.src / pushState) is then asserted against the pass-through rules:
// same-origin root-absolute URLs gain the prefix, everything else
// (cross-origin, protocol-relative, already-prefixed, relative, empty) is
// untouched.
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const relaySource = fs.readFileSync(path.join(root, 'src/app/bin/relay.mjs'), 'utf8')
const START = '/*__DSH_BASE_SHIM_START__*/'
const END = '/*__DSH_BASE_SHIM_END__*/<PREFIX>)'
const start = relaySource.indexOf(START)
const end = relaySource.indexOf(END)
if (start === -1 || end === -1 || start >= end) {
  console.error('shim markers not found in relay.mjs')
  process.exit(1)
}
const shimCall = `${relaySource.slice(start + START.length, end).trim()}"/app/dsh")`

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

// --- stub browser realm ------------------------------------------------------
const calls = []
const fetchCalls = []
class FakeRequest {
  constructor(url, init) {
    this.url = url
    this.init = init
  }
}
function FakeWebSocket(url, protocols) {
  this.url = url
  this.protocols = protocols
  calls.push(['ws-open', url, protocols])
}
FakeWebSocket.CONNECTING = 0
FakeWebSocket.OPEN = 1
FakeWebSocket.CLOSING = 2
FakeWebSocket.CLOSED = 3
function FakeEventSource(url) {
  this.url = url
  calls.push(['es-open', url])
}
class FakeXHR {
  open(...args) {
    calls.push(['xhr', ...args])
  }
}
let srcSet = null
const sandbox = {
  URL,
  console,
  fetch(input, init) {
    fetchCalls.push([input, init])
    return 'fetch-ok'
  },
  Request: FakeRequest,
  XMLHttpRequest: FakeXHR,
  WebSocket: FakeWebSocket,
  EventSource: FakeEventSource,
  location: { origin: 'http://nas.test' },
  navigator: {
    sendBeacon(url, data) {
      calls.push(['beacon', url, data])
      return true
    },
  },
  history: {
    pushState(s, t, u) {
      calls.push(['pushState', s, t, u])
    },
    replaceState(s, t, u) {
      calls.push(['replaceState', s, t, u])
    },
  },
}
sandbox.window = sandbox
function FakeScriptElement() {}
Object.defineProperty(FakeScriptElement.prototype, 'src', {
  configurable: true,
  get() {
    return srcSet
  },
  set(v) {
    srcSet = v
    calls.push(['script-src', v])
  },
})
sandbox.HTMLScriptElement = FakeScriptElement

vm.createContext(sandbox)
vm.runInContext(shimCall, sandbox)

// --- fetch -------------------------------------------------------------------
sandbox.fetch('/sidebar/api/ping', { method: 'POST' })
check('fetch: root-absolute gains the prefix', fetchCalls.at(-1)[0], '/app/dsh/sidebar/api/ping')
check('fetch: init untouched', fetchCalls.at(-1)[1], { method: 'POST' })
sandbox.fetch('/app/dsh/api/x')
check('fetch: already-prefixed untouched', fetchCalls.at(-1)[0], '/app/dsh/api/x')
sandbox.fetch('https://gh-proxy.com/https://github.com/x')
check('fetch: cross-origin untouched', fetchCalls.at(-1)[0], 'https://gh-proxy.com/https://github.com/x')
sandbox.fetch('//cdn.example.com/lib.js')
check('fetch: protocol-relative untouched', fetchCalls.at(-1)[0], '//cdn.example.com/lib.js')
sandbox.fetch('relative/path')
check('fetch: relative untouched', fetchCalls.at(-1)[0], 'relative/path')
sandbox.fetch('data:application/json,{}')
check('fetch: other scheme untouched', fetchCalls.at(-1)[0], 'data:application/json,{}')
sandbox.fetch(new FakeRequest('http://nas.test/sidebar/api/y'))
check('fetch: Request instance URL rewritten', fetchCalls.at(-1)[0]?.url, 'http://nas.test/app/dsh/sidebar/api/y')
sandbox.fetch(new FakeRequest('https://other.test/a'))
check('fetch: cross-origin Request untouched', fetchCalls.at(-1)[0]?.url, 'https://other.test/a')

// --- XHR ---------------------------------------------------------------------
const xhr = new sandbox.XMLHttpRequest()
xhr.open('POST', '/sidebar/upload')
check('XHR: url rewritten', calls.at(-1), ['xhr', 'POST', '/app/dsh/sidebar/upload'])
xhr.open('GET', '/app/dsh/api/z')
check('XHR: already-prefixed untouched', calls.at(-1), ['xhr', 'GET', '/app/dsh/api/z'])

// --- WebSocket / EventSource -------------------------------------------------
new sandbox.WebSocket('ws://nas.test/sidebar/ws/terminal', ['chat'])
check('WebSocket: same-origin ws URL path prefixed', calls.at(-1), ['ws-open', 'ws://nas.test/app/dsh/sidebar/ws/terminal', ['chat']])
check('WebSocket: static constants copied', [sandbox.WebSocket.CONNECTING, sandbox.WebSocket.CLOSED], [0, 3])
check('WebSocket: instanceof preserved', new sandbox.WebSocket('ws://nas.test/sidebar/ws/x') instanceof FakeWebSocket, true)
new sandbox.WebSocket('wss://other.test/ws')
check('WebSocket: cross-origin untouched', calls.at(-1), ['ws-open', 'wss://other.test/ws', undefined])
new sandbox.EventSource('http://nas.test/api/events.mux')
check('EventSource: path prefixed', calls.at(-1), ['es-open', 'http://nas.test/app/dsh/api/events.mux'])

// --- sendBeacon / script src / history ---------------------------------------
sandbox.navigator.sendBeacon('/sidebar/api/telemetry', 'x')
check('sendBeacon: rewritten', calls.at(-1), ['beacon', '/app/dsh/sidebar/api/telemetry', 'x'])
const script = new FakeScriptElement()
script.src = '/sidebar/bundle/chunk-abc.js'
check('script.src: rewritten', srcSet, '/app/dsh/sidebar/bundle/chunk-abc.js')
sandbox.history.pushState({}, '', '/settings')
check('pushState: rewritten', calls.at(-1), ['pushState', {}, '', '/app/dsh/settings'])
sandbox.history.replaceState({}, '', null)
check('replaceState: null url untouched', calls.at(-1), ['replaceState', {}, '', null])

// --- double-eval guard ---------------------------------------------------------
vm.runInContext(shimCall, sandbox)
sandbox.fetch('/sidebar/api/again')
check('second injection is a no-op', fetchCalls.at(-1)[0], '/app/dsh/sidebar/api/again')

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`)
  process.exit(1)
}
console.log('\nAll base-path shim checks passed.')

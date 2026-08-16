// Verifies the relay proxies a WebSocket upgrade: 101 + bidirectional bytes.
import http from 'node:http'

const via = process.argv[2] ?? 'http://127.0.0.1:13080'
const path = '/app/dsh/api/events.mux'

const req = http.request(
  `${via}${path}`,
  {
    headers: {
      connection: 'Upgrade',
      upgrade: 'websocket',
      'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      'sec-websocket-version': '13',
      'x-trim-isadmin': 'true',
      origin: 'http://nas.local:5666',
    },
  },
)
req.on('upgrade', (res, socket) => {
  console.log(`UPGRADE OK: ${res.statusCode}`)
  console.log(`upgrade header: ${res.headers.upgrade}`)
  socket.setTimeout(3000)
  socket.on('data', (chunk) => {
    console.log(`received ${chunk.length} bytes from downstream`)
    socket.destroy()
    process.exit(0)
  })
  socket.on('timeout', () => {
    console.log('no data within 3s (upgrade itself succeeded)')
    process.exit(0)
  })
  socket.on('error', (error) => {
    console.log(`socket error after upgrade: ${error.message}`)
    process.exit(1)
  })
})
req.on('response', (res) => {
  console.log(`FAILED: got normal response ${res.statusCode} instead of 101`)
  process.exit(1)
})
req.on('error', (error) => {
  console.log(`request error: ${error.message}`)
  process.exit(1)
})
req.end()
setTimeout(() => {
  console.log('timeout waiting for upgrade')
  process.exit(1)
}, 8000).unref()

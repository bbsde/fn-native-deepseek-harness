// Verifies the relay's secure-context polyfill generates valid UUID v4 in a
// context where crypto has getRandomValues but no randomUUID (plain HTTP).
import fs from 'node:fs'
import vm from 'node:vm'
import { randomFillSync } from 'node:crypto'

const src = fs.readFileSync(new URL('../src/app/bin/relay.mjs', import.meta.url), 'utf8')
const start = src.indexOf('const SECURE_CONTEXT_POLYFILL')
const end = src.indexOf("</script>'", start)
if (start === -1 || end === -1) throw new Error('polyfill constant not found in relay.mjs')
const decl = src.slice(start, end + "</script>'".length)
const parts = [...decl.matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1])
const script = parts.join('').replace(/^<script>/, '').replace(/<\/script>$/, '')

const ctx = { crypto: { getRandomValues: (arr) => randomFillSync(arr) } }
vm.createContext(ctx)
vm.runInContext(script, ctx)

const uuid = vm.runInContext('crypto.randomUUID()', ctx)
const valid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(uuid)
const unique = uuid !== vm.runInContext('crypto.randomUUID()', ctx)
console.log(`generated: ${uuid}`)
console.log(`valid v4: ${valid ? 'YES' : 'NO'} | unique: ${unique ? 'YES' : 'NO'}`)
if (!valid || !unique) process.exit(1)

// The no-secure-context check must stay intact: with a real randomUUID
// present, the polyfill must not overwrite it.
const ctx2 = { crypto: { getRandomValues: (a) => randomFillSync(a), randomUUID: () => 'native' } }
vm.createContext(ctx2)
vm.runInContext(script, ctx2)
const preserved = vm.runInContext('crypto.randomUUID()', ctx2) === 'native'
console.log(`native implementation preserved: ${preserved ? 'YES' : 'NO'}`)
if (!preserved) process.exit(1)
console.log('Polyfill test passed.')

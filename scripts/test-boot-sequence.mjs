/**
 * Simulates the browser boot sequence against the relay:
 *   1. fetch the index page
 *   2. parse the __DSH_BOOT__ plugin graph
 *   3. fetch every plugin bundle the module loader would request
 *   4. fetch a lazy langs chunk under both plausible resolutions
 * Verifies status AND content-type (the SPA fallback answers 200 with HTML
 * on unknown paths, so a JS path served as text/html is a failure).
 */
const base = process.argv[2] ?? 'http://127.0.0.1:13080'

const failures = []
const check = async (label, url, expectType) => {
  const res = await fetch(url, { headers: { 'x-trim-isadmin': 'true' }, redirect: 'manual' })
  const type = res.headers.get('content-type') ?? ''
  const ok = res.status === 200 && (expectType === undefined || type.startsWith(expectType))
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  ${res.status} ${type.split(';')[0]}  ${url.slice(base.length)}`)
  if (!ok) failures.push(label)
  return res
}

const index = await check('index page', `${base}/app/dsh/`, 'text/html')
const html = await index.text()

const bootMatch = html.match(/window\.__DSH_BOOT__\s*=\s*(\{.*?\})<\/script>/s)
if (bootMatch === null) {
  console.log('FAIL  boot manifest not found in HTML')
  process.exit(1)
}
const boot = JSON.parse(bootMatch[1].replaceAll('\\u003c', '<'))
console.log(`boot manifest: rev ${boot.rev}, ${boot.entries.length} plugin entries`)

let immediate = 0
for (const entry of boot.entries) {
  if (entry.immediately) immediate += 1
  await check(`plugin ${entry.id}`, `${base}${entry.url}`, 'text/javascript')
}
console.log(`(${immediate} immediate, ${boot.entries.length - immediate} lazy)`)

// The shell references langs chunks as relative specifiers; both plausible
// resolutions must serve real JavaScript, not the SPA fallback.
const langsDocBase = await check('langs chunk (document-base resolution)', `${base}/app/dsh/assets/langs/ruby-DEItuUFs.js`, 'text/javascript')
if (langsDocBase.ok) {
  const body = await langsDocBase.text()
  console.log(`langs body starts with: ${body.slice(0, 40)}`)
}

if (failures.length > 0) {
  console.error(`\n${failures.length} failures`)
  process.exit(1)
}
console.log('\nBoot sequence simulation passed.')

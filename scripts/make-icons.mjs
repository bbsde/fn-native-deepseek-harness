/**
 * Exports the app icons from the 600x600 master (assets/ICON.png).
 *
 * fnOS renders every icon slot at 2x physical pixels (HiDPI): the 64pt slot
 * wants 128px, the 256pt slot wants 512px. Committing @1x exports made the
 * desktop upscale the 64px source into a 128px cell — a visibly soft icon.
 * File NAMES stay at the logical size (fnOS resolves icon_{0}.png with
 * {0}=64/256 and the fpk manifest icons are ICON.PNG / ICON_256.PNG); the
 * pixel dimensions inside are @2x.
 *
 * Resizing uses sharp, taken from the staged dsh runtime tree
 * (cache/dsh-runtime/node_modules) — the system python has no PIL. Run
 * `npm run fetch` first on a fresh checkout.
 */
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const candidates = [
  path.join(root, 'cache', 'dsh-runtime', 'node_modules', 'sharp'),
  '/vol1/@appdata/dsh/runtime/node_modules/sharp',
]
const sharpPath = candidates.find((p) => fs.existsSync(path.join(p, 'package.json')))
if (sharpPath === undefined) {
  console.error('sharp not found; run "npm run fetch" first (or install the dsh app)')
  process.exit(1)
}
const sharp = createRequire(import.meta.url)(sharpPath)

const source = path.join(root, 'assets', 'ICON.png')
if (!fs.existsSync(source)) {
  console.error(`master icon missing: ${source}`)
  process.exit(1)
}

// [output, logical size] — pixels are 2x logical.
const targets = [
  ['src/ICON.PNG', 64],
  ['src/ICON_256.PNG', 256],
  ['src/app/ui/images/icon_64.png', 64],
  ['src/app/ui/images/icon_256.png', 256],
]

for (const [rel, logical] of targets) {
  const out = path.join(root, rel)
  fs.mkdirSync(path.dirname(out), { recursive: true })
  await sharp(source)
    .resize(logical * 2, logical * 2, { kernel: 'lanczos3' })
    .png()
    .toFile(out)
  const meta = await sharp(out).metadata()
  const ok = meta.width === logical * 2 && meta.height === logical * 2
  console.log(`${rel}: ${meta.width}x${meta.height} (${logical}pt @2x)${ok ? '' : '  SIZE MISMATCH'}`)
  if (!ok) process.exit(1)
}

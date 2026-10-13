import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = fileURLToPath(new URL('../', import.meta.url))
await build({ entryPoints: [path.join(root, 'src/overlay.mjs')], outfile: path.join(root, 'dist/hud.js'), bundle: true, format: 'iife', platform: 'browser', target: 'chrome120', minify: true, legalComments: 'eof' })
await build({ entryPoints: [path.join(root, 'scripts/runner.mjs')], outfile: path.join(root, 'dist/runner.mjs'), bundle: true, format: 'esm', platform: 'node', target: 'node22', legalComments: 'eof' })
console.log('Built dist/hud.js and dist/runner.mjs (dependencies bundled).')

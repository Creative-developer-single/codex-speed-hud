import http from 'node:http'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { pluginRoot } from './runtime.mjs'

const html = await readFile(path.join(pluginRoot, 'demo/index.html'))
const bundle = await readFile(path.join(pluginRoot, 'dist/hud.js'))
const port = Number(process.env.CODEX_SPEED_HUD_PREVIEW_PORT ?? 4198)
http.createServer((request, response) => {
  const pathname = new URL(request.url, 'http://127.0.0.1').pathname
  if (pathname === '/favicon.ico') { response.writeHead(204); response.end() }
  else if (pathname === '/hud.js') { response.setHeader('Content-Type', 'application/javascript'); response.end(bundle) }
  else if (pathname === '/') { response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(html) }
  else { response.writeHead(404); response.end() }
}).listen(port, '127.0.0.1', () => console.log(`Synthetic preview: http://127.0.0.1:${port} (use /hud.js to load the bundle; runner can inject it via CDP).`))

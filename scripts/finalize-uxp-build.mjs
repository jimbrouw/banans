import { readFile, writeFile } from 'node:fs/promises'

const path = new URL('../plugin-dist/index.html', import.meta.url)
const html = await readFile(path, 'utf8')
const classic = html
  .replace(/<script type="module" crossorigin src="([^"]+)"><\/script>/, '<script src="$1"></script>')
  .replace(/<script type="module" src="([^"]+)"><\/script>/, '<script src="$1"></script>')
const script = classic.match(/\s*<script src="[^"]+"><\/script>/)?.[0]
const finalized = script
  ? classic.replace(script, '').replace('</body>', `${script.trim()}\n  </body>`)
  : classic

if (finalized === html || finalized.includes('type="module"') || finalized.indexOf('<script') < finalized.indexOf('<div id="root"')) {
  throw new Error('Could not convert the Vite entry script to a UXP-compatible classic script.')
}

await writeFile(path, finalized)

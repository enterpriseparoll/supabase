import { readdir } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const root = new URL('../', import.meta.url)
let failed = false
for (const folder of ['src', 'test', 'scripts', 'public']) {
  for (const name of await readdir(new URL(`${folder}/`, root))) {
    if (!name.endsWith('.mjs')) continue
    const result = spawnSync(
      process.execPath,
      ['--check', fileURLToPath(new URL(`${folder}/${name}`, root))],
      { stdio: 'inherit', windowsHide: true }
    )
    if (result.status !== 0) failed = true
  }
}
if (failed) process.exitCode = 1

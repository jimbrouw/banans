import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { extractFcpXmlReference } from '../src/eval/fcpXmlReference'

const input = resolve(process.argv[2] ?? 'EDIT V2 xlm for test .xml')
const output = resolve(process.argv[3] ?? 'eval-output/edit-v2-reference.json')
const xml = await readFile(input, 'utf8')
const result = extractFcpXmlReference(xml, [
  { trackIndex: 1, camera: 'Guest', role: 'guest' },
  { trackIndex: 2, camera: 'Ben', role: 'presenter' },
  { trackIndex: 3, camera: 'Wide', role: 'wide' },
])
await mkdir(dirname(output), { recursive: true })
await writeFile(output, `${JSON.stringify({ source: basename(input), ...result }, null, 2)}\n`)

const profile = result.profile
console.log([
  `${profile.sequenceName}: ${(profile.durationSeconds / 60).toFixed(1)} minutes`,
  `${profile.editCount} edits (${profile.cutsPerMinute.toFixed(2)}/min); ${profile.cameraSwitchCount} camera switches (${profile.cameraSwitchesPerMinute.toFixed(2)}/min)`,
  `Shot length: ${profile.averageShotLengthSeconds.toFixed(1)}s average, ${profile.medianShotLengthSeconds.toFixed(1)}s median, ${profile.minimumShotLengthSeconds.toFixed(2)}s minimum`,
  `Under 2.5s: ${profile.shotsUnderMinimumCount}`,
  `Camera usage: ${Object.entries(profile.cameraUsagePercent).map(([camera, percent]) => `${camera} ${percent.toFixed(1)}%`).join(', ')}`,
  `Reference written to ${output}`,
].join('\n'))

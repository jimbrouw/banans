// Run the selects pass on an episode transcript and score it against clips the
// editor actually published.
//
//   npm run eval:selects -- --episode "eval-input/kate-courtney" --refs "xlr social clips" \
//     --episode-name "Kate Courtney v1" [--provider claude] [--audio "/path/episode mix.wav"]
//
// Needs the local engine running, and Ollama, or ANTHROPIC_API_KEY with --provider claude.
// Writes the picks and the score to <episode>/selects-eval.json (gitignored: it holds transcript text).

import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readReferenceClip } from '../src/eval/clipReference'
import { scoreSelects } from '../src/eval/selectsEval'
import { speechUnits, wordsForClip } from '../src/reviewModel'
import type { EngineWord } from '../src/engineClient'

const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : fallback
}
const episodeDir = arg('episode', 'eval-input/kate-courtney')!
const refsDir = arg('refs', 'xlr social clips')!
const episodeName = arg('episode-name', 'Kate Courtney v1')!
const provider = arg('provider', 'ollama')!
const audio = arg('audio')
const mmss = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`

const transcript = JSON.parse(readFileSync(join(episodeDir, 'transcript.json'), 'utf8')) as { words: EngineWord[] }
const units = speechUnits(wordsForClip(transcript.words, { path: '', start: 0, end: 1e9, inPoint: 0 }, 0))
const references = readdirSync(refsDir).filter((f) => f.endsWith('.xml')).map((f) =>
  readReferenceClip(readFileSync(join(refsDir, f), 'utf8'), (n) => n === episodeName || n.startsWith(`${episodeName}.prproj_mixdown`)))

console.log(`${units.length} sentence lines, ${references.length} published clips to compare against. Asking ${provider}…`)
// Runs as an engine job: a local model takes longer than fetch will wait for one response.
const started = await fetch('http://localhost:7317/jobs/selects', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ units, provider, api_key: process.env.ANTHROPIC_API_KEY, audio_path: audio }),
})
const startBody = await started.json() as { job?: string; detail?: string }
if (!started.ok || !startBody.job) { console.error(`Engine: ${startBody.detail}`); process.exit(1) }
type Out = { model: string; clips: { title: string; type: string; duration: number; opening_line: string; pieces: { start: number; end: number }[] }[]; proposed: number; valid: number; proposals: { title: string; span: [number, number] | null; status: string }[] }
let out: Out | null = null
let lastStep = ''
while (!out) {
  await new Promise((r) => setTimeout(r, 3000))
  const s = await (await fetch(`http://localhost:7317/jobs/${startBody.job}`)).json() as { status: string; step: string; result: Out | null; error: string | null; seconds: number }
  if (s.status === 'error') { console.error(`Engine: ${s.error}`); process.exit(1) }
  if (s.status === 'done') out = s.result
  else if (s.step !== lastStep) { lastStep = s.step; console.log(`  [${s.seconds}s] ${s.step}`) }
}

const score = scoreSelects(out.clips.map((c) => ({ title: c.title, pieces: c.pieces })), references)
console.log(`\n${out.model}: ${out.proposed} proposed, ${out.valid} passed the checks, top ${out.clips.length}:`)
out.clips.forEach((c, i) => console.log(`  ${i + 1}. ${mmss(c.pieces[0].start)} ${c.title} (${c.type}, ${Math.round(c.duration)}s) "${c.opening_line.slice(0, 70)}"`))
console.log(`\nAgainst your published clips: found ${score.found} of ${score.total}, mean overlap ${score.meanIoU}`)
for (const m of score.matches) {
  console.log(m.found
    ? `  ✓ ${m.reference}: pick #${m.rank}, covers ${Math.round(m.coverage * 100)}%, starts ${m.startError}s / ends ${m.endError}s from yours, ${m.sameOpening ? 'same opening line' : 'different opening line'}`
    : `  ✗ ${m.reference}: not in the top ${out.clips.length} (best overlap ${Math.round(m.coverage * 100)}%)`)
}
// Where did each of the editor's clips go? Never proposed, or proposed and dropped (and why)?
for (const ref of references) {
  const touching = out.proposals.filter((p) => p.span && ref.pieces.some((r) => p.span![0] < r.end && r.start < p.span![1]))
  console.log(`\n  Proposals touching ${ref.name} (${ref.pieces.map((p) => `${mmss(p.start)}–${mmss(p.end)}`).join(', ')}): ${touching.length || 'none, the model never proposed this moment'}`)
  for (const p of touching) console.log(`    ${mmss(p.span![0])}–${mmss(p.span![1])} "${p.title}": ${p.status}`)
}
writeFileSync(join(episodeDir, 'selects-eval.json'), JSON.stringify({ at: new Date().toISOString(), model: out.model, picks: out.clips, references, score }, null, 2))

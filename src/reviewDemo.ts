// Browser-demo data for the Review screen: what the engine returns for a short
// talking-head take, so the UI can be exercised without Premiere or the engine.

import type { EngineWord, SilenceRange } from './engineClient'
import type { SourceClip } from './reviewModel'

export const demoClips: SourceClip[] = [{ path: '/demo/talking-head.mov', start: 0, end: 30, inPoint: 0 }]

const line = (segment: number, start: number, text: string, fillers: string[] = []): EngineWord[] => {
  let t = start
  return text.split(' ').map((word) => {
    const w = { text: word, start: t, end: t + 0.32, prob: 0.95, filler: fillers.includes(word.replace(/[^\w]/g, '').toLowerCase()), segment }
    t += 0.38
    return w
  })
}

export const demoWords: EngineWord[] = [
  ...line(0, 0.4, 'Hey everyone, welcome back to the channel.'),
  ...line(1, 4.1, 'So um today we are going to talk about, uh, editing faster.', ['um', 'uh']),
  ...line(2, 10.2, 'Most of your time goes into the first pass.'),
  ...line(3, 14.9, 'Uh, cutting pauses, filler words and retakes.', ['uh']),
  ...line(4, 20.6, 'Let me show you how to skip all of that.'),
  ...line(5, 25.3, 'Hmm, okay, let us get started.', ['hmm']),
]

export const demoSilences: SilenceRange[] = [
  { start: 2.75, end: 4.05 },
  { start: 8.4, end: 10.15 },
  { start: 13.1, end: 14.85 },
  { start: 17.6, end: 20.5 },
  { start: 23.95, end: 25.25 },
  { start: 27.6, end: 30 },
]

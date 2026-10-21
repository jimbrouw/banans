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
  ...line(4, 17.6, 'Let me show you how to, no wait.'),
  ...line(5, 20.6, 'Let me show you how to skip all of that.'),
  ...line(6, 25.3, 'Hmm, okay, let us get started.', ['hmm']),
]

export const demoSilences: SilenceRange[] = [
  { start: 2.75, end: 4.05 },
  { start: 8.4, end: 10.15 },
  { start: 13.1, end: 14.85 },
  { start: 23.95, end: 25.25 },
  { start: 27.6, end: 30 },
]

/** What the AI pass returns for the demo take: the abandoned "Let me show you how to, no wait." */
export function demoAiRemovals(units: { id: number; start: number; end: number; text: string }[]) {
  return units
    .filter((u) => u.text.startsWith('Let me show you how to, no wait'))
    .map((u) => ({ start: u.start, end: u.end, reason: 'retake' as const, note: 'abandoned first attempt; kept the next line' }))
}

/** Demo mic tracks for Podcast Mode: host and guest trading turns, each faintly in the other's mic. */
export function demoMicEnvelopes(seconds: number): number[][] {
  const turns = [[0, 8, 0], [8.5, 15, 1], [15, 17, 0], [17.2, 30, 1], [30.5, 41, 0], [41, 44, 1], [44.2, 60, 0]]
  return [0, 1].map((mic) => Array.from({ length: Math.ceil(seconds * 10) }, (_, i) => {
    const t = (i % 600) / 10
    const turn = turns.find(([a, b]) => t >= a && t < b)
    const breath = Math.sin(i * 1.7) * 3
    if (!turn) return -62 + breath
    return turn[2] === mic ? -20 + breath : -36 + breath
  }))
}

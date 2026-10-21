// Client for the local RoughCut Engine (engine/ — Python, this Mac only).
// The URL must use the host name "localhost": Premiere on macOS blocks plain
// http:// to anything else, including 127.0.0.1 (App Transport Security).
// UXP can't run binaries, but it can fetch localhost; the engine does the
// heavy lifting (transcription, silence detection) on the user's machine.

import { claudeModel } from './settings'

export const ENGINE_URL = 'http://localhost:7317'
export const ENGINE_OFF_MESSAGE = 'The local engine isn’t set up. Run engine/install.sh once and it starts by itself when RoughCut needs it.'

export interface EngineHealth { ok: boolean; version: string; model: string }
export interface SilenceRange { start: number; end: number }
export interface SilencesResult { duration: number; noise_db: number; min_silence: number; silences: SilenceRange[] }
export interface EngineWord { text: string; start: number; end: number; prob: number; filler: boolean; segment: number }
export interface TranscribeResult {
  model: string
  language: string | null
  segments: { start: number; end: number; text: string }[]
  words: EngineWord[]
}

async function call<T>(path: string, body?: unknown, timeoutMs = 3000): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`${ENGINE_URL}${path}`, body === undefined
      ? { signal: controller.signal }
      : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error((data as { detail?: string }).detail ?? `Engine error ${res.status}`)
    return data as T
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Resolves to null when the engine isn't running — callers degrade to Premiere's transcript.
 * Installed on demand (engine/install.sh), this first request is what starts it, so allow a cold start.
 */
export let lastEngineError = ''
export async function engineHealth(): Promise<EngineHealth | null> {
  try {
    const health = await call<EngineHealth>('/health', undefined, 5000)
    lastEngineError = ''
    return health
  } catch (e) {
    lastEngineError = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
    return null
  }
}

export const detectSilences = (path: string, opts: { noise_db?: number; min_silence?: number } = {}) =>
  call<SilencesResult>('/silences', { path, ...opts }, 5 * 60_000)

// First run downloads the model (~1.6 GB) and a long episode takes minutes; results are cached.
export const transcribeMedia = (path: string, opts: { language?: string } = {}) =>
  call<TranscribeResult>('/transcribe', { path, ...opts }, 60 * 60_000)

export interface LevelsResult { rate: number; channel: number | null; duration: number; db: number[] }

/** Loudness over time for one mic (one file, optionally one channel), 10 values per second. */
export const micLevels = (path: string, channel: number | null) =>
  call<LevelsResult>('/levels', { path, channel, rate: 10 }, 10 * 60_000)

export type AiProvider = 'ollama' | 'claude'
/** Claude calls always name the chosen cheap model, so the engine never falls back to its own default. */
const modelFor = (provider: AiProvider) => (provider === 'claude' ? claudeModel().id : undefined)
export interface AiEditResult {
  provider: AiProvider
  model: string
  removals: { start: number; end: number; ids: number[]; reason: 'retake' | 'false_start' | 'repeat' | 'off_topic' | 'instruction'; note: string }[]
  keep_ids: number[]
}

// Local models on a long episode can take several minutes.
export const aiEdit = (
  units: { id: number; start: number; end: number; text: string }[],
  opts: { provider: AiProvider; apiKey?: string; instruction?: string; preferLastTake: boolean },
) => call<AiEditResult>('/edit', {
  units,
  provider: opts.provider,
  model: modelFor(opts.provider),
  api_key: opts.apiKey || undefined,
  instruction: opts.instruction || undefined,
  prefer_last_take: opts.preferLastTake,
}, 30 * 60_000)

export interface SelectClip {
  rank: number
  title: string
  title_check: { score: number; issues: string[] }
  type: 'story' | 'opinion' | 'tip' | 'moment'
  idea: string
  opening_line: string
  why: string
  pieces: SilenceRange[]
  duration: number
  hook_pulled_forward: boolean
  hook_score: { verdict: number; band: string; weakest: string; fix: string; formula: string }
  energy: number | null
}
export interface SelectsResult { model: string; clips: SelectClip[]; proposed: number; valid: number; shortlisted: number }
export interface ChaptersResult { model: string; valid: boolean; chapters: { start: number; label: string; title: string; seconds: number }[]; text: string }
type Units = { id: number; start: number; end: number; text: string }[]
type AiOpts = { provider: AiProvider; apiKey?: string }

interface Job<T> { status: 'running' | 'done' | 'error'; step: string; result: T | null; error: string | null; seconds: number }

/**
 * The few clips worth cutting from a whole episode. Reads everything, so it takes
 * minutes on a local model: runs as an engine job, polled, reporting each step.
 */
export async function findSelects(units: Units, opts: AiOpts & { audioPath?: string }, onStep: (step: string) => void = () => {}): Promise<SelectsResult> {
  const { job } = await call<{ job: string }>('/jobs/selects', { units, provider: opts.provider, model: modelFor(opts.provider), api_key: opts.apiKey || undefined, audio_path: opts.audioPath }, 30_000)
  const deadline = Date.now() + 60 * 60_000
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2500))
    const s = await call<Job<SelectsResult>>(`/jobs/${job}`, undefined, 10_000)
    if (s.status === 'done' && s.result) return s.result
    if (s.status === 'error') throw new Error(s.error ?? 'The selects pass failed.')
    onStep(`${s.step} (${Math.floor(s.seconds / 60)}:${String(s.seconds % 60).padStart(2, '0')})`)
  }
  throw new Error('The selects pass took over an hour and was abandoned.')
}

export const makeChapters = (units: Units, opts: AiOpts) =>
  call<ChaptersResult>('/chapters', { units, provider: opts.provider, model: modelFor(opts.provider), api_key: opts.apiKey || undefined }, 10 * 60_000)

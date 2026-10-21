// Client for the local RoughCut Engine (engine/ — Python, 127.0.0.1 only).
// UXP can't run binaries, but it can fetch localhost; the engine does the
// heavy lifting (transcription, silence detection) on the user's machine.

export const ENGINE_URL = 'http://127.0.0.1:7317'

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

/** Resolves to null when the engine isn't running — callers degrade to Premiere's transcript. */
export async function engineHealth(): Promise<EngineHealth | null> {
  try { return await call<EngineHealth>('/health') } catch { return null }
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
  api_key: opts.apiKey || undefined,
  instruction: opts.instruction || undefined,
  prefer_last_take: opts.preferLastTake,
}, 30 * 60_000)

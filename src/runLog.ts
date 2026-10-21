// Run log: one readable line per action, so you (or Claude) can see what
// worked and what didn't. Written to the plugin's data folder (no extra
// permission needed); in the browser demo it goes to the console instead.
//
//   2026-10-21 15:02:11  OK    Auto Cut          4.2s  "Sequence 01 — Auto Cut 03 (Balanced · 41 cuts · mics)"  source="Sequence 01" cuts=41

import { getRuntimeRequire } from './hostRuntime'

export const LOG_FILE = 'roughcut.log'

export interface LogEntry {
  at: Date
  status: 'OK' | 'FAIL' | 'INFO'
  action: string
  ms?: number
  result?: string
  details?: Record<string, unknown>
}

const pad = (n: number) => String(n).padStart(2, '0')
const stamp = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
const value = (v: unknown) => (typeof v === 'string' ? JSON.stringify(v) : typeof v === 'number' ? String(Math.round(v * 100) / 100) : JSON.stringify(v))

export function formatLogLine(e: LogEntry): string {
  const parts = [stamp(e.at), e.status.padEnd(4), e.action.padEnd(17), e.ms === undefined ? '' : `${(e.ms / 1000).toFixed(1)}s`.padStart(6)]
  if (e.result) parts.push(JSON.stringify(e.result))
  for (const [k, v] of Object.entries(e.details ?? {})) if (v !== undefined && v !== '') parts.push(`${k}=${value(v)}`)
  return parts.join('  ').replace(/\s+$/, '')
}

interface UxpFile { nativePath: string; write(data: string, opts?: { append?: boolean }): Promise<unknown> }
interface UxpFolder { nativePath: string; getEntry(name: string): Promise<UxpFile>; createFile(name: string, opts: { overwrite: boolean }): Promise<UxpFile> }

let filePromise: Promise<UxpFile | null> | null = null
let queue: Promise<unknown> = Promise.resolve()

function logFile(): Promise<UxpFile | null> {
  filePromise ??= (async () => {
    const uxp = getRuntimeRequire()?.('uxp') as { storage: { localFileSystem: { getDataFolder(): Promise<UxpFolder> } } } | undefined
    if (!uxp) return null
    const folder = await uxp.storage.localFileSystem.getDataFolder()
    try { return await folder.getEntry(LOG_FILE) } catch { return folder.createFile(LOG_FILE, { overwrite: false }) }
  })().catch(() => null)
  return filePromise
}

/** Where the log lives on disk (null in the browser demo). */
export async function logPath(): Promise<string | null> {
  return (await logFile())?.nativePath ?? null
}

export function writeLog(entry: LogEntry): void {
  const line = formatLogLine(entry)
  // Serialise writes so lines never interleave; logging must never break a run.
  queue = queue.then(async () => {
    const file = await logFile()
    if (file) await file.write(`${line}\n`, { append: true })
    else console.info(`[RoughCut] ${line}`)
  }).catch(() => { /* ignore log failures */ })
}

/** Run an action, log OK/FAIL with timing and details, and pass the result or error through. */
export async function logged<T>(action: string, details: Record<string, unknown>, run: () => Promise<T>, describe?: (result: T) => string): Promise<T> {
  const started = Date.now()
  try {
    const result = await run()
    writeLog({ at: new Date(), status: 'OK', action, ms: Date.now() - started, result: describe?.(result), details })
    return result
  } catch (error) {
    writeLog({ at: new Date(), status: 'FAIL', action, ms: Date.now() - started, details: { ...details, error: error instanceof Error ? error.message : String(error) } })
    throw error
  }
}

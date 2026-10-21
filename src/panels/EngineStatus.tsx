import { useEffect, useState } from 'react'
import { ENGINE_OFF_MESSAGE, ENGINE_URL, engineHealth, lastEngineError } from '../engineClient'
import { writeLog } from '../runLog'
import type { EngineHealth } from '../engineClient'

const POLL_MS = 10_000

// Header pill: is the local engine reachable? Installed with engine/install.sh, this poll is also what starts it.
export function EngineStatus() {
  const [health, setHealth] = useState<EngineHealth | null | undefined>(undefined)

  useEffect(() => {
    let alive = true
    let wasOnline: boolean | undefined
    const check = () => engineHealth().then((h) => {
      if (!alive) return
      setHealth(h)
      // Log each change, with Premiere's own error text, so "Engine off" is never a mystery.
      if (wasOnline !== !!h) {
        writeLog(h
          ? { at: new Date(), status: 'OK', action: 'Engine check', result: `online · ${h.version}`, details: { url: ENGINE_URL } }
          : { at: new Date(), status: 'FAIL', action: 'Engine check', details: { url: ENGINE_URL, error: lastEngineError } })
        wasOnline = !!h
      }
    })
    check()
    const timer = setInterval(check, POLL_MS)
    return () => { alive = false; clearInterval(timer) }
  }, [])

  const state = health === undefined ? 'checking' : health ? 'online' : 'offline'
  const title = health ? `RoughCut Engine ${health.version} · ${health.model}` : ENGINE_OFF_MESSAGE
  return <span className={`engine-pill ${state}`} title={title}>{state === 'online' ? 'Engine' : state === 'offline' ? 'Engine off' : 'Engine…'}</span>
}

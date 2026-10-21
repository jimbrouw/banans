import { useEffect, useState } from 'react'
import { ENGINE_OFF_MESSAGE, engineHealth } from '../engineClient'
import type { EngineHealth } from '../engineClient'

const POLL_MS = 10_000

// Header pill: is the local engine reachable? Installed with engine/install.sh, this poll is also what starts it.
export function EngineStatus() {
  const [health, setHealth] = useState<EngineHealth | null | undefined>(undefined)

  useEffect(() => {
    let alive = true
    const check = () => engineHealth().then((h) => { if (alive) setHealth(h) })
    check()
    const timer = setInterval(check, POLL_MS)
    return () => { alive = false; clearInterval(timer) }
  }, [])

  const state = health === undefined ? 'checking' : health ? 'online' : 'offline'
  const title = health ? `RoughCut Engine ${health.version} · ${health.model}` : ENGINE_OFF_MESSAGE
  return <span className={`engine-pill ${state}`} title={title}>{state === 'online' ? 'Engine' : state === 'offline' ? 'Engine off' : 'Engine…'}</span>
}

import { useEffect, useState } from 'react'
import { engineHealth } from '../engineClient'
import type { EngineHealth } from '../engineClient'

const POLL_MS = 10_000

// Header pill: is the local engine (engine/, `uv run roughcut-engine`) reachable?
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
  const title = health ? `RoughCut Engine ${health.version} · ${health.model}` : 'Local engine not running. Start it with: cd engine && uv run roughcut-engine'
  return <span className={`engine-pill ${state}`} title={title}>{state === 'online' ? 'Engine' : state === 'offline' ? 'Engine off' : 'Engine…'}</span>
}

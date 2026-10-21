import { useEffect, useState } from 'react'
import { Press } from '../ui'
import { openExternal } from '../uiHelpers'
import { ENGINE_OFF_MESSAGE, ENGINE_URL, engineHealth, lastEngineError } from '../engineClient'
import type { EngineHealth } from '../engineClient'
import { logPath } from '../runLog'
import { readSetting, SETTINGS, writeSetting } from '../settings'
import { isPremiereHost } from '../premiereAdapter'
import { SpikePanel } from './SpikePanel'

/** Things you set once: the local engine, your Claude key, where the log is. */
export function SetupPanel() {
  const [engine, setEngine] = useState<EngineHealth | null | undefined>(undefined)
  const [engineError, setEngineError] = useState('')
  const [key, setKey] = useState(() => readSetting(SETTINGS.claudeKey))
  const [log, setLog] = useState<string | null>(null)

  const check = async () => {
    setEngine(undefined)
    const h = await engineHealth()
    setEngine(h); setEngineError(h ? '' : lastEngineError)
  }
  useEffect(() => {
    const first = setTimeout(check, 0)
    logPath().then(setLog)
    return () => clearTimeout(first)
  }, [])

  return (
    <div className="tab-body">
      <section className="block">
        <h3 className="block-title">Local engine</h3>
        <p className="lede">
          {engine === undefined ? 'Checking…'
            : engine ? `Running at ${ENGINE_URL}. Starts by itself when RoughCut needs it and stops after 10 idle minutes.`
            : ENGINE_OFF_MESSAGE}
        </p>
        {engine && <p className="footnote">Version {engine.version}, Whisper model {engine.model.split('/').pop()}</p>}
        {engineError && <p className="footnote">Premiere said: {engineError}</p>}
        <Press className="text-button" onClick={check}>Check again</Press>
      </section>

      <section className="block">
        <h3 className="block-title">Claude API key</h3>
        <p className="lede">Used for cold opens, and for retakes when you pick Claude instead of Ollama. Stays on this Mac.</p>
        <input className="api-key" type="password" autoComplete="off" placeholder="sk-ant-…" value={key} onChange={(e) => { setKey(e.target.value); writeSetting(SETTINGS.claudeKey, e.target.value.trim()) }} />
        <Press className="text-button" onClick={() => openExternal('https://console.anthropic.com/settings/keys')}>Get a key at console.anthropic.com</Press>
      </section>

      <section className="block">
        <h3 className="block-title">Run log</h3>
        <p className="lede">Every action is written here with what happened. Useful when something doesn't work.</p>
        <p className="path">{log ?? 'In the browser demo, the log goes to the console.'}</p>
      </section>

      {isPremiereHost() && <section className="block">
        <h3 className="block-title">Premiere API check</h3>
        <SpikePanel />
      </section>}
    </div>
  )
}

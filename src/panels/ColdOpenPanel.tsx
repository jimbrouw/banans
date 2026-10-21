import { useState } from 'react'
import { AlertTriangle, Check, Scissors, Sparkles } from 'lucide-react'
import { Press } from '../ui'
import { errorMessage, formatTime, openExternal } from '../uiHelpers'
import { premiere } from '../premiereAdapter'
import { findColdOpens } from '../coldOpenFinder'
import { logged } from '../runLog'
import type { ColdOpenOption } from '../coldOpenFinder'
import type { TranscriptSegment } from '../types'

export function ColdOpenPanel({ sequenceId, segments }: { sequenceId: string; segments: TranscriptSegment[] }) {
  const [apiKey, setApiKey] = useState(() => { try { return localStorage.getItem('roughcut.anthropicKey') ?? '' } catch { return '' } })
  const [coldOpens, setColdOpens] = useState<ColdOpenOption[]>([])
  const [coldOpenStatus, setColdOpenStatus] = useState<'idle' | 'finding' | 'done' | 'assembling' | 'error'>('idle')
  const [coldOpenError, setColdOpenError] = useState('')
  const [coldOpenResult, setColdOpenResult] = useState('')

  const saveApiKey = (key: string) => { setApiKey(key); try { localStorage.setItem('roughcut.anthropicKey', key) } catch { /* localStorage unavailable */ } }

  const findColdOpenHooks = async () => {
    if (!segments.length) { setColdOpenError('Analyze a transcript first so there is something to scan.'); setColdOpenStatus('error'); return }
    try {
      setColdOpenError(''); setColdOpenResult(''); setColdOpenStatus('finding')
      const options = await logged('Cold Open find', { segments: segments.length }, () => findColdOpens(segments, apiKey), (o) => `${o.length} options`)
      setColdOpens(options)
      setColdOpenStatus('done')
    } catch (reason) {
      setColdOpenError(errorMessage(reason))
      setColdOpenStatus('error')
    }
  }

  const assembleColdOpenFromOption = async (option: ColdOpenOption) => {
    try {
      setColdOpenError(''); setColdOpenResult(''); setColdOpenStatus('assembling')
      // The adapter handles everything: lifts the window with synced audio, then
      // detects cameras on the subsequence and applies the Energy Reset shot plan.
      const name = await logged('Cold Open', { start: option.startSeconds, end: option.endSeconds, shots: option.shots.length, archetype: option.archetype },
        () => premiere.assembleColdOpenClip(sequenceId, option.startSeconds, option.endSeconds, option.shots), (n) => n)
      setColdOpenResult(name)
      setColdOpenStatus('done')
    } catch (reason) {
      setColdOpenError(errorMessage(reason))
      setColdOpenStatus('error')
    }
  }

  return (
    <div className="cold-open">
      <div className="cold-open-head"><Sparkles size={16} /><strong>YouTube Cold Open Finder</strong><span className="hint">AI · Claude</span></div>
      <a className="api-key-link" role="link" tabIndex={0} onClick={() => openExternal('https://console.anthropic.com/settings/keys')}>Get an API key at console.anthropic.com →</a>
      <input className="api-key" type="password" autoComplete="off" placeholder="Anthropic API key (sk-ant-…)" value={apiKey} onChange={(e) => saveApiKey(e.target.value)} />
      <Press className="rough-cut" style={{ marginTop: 8, backgroundColor: '#b57bed', color: '#fff' }} disabled={coldOpenStatus === 'finding' || coldOpenStatus === 'assembling'} onClick={findColdOpenHooks}>
        <Sparkles size={19} />{coldOpenStatus === 'finding' ? 'Analysing transcript…' : 'Find 3 Cold Opens (AI)'}
      </Press>
      {coldOpenStatus === 'finding' && (
        <div className="cold-open-thinking">
          <div className="cold-open-thinking-bar" />
          <div className="cold-open-thinking-steps">
            <span className="thinking-step active">Reading transcript</span>
            <span className="thinking-step">Scoring hooks</span>
            <span className="thinking-step">Ranking options</span>
          </div>
        </div>
      )}
      {coldOpens.map((opt, i) => (
        <div className="cold-open-card" key={i}>
          <div className="cold-open-card-head">
            <span className="cold-open-rank">#{i + 1}</span>
            <strong>{opt.archetype}</strong>
            <span className="cold-open-time">{formatTime(opt.startSeconds)}–{formatTime(opt.endSeconds)} · {Math.max(0, Math.round(opt.endSeconds - opt.startSeconds))}s</span>
          </div>
          <p className="cold-open-script">"{opt.script}"</p>
          <p className="cold-open-why"><strong>Why:</strong> {opt.justification}</p>
          {opt.shots.length > 0 && (
            <div className="cold-open-shots">
              {opt.shots.map((s, si) => (
                <span key={si} className="cold-open-shot-pill">
                  {s.offsetSeconds.toFixed(0)}s · {s.shot.replace('_', ' ')}
                </span>
              ))}
            </div>
          )}
          <Press className="text-button" disabled={coldOpenStatus === 'assembling'} onClick={() => assembleColdOpenFromOption(opt)}>
            <Scissors size={14} /> {coldOpenStatus === 'assembling' ? 'Assembling…' : 'Assemble this clip (with audio)'}
          </Press>
        </div>
      ))}
      {coldOpenResult && <div className="success"><Check size={16} /> Created "{coldOpenResult}" — open it in the Project panel.</div>}
      {coldOpenStatus === 'error' && coldOpenError && <div className="error"><AlertTriangle size={15} /> {coldOpenError}</div>}
    </div>
  )
}

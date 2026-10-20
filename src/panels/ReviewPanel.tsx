import { useMemo, useState } from 'react'
import { AlertTriangle, Check, Pause, Scissors, Wand2 } from 'lucide-react'
import { Press, Toggle } from '../ui'
import { errorMessage, formatTime } from '../uiHelpers'
import { detectSilences, engineHealth, transcribeMedia } from '../engineClient'
import type { SilenceRange } from '../engineClient'
import { premiere } from '../premiereAdapter'
import { buildCuts, cutsToDecisions, defaultReviewSettings, groupLines, mapToSequence, summarise, wordsForClip } from '../reviewModel'
import type { ReviewCut, ReviewSettings, ReviewWord } from '../reviewModel'
import { getPrimaryAudioClips, setPlayhead } from '../reviewHost'
import { demoClips, demoSilences, demoWords } from '../reviewDemo'

type Status = 'idle' | 'loading' | 'ready' | 'creating' | 'created' | 'error'

const cutKey = (c: { start: number; end: number }) => `${c.start}-${c.end}`
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

export function ReviewPanel({ sequenceId }: { sequenceId: string }) {
  const [settings, setSettings] = useState<ReviewSettings>(defaultReviewSettings)
  const [words, setWords] = useState<ReviewWord[]>([])
  const [silences, setSilences] = useState<SilenceRange[]>([])
  const [kept, setKept] = useState<Set<string>>(new Set()) // cuts the editor switched off
  const [status, setStatus] = useState<Status>('idle')
  const [step, setStep] = useState('')
  const [error, setError] = useState('')
  const [result, setResult] = useState('')

  const cuts: ReviewCut[] = useMemo(
    () => buildCuts(words, silences, settings).map((c) => ({ ...c, active: !kept.has(cutKey(c)) })),
    [words, silences, settings, kept],
  )
  const lines = useMemo(() => groupLines(words), [words])
  const summary = summarise(cuts)
  const patch = (p: Partial<ReviewSettings>) => setSettings((s) => ({ ...s, ...p }))
  const toggleCut = (c: ReviewCut) => setKept((prev) => { const next = new Set(prev); if (next.has(cutKey(c))) next.delete(cutKey(c)); else next.add(cutKey(c)); return next })
  const cutAt = (w: ReviewWord) => cuts.find((c) => w.start >= c.start - 0.01 && w.end <= c.end + 0.01)

  const load = async () => {
    try {
      setError(''); setResult(''); setStatus('loading'); setKept(new Set())
      setStep('Reading A1 clips')
      const clips = await getPrimaryAudioClips()
      if (!clips) {
        // Browser demo: no Premiere, show canned engine output.
        setStep('Transcribing (demo)'); await wait(500)
        setWords(wordsForClip(demoWords, demoClips[0], 0)); setSilences(mapToSequence(demoSilences, demoClips[0]))
        setStatus('ready'); return
      }
      if (!await engineHealth()) throw new Error('The local engine isn\'t running. In Terminal: cd engine && uv run roughcut-engine')

      const paths = [...new Set(clips.map((c) => c.path))]
      const byPath = new Map<string, { words: Awaited<ReturnType<typeof transcribeMedia>>['words']; silences: SilenceRange[] }>()
      for (const [i, path] of paths.entries()) {
        setStep(`Transcribing ${i + 1}/${paths.length} (first run downloads the model)`)
        const transcript = await transcribeMedia(path)
        setStep(`Finding pauses ${i + 1}/${paths.length}`)
        // Detect at the lowest threshold once; the min-pause setting filters locally.
        const found = await detectSilences(path, { min_silence: 0.3 })
        byPath.set(path, { words: transcript.words, silences: found.silences })
      }
      const nextWords: ReviewWord[] = []
      const nextSilences: SilenceRange[] = []
      clips.forEach((clip, i) => {
        const data = byPath.get(clip.path)!
        nextWords.push(...wordsForClip(data.words, clip, i))
        nextSilences.push(...mapToSequence(data.silences, clip))
      })
      setWords(nextWords); setSilences(nextSilences)
      setStatus('ready')
    } catch (reason) {
      setError(errorMessage(reason)); setStatus('error')
    }
  }

  const createMarkedCut = async () => {
    try {
      setError(''); setStatus('creating')
      setResult(await premiere.createRoughCut(sequenceId, cutsToDecisions(cuts), []))
      setStatus('created')
    } catch (reason) {
      setError(errorMessage(reason)); setStatus('error')
    }
  }

  const jump = (seconds: number) => { setPlayhead(seconds).catch(() => { /* playhead is a convenience */ }) }

  // Interleave transcript lines with pause chips in time order.
  const pauseCuts = cuts.filter((c) => c.reasons.includes('silence'))
  const rows = [...lines.map((l) => ({ kind: 'line' as const, at: l.start, line: l })), ...pauseCuts.map((c) => ({ kind: 'pause' as const, at: c.start, cut: c }))]
    .sort((a, b) => a.at - b.at)

  return (
    <section className="section">
      <div className="section-title"><h2>Clean-up review</h2><span className="hint">Local engine · pauses &amp; fillers</span></div>
      <div className="compact-settings">
        <label>Min pause <select value={settings.minSilence} onChange={(e) => patch({ minSilence: Number(e.target.value) })}><option value="0.4">0.4s</option><option value="0.6">0.6s</option><option value="1">1.0s</option><option value="1.5">1.5s</option></select></label>
        <label>Breathing room <select value={settings.padding} onChange={(e) => patch({ padding: Number(e.target.value) })}><option value="0.06">Tight</option><option value="0.12">Natural</option><option value="0.2">Loose</option></select></label>
      </div>
      <div className="analysis-options">
        <label><div><strong>Cut filler words</strong><span>um, uh, er, hmm</span></div><Toggle checked={settings.cutFillers} onChange={() => patch({ cutFillers: !settings.cutFillers })} /></label>
      </div>
      <Press className="primary" onClick={load} disabled={status === 'loading' || status === 'creating'}>
        <Wand2 size={17} />{status === 'loading' ? step : words.length ? 'Re-run clean-up' : 'Transcribe & find pauses'}
      </Press>
      {error && <div className="error"><AlertTriangle size={16} />{error}</div>}

      {words.length > 0 && <>
        <div className="review-summary">
          <span><strong>{summary.count}</strong> cuts</span>
          <span><strong>{summary.seconds.toFixed(1)}s</strong> removed</span>
          <Press className="text-button" onClick={() => setKept(new Set())}>Cut all</Press>
          <Press className="text-button" onClick={() => setKept(new Set(cuts.map(cutKey)))}>Keep all</Press>
        </div>
        <div className="review-list">
          {rows.map((row) => row.kind === 'line'
            ? <div className="review-line" key={`l-${row.line.id}`}>
                <Press className="review-time" onClick={() => jump(row.line.start)}>{formatTime(row.line.start)}</Press>
                <p>{row.line.words.map((w, i) => {
                  const cut = w.filler ? cutAt(w) : undefined
                  return cut
                    ? <span key={i} role="button" tabIndex={0} className={`review-word filler ${cut.active ? 'cut' : 'kept'}`} title={cut.active ? 'Will be cut — click to keep' : 'Kept — click to cut'} onClick={() => toggleCut(cut)}>{w.text} </span>
                    : <span key={i} className="review-word">{w.text} </span>
                })}</p>
              </div>
            : <Press className={`review-pause ${row.cut.active ? 'cut' : 'kept'}`} key={`p-${row.cut.id}`} onClick={() => toggleCut(row.cut)}>
                <Pause size={11} />{row.cut.label}<span className="review-pause-state">{row.cut.active ? 'cut' : 'kept'}</span>
              </Press>)}
        </div>
        <Press className="rough-cut" disabled={!summary.count || status === 'creating'} onClick={createMarkedCut}>
          <Scissors size={18} />{status === 'creating' ? 'Writing markers…' : `Create Marked Review Cut (${summary.count})`}
        </Press>
        <p className="hint review-note">Writes each cut as a marker on a copy of the sequence. Removing them automatically comes in Phase 3.</p>
        {status === 'created' && <div className="success"><Check size={16} /> Created "{result}" with {summary.count} cut markers.</div>}
      </>}
    </section>
  )
}

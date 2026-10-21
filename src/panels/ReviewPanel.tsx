import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Check, MessageSquare, Pause, Scissors, Sparkles, Wand2 } from 'lucide-react'
import { Options, Press, Toggle } from '../ui'
import { NO_CLAUDE_KEY, readSetting, SETTINGS, writeSetting } from '../settings'
import { errorMessage, formatTime } from '../uiHelpers'
import { aiEdit, detectSilences, ENGINE_OFF_MESSAGE, engineHealth, transcribeMedia } from '../engineClient'
import type { AiProvider, SilenceRange } from '../engineClient'
import { isPremiereHost, premiere } from '../premiereAdapter'
import { buildCuts, cutsToDecisions, defaultReviewSettings, gapSilences, groupLines, mapToSequence, speechUnits, summarise, wordsForClip } from '../reviewModel'
import type { AiRemoval, ReviewCut, ReviewSettings, ReviewWord } from '../reviewModel'
import { getPremiereTranscriptWords, getPrimaryAudioClips, setPlayhead } from '../reviewHost'
import { demoAiRemovals, demoClips, demoSilences, demoWords } from '../reviewDemo'
import { removeCutsViaXml } from '../xmlCutHost'
import { logged, writeLog } from '../runLog'

type Status = 'idle' | 'loading' | 'ready' | 'thinking' | 'creating' | 'cutting' | 'created' | 'error'

const cutKey = (c: { start: number; end: number }) => `${c.start}-${c.end}`
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const overlaps = (a: { start: number; end: number }, b: { start: number; end: number }) => a.start < b.end && b.start < a.end

export function ReviewPanel({ sequenceId, onCreated, onStatus }: { sequenceId: string; onCreated: (name: string) => void; onStatus: (status: string) => void }) {
  const [settings, setSettings] = useState<ReviewSettings>(defaultReviewSettings)
  const [words, setWords] = useState<ReviewWord[]>([])
  const [silences, setSilences] = useState<SilenceRange[]>([])
  const [aiRemovals, setAiRemovals] = useState<AiRemoval[]>([])
  const [kept, setKept] = useState<Set<string>>(new Set()) // cuts the editor switched off
  const [provider, setProvider] = useState<AiProvider>(() => readSetting(SETTINGS.aiProvider, 'ollama') as AiProvider)
  const [preferLastTake, setPreferLastTake] = useState(true)
  const [chat, setChat] = useState('')
  const [aiNote, setAiNote] = useState('')
  const [sourceNote, setSourceNote] = useState('')
  const [status, setStatus] = useState<Status>('idle')
  const [step, setStep] = useState('')
  const [error, setError] = useState('')
  const [result, setResult] = useState('')

  const cuts: ReviewCut[] = useMemo(
    () => buildCuts(words, silences, settings, aiRemovals).map((c) => ({ ...c, active: !kept.has(cutKey(c)) })),
    [words, silences, settings, aiRemovals, kept],
  )
  const lines = useMemo(() => groupLines(words), [words])
  const units = useMemo(() => speechUnits(words), [words])
  const summary = summarise(cuts)
  useEffect(() => { onStatus(words.length ? `${summary.count} cuts` : '') }, [words.length, summary.count, onStatus])
  const runDetail = `${summary.count} cuts · ${summary.seconds.toFixed(1)}s${aiRemovals.length ? ' · AI' : ''}`
  const patch = (p: Partial<ReviewSettings>) => setSettings((s) => ({ ...s, ...p }))
  const toggleCut = (c: ReviewCut) => setKept((prev) => { const next = new Set(prev); if (next.has(cutKey(c))) next.delete(cutKey(c)); else next.add(cutKey(c)); return next })
  const cutAt = (w: ReviewWord) => cuts.find((c) => w.start >= c.start - 0.01 && w.end <= c.end + 0.01)

  const load = async () => {
    try {
      setError(''); setResult(''); setAiNote(''); setSourceNote(''); setStatus('loading'); setKept(new Set()); setAiRemovals([])
      setStep('Reading A1 clips')
      const clips = await getPrimaryAudioClips()
      if (!clips) {
        // Browser demo: no Premiere, show canned transcript + pauses.
        setStep('Reading transcript (demo)'); await wait(500)
        setWords(wordsForClip(demoWords, demoClips[0], 0)); setSilences(mapToSequence(demoSilences, demoClips[0]))
        setSourceNote('Demo transcript'); setStatus('ready'); return
      }

      // 1. Premiere's own transcript (Text panel) — no download, no engine needed.
      setStep('Reading Premiere transcript')
      let nextWords = await getPremiereTranscriptWords()
      const transcriptSource = nextWords.length ? 'Premiere transcript' : 'Whisper (local engine)'
      const engineUp = !!await engineHealth()
      if (!nextWords.length && !engineUp) {
        throw new Error(`No Premiere transcript on this sequence or its A1 clips. Transcribe it in Premiere’s Text panel, or use Whisper: ${ENGINE_OFF_MESSAGE}`)
      }

      // 2. Pauses: measured in the audio when the engine is running, otherwise gaps between words.
      const nextSilences: SilenceRange[] = []
      if (engineUp) {
        const paths = [...new Set(clips.map((c) => c.path))]
        const whisperWords: ReviewWord[] = []
        for (const [i, path] of paths.entries()) {
          if (!nextWords.length) {
            setStep(`Transcribing ${i + 1}/${paths.length} with Whisper (first run downloads the model)`)
            const transcript = await transcribeMedia(path)
            clips.forEach((clip, ci) => { if (clip.path === path) whisperWords.push(...wordsForClip(transcript.words, clip, ci)) })
          }
          setStep(`Finding pauses ${i + 1}/${paths.length}`)
          // Detect at the lowest threshold once; the min-pause setting filters locally.
          const found = await detectSilences(path, { min_silence: 0.3 })
          clips.forEach((clip) => { if (clip.path === path) nextSilences.push(...mapToSequence(found.silences, clip)) })
        }
        if (!nextWords.length) nextWords = whisperWords.sort((a, b) => a.start - b.start)
      } else {
        nextSilences.push(...gapSilences(nextWords))
      }
      setWords(nextWords); setSilences(nextSilences)
      setSourceNote(`${transcriptSource} · pauses from ${engineUp ? 'the audio' : 'gaps between words (start the engine for exact pauses)'}`)
      setStatus('ready')
      writeLog({ at: new Date(), status: 'OK', action: 'Clean-up scan', result: `${nextWords.length} words · ${nextSilences.length} pauses`, details: { transcript: transcriptSource, pauses: engineUp ? 'audio' : 'word gaps', clips: clips.length } })
    } catch (reason) {
      setError(errorMessage(reason)); setStatus('error')
      writeLog({ at: new Date(), status: 'FAIL', action: 'Clean-up scan', details: { error: errorMessage(reason) } })
    }
  }

  /** Without an instruction: find retakes etc. (replaces earlier AI cuts). With one: a Chat Edit on top. */
  const runAi = async (instruction?: string) => {
    try {
      setError(''); setResult(''); setStatus('thinking')
      if (!await engineHealth()) {
        if (!instruction && !isPremiereHost()) {
          // Browser demo without the engine: canned AI output.
          await wait(700)
          setAiRemovals(demoAiRemovals(units)); setAiNote('Demo: found 1 retake.'); setStatus('ready'); return
        }
        throw new Error(ENGINE_OFF_MESSAGE)
      }
      if (provider === 'claude' && !readSetting(SETTINGS.claudeKey)) throw new Error(NO_CLAUDE_KEY)
      const res = await logged(instruction ? 'Chat Edit' : 'AI pass', { provider, lines: units.length, instruction, lastTake: preferLastTake },
        () => aiEdit(units, { provider, apiKey: readSetting(SETTINGS.claudeKey), instruction, preferLastTake }),
        (r) => `${r.model}: ${r.removals.length} cuts · ${r.keep_ids.length} kept`)
      const found: AiRemoval[] = res.removals.map(({ start, end, reason, note }) => ({ start, end, reason, note }))
      if (!instruction) {
        setAiRemovals(found)
        setAiNote(`${res.model}: ${found.length ? `found ${found.length} section${found.length === 1 ? '' : 's'} to cut` : 'nothing to cut'}.`)
      } else {
        const keepRanges = units.filter((u) => res.keep_ids.includes(u.id))
        setAiRemovals((prev) => [
          ...prev.filter((r) => !keepRanges.some((k) => overlaps(r, k))),
          ...found.filter((f) => !prev.some((p) => p.start === f.start && p.end === f.end)),
        ])
        // Pauses and fillers inside a line the editor asked to keep stay too.
        setKept((prev) => new Set([...prev, ...cuts.filter((c) => keepRanges.some((k) => overlaps(c, k))).map(cutKey)]))
        setAiNote(`"${instruction}": ${found.length} cut, ${keepRanges.length} kept.`)
        setChat('')
      }
      setStatus('ready')
    } catch (reason) {
      setError(errorMessage(reason)); setStatus('error')
    }
  }

  const createMarkedCut = async () => {
    try {
      setError(''); setStatus('creating')
      const name = await logged('Clean-up Markers', { cuts: summary.count }, () => premiere.createRoughCut(sequenceId, cutsToDecisions(cuts), [], { action: 'Clean-up Markers', detail: runDetail }), (n) => n)
      setResult(`Created "${name}" with ${summary.count} cut markers.`)
      onCreated(name)
      setStatus('created')
    } catch (reason) {
      setError(errorMessage(reason)); setStatus('error')
    }
  }

  const removeCuts = async () => {
    try {
      setError(''); setStatus('cutting')
      const done = await logged('Clean-up', { cuts: summary.count, seconds: summary.seconds, ai: aiRemovals.length },
        () => removeCutsViaXml(cuts.filter((c) => c.active), runDetail),
        (d) => d ? `${d.name} · ${(d.stats.removedFrames / d.stats.fps).toFixed(1)}s removed · ${d.stats.transitionsDropped} transitions dropped · ${d.stats.unplaced.length} unplaced` : 'demo')
      if (!done) { await wait(600); setResult(`Demo: would create "Episode — Clean-up 01 (${runDetail})".`) }
      else {
        onCreated(done.name)
        setResult(`Created "${done.name}": ${(done.stats.removedFrames / done.stats.fps).toFixed(1)}s removed across ${summary.count} cuts${done.stats.transitionsDropped ? `, ${done.stats.transitionsDropped} transitions dropped` : ''}${done.stats.unplaced.length ? `. ${done.stats.unplaced.length} clips couldn't be placed and were left unedited: check them` : ''}.`)
      }
      setStatus('created')
    } catch (reason) {
      setError(errorMessage(reason)); setStatus('error')
    }
  }
  const busy = status === 'loading' || status === 'thinking' || status === 'creating' || status === 'cutting'

  const jump = (seconds: number) => { setPlayhead(seconds).catch(() => { /* playhead is a convenience */ }) }

  // Interleave transcript lines with chips (pauses and AI cuts) in time order; a chip sorts before a line starting at the same time.
  const chipCuts = cuts.filter((c) => c.reasons.some((r) => r !== 'filler'))
  const rows = [...lines.map((l) => ({ kind: 'line' as const, at: l.start, line: l })), ...chipCuts.map((c) => ({ kind: 'chip' as const, at: c.start - 0.001, cut: c }))]
    .sort((a, b) => a.at - b.at)

  return (
    <div className="tab-body">
      {words.length > 0 && status !== 'loading'
        ? <Press className="text-button" onClick={load} disabled={busy}><Wand2 size={13} /> Find again</Press>
        : <>
            <p className="lede">Finds pauses and um/uh in Premiere's transcript of A1, plus retakes with AI. Review the cuts, then cut to a new sequence.</p>
            <Press className="primary" onClick={load} disabled={busy}><Wand2 size={17} />{status === 'loading' ? step : 'Find pauses and fillers'}</Press>
          </>}
      {sourceNote && <p className="footnote">{sourceNote}</p>}
      <Options summary={`Pauses over ${settings.minSilence}s, ${settings.cutFillers ? 'fillers cut' : 'fillers kept'}, AI: ${provider === 'claude' ? 'Claude' : 'Ollama'}`}>
        <div className="compact-settings">
          <label>Shortest pause <select value={settings.minSilence} onChange={(e) => patch({ minSilence: Number(e.target.value) })}><option value="0.4">0.4s</option><option value="0.6">0.6s</option><option value="1">1.0s</option><option value="1.5">1.5s</option></select></label>
          <label>Breathing room <select value={settings.padding} onChange={(e) => patch({ padding: Number(e.target.value) })}><option value="0.06">Tight</option><option value="0.12">Natural</option><option value="0.2">Loose</option></select></label>
          <label>AI for retakes <select value={provider} onChange={(e) => { const p = e.target.value as AiProvider; setProvider(p); writeSetting(SETTINGS.aiProvider, p) }}><option value="ollama">Ollama, on this Mac</option><option value="claude">Claude, your API key</option></select></label>
        </div>
        <div className="analysis-options">
          <label><div><strong>Cut filler words</strong><span>um, uh, er, hmm</span></div><Toggle checked={settings.cutFillers} onChange={() => patch({ cutFillers: !settings.cutFillers })} /></label>
          <label><div><strong>Keep the last take</strong><span>Off keeps the best take instead</span></div><Toggle checked={preferLastTake} onChange={() => setPreferLastTake((v) => !v)} /></label>
        </div>
      </Options>
      {error && <div className="error"><AlertTriangle size={16} />{error}</div>}

      {words.length > 0 && <>
        <div className="ai-row">
          <Press className="secondary small" disabled={busy} onClick={() => runAi()}>
            <Sparkles size={14} />{status === 'thinking' && !chat ? 'Reading the transcript…' : aiRemovals.length ? 'Find retakes again' : 'Find retakes and repeats'}
          </Press>
        </div>
        <div className="chat-edit">
          <MessageSquare size={14} />
          <input type="text" placeholder="Tell it what to cut or keep" value={chat} onChange={(e) => setChat(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && chat.trim() && !busy) runAi(chat.trim()) }} />
          <Press className="text-button" disabled={!chat.trim() || busy} onClick={() => runAi(chat.trim())}>{status === 'thinking' && chat ? '…' : 'Apply'}</Press>
        </div>
        {aiNote && <p className="footnote">{aiNote}</p>}

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
                  const cut = cutAt(w)
                  return cut && (w.filler || cut.reasons.some((r) => r !== 'silence' && r !== 'filler'))
                    ? <span key={i} role="button" tabIndex={0} className={`review-word removable ${cut.active ? 'cut' : 'kept'}`} title={cut.active ? 'Will be cut — click to keep' : 'Kept — click to cut'} onClick={() => toggleCut(cut)}>{w.text} </span>
                    : <span key={i} className="review-word">{w.text} </span>
                })}</p>
              </div>
            : <Press className={`review-pause ${row.cut.active ? 'cut' : 'kept'}${row.cut.reasons.some((r) => r !== 'silence' && r !== 'filler') ? ' ai' : ''}`} key={`c-${row.cut.id}`} onClick={() => toggleCut(row.cut)}>
                {row.cut.reasons.includes('silence') && row.cut.reasons.length === 1 ? <Pause size={11} /> : <Sparkles size={11} />}{row.cut.label}<span className="review-pause-state">{row.cut.active ? 'cut' : 'kept'}</span>
              </Press>)}
        </div>
        <Press className="primary results-action" disabled={!summary.count || busy} onClick={removeCuts}>
          <Scissors size={18} />{status === 'cutting' ? 'Cutting…' : `Remove ${summary.count} cuts in a new sequence`}
        </Press>
        <Press className="text-button file-import" disabled={!summary.count || busy} onClick={createMarkedCut}>
          {status === 'creating' ? 'Adding markers…' : 'Mark them instead'}
        </Press>
        <p className="hint review-note">Both build a new sequence. Your original stays untouched. Transitions in the sequence are dropped from the cut version.</p>
        {status === 'created' && <div className="success"><Check size={16} /> {result}</div>}
      </>}
    </div>
  )
}

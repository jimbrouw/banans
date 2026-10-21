import { useState } from 'react'
import { AlertTriangle, ListOrdered, Play, Scissors, Sparkles } from 'lucide-react'
import { Press } from '../ui'
import { errorMessage, formatTime } from '../uiHelpers'
import { ENGINE_OFF_MESSAGE, engineHealth, findSelects, makeChapters, transcribeMedia } from '../engineClient'
import type { AiProvider, ChaptersResult, SelectClip } from '../engineClient'
import { speechUnits, withoutFillers, wordsForClip } from '../reviewModel'
import type { ReviewWord } from '../reviewModel'
import { getPremiereTranscriptWords, getPrimaryAudioClips, setPlayhead } from '../reviewHost'
import { buildClipsViaXml } from '../xmlCutHost'
import { demoSelects } from '../reviewDemo'
import { logged } from '../runLog'
import { NO_CLAUDE_KEY, readSetting, SETTINGS } from '../settings'
import { isPremiereHost } from '../premiereAdapter'

type Status = 'idle' | 'reading' | 'thinking' | 'building' | 'chapters'
const typeLabel: Record<SelectClip['type'], string> = { story: 'Story', opinion: 'Opinion', tip: 'Tip', moment: 'Moment' }

/**
 * The Clips tab: the few clips a senior podcast clip producer would cut, not a pile
 * of markers. Reads the whole episode, proposes five, builds the ones you keep.
 */
export function SelectsPanel({ onCreated }: { onCreated: (name: string) => void }) {
  const [status, setStatus] = useState<Status>('idle')
  const [step, setStep] = useState('')
  const [error, setError] = useState('')
  const [words, setWords] = useState<ReviewWord[]>([])
  const [clips, setClips] = useState<SelectClip[]>([])
  const [dropped, setDropped] = useState<Set<number>>(new Set())
  const [note, setNote] = useState('')
  const [chapters, setChapters] = useState<ChaptersResult | null>(null)
  const busy = status !== 'idle'
  const provider = () => readSetting(SETTINGS.aiProvider, 'ollama') as AiProvider
  const apiKey = () => readSetting(SETTINGS.claudeKey)

  /** The whole episode's words: Premiere's transcript first, Whisper if there is none. */
  const episodeWords = async (): Promise<{ words: ReviewWord[]; audioPath?: string }> => {
    if (words.length) return { words }
    setStep('Reading the transcript')
    const clips = await getPrimaryAudioClips()
    let next = await getPremiereTranscriptWords()
    if (!next.length && clips) {
      if (!await engineHealth()) throw new Error(`No Premiere transcript on this sequence. Transcribe it in Premiere's Text panel, or use Whisper: ${ENGINE_OFF_MESSAGE}`)
      for (const [i, clip] of clips.entries()) {
        setStep(`Transcribing ${i + 1}/${clips.length} with Whisper`)
        next.push(...wordsForClip((await transcribeMedia(clip.path)).words, clip, i))
      }
      next = next.sort((a, b) => a.start - b.start)
    }
    setWords(next)
    // One clip from the start of the timeline means its file is the episode's audio, for liveliness.
    const single = clips && clips.length === 1 && clips[0].start === 0 && clips[0].inPoint === 0 ? clips[0].path : undefined
    return { words: next, audioPath: single }
  }

  const find = async () => {
    try {
      setError(''); setNote(''); setStatus('reading')
      if (!isPremiereHost()) {
        setStep('Reading the episode (demo)'); await new Promise((r) => setTimeout(r, 600))
        setClips(demoSelects().clips); setDropped(new Set()); setNote('Demo: 14 proposed, 9 passed the checks.'); return
      }
      if (provider() === 'claude' && !apiKey()) throw new Error(NO_CLAUDE_KEY)
      const { words: w, audioPath } = await episodeWords()
      if (!await engineHealth()) throw new Error(ENGINE_OFF_MESSAGE)
      setStatus('thinking'); setStep('Reading the whole episode and comparing clips (a few minutes)')
      const units = speechUnits(w)
      const res = await logged('Find clips', { lines: units.length, provider: provider() },
        () => findSelects(units, { provider: provider(), apiKey: apiKey(), audioPath }),
        (r) => `${r.model}: ${r.proposed} proposed, ${r.valid} valid, top ${r.clips.length}: ${r.clips.map((c) => `${formatTime(c.pieces[0].start)} ${c.title}`).join(' | ')}`)
      setClips(res.clips); setDropped(new Set())
      setNote(`${res.proposed} proposed, ${res.valid} passed the checks, ${res.shortlisted} compared head to head.`)
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setStatus('idle'); setStep('')
    }
  }

  const build = async () => {
    const kept = clips.filter((c) => !dropped.has(c.rank))
    try {
      setError(''); setStatus('building')
      const names = await logged('Build clips', { kept: `${kept.length} of ${clips.length}`, dropped: clips.filter((c) => dropped.has(c.rank)).map((c) => c.title).join(' | ') },
        () => buildClipsViaXml(kept.map((c) => ({ title: c.title, pieces: withoutFillers(c.pieces, words) }))),
        (n) => (n ? n.join(' | ') : 'demo'))
      if (names?.length) onCreated(names[names.length - 1])
      setNote(names ? `Built ${names.length} clip sequences in the Clips bin.` : `Demo: would build ${kept.length} clip sequences in the Clips bin.`)
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setStatus('idle')
    }
  }

  const findChapters = async () => {
    try {
      setError(''); setStatus('chapters')
      if (!isPremiereHost()) { setChapters({ model: 'demo', valid: true, text: '0:00 Why she nearly quit\n6:12 Her first World Tour race\n14:40 Training on a budget\n23:05 What juniors get wrong\n31:50 Fuelling on race day\n44:20 What comes next', chapters: [] }); return }
      const { words: w } = await episodeWords()
      if (!await engineHealth()) throw new Error(ENGINE_OFF_MESSAGE)
      setStep('Finding the chapters')
      setChapters(await logged('Chapters', {}, () => makeChapters(speechUnits(w), { provider: provider(), apiKey: apiKey() }), (r) => r.text.replace(/\n/g, ' | ')))
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setStatus('idle'); setStep('')
    }
  }

  const keptCount = clips.filter((c) => !dropped.has(c.rank)).length
  const toggle = (rank: number) => setDropped((d) => { const n = new Set(d); if (n.has(rank)) n.delete(rank); else n.add(rank); return n })

  return (
    <div className="block">
      {!clips.length
        ? <>
            <p className="lede">Reads the whole episode like a clip producer and picks the five clips worth cutting: 20 to 60 seconds, one idea, a hook in the first three seconds, a payoff at the end.</p>
            <Press className="primary" onClick={find} disabled={busy}><Sparkles size={17} />{status === 'reading' || status === 'thinking' ? step : 'Find the best clips'}</Press>
          </>
        : <Press className="text-button" onClick={find} disabled={busy}><Sparkles size={13} /> {status === 'reading' || status === 'thinking' ? step : 'Find again'}</Press>}
      {note && <p className="footnote">{note}</p>}

      {clips.length > 0 && <>
        <div className="clip-cards">
          {clips.map((c) => (
            <div key={c.rank} className={`clip-card ${dropped.has(c.rank) ? 'dropped' : ''}`}>
              <div className="clip-head">
                <span className="clip-rank">{c.rank}</span>
                <strong>{c.title}</strong>
              </div>
              <p className="clip-meta">{typeLabel[c.type]}, {Math.round(c.duration)}s{c.hook_pulled_forward ? ', opens on a line from later in the passage' : ''}</p>
              <p className="clip-open">“{c.opening_line}”</p>
              <p className="clip-why">{c.why}</p>
              <div className="clip-foot">
                <Press className="text-button" onClick={() => setPlayhead(c.pieces[0].start).catch(() => {})}><Play size={12} /> {formatTime(c.pieces[0].start)}</Press>
                <span className="clip-hook" title={`Hook score ${c.hook_score.verdict}/100. To strengthen it: ${c.hook_score.fix}`}>Hook {c.hook_score.verdict}</span>
                {c.title_check.issues[0] && <span className="clip-hook" title={c.title_check.issues.join('\n')}>Title note</span>}
                <Press className={`clip-keep ${dropped.has(c.rank) ? '' : 'on'}`} onClick={() => toggle(c.rank)}>{dropped.has(c.rank) ? 'Dropped' : 'Keep'}</Press>
              </div>
            </div>
          ))}
        </div>
        <Press className="primary results-action" disabled={busy || !keptCount} onClick={build}>
          <Scissors size={17} />{status === 'building' ? 'Building…' : `Build ${keptCount} clip sequence${keptCount === 1 ? '' : 's'}`}
        </Press>
        <p className="footnote">Each goes in the Clips bin as its own sequence, with filler words cut out. Your episode stays as it is.</p>
      </>}

      <div className="chapters-block">
        <div className="step-head"><strong>YouTube chapters</strong>
          <Press className="text-button" onClick={findChapters} disabled={busy}><ListOrdered size={13} /> {status === 'chapters' ? step || 'Working…' : chapters ? 'Again' : 'Make chapters'}</Press>
        </div>
        {chapters && <>
          <textarea className="chapters-text" readOnly value={chapters.text} rows={chapters.text.split('\n').length} onFocus={(e) => e.currentTarget.select()} />
          <p className="footnote">{chapters.valid ? 'Paste into the description. Starts at 0:00, every chapter at least 10 seconds, so YouTube will show them.' : 'YouTube would not show these: it needs 0:00 first, three or more chapters, each at least 10 seconds.'}</p>
        </>}
      </div>
      {error && <div className="error"><AlertTriangle size={16} />{error}</div>}
    </div>
  )
}

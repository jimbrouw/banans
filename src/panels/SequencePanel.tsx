import { Check, Film } from 'lucide-react'
import { Press } from '../ui'
import type { SequenceInfo, SpeakerMapping } from '../types'

const cameras = ['Camera 1', 'Camera 2', 'Wide']

interface SequenceProps {
  sequence: SequenceInfo
  sequences: { id: string; name: string }[]
  loading: boolean
  onSelect: (id: string) => void
}

/** Follows Premiere's active sequence; the picker opens another sequence in the Timeline. */
export function SequencePanel({ sequence, sequences, loading, onSelect }: SequenceProps) {
  return (
    <section className="section sequence-section">
      <div className="section-title"><h2>Active sequence</h2><span className="live-dot">Follows the Timeline</span></div>
      <label className="sequence-row sequence-picker">
        <Film size={20} />
        <select value={sequence.id} onChange={(e) => onSelect(e.target.value)} aria-label="Sequence">
          {!sequences.some((s) => s.id === sequence.id) && <option value={sequence.id}>{sequence.name}</option>}
          {sequences.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </label>
      <div className="transcript-row"><span className="check-icon"><Check size={14} /></span><strong>{loading ? 'Connecting...' : 'Sequence ready'}</strong><span>{Math.floor(sequence.duration / 60)}:{String(sequence.duration % 60).padStart(2, '0')}{sequence.transcriptCoverage ? ` · ${sequence.transcriptCoverage}% demo coverage` : ''}</span></div>
    </section>
  )
}

export function SpeakerMappingPanel({ mappings, onChange }: { mappings: SpeakerMapping[]; onChange: (speaker: string, camera: string) => void }) {
  return (
    <section className="section">
      <div className="section-title"><h2>Speaker mapping</h2><Press className="text-button">Auto-detect</Press></div>
      <div className="mapping-list">
        {mappings.map((mapping, index) => <div className="mapping" key={mapping.speaker}><span className="speaker-dot" style={{ background: index ? '#52cbc7' : '#58a9e8' }} /><strong>{mapping.speaker}</strong><span className="maps-to">maps to</span><select value={mapping.camera} onChange={(e) => onChange(mapping.speaker, e.target.value)}>{cameras.map((camera) => <option key={camera}>{camera}</option>)}</select></div>)}
        <div className="mapping"><span className="speaker-dot wide" /><strong>Fallback</strong><span className="maps-to">uses</span><select defaultValue="Wide">{cameras.map((camera) => <option key={camera}>{camera}</option>)}</select></div>
      </div>
    </section>
  )
}

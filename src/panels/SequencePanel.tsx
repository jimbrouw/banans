import { Check, ChevronDown, Film } from 'lucide-react'
import { Press } from '../ui'
import type { SequenceInfo, SpeakerMapping } from '../types'

const cameras = ['Camera 1', 'Camera 2', 'Wide']

export function SequencePanel({ sequence, loading }: { sequence: SequenceInfo; loading: boolean }) {
  return (
    <section className="section sequence-section">
      <div className="section-title"><h2>Active sequence</h2><span className="live-dot">Connected</span></div>
      <Press className="sequence-row"><Film size={20} /><strong>{sequence.name}</strong><ChevronDown size={17} /></Press>
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

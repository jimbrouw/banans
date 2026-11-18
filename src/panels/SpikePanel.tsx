import { useState } from 'react'
import { Press } from '../ui'
import { allProbes, probeLabels, runColdOpenSpike } from '../spike-coldopen'
import { writeLog } from '../runLog'
import type { Phase0Results, ProbeKey } from '../spike-coldopen'

export function SpikePanel() {
  const [spikeStatus, setSpikeStatus] = useState<'idle' | 'running' | 'done' | 'error'>('idle')
  const [spikeResults, setSpikeResults] = useState<Phase0Results | null>(null)

  const runSpike = async () => {
    try {
      setSpikeStatus('running'); setSpikeResults(null)
      const results = await runColdOpenSpike()
      setSpikeResults(results); setSpikeStatus('done')
      for (const k of Object.keys(probeLabels) as ProbeKey[]) {
        writeLog({ at: new Date(), status: results[k].ok ? 'OK' : 'FAIL', action: `Spike: ${probeLabels[k]}`, details: { detail: results[k].detail } })
      }
    } catch (e) {
      setSpikeStatus('error')
      setSpikeResults(allProbes(false, String(e)))
    }
  }

  return (
    <div className="spike-panel">
      <div className="spike-panel-head">
        <strong>Phase 0 API Spike</strong>
        <span className="hint">Run once on a multi-cam sequence with 2+ clips on V1</span>
      </div>
      <Press className="text-button" disabled={spikeStatus === 'running'} onClick={runSpike}>
        {spikeStatus === 'running' ? 'Running probes…' : 'Run API Spike'}
      </Press>
      {spikeResults && (
        <div className="spike-results">
          {(Object.keys(probeLabels) as ProbeKey[]).map((k) => {
            const r = spikeResults[k]
            return (
              <div key={k} className={`spike-probe ${r.ok ? 'ok' : 'fail'}`}>
                <span className="spike-probe-label">{r.ok ? '✓' : '✗'} {probeLabels[k]}</span>
                <span className="spike-probe-detail">{r.detail}</span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

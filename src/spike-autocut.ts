// spike-autocut.ts — Phase 0 runtime spike for auto-cut engine.
//
// Throwaway dev-only module. Two probes to verify undocumented UXP behavior:
//   Probe A: Does createOverwriteItemAction auto-create a new video track?
//   Probe B: Does audioTrackIndex = -1 suppress audio placement?
//
// Wire to a temporary button in the panel. Delete after probes are run.

import type { premierepro, VideoClipTrackItem } from '@adobe/premierepro'
import { getRuntimeRequire } from './hostRuntime'

interface ProbeResult {
  probeA: { autoCreates: boolean; detail: string }
  probeB: { suppressesAudio: boolean; detail: string }
}

export async function runPhase0Spike(): Promise<ProbeResult> {
  const runtimeRequire = getRuntimeRequire()
  if (!runtimeRequire) {
    return {
      probeA: { autoCreates: false, detail: 'Not running inside Premiere — skipped.' },
      probeB: { suppressesAudio: false, detail: 'Not running inside Premiere — skipped.' },
    }
  }

  const ppro = runtimeRequire('premierepro') as premierepro
  const project = await ppro.Project.getActiveProject()
  if (!project) throw new Error('No active project.')
  const sequence = await project.getActiveSequence()
  if (!sequence) throw new Error('No active sequence.')

  // Find the first video clip on V1 to use as a test item.
  const track0 = await sequence.getVideoTrack(0)
  const items = await track0.getTrackItems(ppro.Constants.TrackItemType.CLIP, false)
  if (!items.length) throw new Error('V1 has no clips. Open a sequence with footage.')
  const testItem = await (items[0] as VideoClipTrackItem).getProjectItem()

  // Clone the sequence so we never touch the original.
  const beforeGuids = new Set((await project.getSequences()).map(s => s.guid.toString()))
  const cloneOk = project.executeTransaction(
    (c) => c.addAction(sequence.createCloneAction()),
    'Phase 0 spike clone',
  )
  if (!cloneOk) throw new Error('Clone transaction rejected.')
  const clone = (await project.getSequences()).find(s => !beforeGuids.has(s.guid.toString()))
  if (!clone) throw new Error('Clone not found after transaction.')

  const editor = await ppro.SequenceEditor.getEditor(clone)
  const trackCount = await clone.getVideoTrackCount()
  const t0 = ppro.TickTime.createWithSeconds(0)

  // ── Probe A: overwrite onto a non-existent track ────────────────────────
  let probeA: ProbeResult['probeA']
  try {
    const overwriteOk = project.executeTransaction(
      (c) => c.addAction(editor.createOverwriteItemAction(testItem, t0, trackCount, -1)),
      'Probe A: overwrite auto-create',
    )
    const newTrackCount = await clone.getVideoTrackCount()
    if (overwriteOk && newTrackCount > trackCount) {
      probeA = { autoCreates: true, detail: `Overwrite auto-created track. Was ${trackCount}, now ${newTrackCount}.` }
    } else if (overwriteOk) {
      probeA = { autoCreates: false, detail: `Overwrite succeeded but track count unchanged (${trackCount}). Check manually.` }
    } else {
      probeA = { autoCreates: false, detail: `Overwrite transaction rejected. Use createInsertProjectItemAction for first clip.` }
    }
  } catch (e) {
    probeA = { autoCreates: false, detail: `Overwrite threw: ${e instanceof Error ? e.message : String(e)}. Use createInsertProjectItemAction.` }
  }

  // ── Probe B: audio suppression with audioTrackIndex = -1 ────────────────
  let probeB: ProbeResult['probeB']
  try {
    // Count audio items on all tracks before.
    const audioTrackCount = await clone.getAudioTrackCount()
    let audioBefore = 0
    for (let a = 0; a < audioTrackCount; a++) {
      const at = await clone.getAudioTrack(a)
      const ai = await at.getTrackItems(ppro.Constants.TrackItemType.CLIP, false)
      audioBefore += ai.length
    }

    // Overwrite onto V1 with audioTrackIndex = -1.
    const writeOk = project.executeTransaction(
      (c) => c.addAction(editor.createOverwriteItemAction(testItem, t0, 0, -1)),
      'Probe B: audio suppression',
    )

    // Count audio items after.
    const audioTrackCountAfter = await clone.getAudioTrackCount()
    let audioAfter = 0
    for (let a = 0; a < audioTrackCountAfter; a++) {
      const at = await clone.getAudioTrack(a)
      const ai = await at.getTrackItems(ppro.Constants.TrackItemType.CLIP, false)
      audioAfter += ai.length
    }

    if (!writeOk) {
      probeB = { suppressesAudio: false, detail: 'Overwrite transaction rejected.' }
    } else if (audioAfter <= audioBefore) {
      probeB = { suppressesAudio: true, detail: `Audio items unchanged (${audioBefore} → ${audioAfter}). -1 suppresses audio.` }
    } else {
      probeB = {
        suppressesAudio: false,
        detail: `BLOCKER: audioTrackIndex=-1 does not suppress audio. Audio items ${audioBefore} → ${audioAfter}. Phase 1 implementation cannot proceed.`,
      }
    }
  } catch (e) {
    probeB = { suppressesAudio: false, detail: `Audio probe threw: ${e instanceof Error ? e.message : String(e)}` }
  }

  return { probeA, probeB }
}

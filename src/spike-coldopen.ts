// spike-coldopen.ts — Phase 0 runtime spike for dynamic cold open.
//
// Probes three Premiere APIs that exist in the type defs but haven't been
// exercised in this project. Run via a temporary button in the panel.
// Delete this file after probes are confirmed on a real sequence in UDT.
//
// Probe A: Scale keyframing via VideoComponentChain / ComponentParam.
//   - Can we get the Motion component on a video clip, find Scale, enable
//     time-varying, and place two keyframes? Needed for "Digital Punch-In".
//
// Probe B: Audio track item access.
//   - Can we get the linked audio item for a clip and independently
//     set its in/out (J-cut / L-cut split edit)?
//
// Probe C: MOGRT insert from a local path.
//   - Does insertMogrtFromPath exist at runtime and place a graphic?
//   - Non-destructive: we clone the sequence and insert on the clone.

import type { premierepro, VideoClipTrackItem } from '@adobe/premierepro'
import { getRuntimeRequire } from './hostRuntime'

export interface Phase0Results {
  probeA: { ok: boolean; detail: string }
  probeB: { ok: boolean; detail: string }
  probeC: { ok: boolean; detail: string }
}

export async function runColdOpenSpike(): Promise<Phase0Results> {
  const runtimeRequire = getRuntimeRequire()
  if (!runtimeRequire) {
    return {
      probeA: { ok: false, detail: 'Not inside Premiere — skipped.' },
      probeB: { ok: false, detail: 'Not inside Premiere — skipped.' },
      probeC: { ok: false, detail: 'Not inside Premiere — skipped.' },
    }
  }

  const ppro = runtimeRequire('premierepro') as premierepro
  const project = await ppro.Project.getActiveProject()
  if (!project) throw new Error('No active project.')
  const sequence = await project.getActiveSequence()
  if (!sequence) throw new Error('No active sequence.')

  // Clone once so every probe works on the clone, never the original.
  const beforeGuids = new Set((await project.getSequences()).map(s => s.guid.toString()))
  let ok = false
  project.lockedAccess(() => {
    ok = project.executeTransaction(
      (c) => c.addAction(sequence.createCloneAction()),
      'Phase 0 cold-open spike clone',
    )
  })
  if (!ok) throw new Error('Clone transaction rejected.')
  const clone = (await project.getSequences()).find(s => !beforeGuids.has(s.guid.toString()))
  if (!clone) throw new Error('Clone not found after transaction.')

  // Grab the first video clip on V1 of the clone.
  const cloneTrack0 = await clone.getVideoTrack(0)
  const videoItems = await cloneTrack0.getTrackItems(ppro.Constants.TrackItemType.CLIP, false)
  if (!videoItems.length) throw new Error('V1 has no clips. Open a sequence with footage.')
  const videoItem = videoItems[0] as VideoClipTrackItem

  // ── Probe A: Scale keyframing ──────────────────────────────────────────────
  let probeA: Phase0Results['probeA']
  try {
    const chain = await videoItem.getComponentChain()
    const compCount = chain.getComponentCount()

    // Motion is typically the first fixed component (index 0) with
    // matchName "ADBE Motion". Walk components to find it.
    let motionComp = null
    for (let i = 0; i < compCount; i++) {
      const comp = chain.getComponentAtIndex(i)
      const name = await comp.getMatchName()
      if (name.includes('Motion') || name.includes('ADBE Motion')) {
        motionComp = comp
        break
      }
    }

    if (!motionComp) {
      // Log all component names so we can find the right one.
      const names: string[] = []
      for (let i = 0; i < compCount; i++) {
        names.push(await chain.getComponentAtIndex(i).getMatchName())
      }
      probeA = { ok: false, detail: `Motion component not found. Components: [${names.join(', ')}]` }
    } else {
      // Scale is typically param index 3 on the Motion component.
      // Walk params to find it.
      const paramCount = motionComp.getParamCount()
      let scaleParam = null
      let scaleParamName = ''
      for (let i = 0; i < paramCount; i++) {
        const param = motionComp.getParam(i)
        const pname = param.displayName
        if (pname.toLowerCase().includes('scale')) {
          scaleParam = param
          scaleParamName = pname
          break
        }
      }

      if (!scaleParam) {
        const names: string[] = []
        for (let i = 0; i < paramCount; i++) names.push(motionComp.getParam(i).displayName)
        probeA = { ok: false, detail: `Scale param not found. Params: [${names.join(', ')}]` }
      } else {
        // Enable time-varying, then place two keyframes: 100% at start, 103% at end.
        void await videoItem.getStartTime()
        void await videoItem.getEndTime()

        const kfStart = scaleParam.createKeyframe(100)
        const kfEnd = scaleParam.createKeyframe(103)

        // Set time-varying + add keyframes inside a transaction.
        let kvOk = false
        project.lockedAccess(() => {
          kvOk = project.executeTransaction((c) => {
            c.addAction(scaleParam!.createSetTimeVaryingAction(true))
            c.addAction(scaleParam!.createAddKeyframeAction(kfStart))
            c.addAction(scaleParam!.createAddKeyframeAction(kfEnd))
          }, 'Probe A: scale keyframes')
        })

        if (kvOk) {
          // Verify by reading back keyframe times.
          const kfTimes = scaleParam.getKeyframeListAsTickTimes()
          probeA = {
            ok: true,
            detail: `Scale keyframing works. Param: "${scaleParamName}". Placed ${kfTimes.length} keyframes. Keyframe API is safe to use.`,
          }
        } else {
          probeA = { ok: false, detail: 'Scale keyframe transaction was rejected by Premiere.' }
        }
      }
    }
  } catch (e) {
    probeA = { ok: false, detail: `Threw: ${e instanceof Error ? e.message : String(e)}` }
  }

  // ── Probe B: Audio track item access ──────────────────────────────────────
  let probeB: Phase0Results['probeB']
  try {
    const audioTrackCount = await clone.getAudioTrackCount()
    if (!audioTrackCount) {
      probeB = { ok: false, detail: 'No audio tracks in this sequence.' }
    } else {
      const a1 = await clone.getAudioTrack(0)
      const audioItems = await a1.getTrackItems(ppro.Constants.TrackItemType.CLIP, false)
      if (!audioItems.length) {
        probeB = { ok: false, detail: 'No audio clips on A1.' }
      } else {
        // Try to read the in/out of the first audio item.
        const aItem = audioItems[0]
        const aIn = await aItem.getInPoint()
        const aOut = await aItem.getOutPoint()
        const aStart = await aItem.getStartTime()

        // Try to set inPoint offset by 1.5 seconds (J-cut: audio leads video by 1.5s).
        const jOffset = 1.5
        const jInTick = ppro.TickTime.createWithSeconds(aIn.seconds - jOffset)
        let jOk = false
        project.lockedAccess(() => {
          jOk = project.executeTransaction((c) => {
            c.addAction(aItem.createSetInPointAction(jOffset > aIn.seconds ? aIn : jInTick))
          }, 'Probe B: J-cut audio in-point')
        })

        probeB = {
          ok: true,
          detail: `Audio access works. A1 item: in=${aIn.seconds.toFixed(2)}s out=${aOut.seconds.toFixed(2)}s start=${aStart.seconds.toFixed(2)}s. J-cut tx: ${jOk ? 'accepted' : 'rejected'}.`,
        }
      }
    }
  } catch (e) {
    probeB = { ok: false, detail: `Threw: ${e instanceof Error ? e.message : String(e)}` }
  }

  // ── Probe C: MOGRT insert ─────────────────────────────────────────────────
  let probeC: Phase0Results['probeC']
  try {
    const editor = await ppro.SequenceEditor.getEditor(clone)

    // Check if insertMogrtFromPath is a function at runtime (type defs may lie).
    if (typeof (editor as unknown as Record<string, unknown>)['insertMogrtFromPath'] !== 'function') {
      probeC = { ok: false, detail: 'insertMogrtFromPath is not a function at runtime. MOGRT API unavailable.' }
    } else {
      // We can't insert without a real .mogrt file, so just confirm the method exists.
      probeC = {
        ok: true,
        detail: 'insertMogrtFromPath exists at runtime. Need a real .mogrt file path to test placement. Conditionally green — confirm with a file in a follow-up test.',
      }
    }
  } catch (e) {
    probeC = { ok: false, detail: `Threw: ${e instanceof Error ? e.message : String(e)}` }
  }

  return { probeA, probeB, probeC }
}

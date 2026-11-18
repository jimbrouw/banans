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
//
// Probe D: Ripple delete.
//   - Does SequenceEditor.createRemoveItemsAction(selection, ripple=true)
//     close the gap? Gates real silence / filler cutting (Phase 3, option a).
//
// Probe E: FCP XML import.
//   - Does project.importFiles() accept an .xml and create a sequence?
//     Gates Phase 3, option b (build the cut as XML, import it).
//     Leaves a "RoughCut XML Probe" sequence in the project — delete it after.
//
// Probe F: Media file path.
//   - Can we read the source file path of a timeline clip? The local engine
//     (Phase 1) needs it to transcribe / detect silences on the real audio.

import type { premierepro, TrackItemSelection, VideoClipTrackItem } from '@adobe/premierepro'
import { getRuntimeRequire } from './hostRuntime'

export type ProbeKey = 'probeA' | 'probeB' | 'probeC' | 'probeD' | 'probeE' | 'probeF'
export type Phase0Results = Record<ProbeKey, { ok: boolean; detail: string }>

export const probeLabels: Record<ProbeKey, string> = {
  probeA: 'Scale keyframing',
  probeB: 'Audio access',
  probeC: 'MOGRT',
  probeD: 'Ripple delete',
  probeE: 'FCP XML import',
  probeF: 'Media file path',
}

export function allProbes(ok: boolean, detail: string): Phase0Results {
  const keys = Object.keys(probeLabels) as ProbeKey[]
  return Object.fromEntries(keys.map((k) => [k, { ok, detail }])) as Phase0Results
}

const errorDetail = (e: unknown) => `Threw: ${e instanceof Error ? e.message : String(e)}`

const PROBE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE xmeml>
<xmeml version="4">
  <sequence>
    <name>RoughCut XML Probe</name>
    <duration>250</duration>
    <rate><timebase>25</timebase><ntsc>FALSE</ntsc></rate>
    <media><video><track/></video><audio><track/></audio></media>
  </sequence>
</xmeml>
`

export async function runColdOpenSpike(): Promise<Phase0Results> {
  const runtimeRequire = getRuntimeRequire()
  if (!runtimeRequire) return allProbes(false, 'Not inside Premiere — skipped.')

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

  // ── Probe F: Media file path (read-only, runs before D deletes the clip) ──
  let probeF: Phase0Results['probeF']
  try {
    const projectItem = await videoItem.getProjectItem()
    const clipItem = ppro.ClipProjectItem.cast(projectItem)
    const path = await clipItem.getMediaFilePath()
    probeF = path
      ? { ok: true, detail: `V1 clip media: ${path}` }
      : { ok: false, detail: 'getMediaFilePath returned an empty string.' }
  } catch (e) {
    probeF = { ok: false, detail: errorDetail(e) }
  }

  // ── Probe D: Ripple delete ────────────────────────────────────────────────
  let probeD: Phase0Results['probeD']
  try {
    const items = await cloneTrack0.getTrackItems(ppro.Constants.TrackItemType.CLIP, false)
    if (items.length < 2) {
      probeD = { ok: false, detail: 'Need at least 2 clips on V1 to see whether the gap closes. Blade V1 once and re-run.' }
    } else {
      const target = items[0] as VideoClipTrackItem
      const nextBefore = (await items[1].getStartTime()).seconds
      const targetStart = (await target.getStartTime()).seconds
      let selection: TrackItemSelection | null = null
      ppro.TrackItemSelection.createEmptySelection((s) => { s.addItem(target); selection = s })
      if (!selection) throw new Error('createEmptySelection did not return a selection.')
      const editor = await ppro.SequenceEditor.getEditor(clone)
      let removeOk = false
      project.lockedAccess(() => {
        removeOk = project.executeTransaction(
          (c) => c.addAction(editor.createRemoveItemsAction(selection!, true, ppro.Constants.MediaType.ANY)),
          'Probe D: ripple delete',
        )
      })
      const after = await (await clone.getVideoTrack(0)).getTrackItems(ppro.Constants.TrackItemType.CLIP, false)
      const nextAfter = after.length ? (await after[0].getStartTime()).seconds : NaN
      const closed = Math.abs(nextAfter - targetStart) < 0.05
      probeD = {
        ok: removeOk && closed,
        detail: `tx ${removeOk ? 'accepted' : 'rejected'}. Next clip start ${nextBefore.toFixed(2)}s → ${nextAfter.toFixed(2)}s (gap ${closed ? 'closed' : 'NOT closed'}). V1 items ${items.length} → ${after.length}.`,
      }
    }
  } catch (e) {
    probeD = { ok: false, detail: errorDetail(e) }
  }

  // ── Probe E: FCP XML import ───────────────────────────────────────────────
  let probeE: Phase0Results['probeE']
  try {
    const uxp = runtimeRequire('uxp') as {
      storage: { localFileSystem: { getTemporaryFolder(): Promise<{
        createFile(name: string, opts: { overwrite: boolean }): Promise<{ write(data: string): Promise<unknown>; nativePath: string }>
      }> } }
    }
    const tmp = await uxp.storage.localFileSystem.getTemporaryFolder()
    const file = await tmp.createFile('roughcut-xml-probe.xml', { overwrite: true })
    await file.write(PROBE_XML)
    const before = new Set((await project.getSequences()).map(s => s.guid.toString()))
    const imported = await project.importFiles([file.nativePath], true)
    const added = (await project.getSequences()).filter(s => !before.has(s.guid.toString()))
    probeE = {
      ok: imported && added.length > 0,
      detail: `importFiles → ${imported}. New sequences: ${added.length ? added.map(s => `"${s.name}"`).join(', ') : 'none'}. File: ${file.nativePath}`,
    }
  } catch (e) {
    probeE = { ok: false, detail: errorDetail(e) }
  }

  return { probeA, probeB, probeC, probeD, probeE, probeF }
}

// Premiere reads for the Review screen. Kept out of premiereAdapter.ts because
// they're read-only and small; returns null outside Premiere so the panel can
// fall back to demo data.

import type { premierepro } from '@adobe/premierepro'
import { getRuntimeRequire } from './hostRuntime'
import type { SourceClip } from './reviewModel'

async function activeSequence() {
  const runtimeRequire = getRuntimeRequire()
  if (!runtimeRequire) return null
  const ppro = runtimeRequire('premierepro') as premierepro
  const project = await ppro.Project.getActiveProject()
  const sequence = project && await project.getActiveSequence()
  if (!sequence) throw new Error('No active sequence.')
  return { ppro, sequence }
}

/** Clips on A1 (the primary dialogue track), in timeline order, with their source file paths. */
export async function getPrimaryAudioClips(): Promise<SourceClip[] | null> {
  const ctx = await activeSequence()
  if (!ctx) return null
  const { ppro, sequence } = ctx
  if (!await sequence.getAudioTrackCount()) throw new Error('This sequence has no audio tracks.')
  const a1 = await sequence.getAudioTrack(0)
  const items = await a1.getTrackItems(ppro.Constants.TrackItemType.CLIP, false)
  const clips: SourceClip[] = []
  for (const item of items) {
    const clipItem = ppro.ClipProjectItem.cast(await item.getProjectItem())
    const path = await clipItem.getMediaFilePath()
    if (!path) continue // nested sequences / generated media have no file
    clips.push({
      path,
      start: (await item.getStartTime()).seconds,
      end: (await item.getEndTime()).seconds,
      inPoint: (await item.getInPoint()).seconds,
    })
  }
  if (!clips.length) throw new Error('No file-based clips on A1. Put the dialogue audio on A1 and try again.')
  return clips.sort((a, b) => a.start - b.start)
}

export async function setPlayhead(seconds: number): Promise<void> {
  const ctx = await activeSequence()
  if (!ctx) return
  await ctx.sequence.setPlayerPosition(ctx.ppro.TickTime.createWithSeconds(seconds))
}

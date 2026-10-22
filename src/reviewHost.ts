// Premiere reads for the Review screen. Kept out of premiereAdapter.ts because
// they're read-only and small; returns null outside Premiere so the panel can
// fall back to demo data.

import type { premierepro } from '@adobe/premierepro'
import { getRuntimeRequire } from './hostRuntime'
import { mapToSequence } from './reviewModel'
import type { ReviewWord, SourceClip } from './reviewModel'
import { transcriptWordsFromJson } from './transcriptParse'

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

const toReviewWords = (words: ReturnType<typeof transcriptWordsFromJson>, prefix: string): ReviewWord[] =>
  words.map((w) => ({ text: w.text, start: w.start, end: w.end, filler: w.filler, segment: `${prefix}:${w.segment}` }))

/**
 * Premiere's own transcript at word level: the sequence transcript if there is
 * one, otherwise each A1 clip's source transcript placed on the timeline.
 * Returns [] when nothing has been transcribed.
 */
export async function getPremiereTranscriptWords(): Promise<ReviewWord[]> {
  const ctx = await activeSequence()
  if (!ctx) return []
  const { ppro, sequence } = ctx
  try {
    const json = await ppro.Transcript.exportToJSON(ppro.ClipProjectItem.cast(await sequence.getProjectItem()))
    const words = json ? transcriptWordsFromJson(json) : []
    if (words.length) return toReviewWords(words, 'seq')
  } catch { /* no sequence transcript; try the clips */ }

  const a1 = await sequence.getAudioTrack(0)
  const items = await a1.getTrackItems(ppro.Constants.TrackItemType.CLIP, false)
  const out: ReviewWord[] = []
  for (const [i, item] of items.entries()) {
    try {
      const json = await ppro.Transcript.exportToJSON(ppro.ClipProjectItem.cast(await item.getProjectItem()))
      if (!json) continue
      // Clip transcripts are in source time; place them where the clip sits on the timeline.
      const clip = { path: '', start: (await item.getStartTime()).seconds, end: (await item.getEndTime()).seconds, inPoint: (await item.getInPoint()).seconds }
      out.push(...toReviewWords(mapToSequence(transcriptWordsFromJson(json), clip), `clip${i}`))
    } catch { /* clip without a transcript */ }
  }
  return out.sort((a, b) => a.start - b.start)
}

/** Every audio track that has file-based clips, for picking mic tracks in Podcast Mode. */
export async function getAudioTracks(): Promise<{ index: number; clips: SourceClip[] }[] | null> {
  const ctx = await activeSequence()
  if (!ctx) return null
  const { ppro, sequence } = ctx
  const tracks: { index: number; clips: SourceClip[] }[] = []
  for (let index = 0; index < await sequence.getAudioTrackCount(); index++) {
    const items = await (await sequence.getAudioTrack(index)).getTrackItems(ppro.Constants.TrackItemType.CLIP, false)
    const clips: SourceClip[] = []
    for (const item of items) {
      const path = await ppro.ClipProjectItem.cast(await item.getProjectItem()).getMediaFilePath()
      if (path) clips.push({ path, start: (await item.getStartTime()).seconds, end: (await item.getEndTime()).seconds, inPoint: (await item.getInPoint()).seconds })
    }
    if (clips.length) tracks.push({ index, clips })
  }
  return tracks
}

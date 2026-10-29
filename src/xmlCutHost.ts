// Premiere glue for the XML cutting path: export the active sequence as FCP XML,
// remove the cut ranges (xmlCut.ts), import the result as a new sequence and
// open it. The original sequence is never touched.

import type { premierepro, ProjectItem } from '@adobe/premierepro'
import { getRuntimeRequire } from './hostRuntime'
import { applyCutsToXml, applyPiecesToXml, mergeSequencesXml } from './xmlCut'
import { CLIPS_BIN, MEDIA_BIN, nextSequenceName, sourceBaseName } from './sequenceNames'
import { childBin, fileInRoughCutBin, gatherImported, rootItemIds, roughCutBin } from './projectBin'
import type { CutRangeSeconds, XmlCutStats } from './xmlCut'

interface UxpEntry { name: string; nativePath: string; read(): Promise<string>; write(data: string): Promise<unknown> }
interface UxpFolder {
  nativePath: string
  createFile(name: string, opts: { overwrite: boolean }): Promise<UxpEntry>
  getEntry(name: string): Promise<UxpEntry>
}
type Uxp = { storage: { localFileSystem: { getTemporaryFolder(): Promise<UxpFolder> } } }

/** Returns null outside Premiere (browser demo). */
export async function removeCutsViaXml(cuts: CutRangeSeconds[], detail: string): Promise<{ name: string; stats: XmlCutStats } | null> {
  const runtimeRequire = getRuntimeRequire()
  if (!runtimeRequire) return null
  const ppro = runtimeRequire('premierepro') as premierepro
  const tmp = await (runtimeRequire('uxp') as Uxp).storage.localFileSystem.getTemporaryFolder()

  const project = await ppro.Project.getActiveProject()
  const sequence = project && await project.getActiveSequence()
  if (!project || !sequence) throw new Error('No active sequence.')

  const stamp = Date.now()
  const exportName = `roughcut-export-${stamp}.xml`
  const exportPath = `${tmp.nativePath.replace(/\/$/, '')}/${exportName}`
  if (!await ppro.ProjectConverter.exportAsFinalCutProXML(sequence, exportPath, true)) {
    throw new Error('Premiere could not export the sequence as Final Cut Pro XML.')
  }
  const exported = await (await tmp.getEntry(exportName)).read()

  const name = nextSequenceName(sequence.name, 'Clean-up', detail, (await project.getSequences()).map((s) => s.name))
  const { xml, stats } = applyCutsToXml(exported, cuts, name)

  const outFile = await tmp.createFile(`roughcut-cut-${stamp}.xml`, { overwrite: true })
  await outFile.write(xml)
  const before = new Set((await project.getSequences()).map((s) => s.guid.toString()))
  const rcBin = await roughCutBin(ppro, project)
  const mediaBin = rcBin && await childBin(ppro, project, rcBin, MEDIA_BIN)
  const rootBefore = await rootItemIds(project)
  if (!await project.importFiles([outFile.nativePath], true)) throw new Error(`Premiere could not import the cut XML (${outFile.nativePath}).`)
  const created = (await project.getSequences()).find((s) => !before.has(s.guid.toString()))
  if (!created) throw new Error(`Imported the cut XML but no new sequence appeared. The file is at ${outFile.nativePath}.`)
  const createdItem = await created.getProjectItem()
  if (mediaBin) await gatherImported(project, rootBefore, [createdItem], mediaBin)
  await fileInRoughCutBin(ppro, project, createdItem)
  await project.openSequence(created)
  await project.setActiveSequence(created)
  return { name: created.name, stats }
}

/**
 * Build each clip as its own sequence in a "Clips — <episode>" bin (inside RoughCut): pieces of
 * the active sequence, played in the order given. Exports the sequence once and imports every
 * clip in one XML so Premiere copies the media once; the copies go in an "Imported media" bin.
 * Returns the new sequence names (null in the browser demo).
 */
export async function buildClipsViaXml(clips: { title: string; pieces: CutRangeSeconds[] }[]): Promise<string[] | null> {
  const runtimeRequire = getRuntimeRequire()
  if (!runtimeRequire) return null
  const ppro = runtimeRequire('premierepro') as premierepro
  const tmp = await (runtimeRequire('uxp') as Uxp).storage.localFileSystem.getTemporaryFolder()
  const project = await ppro.Project.getActiveProject()
  const sequence = project && await project.getActiveSequence()
  if (!project || !sequence) throw new Error('No active sequence.')

  const stamp = Date.now()
  const exportName = `roughcut-export-${stamp}.xml`
  if (!await ppro.ProjectConverter.exportAsFinalCutProXML(sequence, `${tmp.nativePath.replace(/\/$/, '')}/${exportName}`, true)) {
    throw new Error('Premiere could not export the sequence as Final Cut Pro XML.')
  }
  const exported = await (await tmp.getEntry(exportName)).read()

  const names: string[] = []
  const xmls: string[] = []
  for (const clip of clips) {
    const name = nextSequenceName(sequence.name, 'Clip', clip.title, [...(await project.getSequences()).map((s) => s.name), ...names])
    xmls.push(applyPiecesToXml(exported, clip.pieces, name).xml)
    names.push(name)
  }

  const rcBin = await roughCutBin(ppro, project)
  const folder = rcBin && await childBin(ppro, project, rcBin, `${CLIPS_BIN} — ${sourceBaseName(sequence.name)}`)
  const mediaBin = folder && await childBin(ppro, project, folder, MEDIA_BIN)

  /** Import XML files, return the sequences they added, filed in the clips folder. */
  const importXml = async (files: string[]) => {
    const seqsBefore = new Set((await project.getSequences()).map((s) => s.guid.toString()))
    const rootBefore = await rootItemIds(project)
    if (!await project.importFiles(files, true, (mediaBin ?? undefined) as ProjectItem | undefined)) return null
    const made = (await project.getSequences()).filter((s) => !seqsBefore.has(s.guid.toString()))
    const items = await Promise.all(made.map((s) => s.getProjectItem()))
    if (mediaBin) await gatherImported(project, rootBefore, items, mediaBin)
    for (const item of items) await fileInRoughCutBin(ppro, project, item, folder ? undefined : CLIPS_BIN, folder)
    return made
  }

  const all = await tmp.createFile(`roughcut-clips-${stamp}.xml`, { overwrite: true })
  await all.write(xmls.length > 1 ? mergeSequencesXml(xmls) : xmls[0])
  let made = await importXml([all.nativePath])
  if (made && made.length < clips.length) {
    throw new Error(`Premiere imported ${made.length} of ${clips.length} clip sequences (${all.nativePath}). Check the ${CLIPS_BIN} bin before building again.`)
  }
  if (!made) {
    // The combined file didn't import: fall back to one file per clip (more media copies, but it works).
    made = []
    for (const [i, xml] of xmls.entries()) {
      const file = await tmp.createFile(`roughcut-clip-${stamp}-${i + 1}.xml`, { overwrite: true })
      await file.write(xml)
      const one = await importXml([file.nativePath])
      if (!one?.length) throw new Error(`Premiere could not import clip ${i + 1} (${file.nativePath}).`)
      made.push(...one)
    }
  }
  return names.filter((n) => made!.some((s) => s.name === n))
}

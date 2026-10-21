// Premiere glue for the XML cutting path: export the active sequence as FCP XML,
// remove the cut ranges (xmlCut.ts), import the result as a new sequence and
// open it. The original sequence is never touched.

import type { premierepro } from '@adobe/premierepro'
import { getRuntimeRequire } from './hostRuntime'
import { applyCutsToXml } from './xmlCut'
import { nextSequenceName } from './sequenceNames'
import { fileInRoughCutBin } from './projectBin'
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
  if (!await project.importFiles([outFile.nativePath], true)) throw new Error(`Premiere could not import the cut XML (${outFile.nativePath}).`)
  const created = (await project.getSequences()).find((s) => !before.has(s.guid.toString()))
  if (!created) throw new Error(`Imported the cut XML but no new sequence appeared. The file is at ${outFile.nativePath}.`)
  await fileInRoughCutBin(ppro, project, await created.getProjectItem())
  await project.setActiveSequence(created)
  return { name: created.name, stats }
}

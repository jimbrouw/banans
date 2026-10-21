// The "RoughCut" bin that every generated sequence is filed into, so the
// project root stays tidy. Filing is best-effort: a failure never fails a run.

import type { CompoundAction, FolderItem, premierepro, Project, ProjectItem } from '@adobe/premierepro'
import { BIN_NAME } from './sequenceNames'

function tx(project: Project, build: (c: CompoundAction) => void, label: string): boolean {
  let ok = false
  project.lockedAccess(() => { ok = project.executeTransaction(build, label) })
  return ok
}

/** The RoughCut bin at the project root, created on first use. */
export async function roughCutBin(ppro: premierepro, project: Project): Promise<FolderItem | null> {
  const find = async () => {
    const root = await project.getRootItem()
    const hit = (await root.getItems()).find((i) => i.type === ppro.ProjectItem.TYPE_BIN && i.name === BIN_NAME)
    return { root, bin: hit ? ppro.FolderItem.cast(hit) : null }
  }
  const { root, bin } = await find()
  if (bin) return bin
  if (!tx(project, (c) => c.addAction(root.createBinAction(BIN_NAME, false)), 'Create RoughCut bin')) return null
  return (await find()).bin
}

/** Move a generated sequence into the RoughCut bin. Returns false if it couldn't. */
export async function fileInRoughCutBin(ppro: premierepro, project: Project, item: ProjectItem): Promise<boolean> {
  try {
    const bin = await roughCutBin(ppro, project)
    if (!bin) return false
    const root = await project.getRootItem()
    return tx(project, (c) => c.addAction(root.createMoveItemAction(item, bin)), 'Move into RoughCut bin')
  } catch {
    return false
  }
}

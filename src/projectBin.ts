// The "RoughCut" bin that every generated sequence is filed into, so the
// project root stays tidy. Filing is best-effort: a failure never fails a run.

import type { CompoundAction, FolderItem, premierepro, Project, ProjectItem } from '@adobe/premierepro'
import { BIN_NAME } from './sequenceNames'

function tx(project: Project, build: (c: CompoundAction) => void, label: string): boolean {
  let ok = false
  project.lockedAccess(() => { ok = project.executeTransaction(build, label) })
  return ok
}

/** A bin at the project root (the RoughCut bin by default), created on first use. */
export async function roughCutBin(ppro: premierepro, project: Project, name = BIN_NAME): Promise<FolderItem | null> {
  const find = async () => {
    const root = await project.getRootItem()
    const hit = (await root.getItems()).find((i) => i.type === ppro.ProjectItem.TYPE_BIN && i.name === name)
    return { root, bin: hit ? ppro.FolderItem.cast(hit) : null }
  }
  const { root, bin } = await find()
  if (bin) return bin
  if (!tx(project, (c) => c.addAction(root.createBinAction(name, false)), `Create ${name} bin`)) return null
  return (await find()).bin
}

/** Move a generated sequence into the RoughCut bin (or the named one). Returns false if it couldn't. */
export async function fileInRoughCutBin(ppro: premierepro, project: Project, item: ProjectItem, binName = BIN_NAME, into?: FolderItem | null): Promise<boolean> {
  try {
    const bin = into ?? await roughCutBin(ppro, project, binName)
    if (!bin) return false
    const root = await project.getRootItem()
    return tx(project, (c) => c.addAction(root.createMoveItemAction(item, bin)), 'Move into RoughCut bin')
  } catch {
    return false
  }
}

/** A bin inside `parent`, created on first use. */
export async function childBin(ppro: premierepro, project: Project, parent: FolderItem, name: string): Promise<FolderItem | null> {
  const find = async () => {
    const hit = (await parent.getItems()).find((i) => i.type === ppro.ProjectItem.TYPE_BIN && i.name === name)
    return hit ? ppro.FolderItem.cast(hit) : null
  }
  const bin = await find()
  if (bin) return bin
  if (!tx(project, (c) => c.addAction(parent.createBinAction(name, false)), `Create ${name} bin`)) return null
  return find()
}

/** Ids of everything at the project root, to tell later what an import added. */
export async function rootItemIds(project: Project): Promise<Set<string>> {
  return new Set((await (await project.getRootItem()).getItems()).map((i) => i.getId()))
}

/**
 * Premiere makes copies of the media for every XML import and leaves them at the project
 * root. Move whatever an import added there (except the sequences in `keep`) into `bin`.
 * Best-effort, like the rest of the filing.
 */
export async function gatherImported(project: Project, before: Set<string>, keep: ProjectItem[], bin: FolderItem): Promise<void> {
  try {
    const keepIds = new Set(keep.map((i) => i.getId()))
    const root = await project.getRootItem()
    const added = (await root.getItems()).filter((i) => !before.has(i.getId()) && !keepIds.has(i.getId()) && i.getId() !== (bin as unknown as ProjectItem).getId())
    for (const item of added) tx(project, (c) => c.addAction(root.createMoveItemAction(item, bin)), 'Move imported media')
  } catch { /* leave them where they are */ }
}

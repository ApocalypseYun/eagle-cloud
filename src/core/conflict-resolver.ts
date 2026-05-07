import type {
  ConflictEntry,
  ConflictStrategy,
  ItemMetadata,
  MergedResult,
  Operation,
} from './types.js'

type ScalarValue = string | number | boolean

/**
 * Hybrid conflict resolver:
 *  - tags / folders → Add-Wins Set (union of additions; removals only if not re-added)
 *  - name / annotation / star → LWW (latest timestamp wins)
 */
export class ConflictResolver {
  /**
   * Merges local and remote operations for the same item(s),
   * producing resolved metadata and a conflict report for logging.
   */
  resolve(localOps: readonly Operation[], remoteOps: readonly Operation[]): MergedResult {
    const itemIds = this.collectItemIds(localOps, remoteOps)
    const conflicts: ConflictEntry[] = []
    let resolvedMetadata: ItemMetadata = this.emptyMetadata('')

    for (const itemId of itemIds) {
      const localByItem = localOps.filter((o) => this.opItemId(o) === itemId)
      const remoteByItem = remoteOps.filter((o) => this.opItemId(o) === itemId)

      resolvedMetadata = this.mergeItem(itemId, localByItem, remoteByItem, conflicts)
    }

    return { resolvedMetadata, conflictReport: conflicts }
  }

  private mergeItem(
    itemId: string,
    localOps: readonly Operation[],
    remoteOps: readonly Operation[],
    conflicts: ConflictEntry[]
  ): ItemMetadata {
    const name = this.resolveLWW(itemId, 'name', localOps, remoteOps, conflicts)
    const annotation = this.resolveLWW(itemId, 'annotation', localOps, remoteOps, conflicts)
    const star = this.resolveLWW(itemId, 'star', localOps, remoteOps, conflicts)

    const tags = this.resolveAddWinsSet(itemId, 'tags', localOps, remoteOps, conflicts)
    const folders = this.resolveAddWinsSet(itemId, 'folders', localOps, remoteOps, conflicts)

    return {
      id: itemId,
      name: typeof name === 'string' ? name : '',
      tags,
      folders,
      annotation: typeof annotation === 'string' ? annotation : '',
      star: typeof star === 'number' ? star : 0,
      modificationTime: Date.now(),
      ext: '',
    }
  }

  /**
   * Last-Writer-Wins: the operation with the latest timestamp wins.
   */
  private resolveLWW(
    itemId: string,
    field: string,
    localOps: readonly Operation[],
    remoteOps: readonly Operation[],
    conflicts: ConflictEntry[]
  ): ScalarValue | undefined {
    const localUpdate = this.latestFieldUpdate(field, localOps)
    const remoteUpdate = this.latestFieldUpdate(field, remoteOps)

    if (!localUpdate && !remoteUpdate) return undefined

    const localValue = this.extractFieldValue(localUpdate)
    const remoteValue = this.extractFieldValue(remoteUpdate)

    if (!remoteUpdate) return localValue
    if (!localUpdate) return remoteValue

    // Both sides modified — latest timestamp wins
    const winner = localUpdate.timestamp >= remoteUpdate.timestamp
      ? localValue
      : remoteValue

    if (localValue !== remoteValue) {
      conflicts.push({
        itemId,
        field,
        strategy: 'lww' as ConflictStrategy,
        localValue: localValue ?? '',
        remoteValue: remoteValue ?? '',
        resolvedValue: winner ?? '',
      })
    }

    return winner
  }

  /**
   * Add-Wins Set: union of all additions from both sides.
   * A removal only applies if the element was NOT re-added by the other side.
   */
  private resolveAddWinsSet(
    itemId: string,
    field: 'tags' | 'folders',
    localOps: readonly Operation[],
    remoteOps: readonly Operation[],
    conflicts: ConflictEntry[]
  ): readonly string[] {
    const addKind = field === 'tags' ? 'tags_add' : 'folders_add'
    const removeKind = field === 'tags' ? 'tags_remove' : 'folders_remove'

    const localAdds = this.collectSetValues(addKind, localOps)
    const localRemoves = this.collectSetValues(removeKind, localOps)
    const remoteAdds = this.collectSetValues(addKind, remoteOps)
    const remoteRemoves = this.collectSetValues(removeKind, remoteOps)

    // Union of all additions
    const allAdds = new Set([...localAdds, ...remoteAdds])

    // Removals only apply if NOT re-added by the other side
    for (const item of localRemoves) {
      if (!remoteAdds.has(item)) {
        allAdds.delete(item)
      }
    }
    for (const item of remoteRemoves) {
      if (!localAdds.has(item)) {
        allAdds.delete(item)
      }
    }

    const resolved = [...allAdds]

    if (localRemoves.size > 0 || remoteRemoves.size > 0) {
      conflicts.push({
        itemId,
        field,
        strategy: 'add-wins-set' as ConflictStrategy,
        localValue: [...localAdds],
        remoteValue: [...remoteAdds],
        resolvedValue: resolved,
      })
    }

    return resolved
  }

  private latestFieldUpdate(
    field: string,
    ops: readonly Operation[]
  ): Operation | undefined {
    return ops
      .filter((o) => o.op.kind === 'metadata_update' && o.op.field === field)
      .sort((a, b) => b.timestamp - a.timestamp)[0]
  }

  private extractFieldValue(op: Operation | undefined): ScalarValue | undefined {
    if (!op) return undefined
    if (op.op.kind === 'metadata_update') return op.op.value
    return undefined
  }

  private collectSetValues(
    kind: string,
    ops: readonly Operation[]
  ): Set<string> {
    const values = new Set<string>()
    for (const op of ops) {
      if (op.op.kind === kind) {
        const items: readonly string[] =
          'tags' in op.op ? op.op.tags :
          'folderIds' in op.op ? op.op.folderIds :
          []
        for (const v of items) {
          values.add(v)
        }
      }
    }
    return values
  }

  private opItemId(op: Operation): string {
    return 'itemId' in op.op ? op.op.itemId : ''
  }

  private collectItemIds(
    localOps: readonly Operation[],
    remoteOps: readonly Operation[]
  ): readonly string[] {
    const ids = new Set<string>()
    for (const op of [...localOps, ...remoteOps]) {
      const id = this.opItemId(op)
      if (id) ids.add(id)
    }
    return [...ids]
  }

  private emptyMetadata(id: string): ItemMetadata {
    return {
      id,
      name: '',
      tags: [],
      folders: [],
      annotation: '',
      star: 0,
      modificationTime: 0,
      ext: '',
    }
  }
}

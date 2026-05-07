import { randomUUID } from 'node:crypto'
import type { ItemMetadata, Operation, OpType, SyncState } from './types.js'

declare const eagle: {
  item: {
    getIdsWithModifiedAt(): Promise<ReadonlyArray<{ id: string; modifiedAt: number }>>
    getById(id: string): Promise<{ metadata: ItemMetadata }>
  }
}

/**
 * Detects local changes by comparing Eagle's current item state
 * against the persisted SyncState. Generates Operation objects
 * for each detected change.
 */
export class ChangeDetector {
  private lastRunAt = 0
  private readonly debounceMs: number
  private readonly deviceId: string

  constructor(deviceId: string, debounceMs = 5000) {
    this.deviceId = deviceId
    this.debounceMs = debounceMs
  }

  async detectChanges(syncState: SyncState): Promise<readonly Operation[]> {
    const now = Date.now()
    if (now - this.lastRunAt < this.debounceMs) {
      return []
    }
    this.lastRunAt = now

    const currentItems = await eagle.item.getIdsWithModifiedAt()
    const operations: Operation[] = []

    for (const { id, modifiedAt } of currentItems) {
      const itemState = syncState.itemStates[id]

      if (!itemState) {
        // New item — fetch metadata and generate item_add operation
        const { metadata } = await eagle.item.getById(id)
        operations.push(this.createOp({ kind: 'item_add', itemId: id, metadata }))
        continue
      }

      if (modifiedAt > itemState.localModifiedAt) {
        const { metadata } = await eagle.item.getById(id)
        const diffOps = this.diffMetadata(itemState, metadata)
        for (const op of diffOps) {
          operations.push(this.createOp(op))
        }
      }
    }

    // Detect deletions: items in sync state but no longer in Eagle
    const currentIdSet = new Set(currentItems.map((i) => i.id))
    for (const itemId of Object.keys(syncState.itemStates)) {
      if (!currentIdSet.has(itemId)) {
        operations.push(this.createOp({ kind: 'item_delete', itemId }))
      }
    }

    return operations
  }

  /**
   * Diffs two metadata states to produce granular operations.
   * Compares the last known state (from ItemSyncState) against
   * current Eagle metadata.
   */
  diffMetadata(
    oldState: { readonly itemId: string },
    newMeta: ItemMetadata
  ): readonly OpType[] {
    const ops: OpType[] = []
    const itemId = oldState.itemId

    // LWW fields — always emit; conflict resolver will pick the winner
    ops.push({ kind: 'metadata_update', itemId, field: 'name', value: newMeta.name })
    ops.push({ kind: 'metadata_update', itemId, field: 'annotation', value: newMeta.annotation })
    ops.push({ kind: 'metadata_update', itemId, field: 'star', value: newMeta.star })

    // Tags and folders — emit as add sets (resolver does union)
    if (newMeta.tags.length > 0) {
      ops.push({ kind: 'tags_add', itemId, tags: newMeta.tags })
    }
    if (newMeta.folders.length > 0) {
      ops.push({ kind: 'folders_add', itemId, folderIds: newMeta.folders })
    }

    return ops
  }

  private createOp(op: OpType): Operation {
    return {
      id: randomUUID(),
      deviceId: this.deviceId,
      timestamp: Date.now(),
      op,
    }
  }
}

import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { ChangeDetector } from './change-detector.js'
import { ConflictResolver } from './conflict-resolver.js'
import { QueueManager } from './queue-manager.js'
import type {
  ItemMetadata,
  Operation,
  QueueTask,
  StorageProvider,
  SyncEngineStatus,
  SyncPhase,
  SyncState,
} from './types.js'

declare const eagle: {
  item: {
    getById(id: string): Promise<{ metadata: ItemMetadata; thumbnailPath: string }>
    save(id: string, metadata: Partial<ItemMetadata>): Promise<void>
  }
}

export interface SyncEngineEvents {
  statusChanged: (status: SyncEngineStatus) => void
  error: (error: Error) => void
  syncComplete: () => void
}

export declare interface SyncEngine {
  on<E extends keyof SyncEngineEvents>(event: E, listener: SyncEngineEvents[E]): this
  emit<E extends keyof SyncEngineEvents>(event: E, ...args: Parameters<SyncEngineEvents[E]>): boolean
}

/**
 * Orchestrates the full sync cycle: push → pull → reconcile.
 * Coordinates ChangeDetector, ConflictResolver, QueueManager,
 * and a StorageProvider for cloud I/O.
 */
// eslint-disable-next-line no-redeclare
export class SyncEngine extends EventEmitter {
  private phase: SyncPhase = 'idle'
  private lastSyncAt = 0
  private errors: readonly string[] = []
  private syncState: SyncState
  private running = false

  private readonly changeDetector: ChangeDetector
  private readonly conflictResolver: ConflictResolver
  private readonly queueManager: QueueManager
  private readonly storage: StorageProvider

  constructor(
    deviceId: string,
    storage: StorageProvider,
    syncState: SyncState
  ) {
    super()
    this.storage = storage
    this.syncState = syncState
    this.changeDetector = new ChangeDetector(deviceId)
    this.conflictResolver = new ConflictResolver()
    this.queueManager = new QueueManager((task) => this.executeTask(task))
  }

  async startSync(): Promise<void> {
    this.running = true
    await this.triggerSync()
  }

  stopSync(): void {
    this.running = false
    this.queueManager.pause()
    this.setPhase('idle')
  }

  async triggerSync(): Promise<void> {
    if (this.phase !== 'idle') return

    try {
      await this.pushPhase()
      await this.pullPhase()
      await this.reconcilePhase()
      this.lastSyncAt = Date.now()
      this.emit('syncComplete')
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      this.errors = [...this.errors, error.message]
      this.setPhase('error')
      this.emit('error', error)
    } finally {
      // Phase may be 'error' if catch ran; avoid narrowing by reading via getter
      if ((this.phase as string) !== 'error') {
        this.setPhase('idle')
      }
    }
  }

  getStatus(): SyncEngineStatus {
    return {
      phase: this.phase,
      lastSyncAt: this.lastSyncAt,
      pendingOperations: this.queueManager.getStatus().pending,
      errors: this.errors,
    }
  }

  getSyncState(): SyncState {
    return this.syncState
  }

  // --- Push Phase ---

  private async pushPhase(): Promise<void> {
    this.setPhase('pushing')

    const localOps = await this.changeDetector.detectChanges(this.syncState)
    if (localOps.length === 0) return

    // Upload operations log
    const opsKey = `ops/${Date.now()}-${this.syncState.deviceId}.jsonl`
    const opsData = Buffer.from(
      localOps.map((op) => JSON.stringify(op)).join('\n')
    )
    await this.storage.put(opsKey, opsData)

    // Enqueue metadata and thumbnail uploads for changed items
    for (const op of localOps) {
      if (op.op.kind === 'item_add' || op.op.kind === 'metadata_update') {
        const itemId = op.op.itemId
        this.enqueueMetadataUpload(itemId)
        this.enqueueThumbnailUpload(itemId)
      }
    }
  }

  // --- Pull Phase ---

  private async pullPhase(): Promise<void> {
    this.setPhase('pulling')

    const remoteOpsFiles = await this.storage.list('ops/')
    const newOpsFiles = remoteOpsFiles.filter(
      (f) => f.lastModified > this.syncState.lastSyncTimestamp
        && !f.key.includes(this.syncState.deviceId)
    )

    const remoteOps: Operation[] = []
    for (const file of newOpsFiles) {
      const data = await this.storage.get(file.key)
      const lines = data.toString('utf-8').split('\n').filter(Boolean)
      for (const line of lines) {
        remoteOps.push(JSON.parse(line) as Operation)
      }
    }

    if (remoteOps.length === 0) return

    // Detect which local ops may conflict
    const localOps = await this.changeDetector.detectChanges(this.syncState)

    // Resolve conflicts
    const { resolvedMetadata } = this.conflictResolver.resolve(
      [...localOps],
      remoteOps
    )

    // Apply resolved metadata to local Eagle library
    if (resolvedMetadata.id) {
      await eagle.item.save(resolvedMetadata.id, {
        name: resolvedMetadata.name,
        tags: [...resolvedMetadata.tags],
        folders: [...resolvedMetadata.folders],
        annotation: resolvedMetadata.annotation,
        star: resolvedMetadata.star,
      })
    }
  }

  // --- Reconcile Phase ---

  private async reconcilePhase(): Promise<void> {
    this.setPhase('reconciling')

    this.syncState = {
      ...this.syncState,
      lastSyncTimestamp: Date.now(),
    }
  }

  // --- Queue helpers ---

  private enqueueMetadataUpload(itemId: string): void {
    const task: QueueTask = {
      id: randomUUID(),
      itemId,
      priority: 'metadata',
      type: 'upload',
      key: `items/${itemId}/metadata.json`,
      retryCount: 0,
      createdAt: Date.now(),
    }
    this.queueManager.enqueue(task)
  }

  private enqueueThumbnailUpload(itemId: string): void {
    const task: QueueTask = {
      id: randomUUID(),
      itemId,
      priority: 'thumbnail',
      type: 'upload',
      key: `items/${itemId}/thumbnail.png`,
      retryCount: 0,
      createdAt: Date.now(),
    }
    this.queueManager.enqueue(task)
  }

  private async executeTask(task: QueueTask): Promise<void> {
    if (task.type === 'upload') {
      await this.executeUpload(task)
    } else {
      await this.executeDownload(task)
    }
  }

  private async executeUpload(task: QueueTask): Promise<void> {
    if (task.priority === 'metadata') {
      const { metadata } = await eagle.item.getById(task.itemId)
      const data = Buffer.from(JSON.stringify(metadata))
      await this.storage.put(task.key, data)
    } else if (task.priority === 'thumbnail') {
      const { thumbnailPath } = await eagle.item.getById(task.itemId)
      if (thumbnailPath) {
        const { readFile } = await import('node:fs/promises')
        const data = await readFile(thumbnailPath)
        await this.storage.put(task.key, data)
      }
    } else if (task.data) {
      await this.storage.put(task.key, task.data)
    }
  }

  private async executeDownload(task: QueueTask): Promise<void> {
    const _data = await this.storage.get(task.key)
    // Downloaded data handling delegated to taskComplete event listeners
  }

  private setPhase(phase: SyncPhase): void {
    this.phase = phase
    this.emit('statusChanged', this.getStatus())
  }
}

import { EventEmitter } from 'node:events'
import type { QueueStatus, QueueTask, TaskPriority } from './types.js'

const PRIORITY_ORDER: Record<TaskPriority, number> = {
  metadata: 0,
  thumbnail: 1,
  source: 2,
}

const MAX_RETRY_DELAY_MS = 5 * 60 * 1000 // 5 minutes
const MAX_ATTEMPTS = 5
const BASE_DELAY_MS = 1000

export interface QueueManagerEvents {
  taskComplete: (task: QueueTask) => void
  taskError: (task: QueueTask, error: Error) => void
  queueEmpty: () => void
}

export declare interface QueueManager {
  on<E extends keyof QueueManagerEvents>(event: E, listener: QueueManagerEvents[E]): this
  emit<E extends keyof QueueManagerEvents>(event: E, ...args: Parameters<QueueManagerEvents[E]>): boolean
}

/**
 * Upload/download task queue with priority ordering,
 * configurable concurrency, and exponential backoff retry.
 */
// eslint-disable-next-line no-redeclare
export class QueueManager extends EventEmitter {
  private pending: QueueTask[] = []
  private active: Map<string, QueueTask> = new Map()
  private completedCount = 0
  private failedCount = 0
  private paused = false
  private readonly concurrency: number
  private readonly executor: (task: QueueTask) => Promise<void>

  constructor(
    executor: (task: QueueTask) => Promise<void>,
    concurrency = 3
  ) {
    super()
    this.executor = executor
    this.concurrency = concurrency
  }

  enqueue(task: QueueTask): void {
    const insertIdx = this.findInsertIndex(task.priority)
    this.pending = [
      ...this.pending.slice(0, insertIdx),
      task,
      ...this.pending.slice(insertIdx),
    ]
    this.drain()
  }

  pause(): void {
    this.paused = true
  }

  resume(): void {
    this.paused = false
    this.drain()
  }

  getStatus(): QueueStatus {
    return {
      pending: this.pending.length,
      active: this.active.size,
      completed: this.completedCount,
      failed: this.failedCount,
      paused: this.paused,
    }
  }

  private drain(): void {
    if (this.paused) return

    while (this.active.size < this.concurrency && this.pending.length > 0) {
      const task = this.pending[0]!
      this.pending = this.pending.slice(1)
      this.active.set(task.id, task)
      this.executeTask(task)
    }
  }

  private async executeTask(task: QueueTask): Promise<void> {
    try {
      await this.executor(task)
      this.active.delete(task.id)
      this.completedCount += 1
      this.emit('taskComplete', task)
    } catch (err) {
      this.active.delete(task.id)
      const error = err instanceof Error ? err : new Error(String(err))

      if (task.retryCount < MAX_ATTEMPTS - 1) {
        const retried: QueueTask = {
          ...task,
          retryCount: task.retryCount + 1,
        }
        const delay = this.computeBackoff(retried.retryCount)
        setTimeout(() => this.enqueue(retried), delay)
      } else {
        this.failedCount += 1
        this.emit('taskError', task, error)
      }
    }

    if (this.pending.length === 0 && this.active.size === 0) {
      this.emit('queueEmpty')
    } else {
      this.drain()
    }
  }

  private computeBackoff(attempt: number): number {
    const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1)
    return Math.min(delay, MAX_RETRY_DELAY_MS)
  }

  /**
   * Insert in priority order.
   * Lower priority number = higher priority (runs first).
   */
  private findInsertIndex(priority: TaskPriority): number {
    const order = PRIORITY_ORDER[priority]
    let idx = this.pending.length
    for (let i = 0; i < this.pending.length; i++) {
      if (PRIORITY_ORDER[this.pending[i]!.priority] > order) {
        idx = i
        break
      }
    }
    return idx
  }
}

import type { SyncMode } from '../core/types.js'
import type { SyncEngine } from '../core/sync-engine.js'

interface DaemonConfig {
  readonly mode: SyncMode
  readonly intervalMs: number
}

/**
 * Manages the sync loop timing with configurable modes:
 *  - realtime: 5s poll interval
 *  - interval: user-configurable poll interval
 *  - manual: no automatic sync, only triggerNow()
 */
export class SyncDaemon {
  private timer: ReturnType<typeof setInterval> | null = null
  private config: DaemonConfig
  private readonly engine: SyncEngine

  constructor(engine: SyncEngine, config?: Partial<DaemonConfig>) {
    this.engine = engine
    this.config = {
      mode: config?.mode ?? 'realtime',
      intervalMs: config?.intervalMs ?? 5000,
    }
  }

  start(): void {
    this.stop()

    if (this.config.mode === 'manual') return

    const interval = this.config.mode === 'realtime'
      ? 5000
      : this.config.intervalMs

    this.timer = setInterval(() => {
      void this.engine.triggerSync()
    }, interval)
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  setMode(mode: SyncMode, intervalMs?: number): void {
    this.config = {
      mode,
      intervalMs: intervalMs ?? this.config.intervalMs,
    }

    // Restart loop with new config if currently running
    if (this.timer !== null) {
      this.start()
    }
  }

  triggerNow(): void {
    void this.engine.triggerSync()
  }

  getConfig(): DaemonConfig {
    return this.config
  }
}

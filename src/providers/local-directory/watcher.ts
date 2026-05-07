import * as fs from 'node:fs'
import * as path from 'node:path'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface WatchEvent {
  readonly type: 'add' | 'change' | 'delete'
  readonly path: string
  readonly timestamp: number
}

type ChangesCallback = (events: ReadonlyArray<WatchEvent>) => void

// ─── Constants ───────────────────────────────────────────────────────────────

const DEBOUNCE_MS = 500

const IGNORED_FILES: ReadonlySet<string> = new Set([
  '.DS_Store',
  'Thumbs.db',
  'desktop.ini',
  '.Spotlight-V100',
  '.Trashes',
  'ehthumbs.db',
])

const IGNORED_EXTENSIONS: ReadonlySet<string> = new Set([
  '.tmp',
  '.partial',
  '.downloading',
  '.~lock',
  '.crdownload',
  '.part',
])

// ─── DirectoryWatcher ────────────────────────────────────────────────────────

export class DirectoryWatcher {
  private watcher: fs.FSWatcher | null = null
  private callback: ChangesCallback | null = null
  private pendingEvents: WatchEvent[] = []
  private debounceTimer: ReturnType<typeof setTimeout> | null = null
  private readonly localWrites: Set<string> = new Set()
  private watchDir = ''

  /**
   * Start watching a directory for file changes.
   * Uses recursive fs.watch where supported (macOS, Windows).
   */
  start(dir: string): void {
    if (this.watcher) {
      this.stop()
    }

    this.watchDir = dir
    this.watcher = fs.watch(dir, { recursive: true }, (eventType, filename) => {
      if (!filename) return
      this.handleRawEvent(eventType, filename)
    })

    this.watcher.on('error', () => {
      // Watcher errors are non-fatal; the watcher may recover
    })
  }

  /** Stop watching and clear all pending state. */
  stop(): void {
    if (this.watcher) {
      this.watcher.close()
      this.watcher = null
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
    this.pendingEvents = []
    this.watchDir = ''
  }

  /** Register a debounced callback for batched change events. */
  onChanges(callback: ChangesCallback): void {
    this.callback = callback
  }

  /**
   * Mark a path as a local write so it won't be emitted as a remote change.
   * Call this BEFORE performing a write operation.
   */
  markLocalWrite(relativePath: string): void {
    this.localWrites.add(relativePath)
  }

  /**
   * Clear a local write marker after the write is complete and
   * the fs.watch event has had time to fire.
   */
  clearLocalWrite(relativePath: string): void {
    this.localWrites.delete(relativePath)
  }

  // ─── Private ─────────────────────────────────────────────────────────────

  private handleRawEvent(eventType: string, filename: string): void {
    if (this.shouldIgnore(filename)) return

    const normalized = filename.replace(/\\/g, '/')

    // Skip events triggered by our own writes
    if (this.localWrites.has(normalized)) return

    const fullPath = path.join(this.watchDir, filename)
    const watchEvent = this.classifyEvent(eventType, fullPath, normalized)
    if (!watchEvent) return

    this.pendingEvents.push(watchEvent)
    this.scheduleFlush()
  }

  private classifyEvent(
    eventType: string,
    fullPath: string,
    relativePath: string,
  ): WatchEvent | null {
    const timestamp = Date.now()

    if (eventType === 'rename') {
      // 'rename' can mean add or delete; check existence
      try {
        fs.accessSync(fullPath)
        return { type: 'add', path: relativePath, timestamp }
      } catch {
        return { type: 'delete', path: relativePath, timestamp }
      }
    }

    // eventType === 'change'
    return { type: 'change', path: relativePath, timestamp }
  }

  private shouldIgnore(filename: string): boolean {
    const basename = path.basename(filename)
    if (IGNORED_FILES.has(basename)) return true

    const ext = path.extname(basename).toLowerCase()
    if (IGNORED_EXTENSIONS.has(ext)) return true

    // Ignore hidden temp files starting with .~
    if (basename.startsWith('.~')) return true

    return false
  }

  private scheduleFlush(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
    }
    this.debounceTimer = setTimeout(() => {
      this.flush()
    }, DEBOUNCE_MS)
  }

  private flush(): void {
    if (this.pendingEvents.length === 0) return
    if (!this.callback) return

    const events = [...this.pendingEvents]
    this.pendingEvents = []
    this.callback(events)
  }
}

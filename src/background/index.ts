import { randomUUID } from 'node:crypto'
import { SyncEngine } from '../core/sync-engine.js'
import { SyncDaemon } from './daemon.js'
import { LibraryManager, deriveLibraryId } from '../models/library-manager.js'
import { LocalDirectoryProvider } from '../providers/local-directory/provider.js'
import type { PluginConfig, SyncState } from '../core/types.js'

declare const eagle: {
  onPluginCreate(callback: (plugin: unknown) => void): void
  onPluginRun(callback: () => void): void
  onLibraryChanged(callback: (newLibraryPath: string) => void): void
  library: {
    path: string
    name: string
  }
  log: {
    info(msg: string): void
    error(msg: string): void
  }
}

// ─── State ──────────────────────────────────────────────────────────────────

let syncEngine: SyncEngine | null = null
let daemon: SyncDaemon | null = null
let libraryManager: LibraryManager | null = null
let currentProvider: LocalDirectoryProvider | null = null

// ─── Config ─────────────────────────────────────────────────────────────────

/**
 * Load plugin configuration from Eagle's plugin data directory.
 * In production this reads from a persisted JSON file.
 * Falls back to defaults if config doesn't exist yet.
 */
function loadConfig(): PluginConfig {
  // TODO: Read from persisted config file
  return {
    deviceId: getOrCreateDeviceId(),
    deviceName: 'default-device',
    provider: 'local-directory',
    syncMode: 'realtime',
    syncIntervalMs: 5000,
    lazyPull: true,
    maxConcurrentUploads: 3,
    maxConcurrentDownloads: 3,
    providers: {},
  }
}

/** Get or create a persistent device ID. */
function getOrCreateDeviceId(): string {
  // TODO: Persist to config file so it stays stable across restarts
  return randomUUID()
}

/**
 * Load sync state from persisted storage.
 * Returns empty state on first run.
 */
function loadSyncState(deviceId: string): SyncState {
  // TODO: Load from disk
  return {
    deviceId,
    lastSyncTimestamp: 0,
    itemStates: {},
  }
}

// ─── Sync Initialization ────────────────────────────────────────────────────

/**
 * Initialize sync for the current Eagle library.
 * Only starts if:
 * 1. A sync folder is configured
 * 2. The current library is enabled for sync
 */
async function initSyncForCurrentLibrary(config: PluginConfig): Promise<void> {
  const libraryPath = eagle.library.path
  const libraryName = eagle.library.name
  const libraryId = deriveLibraryId(libraryPath)

  // TODO: Read syncFolder from persisted config (set in Window plugin settings)
  const syncFolder = config.providers['local-directory' as keyof typeof config.providers]
    ? '/placeholder'
    : null

  if (!syncFolder) {
    eagle.log.info('[eagle-cloud] No sync folder configured. Open settings to configure.')
    return
  }

  // Initialize library manager
  libraryManager = new LibraryManager({
    syncFolder,
    deviceId: config.deviceId,
    deviceName: config.deviceName,
  })
  await libraryManager.init()

  // Check if this library is enabled for sync
  const isSyncEnabled = await libraryManager.isSyncEnabled(libraryId)
  if (!isSyncEnabled) {
    eagle.log.info(`[eagle-cloud] Library "${libraryName}" is not enabled for sync. Skipping.`)
    return
  }

  // Create provider pointed at this library's sync directory
  const libraryDir = libraryManager.getLibraryDir(libraryId)
  currentProvider = new LocalDirectoryProvider({
    libraryDir,
    onRemoteChanges: (events) => {
      eagle.log.info(`[eagle-cloud] Detected ${events.length} remote change(s)`)
      // Trigger pull when remote changes detected
      if (syncEngine) {
        void syncEngine.triggerSync()
      }
    },
  })
  await currentProvider.init()

  // Initialize sync engine
  const syncState = loadSyncState(config.deviceId)
  syncEngine = new SyncEngine(config.deviceId, currentProvider, syncState)
  daemon = new SyncDaemon(syncEngine, {
    mode: config.syncMode,
    intervalMs: config.syncIntervalMs,
  })

  syncEngine.on('error', (err) => {
    eagle.log.error(`[eagle-cloud] Sync error: ${err.message}`)
  })

  syncEngine.on('syncComplete', () => {
    eagle.log.info('[eagle-cloud] Sync cycle complete')
  })

  daemon.start()
  eagle.log.info(
    `[eagle-cloud] Syncing library "${libraryName}" (${libraryId}) in ${config.syncMode} mode`
  )
}

/** Stop all sync activity and clean up resources. */
function teardown(): void {
  if (daemon) {
    daemon.stop()
    daemon = null
  }
  if (syncEngine) {
    syncEngine.stopSync()
    syncEngine = null
  }
  if (currentProvider) {
    currentProvider.destroy()
    currentProvider = null
  }
}

// ─── Eagle Plugin Lifecycle ─────────────────────────────────────────────────

eagle.onPluginCreate((_plugin) => {
  eagle.log.info('[eagle-cloud] Plugin created')
})

eagle.onPluginRun(() => {
  eagle.log.info('[eagle-cloud] Plugin running, initializing...')

  const config = loadConfig()
  void initSyncForCurrentLibrary(config).catch((err) => {
    const msg = err instanceof Error ? err.message : String(err)
    eagle.log.error(`[eagle-cloud] Failed to initialize: ${msg}`)
  })
})

eagle.onLibraryChanged((_newLibraryPath) => {
  eagle.log.info('[eagle-cloud] Library changed, re-evaluating sync...')

  // Tear down current sync
  teardown()

  // Re-initialize for the new library (if it has sync enabled)
  const config = loadConfig()
  void initSyncForCurrentLibrary(config).catch((err) => {
    const msg = err instanceof Error ? err.message : String(err)
    eagle.log.error(`[eagle-cloud] Re-init failed: ${msg}`)
  })
})

// ─── Exports for Window plugin communication ────────────────────────────────

export { syncEngine, daemon, libraryManager }

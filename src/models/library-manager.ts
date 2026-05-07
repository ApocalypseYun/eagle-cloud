import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as crypto from 'node:crypto'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface LibraryRegistration {
  readonly libraryId: string
  readonly libraryName: string
  readonly libraryPath: string
  readonly deviceId: string
  readonly registeredAt: number
}

export interface SyncManifest {
  readonly version: number
  readonly libraries: ReadonlyArray<LibraryRegistration>
  readonly devices: ReadonlyArray<DeviceInfo>
}

export interface DeviceInfo {
  readonly deviceId: string
  readonly deviceName: string
  readonly lastSeenAt: number
  readonly platform: string
}

export interface LibraryManagerConfig {
  readonly syncFolder: string
  readonly deviceId: string
  readonly deviceName: string
}

// ─── Constants ──────────────────────────────────────────────────────────────

const ROOT_DIR_NAME = 'EagleCloudSync'
const MANIFEST_FILE = 'config.json'

// ─── LibraryManager ─────────────────────────────────────────────────────────

/**
 * Manages multi-library sync registration.
 *
 * Responsibilities:
 * - Maintain the shared EagleCloudSync/ directory in the sync folder
 * - Register/unregister libraries for sync
 * - Track which devices participate
 * - Discover libraries synced from other devices
 */
export class LibraryManager {
  private readonly rootDir: string
  private readonly config: LibraryManagerConfig

  constructor(config: LibraryManagerConfig) {
    this.config = config
    this.rootDir = path.join(config.syncFolder, ROOT_DIR_NAME)
  }

  /** Ensure the root sync directory exists and device is registered. */
  async init(): Promise<void> {
    await fs.mkdir(this.rootDir, { recursive: true })
    await this.registerDevice()
  }

  /** Get the root directory path for the EagleCloudSync structure. */
  getRootDir(): string {
    return this.rootDir
  }

  /** Get the sync data directory for a specific library. */
  getLibraryDir(libraryId: string): string {
    return path.join(this.rootDir, libraryId)
  }

  // ─── Library Registration ────────────────────────────────────────────────

  /**
   * Enable sync for a library. Creates its directory structure in the sync folder.
   * Does NOT move or copy the local library — only creates a sync mirror directory.
   */
  async enableSync(libraryId: string, libraryName: string, libraryPath: string): Promise<void> {
    const libDir = this.getLibraryDir(libraryId)

    // Create library sync directory structure
    await fs.mkdir(path.join(libDir, 'ops'), { recursive: true })
    await fs.mkdir(path.join(libDir, 'items'), { recursive: true })
    await fs.mkdir(path.join(libDir, 'folders'), { recursive: true })
    await fs.mkdir(path.join(libDir, 'devices'), { recursive: true })

    // Register in manifest
    const manifest = await this.loadManifest()
    const existing = manifest.libraries.find((l) => l.libraryId === libraryId)

    if (!existing) {
      const registration: LibraryRegistration = {
        libraryId,
        libraryName,
        libraryPath,
        deviceId: this.config.deviceId,
        registeredAt: Date.now(),
      }
      const updatedManifest: SyncManifest = {
        ...manifest,
        libraries: [...manifest.libraries, registration],
      }
      await this.saveManifest(updatedManifest)
    }
  }

  /**
   * Disable sync for a library. Removes its registration but preserves remote data
   * (other devices may still need it).
   */
  async disableSync(libraryId: string): Promise<void> {
    const manifest = await this.loadManifest()
    const updatedManifest: SyncManifest = {
      ...manifest,
      libraries: manifest.libraries.filter((l) => l.libraryId !== libraryId),
    }
    await this.saveManifest(updatedManifest)
  }

  /** Check if a library is currently enabled for sync. */
  async isSyncEnabled(libraryId: string): Promise<boolean> {
    const manifest = await this.loadManifest()
    return manifest.libraries.some((l) => l.libraryId === libraryId)
  }

  /** List all libraries registered for sync (from all devices). */
  async listSyncedLibraries(): Promise<ReadonlyArray<LibraryRegistration>> {
    const manifest = await this.loadManifest()
    return manifest.libraries
  }

  /**
   * Discover libraries synced from other devices that are not yet linked locally.
   * This allows a new device to "pull" existing synced libraries.
   */
  async discoverRemoteLibraries(): Promise<ReadonlyArray<LibraryRegistration>> {
    const manifest = await this.loadManifest()
    return manifest.libraries.filter((l) => l.deviceId !== this.config.deviceId)
  }

  // ─── Device Management ───────────────────────────────────────────────────

  /** Register this device in the shared manifest. */
  private async registerDevice(): Promise<void> {
    const manifest = await this.loadManifest()
    const existingIdx = manifest.devices.findIndex(
      (d) => d.deviceId === this.config.deviceId
    )

    const deviceInfo: DeviceInfo = {
      deviceId: this.config.deviceId,
      deviceName: this.config.deviceName,
      lastSeenAt: Date.now(),
      platform: process.platform,
    }

    const updatedDevices = existingIdx >= 0
      ? manifest.devices.map((d, i) => (i === existingIdx ? deviceInfo : d))
      : [...manifest.devices, deviceInfo]

    const updatedManifest: SyncManifest = {
      ...manifest,
      devices: updatedDevices,
    }
    await this.saveManifest(updatedManifest)
  }

  /** Update device's lastSeenAt timestamp. */
  async heartbeat(): Promise<void> {
    await this.registerDevice()
  }

  /** List all registered devices. */
  async listDevices(): Promise<ReadonlyArray<DeviceInfo>> {
    const manifest = await this.loadManifest()
    return manifest.devices
  }

  // ─── Manifest Persistence ────────────────────────────────────────────────

  private async loadManifest(): Promise<SyncManifest> {
    const manifestPath = path.join(this.rootDir, MANIFEST_FILE)
    try {
      const raw = await fs.readFile(manifestPath, 'utf-8')
      return JSON.parse(raw) as SyncManifest
    } catch (err: unknown) {
      if (isNodeError(err) && err.code === 'ENOENT') {
        return { version: 1, libraries: [], devices: [] }
      }
      throw err
    }
  }

  private async saveManifest(manifest: SyncManifest): Promise<void> {
    const manifestPath = path.join(this.rootDir, MANIFEST_FILE)
    const data = JSON.stringify(manifest, null, 2)
    // Atomic write
    const tmpPath = `${manifestPath}.${crypto.randomBytes(4).toString('hex')}.tmp`
    await fs.writeFile(tmpPath, data, 'utf-8')
    await fs.rename(tmpPath, manifestPath)
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Derive a stable libraryId from the Eagle library path.
 * Uses the library folder name + a short hash of the full path
 * to avoid collisions while remaining human-readable.
 */
export function deriveLibraryId(libraryPath: string): string {
  const folderName = path.basename(libraryPath).replace(/\.library$/, '')
  const hash = crypto.createHash('sha256').update(libraryPath).digest('hex').slice(0, 8)
  return `${sanitizeName(folderName)}-${hash}`
}

function sanitizeName(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9一-鿿_-]/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 32)
}

// ─── Utilities ───────────────────────────────────────────────────────────────

interface NodeError extends Error {
  readonly code?: string
}

function isNodeError(err: unknown): err is NodeError {
  return err instanceof Error && 'code' in err
}

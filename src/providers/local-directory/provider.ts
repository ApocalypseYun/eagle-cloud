import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import type { StorageProvider, FileEntry, FileMeta, PartInfo } from '../interface.js'
import { DirectoryWatcher, type WatchEvent } from './watcher.js'

// ─── Constants ───────────────────────────────────────────────────────────────

const LOCAL_WRITE_CLEAR_DELAY_MS = 2000

// ─── Types ───────────────────────────────────────────────────────────────────

export interface LocalDirectoryProviderConfig {
  /**
   * The full path to the library's sync data directory.
   * e.g., ~/BaiduNetdiskSync/EagleCloudSync/{libraryId}/
   * Use LibraryManager.getLibraryDir(libraryId) to obtain this.
   */
  readonly libraryDir: string
  /** Optional callback when remote changes are detected */
  readonly onRemoteChanges?: (events: ReadonlyArray<WatchEvent>) => void
}

interface MultipartSession {
  readonly key: string
  readonly tmpPath: string
  readonly parts: ReadonlyArray<Buffer>
}

// ─── Provider ────────────────────────────────────────────────────────────────

export class LocalDirectoryProvider implements StorageProvider {
  readonly name = 'local-directory'

  private readonly rootDir: string
  private readonly watcher: DirectoryWatcher
  private readonly multipartSessions: Map<string, MultipartSession> = new Map()

  constructor(private readonly config: LocalDirectoryProviderConfig) {
    this.rootDir = config.libraryDir
    this.watcher = new DirectoryWatcher()

    if (config.onRemoteChanges) {
      this.watcher.onChanges(config.onRemoteChanges)
    }
  }

  /** Initialize the provider: ensure root dir exists and start watching. */
  async init(): Promise<void> {
    await fs.mkdir(this.rootDir, { recursive: true })
    this.watcher.start(this.rootDir)
  }

  /** Gracefully shut down the watcher. */
  destroy(): void {
    this.watcher.stop()
  }

  // ─── Basic operations ──────────────────────────────────────────────────────

  async list(prefix: string): Promise<ReadonlyArray<FileEntry>> {
    const dir = this.resolve(prefix)
    const entries: FileEntry[] = []

    try {
      await this.walkDir(dir, prefix, entries)
    } catch (err: unknown) {
      if (isNodeError(err) && err.code === 'ENOENT') {
        return []
      }
      throw err
    }

    return entries
  }

  async get(key: string): Promise<Buffer> {
    const filePath = this.resolve(key)
    return fs.readFile(filePath)
  }

  async put(key: string, data: Buffer, _meta?: Partial<FileMeta>): Promise<void> {
    const filePath = this.resolve(key)
    const relativePath = key.replace(/\\/g, '/')

    this.watcher.markLocalWrite(relativePath)

    await fs.mkdir(path.dirname(filePath), { recursive: true })
    // Atomic write: write to temp file then rename
    const tmpPath = `${filePath}.${crypto.randomBytes(4).toString('hex')}.tmp`
    await fs.writeFile(tmpPath, data)
    await fs.rename(tmpPath, filePath)

    // Clear local write marker after delay to let fs.watch fire
    setTimeout(() => {
      this.watcher.clearLocalWrite(relativePath)
    }, LOCAL_WRITE_CLEAR_DELAY_MS)
  }

  async delete(key: string): Promise<void> {
    const filePath = this.resolve(key)
    const relativePath = key.replace(/\\/g, '/')

    this.watcher.markLocalWrite(relativePath)

    try {
      await fs.unlink(filePath)
    } catch (err: unknown) {
      if (isNodeError(err) && err.code === 'ENOENT') {
        return // Already gone
      }
      throw err
    }

    setTimeout(() => {
      this.watcher.clearLocalWrite(relativePath)
    }, LOCAL_WRITE_CLEAR_DELAY_MS)
  }

  async stat(key: string): Promise<FileMeta | null> {
    const filePath = this.resolve(key)
    try {
      const stats = await fs.stat(filePath)
      return {
        size: stats.size,
        lastModified: stats.mtimeMs,
      }
    } catch (err: unknown) {
      if (isNodeError(err) && err.code === 'ENOENT') {
        return null
      }
      throw err
    }
  }

  async exists(key: string): Promise<boolean> {
    const filePath = this.resolve(key)
    try {
      await fs.access(filePath)
      return true
    } catch {
      return false
    }
  }

  // ─── Multipart upload (simplified for local FS) ────────────────────────────

  async initMultipartUpload(key: string): Promise<string> {
    const sessionId = `local_mp_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`
    const tmpPath = this.resolve(key) + `.${sessionId}.tmp`
    this.multipartSessions.set(sessionId, { key, tmpPath, parts: [] })
    return sessionId
  }

  async uploadPart(uploadId: string, partNumber: number, data: Buffer): Promise<string> {
    const session = this.multipartSessions.get(uploadId)
    if (!session) {
      throw new Error(`Unknown multipart session: ${uploadId}`)
    }

    const updatedParts = [...session.parts]
    updatedParts[partNumber] = data

    this.multipartSessions.set(uploadId, { ...session, parts: updatedParts })

    const etag = crypto.createHash('md5').update(data).digest('hex')
    return etag
  }

  async completeMultipartUpload(uploadId: string, _parts: ReadonlyArray<PartInfo>): Promise<void> {
    const session = this.multipartSessions.get(uploadId)
    if (!session) {
      throw new Error(`Unknown multipart session: ${uploadId}`)
    }

    // Concatenate all parts and write atomically
    const combined = Buffer.concat(session.parts.filter(Boolean))
    await this.put(session.key, combined)
    this.multipartSessions.delete(uploadId)

    // Clean up temp file if it exists
    try {
      await fs.unlink(session.tmpPath)
    } catch {
      // tmp file may not exist yet
    }
  }

  async abortMultipartUpload(uploadId: string): Promise<void> {
    const session = this.multipartSessions.get(uploadId)
    if (!session) return

    this.multipartSessions.delete(uploadId)

    try {
      await fs.unlink(session.tmpPath)
    } catch {
      // Already cleaned or never created
    }
  }

  // ─── Auth lifecycle (no-op for local FS) ───────────────────────────────────

  isAuthenticated(): boolean {
    return true
  }

  async authenticate(): Promise<void> {
    // No authentication needed for local filesystem
  }

  async refreshAuth(): Promise<void> {
    // No token refresh needed for local filesystem
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  private resolve(key: string): string {
    return path.join(this.rootDir, ...key.split('/'))
  }

  private async walkDir(
    dir: string,
    prefix: string,
    results: FileEntry[],
  ): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true })

    const tasks = entries.map(async (entry) => {
      const entryPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        const subPrefix = prefix ? `${prefix}/${entry.name}` : entry.name
        await this.walkDir(entryPath, subPrefix, results)
      } else if (entry.isFile()) {
        const stats = await fs.stat(entryPath)
        const key = prefix ? `${prefix}/${entry.name}` : entry.name
        results.push({
          key,
          size: stats.size,
          lastModified: stats.mtimeMs,
        })
      }
    })

    await Promise.all(tasks)
  }
}

// ─── Utilities ───────────────────────────────────────────────────────────────

interface NodeError extends Error {
  readonly code?: string
}

function isNodeError(err: unknown): err is NodeError {
  return err instanceof Error && 'code' in err
}

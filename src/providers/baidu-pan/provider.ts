import * as crypto from 'node:crypto'
import type { StorageProvider, FileEntry, FileMeta, PartInfo } from '../interface.js'
import { BaiduPanAuth, type AuthConfig, type BaiduTokens, type ConfigPersister } from './auth.js'
import { BaiduPanClient, type BaiduFileInfo, type PrecreateResult } from './client.js'
import { RateLimiter, type RateLimiterConfig } from './rate-limiter.js'

const ROOT_PATH = '/apps/eagle-sync'
const LARGE_FILE_THRESHOLD = 4 * 1024 * 1024 // 4MB

export interface BaiduPanProviderConfig {
  readonly auth: AuthConfig
  readonly tokens: BaiduTokens | null
  readonly persistTokens: ConfigPersister
  readonly rateLimiter?: RateLimiterConfig
}

// Track in-flight multipart uploads
interface MultipartSession {
  readonly key: string
  readonly fullPath: string
  readonly precreateResult: PrecreateResult
  readonly blockMd5s: readonly string[]
  readonly totalSize: number
}

export class BaiduPanProvider implements StorageProvider {
  readonly name = 'baidupan'

  private readonly auth: BaiduPanAuth
  private readonly client: BaiduPanClient
  private readonly rateLimiter: RateLimiter
  private readonly multipartSessions: Map<string, MultipartSession>

  constructor(config: BaiduPanProviderConfig) {
    this.rateLimiter = new RateLimiter(config.rateLimiter)
    this.auth = new BaiduPanAuth(config.auth, config.tokens, config.persistTokens)
    this.client = new BaiduPanClient(this.auth, this.rateLimiter, ROOT_PATH)
    this.multipartSessions = new Map()
  }

  // --- Basic operations ---

  async list(prefix: string): Promise<FileEntry[]> {
    const files = await this.client.listFiles(prefix)
    return files
      .filter((f) => f.isdir === 0)
      .map((f) => this.toFileEntry(f))
  }

  async get(key: string): Promise<Buffer> {
    return this.client.downloadFile(key)
  }

  async put(key: string, data: Buffer, _meta?: Partial<FileMeta>): Promise<void> {
    if (data.length >= LARGE_FILE_THRESHOLD) {
      await this.putLargeFile(key, data)
      return
    }
    await this.client.uploadFile(key, data)
  }

  async delete(key: string): Promise<void> {
    await this.client.deleteFile(key)
  }

  async stat(key: string): Promise<FileMeta | null> {
    const info = await this.client.getFileInfo(key)
    if (!info) return null
    return {
      size: info.size,
      lastModified: info.server_mtime * 1000,
      etag: info.md5,
    }
  }

  async exists(key: string): Promise<boolean> {
    const info = await this.client.getFileInfo(key)
    return info !== null
  }

  // --- Multipart upload ---

  async initMultipartUpload(key: string): Promise<string> {
    // We defer actual precreate until we know the block list.
    // Use a session ID to track state; precreate happens on complete.
    const sessionId = `mp_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
    const fullPath = this.client.resolvePath(key)
    this.multipartSessions.set(sessionId, {
      key,
      fullPath,
      precreateResult: { uploadid: '', block_list: [] },
      blockMd5s: [],
      totalSize: 0,
    })
    return sessionId
  }

  async uploadPart(uploadId: string, partNumber: number, data: Buffer): Promise<string> {
    const session = this.multipartSessions.get(uploadId)
    if (!session) {
      throw new Error(`Unknown multipart session: ${uploadId}`)
    }

    const md5 = this.computeMd5(data)
    const updatedMd5s = [...session.blockMd5s]
    updatedMd5s[partNumber] = md5
    const updatedSize = session.totalSize + data.length

    // BaiduPan requires precreate before upload. Precreate lazily on first part.
    if (!session.precreateResult.uploadid) {
      const blockList = [md5]
      const precreate = await this.client.precreate(
        session.fullPath,
        data.length,
        blockList
      )
      this.multipartSessions.set(uploadId, {
        ...session,
        precreateResult: precreate,
        blockMd5s: updatedMd5s,
        totalSize: updatedSize,
      })
      await this.client.uploadSlice(precreate.uploadid, partNumber, session.fullPath, data)
      return md5
    }

    this.multipartSessions.set(uploadId, {
      ...session,
      blockMd5s: updatedMd5s,
      totalSize: updatedSize,
    })

    await this.client.uploadSlice(
      session.precreateResult.uploadid,
      partNumber,
      session.fullPath,
      data
    )
    return md5
  }

  async completeMultipartUpload(uploadId: string, parts: PartInfo[]): Promise<void> {
    const session = this.multipartSessions.get(uploadId)
    if (!session) {
      throw new Error(`Unknown multipart session: ${uploadId}`)
    }

    const blockList = parts.map((p) => session.blockMd5s[p.partNumber] ?? p.etag)
    await this.client.createFile(
      session.fullPath,
      session.totalSize,
      session.precreateResult.uploadid,
      blockList
    )
    this.multipartSessions.delete(uploadId)
  }

  async abortMultipartUpload(uploadId: string): Promise<void> {
    // BaiduPan auto-cleans incomplete uploads after 24h.
    // Just remove local tracking.
    this.multipartSessions.delete(uploadId)
  }

  // --- Auth lifecycle ---

  isAuthenticated(): boolean {
    return this.auth.isAuthenticated()
  }

  async authenticate(): Promise<void> {
    // In a plugin context, this would open a browser window.
    // The actual code exchange happens via exchangeCode() after redirect.
    const url = this.auth.getAuthUrl()
    throw new Error(
      `User authentication required. Open this URL in a browser:\n${url}`
    )
  }

  async refreshAuth(): Promise<void> {
    await this.auth.refreshToken()
  }

  // Expose auth for external code exchange flow
  getAuth(): BaiduPanAuth {
    return this.auth
  }

  // --- Private helpers ---

  private async putLargeFile(key: string, data: Buffer): Promise<void> {
    const fullPath = this.client.resolvePath(key)
    const blockList = this.client.computeBlockList(data)
    const precreate = await this.client.precreate(fullPath, data.length, blockList)

    const sliceSize = 4 * 1024 * 1024
    const sliceCount = Math.ceil(data.length / sliceSize)
    for (let i = 0; i < sliceCount; i++) {
      const start = i * sliceSize
      const end = Math.min(start + sliceSize, data.length)
      await this.client.uploadSlice(precreate.uploadid, i, fullPath, data.slice(start, end))
    }

    await this.client.createFile(fullPath, data.length, precreate.uploadid, blockList)
  }

  private toFileEntry(info: BaiduFileInfo): FileEntry {
    const key = info.path.replace(`${ROOT_PATH}/`, '')
    return {
      key,
      size: info.size,
      lastModified: info.server_mtime * 1000,
      etag: info.md5,
    }
  }

  private computeMd5(data: Buffer): string {
    return crypto.createHash('md5').update(data).digest('hex')
  }
}

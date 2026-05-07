import * as https from 'node:https'
import * as http from 'node:http'
import * as crypto from 'node:crypto'
import * as querystring from 'node:querystring'
import { BaiduPanAuth } from './auth.js'
import { RateLimiter } from './rate-limiter.js'

const XPAN_BASE = 'https://pan.baidu.com/rest/2.0/xpan'
const PCS_SUPERFILE_BASE = 'https://d.pcs.baidu.com/rest/2.0/pcs/superfile2'
const SLICE_SIZE = 4 * 1024 * 1024 // 4MB per slice

export interface BaiduFileInfo {
  readonly fs_id: number
  readonly path: string
  readonly size: number
  readonly server_mtime: number
  readonly isdir: number
  readonly md5?: string
  readonly dlink?: string
}

export interface PrecreateResult {
  readonly uploadid: string
  readonly block_list: readonly number[]
}

interface ApiResponse {
  readonly errno: number
  readonly [key: string]: unknown
}

export class BaiduPanClient {
  private readonly auth: BaiduPanAuth
  private readonly rateLimiter: RateLimiter
  private readonly rootPath: string

  constructor(auth: BaiduPanAuth, rateLimiter: RateLimiter, rootPath: string) {
    this.auth = auth
    this.rateLimiter = rateLimiter
    this.rootPath = rootPath
  }

  async listFiles(dir: string): Promise<readonly BaiduFileInfo[]> {
    const fullPath = this.resolvePath(dir)
    const params = { method: 'list', dir: fullPath, limit: '1000' }
    const data = await this.apiGet('/file', params)
    return (data.list as BaiduFileInfo[]) ?? []
  }

  async getFileInfo(path: string): Promise<BaiduFileInfo | null> {
    const fullPath = this.resolvePath(path)
    // List parent directory to find fs_id, then query filemetas for dlink
    const parentDir = fullPath.substring(0, fullPath.lastIndexOf('/')) || '/'
    const listing = await this.listFiles(
      parentDir.replace(this.rootPath, '').replace(/^\//, '')
    )
    const entry = listing.find((f) => f.path === fullPath)
    if (!entry) return null

    const params = {
      method: 'filemetas',
      fsids: JSON.stringify([entry.fs_id]),
      dlink: '1',
    }
    const data = await this.apiGet('/multimedia', params)
    const items = data.list as BaiduFileInfo[] | undefined
    return items?.[0] ?? null
  }

  async uploadFile(path: string, content: Buffer): Promise<void> {
    const fullPath = this.resolvePath(path)
    const blockList = this.computeBlockList(content)

    const precreateResult = await this.precreate(fullPath, content.length, blockList)

    // Upload each slice
    const sliceCount = Math.ceil(content.length / SLICE_SIZE)
    for (let i = 0; i < sliceCount; i++) {
      const start = i * SLICE_SIZE
      const end = Math.min(start + SLICE_SIZE, content.length)
      const slice = content.slice(start, end)
      await this.uploadSlice(precreateResult.uploadid, i, fullPath, slice)
    }

    await this.createFile(fullPath, content.length, precreateResult.uploadid, blockList)
  }

  async downloadFile(path: string): Promise<Buffer> {
    const info = await this.getFileInfo(path)
    if (!info || !info.dlink) {
      throw new Error(`File not found or no download link: ${path}`)
    }
    const token = await this.auth.getAccessToken()
    const url = `${info.dlink}&access_token=${token}`
    return this.downloadFromUrl(url)
  }

  async deleteFile(path: string): Promise<void> {
    const fullPath = this.resolvePath(path)
    const token = await this.auth.getAccessToken()
    await this.rateLimiter.acquire()

    const body = querystring.stringify({
      async: '0',
      filelist: JSON.stringify([fullPath]),
    })

    const url = `${XPAN_BASE}/file?method=filemanager&opera=delete&access_token=${token}`
    await this.postRequest(url, body)
  }

  async createDirectory(dir: string): Promise<void> {
    const fullPath = this.resolvePath(dir)
    const token = await this.auth.getAccessToken()
    await this.rateLimiter.acquire()

    const body = querystring.stringify({
      path: fullPath,
      size: '0',
      isdir: '1',
      rtype: '1', // rename on conflict
    })

    const url = `${XPAN_BASE}/file?method=create&access_token=${token}`
    await this.postRequest(url, body)
  }

  // --- Multipart upload primitives (exposed for StorageProvider) ---

  async precreate(
    fullPath: string,
    size: number,
    blockList: readonly string[]
  ): Promise<PrecreateResult> {
    const token = await this.auth.getAccessToken()
    await this.rateLimiter.acquire()

    const body = querystring.stringify({
      path: fullPath,
      size: String(size),
      isdir: '0',
      autoinit: '1',
      rtype: '3', // overwrite on conflict
      block_list: JSON.stringify(blockList),
    })

    const url = `${XPAN_BASE}/file?method=precreate&access_token=${token}`
    const data = await this.postRequest(url, body)
    return {
      uploadid: data.uploadid as string,
      block_list: data.block_list as number[],
    }
  }

  async uploadSlice(
    uploadId: string,
    partSeq: number,
    fullPath: string,
    slice: Buffer
  ): Promise<string> {
    const token = await this.auth.getAccessToken()
    await this.rateLimiter.acquire()

    const boundary = `----FormBoundary${crypto.randomBytes(8).toString('hex')}`
    const header = Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="chunk"\r\n` +
        `Content-Type: application/octet-stream\r\n\r\n`
    )
    const footer = Buffer.from(`\r\n--${boundary}--\r\n`)
    const payload = Buffer.concat([header, slice, footer])

    const params = querystring.stringify({
      method: 'upload',
      access_token: token,
      type: 'tmpfile',
      path: fullPath,
      uploadid: uploadId,
      partseq: String(partSeq),
    })

    const url = `${PCS_SUPERFILE_BASE}?${params}`
    const data = await this.postRawRequest(url, payload, `multipart/form-data; boundary=${boundary}`)
    return (data.md5 as string) ?? ''
  }

  async createFile(
    fullPath: string,
    size: number,
    uploadId: string,
    blockList: readonly string[]
  ): Promise<void> {
    const token = await this.auth.getAccessToken()
    await this.rateLimiter.acquire()

    const body = querystring.stringify({
      path: fullPath,
      size: String(size),
      isdir: '0',
      rtype: '3',
      uploadid: uploadId,
      block_list: JSON.stringify(blockList),
    })

    const url = `${XPAN_BASE}/file?method=create&access_token=${token}`
    await this.postRequest(url, body)
  }

  // --- Helpers ---

  resolvePath(relativePath: string): string {
    const cleaned = relativePath.replace(/^\/+/, '')
    return cleaned ? `${this.rootPath}/${cleaned}` : this.rootPath
  }

  computeBlockList(content: Buffer): readonly string[] {
    const sliceCount = Math.ceil(content.length / SLICE_SIZE)
    const list: string[] = []
    for (let i = 0; i < sliceCount; i++) {
      const start = i * SLICE_SIZE
      const end = Math.min(start + SLICE_SIZE, content.length)
      const md5 = crypto.createHash('md5').update(content.slice(start, end)).digest('hex')
      list.push(md5)
    }
    return list
  }

  private async apiGet(endpoint: string, params: Record<string, string>): Promise<ApiResponse> {
    const token = await this.auth.getAccessToken()
    await this.rateLimiter.acquire()

    const qs = querystring.stringify({ ...params, access_token: token })
    const url = `${XPAN_BASE}${endpoint}?${qs}`
    return this.getRequest(url)
  }

  private getRequest(url: string): Promise<ApiResponse> {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url)
      const options: https.RequestOptions = {
        hostname: parsed.hostname,
        path: `${parsed.pathname}${parsed.search}`,
        method: 'GET',
      }

      const req = https.request(options, (res) => {
        this.collectResponse(res).then(resolve).catch(reject)
      })
      req.on('error', reject)
      req.end()
    })
  }

  private postRequest(url: string, body: string): Promise<ApiResponse> {
    return this.postRawRequest(url, Buffer.from(body), 'application/x-www-form-urlencoded')
  }

  private postRawRequest(
    url: string,
    payload: Buffer,
    contentType: string
  ): Promise<ApiResponse> {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url)
      const options: https.RequestOptions = {
        hostname: parsed.hostname,
        path: `${parsed.pathname}${parsed.search}`,
        method: 'POST',
        headers: {
          'Content-Type': contentType,
          'Content-Length': payload.length,
        },
      }

      const req = https.request(options, (res) => {
        this.collectResponse(res).then(resolve).catch(reject)
      })
      req.on('error', reject)
      req.write(payload)
      req.end()
    })
  }

  private collectResponse(res: http.IncomingMessage): Promise<ApiResponse> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf-8')
        try {
          const json = JSON.parse(raw) as ApiResponse
          if (json.errno && json.errno !== 0) {
            reject(new Error(`BaiduPan API error (errno=${json.errno}): ${raw}`))
            return
          }
          resolve(json)
        } catch {
          reject(new Error(`Failed to parse BaiduPan response: ${raw.slice(0, 200)}`))
        }
      })
    })
  }

  private downloadFromUrl(url: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url)
      const options: https.RequestOptions = {
        hostname: parsed.hostname,
        path: `${parsed.pathname}${parsed.search}`,
        method: 'GET',
      }

      const req = https.request(options, (res) => {
        // Follow redirects (BaiduPan download often 302s)
        if (res.statusCode === 302 && res.headers.location) {
          this.downloadFromUrl(res.headers.location).then(resolve).catch(reject)
          return
        }
        if (res.statusCode !== 200) {
          reject(new Error(`Download failed with status ${res.statusCode}`))
          return
        }
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => resolve(Buffer.concat(chunks)))
      })
      req.on('error', reject)
      req.end()
    })
  }
}

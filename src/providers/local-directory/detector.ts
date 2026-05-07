import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { execSync } from 'node:child_process'

// ─── Types ───────────────────────────────────────────────────────────────────

export type SyncClientType =
  | 'baidupan'
  | 'jianguoyun'
  | 'onedrive'
  | 'dropbox'
  | 'icloud'
  | 'custom'

export interface DetectedSyncFolder {
  readonly client: SyncClientType
  readonly path: string
  readonly displayName: string
  readonly verified: boolean
}

// ─── Internal constants ──────────────────────────────────────────────────────

interface CandidatePath {
  readonly client: SyncClientType
  readonly displayName: string
  readonly paths: ReadonlyArray<string>
}

const HOME = os.homedir()
const PLATFORM = os.platform()

function buildCandidates(): ReadonlyArray<CandidatePath> {
  if (PLATFORM === 'darwin') {
    return [
      {
        client: 'baidupan',
        displayName: '百度网盘同步空间',
        paths: [
          path.join(HOME, 'BaiduNetdiskSync'),
          path.join(HOME, '百度网盘', '同步空间'),
        ],
      },
      {
        client: 'jianguoyun',
        displayName: '坚果云',
        paths: [
          path.join(HOME, 'Nutstore Files'),
          path.join(HOME, 'Library', 'Application Support', 'Nutstore'),
        ],
      },
      {
        client: 'onedrive',
        displayName: 'OneDrive',
        paths: [
          path.join(HOME, 'OneDrive'),
          path.join(HOME, 'Library', 'CloudStorage', 'OneDrive-Personal'),
        ],
      },
      {
        client: 'dropbox',
        displayName: 'Dropbox',
        paths: [path.join(HOME, 'Dropbox')],
      },
      {
        client: 'icloud',
        displayName: 'iCloud Drive',
        paths: [
          path.join(HOME, 'Library', 'Mobile Documents', 'com~apple~CloudDocs'),
        ],
      },
    ]
  }

  if (PLATFORM === 'win32') {
    return [
      {
        client: 'baidupan',
        displayName: '百度网盘同步空间',
        paths: [
          path.join(HOME, 'BaiduNetdiskSync'),
          path.join(HOME, '百度网盘', '同步空间'),
        ],
      },
      {
        client: 'jianguoyun',
        displayName: '坚果云',
        paths: [path.join(HOME, 'Nutstore')],
      },
      {
        client: 'onedrive',
        displayName: 'OneDrive',
        paths: [path.join(HOME, 'OneDrive')],
      },
      {
        client: 'dropbox',
        displayName: 'Dropbox',
        paths: [path.join(HOME, 'Dropbox')],
      },
    ]
  }

  // Linux fallback
  return [
    {
      client: 'dropbox',
      displayName: 'Dropbox',
      paths: [path.join(HOME, 'Dropbox')],
    },
    {
      client: 'onedrive',
      displayName: 'OneDrive',
      paths: [path.join(HOME, 'OneDrive')],
    },
  ]
}

// ─── Process detection ───────────────────────────────────────────────────────

const PROCESS_PATTERNS: Readonly<Record<SyncClientType, ReadonlyArray<string>>> = {
  baidupan: ['BaiduNetdisk', 'baidunetdisk'],
  jianguoyun: ['Nutstore', 'nutstore'],
  onedrive: ['OneDrive', 'onedrive'],
  dropbox: ['Dropbox', 'dropbox'],
  icloud: ['bird'], // macOS iCloud daemon
  custom: [],
}

function detectRunningClients(): ReadonlySet<SyncClientType> {
  const running = new Set<SyncClientType>()

  try {
    const cmd = PLATFORM === 'win32' ? 'tasklist' : 'ps aux'
    const output = execSync(cmd, { encoding: 'utf-8', timeout: 5000 })

    for (const [client, patterns] of Object.entries(PROCESS_PATTERNS)) {
      const hasMatch = patterns.some((p) =>
        output.toLowerCase().includes(p.toLowerCase()),
      )
      if (hasMatch) {
        running.add(client as SyncClientType)
      }
    }
  } catch {
    // Process detection is best-effort; swallow errors
  }

  return running
}

// ─── Config file parsing ─────────────────────────────────────────────────────

async function parseDropboxConfigPath(): Promise<string | null> {
  const infoPath =
    PLATFORM === 'win32'
      ? path.join(process.env['APPDATA'] ?? '', 'Dropbox', 'info.json')
      : path.join(HOME, '.dropbox', 'info.json')

  try {
    const raw = await fs.readFile(infoPath, 'utf-8')
    const info = JSON.parse(raw) as Record<string, { path?: string }>
    return info['personal']?.path ?? info['business']?.path ?? null
  } catch {
    return null
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Verify that a directory path exists and is writable.
 * Writes (and removes) a temp file to confirm write permission.
 */
export async function verify(dirPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(dirPath)
    if (!stat.isDirectory()) return false

    // Test write permission with a temp file
    const tmpFile = path.join(dirPath, `.eagle-cloud-verify-${Date.now()}.tmp`)
    await fs.writeFile(tmpFile, '')
    await fs.unlink(tmpFile)
    return true
  } catch {
    return false
  }
}

/**
 * Detect all available sync folders on this machine.
 * Combines known-path scanning, process detection, and config parsing.
 * Results are sorted: verified folders first, then by running process.
 */
export async function detectAll(): Promise<ReadonlyArray<DetectedSyncFolder>> {
  const candidates = buildCandidates()
  const runningClients = detectRunningClients()
  const results: DetectedSyncFolder[] = []

  // Check known default paths
  const pathChecks = candidates.flatMap((candidate) =>
    candidate.paths.map(async (candidatePath) => {
      const isVerified = await verify(candidatePath)
      if (isVerified) {
        results.push({
          client: candidate.client,
          path: candidatePath,
          displayName: candidate.displayName,
          verified: true,
        })
      }
    }),
  )
  await Promise.all(pathChecks)

  // Attempt Dropbox config-based path (may reveal non-default location)
  const dropboxPath = await parseDropboxConfigPath()
  if (dropboxPath) {
    const alreadyFound = results.some(
      (r) => r.client === 'dropbox' && r.path === dropboxPath,
    )
    if (!alreadyFound) {
      const isVerified = await verify(dropboxPath)
      if (isVerified) {
        results.push({
          client: 'dropbox',
          path: dropboxPath,
          displayName: 'Dropbox',
          verified: true,
        })
      }
    }
  }

  // Sort: running clients first, then alphabetically by displayName
  return [...results].sort((a, b) => {
    const aRunning = runningClients.has(a.client) ? 0 : 1
    const bRunning = runningClients.has(b.client) ? 0 : 1
    if (aRunning !== bRunning) return aRunning - bRunning
    return a.displayName.localeCompare(b.displayName)
  })
}

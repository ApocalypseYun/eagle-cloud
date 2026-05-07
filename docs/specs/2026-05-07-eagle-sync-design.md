# Eagle Cloud Sync Plugin - Design Spec

## Overview

An Eagle plugin that enables multi-device synchronization of Eagle libraries through pluggable cloud storage backends. MVP targets BaiduPan as the first provider, with architecture supporting WebDAV, S3-compatible, and other backends.

## Requirements

- **Primary use case**: Personal multi-device sync (2+ computers), extensible to small team collaboration
- **Library scale**: No preset limit, progressive approach (MVP targets medium ~50GB)
- **Storage backend**: Pluggable adapter layer; BaiduPan first, then WebDAV (JianguoYun), S3-compatible (Aliyun OSS / Tencent COS)
- **Conflict resolution**: Hybrid (tags/folders = Add-Wins Set merge; name/annotation/star = LWW)
- **Sync timing**: Default real-time (debounced 5s), configurable to interval or manual
- **File sync strategy**: Metadata + thumbnails always synced; original files lazy-pull on demand
- **Encryption**: Deferred to future phase
- **Tech stack**: TypeScript + Node.js (Eagle plugin native environment: Chromium 107 + Node 16)

## Architecture

```
┌──────────────────────────────────────────────────────┐
│                    Eagle Plugin                        │
│                                                        │
│  ┌─────────────────┐    ┌──────────────────────────┐  │
│  │  Window Plugin   │    │  Background Service       │  │
│  │  (Config UI)     │    │  Plugin (Sync Daemon)     │  │
│  │                  │    │                            │  │
│  │  - Backend config │    │  - ChangeDetector         │  │
│  │  - Sync status    │    │  - SyncEngine             │  │
│  │  - Conflict view  │    │  - ConflictResolver       │  │
│  │  - Manual trigger │    │  - QueueManager           │  │
│  └────────┬─────────┘    └─────────────┬────────────┘  │
│           │       shared config/state   │               │
│           └─────────────────────────────┘               │
│                          │                              │
│           ┌──────────────┴──────────────┐               │
│           │     StorageProvider Layer     │               │
│           └──┬──────────┬────────────┬───┘               │
│              │          │            │                    │
│         BaiduPan    WebDAV     S3-Compatible             │
│         Provider    Provider    Provider                  │
└──────────────────────────────────────────────────────┘
```

## Plugin Structure

```
eagle-cloud/
├── manifest.json              # Eagle plugin manifest
├── package.json
├── tsconfig.json
├── src/
│   ├── background/            # Background Service Plugin entry
│   │   ├── index.ts           # Plugin lifecycle (onPluginCreate, etc.)
│   │   └── daemon.ts          # Main sync loop
│   ├── window/                # Window Plugin entry
│   │   ├── index.html
│   │   ├── index.ts
│   │   └── components/        # UI components
│   ├── core/                  # Sync engine core
│   │   ├── change-detector.ts
│   │   ├── sync-engine.ts
│   │   ├── conflict-resolver.ts
│   │   ├── queue-manager.ts
│   │   └── types.ts
│   ├── providers/             # Storage provider implementations
│   │   ├── interface.ts       # StorageProvider interface
│   │   ├── baidu-pan/
│   │   │   ├── client.ts      # BaiduPan API client
│   │   │   ├── auth.ts        # OAuth2 flow
│   │   │   ├── provider.ts    # StorageProvider implementation
│   │   │   └── rate-limiter.ts
│   │   ├── webdav/
│   │   │   └── provider.ts
│   │   └── s3/
│   │       └── provider.ts
│   ├── models/                # Data models
│   │   ├── sync-state.ts      # Local sync state tracking
│   │   ├── operation-log.ts   # CRDT-like operation logs
│   │   └── item.ts            # Eagle item representation
│   └── utils/
│       ├── hash.ts            # SHA-256 content hashing
│       ├── chunked-upload.ts  # Multipart upload helper
│       └── logger.ts
├── dist/                      # Compiled output
└── tests/
```

## Core Interfaces

### StorageProvider

```typescript
interface FileEntry {
  key: string
  size: number
  lastModified: number
  etag?: string
}

interface FileMeta {
  size: number
  lastModified: number
  etag?: string
  contentType?: string
}

interface StorageProvider {
  readonly name: string

  // Basic operations
  list(prefix: string): Promise<FileEntry[]>
  get(key: string): Promise<Buffer>
  put(key: string, data: Buffer, meta?: Partial<FileMeta>): Promise<void>
  delete(key: string): Promise<void>
  stat(key: string): Promise<FileMeta | null>
  exists(key: string): Promise<boolean>

  // Multipart upload (for large files)
  initMultipartUpload(key: string): Promise<string>
  uploadPart(uploadId: string, partNumber: number, data: Buffer): Promise<string>
  completeMultipartUpload(uploadId: string, parts: PartInfo[]): Promise<void>
  abortMultipartUpload(uploadId: string): Promise<void>

  // Auth lifecycle
  isAuthenticated(): boolean
  authenticate(): Promise<void>
  refreshAuth(): Promise<void>
}
```

### SyncState

```typescript
interface SyncState {
  deviceId: string
  lastSyncTimestamp: number
  itemStates: Map<string, ItemSyncState>
}

interface ItemSyncState {
  itemId: string
  localModifiedAt: number
  remoteModifiedAt: number
  metadataHash: string        // SHA-256 of metadata.json
  fileHash: string            // SHA-256 of source file
  thumbnailHash: string       // SHA-256 of thumbnail
  syncStatus: 'synced' | 'local_modified' | 'remote_modified' | 'conflict'
  fileStatus: 'synced' | 'remote_only' | 'downloading'  // for lazy pull
}
```

### OperationLog (CRDT-like)

```typescript
type OpType =
  | { kind: 'item_add'; itemId: string; metadata: ItemMetadata }
  | { kind: 'item_delete'; itemId: string }
  | { kind: 'metadata_update'; itemId: string; field: string; value: unknown }
  | { kind: 'tags_add'; itemId: string; tags: string[] }
  | { kind: 'tags_remove'; itemId: string; tags: string[] }
  | { kind: 'folders_add'; itemId: string; folderIds: string[] }
  | { kind: 'folders_remove'; itemId: string; folderIds: string[] }
  | { kind: 'file_update'; itemId: string; fileHash: string }

interface Operation {
  id: string             // UUID
  deviceId: string
  timestamp: number      // Unix ms
  op: OpType
}
```

## Sync Algorithm

### Change Detection (local)

```
every 5s (debounced):
  currentIds = eagle.item.getIdsWithModifiedAt()
  for each (id, modifiedAt) in currentIds:
    if modifiedAt > syncState.itemStates[id].localModifiedAt:
      generate Operation(s) by diffing current metadata vs last-known
      enqueue operations for upload
```

### Sync Cycle

```
1. Push phase:
   - Upload pending local operations to remote ops/ directory
   - Upload modified metadata + thumbnails
   - For new items: upload source file (or mark as pending upload)

2. Pull phase:
   - List remote ops/ for operations newer than lastSyncTimestamp
   - Download and merge operations using conflict resolution rules
   - Apply merged operations to local Eagle library via eagle.item API
   - Download thumbnails for new/modified items
   - Mark source files as "remote_only" (lazy pull)

3. Reconcile:
   - Update syncState with new timestamps and hashes
   - Persist syncState to local config
```

### Conflict Resolution Rules

| Field | Strategy | Behavior |
|-------|----------|----------|
| tags | Add-Wins Set | Union of both sides' additions; removals only apply if not re-added |
| folders | Add-Wins Set | Same as tags |
| name | LWW | Latest timestamp wins |
| annotation | LWW | Latest timestamp wins |
| star | LWW | Latest timestamp wins |
| source file | LWW + version | Keep both versions, latest becomes active |

## Remote Storage Layout

```
/apps/eagle-sync/               (BaiduPan root)
├── manifest.json               # Sync manifest (version, devices list)
├── devices/
│   ├── {deviceId-A}.json       # Device registration + last sync time
│   └── {deviceId-B}.json
├── ops/
│   ├── {timestamp}-{deviceId}.jsonl   # Operation logs (append-only)
│   └── ...
├── items/
│   ├── {itemId}/
│   │   ├── metadata.json       # Merged metadata snapshot
│   │   ├── thumbnail.png       # Thumbnail file
│   │   └── source.{ext}        # Original file (content-addressed internally)
│   └── ...
└── folders/
    └── structure.json          # Folder tree structure
```

## BaiduPan Provider Specifics

### Authentication
- OAuth 2.0 Authorization Code flow
- Plugin opens browser to Baidu auth page → user grants access → callback with code
- Exchange code for access_token + refresh_token
- Auto-refresh before expiry (access_token: 30 days)

### Rate Limiting
- API quota: 1000 calls/day (personal developer)
- Strategy: aggressive batching, minimize API calls
  - Use `list` with prefix instead of individual `stat` calls
  - Batch metadata into single JSONL files
  - Upload queue with priority (metadata > thumbnail > source)
- Rate limiter: 8 req/s burst, 900 req/day soft limit (reserve 100 for retries)

### Large File Upload
- BaiduPan supports precreate + superfile2 (slice upload)
- Slice size: 4MB per part, max 1024 parts (≈ 4GB max file)
- MD5 per-slice for integrity verification

### Key Constraints
- Can only access `/apps/{app_name}/` directory
- File path max 1000 chars
- Single file max 4GB (slice upload) or 20GB (SVIP)

## MVP Scope

### In Scope (Phase 1)
- [x] Background Service Plugin with sync daemon
- [x] Window Plugin with basic config UI (backend selection, auth, sync status)
- [x] StorageProvider interface + BaiduPan implementation
- [x] Change detection via polling getIdsWithModifiedAt()
- [x] Bidirectional incremental sync (metadata + thumbnails)
- [x] Lazy pull for source files (download on open/export)
- [x] Conflict resolution (hybrid merge + LWW)
- [x] Operation log for change tracking
- [x] Basic error handling + retry with exponential backoff
- [x] Sync status indicator (synced / syncing / error)

### Out of Scope (Future Phases)
- [ ] End-to-end encryption
- [ ] WebDAV provider (坚果云)
- [ ] S3-compatible provider (Aliyun OSS / Tencent COS)
- [ ] Selective folder sync
- [ ] Bandwidth throttling UI
- [ ] Conflict resolution UI (manual mode)
- [ ] Team collaboration features (locking, permissions)
- [ ] Sync history / undo

## Error Handling

| Scenario | Strategy |
|----------|----------|
| Network failure | Exponential backoff retry (1s, 2s, 4s, 8s... max 5min) |
| BaiduPan API quota exceeded | Pause sync, notify user, retry next day |
| Auth token expired | Auto-refresh; if fails, prompt re-auth |
| File conflict on upload | Rename with suffix, log conflict |
| Corrupted metadata | Fall back to remote version, log warning |
| Eagle library switched | Reset sync state, trigger full reconciliation |

## Performance Considerations

- **Hash computation**: Use Node.js `crypto.createHash('sha256')` with streaming for large files
- **Batch operations**: Group multiple small metadata changes into single upload
- **Debounce**: 5s debounce on change detection to avoid thrashing during batch operations
- **Parallel uploads**: Up to 3 concurrent uploads for metadata/thumbnails
- **Lazy pull trigger**: Eagle has no `onItemOpen` event. Approach: periodically check `eagle.item.getSelected()` — if a selected item has `fileStatus: 'remote_only'`, trigger download. Additionally, provide a right-click/UI button "Download Original" for explicit pull.
- **Lazy pull queue**: Prioritize currently-viewed/selected items; background download idle items
- **Memory**: Stream large files, never load full file into memory

## Configuration

Stored in plugin's local config (Eagle plugin data directory):

```json
{
  "deviceId": "uuid-v4",
  "deviceName": "MacBook-Work",
  "provider": "baidupan",
  "syncMode": "realtime",
  "syncIntervalMs": 5000,
  "lazyPull": true,
  "maxConcurrentUploads": 3,
  "maxConcurrentDownloads": 3,
  "providers": {
    "baidupan": {
      "accessToken": "...",
      "refreshToken": "...",
      "tokenExpiresAt": 1715000000000
    }
  }
}
```
